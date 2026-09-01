/**
 * Working out what the examples in a repo are, and how to run each one.
 *
 * Discovery happens against the *machine's* filesystem, not the local one —
 * the repo is cloned inside a microVM and never lands on the host. The
 * inference itself is a pure function over a directory listing so it can be
 * tested against a dozen repo layouts without cloning anything.
 */

import type { CanaryConfig, VerifySpec } from "./config.ts";
import type { Machine } from "./solari/types.ts";

export interface PackageManifest {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface DirEntry {
  name: string;
  files: string[];
  packageJson?: PackageManifest;
}

export type Runtime = "node" | "python" | "unknown";

export interface Example {
  name: string;
  dir: string;
  runtime: Runtime;
  install: string | undefined;
  start: string | undefined;
  needsDisplay: boolean;
  skip: boolean;
  skipReason: string | undefined;
  verify: VerifySpec;
  timeoutMs: number;
  secrets: string[];
  /** Which Solari products this example exercises, for report coverage. */
  solariPackages: string[];
}

const NODE_ENTRYPOINTS = ["index.ts", "main.ts", "index.js", "main.js", "index.mjs", "main.mjs"];
const PYTHON_ENTRYPOINTS = ["main.py", "app.py", "run.py", "example.py"];
const DISPLAY_HINT = /(?:^|[-_])(?:desktop|vnc|gui|computer-use)(?:$|[-_])/i;

function detectRuntime(entry: DirEntry): Runtime {
  if (entry.packageJson || entry.files.includes("package.json")) return "node";
  if (
    entry.files.includes("requirements.txt") ||
    entry.files.includes("pyproject.toml") ||
    entry.files.some((f) => PYTHON_ENTRYPOINTS.includes(f))
  ) {
    return "python";
  }
  return "unknown";
}

function inferInstall(entry: DirEntry, runtime: Runtime): string | undefined {
  if (runtime === "node") {
    return entry.files.includes("package-lock.json")
      ? "npm ci --no-audit --no-fund"
      : "npm install --no-audit --no-fund";
  }
  if (runtime === "python") {
    if (entry.files.includes("requirements.txt")) return "pip install --quiet -r requirements.txt";
    if (entry.files.includes("pyproject.toml")) return "pip install --quiet .";
  }
  return undefined;
}

function inferStart(entry: DirEntry, runtime: Runtime): string | undefined {
  if (runtime === "node") {
    if (entry.packageJson?.scripts?.start) return "npm start";
    const found = NODE_ENTRYPOINTS.find((f) => entry.files.includes(f));
    return found ? `node ${found}` : undefined;
  }
  if (runtime === "python") {
    const found = PYTHON_ENTRYPOINTS.find((f) => entry.files.includes(f));
    return found ? `python ${found}` : undefined;
  }
  return undefined;
}

function solariPackages(entry: DirEntry): string[] {
  const deps = { ...entry.packageJson?.dependencies, ...entry.packageJson?.devDependencies };
  return Object.keys(deps)
    .filter((name) => name.startsWith("@solarisdk/"))
    .sort();
}

export function discoverExamples(entries: readonly DirEntry[], config: CanaryConfig): Example[] {
  return entries
    .filter((entry) => !entry.name.startsWith(".") && !entry.name.startsWith("_"))
    .map((entry) => {
      const override = config.overrides[entry.name] ?? {};
      const runtime = detectRuntime(entry);
      const install = override.install ?? inferInstall(entry, runtime);
      const start = override.start ?? inferStart(entry, runtime);

      let skip = override.skip ?? false;
      let skipReason = override.reason;
      if (!skip && !start) {
        skip = true;
        skipReason =
          runtime === "unknown"
            ? "no package.json or requirements.txt — cannot tell how to run it"
            : `no entrypoint found for a ${runtime} example`;
      }

      return {
        name: entry.name,
        dir: `${config.examplesDir}/${entry.name}`,
        runtime,
        install,
        start,
        needsDisplay: override.needsDisplay ?? DISPLAY_HINT.test(entry.name),
        skip,
        skipReason,
        verify: override.verify ?? { kind: "exit" },
        timeoutMs: override.timeoutMs ?? config.timeoutMs,
        secrets: override.secrets ?? config.secrets,
        solariPackages: solariPackages(entry),
      } satisfies Example;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One `find` for the whole tree instead of a listing call per directory —
 * round trips to a machine cost more than parsing does. Falls back to `ls`
 * per directory if `find` is unavailable in the template.
 */
export async function collectDirEntries(
  machine: Machine,
  repoRoot: string,
  examplesDir: string,
): Promise<DirEntry[]> {
  const root = `${repoRoot}/${examplesDir}`;
  const byDir = new Map<string, string[]>();

  const found = await machine.exec("find", { args: [root, "-maxdepth", "2", "-type", "f"] });
  if (found.exitCode === 0 && found.stdout.trim().length > 0) {
    for (const line of found.stdout.split("\n")) {
      const rel = line.trim().slice(root.length + 1);
      if (!rel || rel.includes("/") === false) continue;
      const slash = rel.indexOf("/");
      const dir = rel.slice(0, slash);
      const file = rel.slice(slash + 1);
      if (file.includes("/")) continue;
      const list = byDir.get(dir);
      if (list) list.push(file);
      else byDir.set(dir, [file]);
    }
  } else {
    const listed = await machine.exec("ls", { args: ["-1", root] });
    if (listed.exitCode !== 0) {
      throw new Error(`could not list ${root}: ${listed.stderr.trim() || `exit ${listed.exitCode}`}`);
    }
    for (const name of listed.stdout.split("\n").map((n) => n.trim()).filter(Boolean)) {
      const inner = await machine.exec("ls", { args: ["-1", `${root}/${name}`] });
      byDir.set(name, inner.stdout.split("\n").map((n) => n.trim()).filter(Boolean));
    }
  }

  const entries: DirEntry[] = [];
  for (const [name, files] of byDir) {
    const entry: DirEntry = { name, files: files.sort() };
    if (files.includes("package.json")) {
      try {
        entry.packageJson = JSON.parse(await machine.readText(`${root}/${name}/package.json`)) as PackageManifest;
      } catch {
        // A malformed manifest is the example's problem, not discovery's; the
        // run will fail on install and say so with the real error.
      }
    }
    entries.push(entry);
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
