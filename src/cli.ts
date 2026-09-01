#!/usr/bin/env node
/**
 * CLI wrapper. Deliberately thin: it resolves config, builds a real Solari
 * machine pool, calls `runCanary`, and writes the three reports. All of the
 * interesting behaviour lives in the library so it can be tested without a key.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { ConfigError, parseConfig, type CanaryConfig } from "./config.ts";
import { renderHtml } from "./report/html.ts";
import { toArtifact } from "./report/json.ts";
import { renderMarkdown } from "./report/markdown.ts";
import { runCanary, type RunSummary } from "./runner.ts";
import { createBrowserProbe, createSolariPool } from "./solari/real.ts";

const HELP = `cookbook-canary — prove every example in a repo still runs

Usage
  canary [options]

Options
  --config <path>      config file (default: ./canary.json)
  --repo <url>         git URL to check; overrides the config
  --ref <ref>          branch or tag (default: main)
  --only <a,b,c>       run just these example directories
  --concurrency <n>    machines in flight at once (default: 6)
  --out <dir>          where to write reports (default: ./canary-out)
  --dry-run            resolve and print the config; create no machines
  --quiet              suppress progress lines
  -h, --help           this text

Environment
  SOLARI_API_KEY       required, and forwarded into each example's run step
  SOLARI_BASE_URL      optional API override
  SOLARI_REGION        optional region override

Exit code is 1 if any example failed or timed out. Skips and flakes do not fail
the build; they are reported.
`;

interface Options {
  config: string;
  repo?: string;
  ref?: string;
  only?: string[];
  concurrency?: number;
  out: string;
  dryRun: boolean;
  quiet: boolean;
}

function parseOptions(argv: string[]): Options | undefined {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string", default: "canary.json" },
      repo: { type: "string" },
      ref: { type: "string" },
      only: { type: "string" },
      concurrency: { type: "string" },
      out: { type: "string", default: "canary-out" },
      "dry-run": { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return undefined;
  }

  const concurrency = values.concurrency === undefined ? undefined : Number(values.concurrency);
  if (concurrency !== undefined && !Number.isInteger(concurrency)) {
    throw new Error("--concurrency must be an integer");
  }

  return {
    config: values.config as string,
    ...(values.repo ? { repo: values.repo } : {}),
    ...(values.ref ? { ref: values.ref } : {}),
    ...(values.only ? { only: values.only.split(",").map((name) => name.trim()).filter(Boolean) } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    out: values.out as string,
    dryRun: values["dry-run"] as boolean,
    quiet: values.quiet as boolean,
  };
}

async function loadConfig(options: Options): Promise<CanaryConfig> {
  let fileContents: Record<string, unknown> = {};
  try {
    fileContents = JSON.parse(await readFile(resolve(options.config), "utf8")) as Record<string, unknown>;
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    if (!missing) throw new Error(`could not read ${options.config}: ${(error as Error).message}`);
    if (!options.repo) {
      throw new Error(`no ${options.config} found and no --repo given; see --help`);
    }
  }

  return parseConfig({
    ...fileContents,
    ...(options.repo ? { repo: options.repo } : {}),
    ...(options.ref ? { ref: options.ref } : {}),
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
  });
}

async function writeReports(dir: string, summary: RunSummary, secrets: (string | undefined)[]): Promise<string> {
  const out = resolve(dir);
  await mkdir(out, { recursive: true });
  // Scrub once, then render three views of the same scrubbed tree. Doing it here
  // rather than inside each renderer means a declared secret cannot reach the
  // published HTML dashboard just because it took a different code path from the
  // JSON — and the renderers stay pure functions of what they are handed.
  const artifact = toArtifact(summary, secrets);
  await Promise.all([
    writeFile(resolve(out, "report.md"), renderMarkdown(artifact.summary), "utf8"),
    writeFile(resolve(out, "report.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8"),
    writeFile(resolve(out, "index.html"), renderHtml(artifact.summary), "utf8"),
  ]);
  return out;
}

function oneLine(summary: RunSummary): string {
  const { pass, fail, skipped, flake, timeout } = summary.totals;
  const parts = [`${pass} passed`, `${fail} failed`];
  if (timeout > 0) parts.push(`${timeout} timed out`);
  if (flake > 0) parts.push(`${flake} flaky`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  const minutes = summary.machineMinutes.toFixed(1);
  return `${parts.join(", ")} in ${(summary.durationMs / 1000).toFixed(1)}s (${minutes} machine-minutes)`;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options) return;

  const config = await loadConfig(options);
  const log = options.quiet ? () => {} : (line: string) => process.stderr.write(`${line}\n`);

  if (options.dryRun) {
    // Print the merged config and stop. Nothing is created, so this is the
    // cheap way to check a `canary.json` before spending machine-minutes.
    process.stdout.write(`${JSON.stringify({ ...config, only: options.only ?? null }, null, 2)}\n`);
    return;
  }

  const apiKey = process.env.SOLARI_API_KEY;
  if (!apiKey) throw new Error("SOLARI_API_KEY is not set (use --dry-run to check config without it)");
  const creds = {
    apiKey,
    ...(process.env.SOLARI_BASE_URL ? { baseUrl: process.env.SOLARI_BASE_URL } : {}),
    ...(process.env.SOLARI_REGION ? { region: process.env.SOLARI_REGION } : {}),
  };

  const summary = await runCanary(config, {
    machines: createSolariPool(creds),
    // A thunk, not a probe: a repo with no preview checks never opens a browser
    // session, and therefore never pays for one.
    browser: () => createBrowserProbe(creds),
    ...(options.only ? { only: options.only } : {}),
    env: process.env,
    log,
  });

  const out = await writeReports(options.out, summary, config.secrets.map((name) => process.env[name]));
  log(oneLine(summary));
  log(`reports → ${out}`);
  process.exitCode = summary.exitCode;
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`canary: ${(error as Error).message}\n`);
  }
  process.exitCode = 2;
});
