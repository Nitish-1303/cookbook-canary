/**
 * Config parsing and validation.
 *
 * Validation is strict and reports every problem at once. A canary that runs
 * for six minutes across thirty microVMs and *then* complains about a typo in
 * `concurrency` has wasted real money.
 */

export interface VerifySpec {
  /**
   * - `exit`    — the process exited 0 (default)
   * - `stdout`  — exited 0 and stdout matched `expectStdout`
   * - `preview` — exited 0, a server came up on `port`, and a real browser
   *               loaded it and saw `expectText`
   */
  kind: "exit" | "stdout" | "preview";
  port?: number;
  path?: string;
  expectText?: string[];
  expectStdout?: string;
}

export interface ExampleOverride {
  skip?: boolean;
  reason?: string;
  timeoutMs?: number;
  /** Route to a desktop VM instead of a headless sandbox. */
  needsDisplay?: boolean;
  install?: string;
  start?: string;
  verify?: VerifySpec;
  secrets?: string[];
}

export interface CanaryConfig {
  repo: string;
  ref: string;
  examplesDir: string;
  concurrency: number;
  timeoutMs: number;
  template: string;
  cpu: number | undefined;
  memMb: number | undefined;
  /** Env var names forwarded into each machine. Values never touch the config. */
  secrets: string[];
  /** Hard ceiling on total machine-minutes, as a runaway-cost brake. */
  maxMachineMinutes: number;
  /** Re-runs granted only to verdicts classified retryable. */
  retries: number;
  overrides: Record<string, ExampleOverride>;
}

export const DEFAULTS = {
  ref: "main",
  examplesDir: "examples",
  concurrency: 6,
  timeoutMs: 240_000,
  template: "base",
  secrets: ["SOLARI_API_KEY"],
  maxMachineMinutes: 120,
  retries: 1,
} as const;

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid canary config:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const VERIFY_KINDS = new Set(["exit", "stdout", "preview"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function intInRange(
  value: unknown,
  name: string,
  min: number,
  max: number,
  problems: string[],
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return value;
}

function parseVerify(raw: unknown, path: string, problems: string[]): VerifySpec | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    problems.push(`${path} must be an object`);
    return undefined;
  }
  const kind = raw.kind;
  if (typeof kind !== "string" || !VERIFY_KINDS.has(kind)) {
    problems.push(`${path}.kind must be one of exit, stdout, preview`);
    return undefined;
  }
  const spec: VerifySpec = { kind: kind as VerifySpec["kind"] };
  if (kind === "preview") {
    const port = raw.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      problems.push(`${path}.port is required for preview verification (1-65535)`);
    } else {
      spec.port = port;
    }
    if (typeof raw.path === "string") spec.path = raw.path;
  }
  if (kind === "stdout") {
    if (typeof raw.expectStdout !== "string") {
      problems.push(`${path}.expectStdout is required for stdout verification`);
    } else {
      try {
        new RegExp(raw.expectStdout);
        spec.expectStdout = raw.expectStdout;
      } catch {
        problems.push(`${path}.expectStdout is not a valid regular expression`);
      }
    }
  }
  if (raw.expectText !== undefined) {
    if (!Array.isArray(raw.expectText) || raw.expectText.some((t) => typeof t !== "string")) {
      problems.push(`${path}.expectText must be an array of strings`);
    } else {
      spec.expectText = raw.expectText as string[];
    }
  }
  return spec;
}

function parseOverride(raw: unknown, path: string, problems: string[]): ExampleOverride {
  if (!isRecord(raw)) {
    problems.push(`${path} must be an object`);
    return {};
  }
  const override: ExampleOverride = {};
  if (raw.skip !== undefined) {
    if (typeof raw.skip !== "boolean") problems.push(`${path}.skip must be a boolean`);
    else override.skip = raw.skip;
  }
  if (raw.needsDisplay !== undefined) {
    if (typeof raw.needsDisplay !== "boolean") problems.push(`${path}.needsDisplay must be a boolean`);
    else override.needsDisplay = raw.needsDisplay;
  }
  for (const key of ["reason", "install", "start"] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "string") problems.push(`${path}.${key} must be a string`);
      else override[key] = raw[key] as string;
    }
  }
  if (raw.timeoutMs !== undefined) {
    override.timeoutMs = intInRange(raw.timeoutMs, `${path}.timeoutMs`, 1_000, 3_600_000, problems, DEFAULTS.timeoutMs);
  }
  if (raw.secrets !== undefined) {
    if (!Array.isArray(raw.secrets) || raw.secrets.some((s) => typeof s !== "string")) {
      problems.push(`${path}.secrets must be an array of env var names`);
    } else {
      override.secrets = raw.secrets as string[];
    }
  }
  const verify = parseVerify(raw.verify, `${path}.verify`, problems);
  if (verify) override.verify = verify;

  if (override.skip && !override.reason) {
    problems.push(`${path} is skipped but gives no reason; a silent skip is how examples rot`);
  }
  return override;
}

const REPO_URL = /^(?:https:\/\/|git@)[\w.-]+[/:][\w.-]+\/[\w.-]+?(?:\.git)?\/?$/;

/** Throws {@link ConfigError} listing every problem found, not just the first. */
export function parseConfig(raw: unknown): CanaryConfig {
  const problems: string[] = [];
  if (!isRecord(raw)) throw new ConfigError(["config must be a JSON object"]);

  const repo = raw.repo;
  if (typeof repo !== "string" || !REPO_URL.test(repo)) {
    problems.push("repo must be a git URL, e.g. https://github.com/owner/name");
  }

  // Annotated, not inferred: `DEFAULTS` is `as const`, so inference would give
  // each key its own literal type and the write below would have to satisfy all
  // three at once.
  const strings: Record<"ref" | "examplesDir" | "template", string> = {
    ref: DEFAULTS.ref,
    examplesDir: DEFAULTS.examplesDir,
    template: DEFAULTS.template,
  };
  for (const key of ["ref", "examplesDir", "template"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "string" || (raw[key] as string).length === 0) {
      problems.push(`${key} must be a non-empty string`);
    } else {
      strings[key] = raw[key] as string;
    }
  }

  let secrets: string[] = [...DEFAULTS.secrets];
  if (raw.secrets !== undefined) {
    if (!Array.isArray(raw.secrets) || raw.secrets.some((s) => typeof s !== "string")) {
      problems.push("secrets must be an array of env var names");
    } else {
      secrets = raw.secrets as string[];
    }
  }

  const overrides: Record<string, ExampleOverride> = {};
  if (raw.overrides !== undefined) {
    if (!isRecord(raw.overrides)) {
      problems.push("overrides must be an object keyed by example directory name");
    } else {
      for (const [name, value] of Object.entries(raw.overrides)) {
        overrides[name] = parseOverride(value, `overrides.${name}`, problems);
      }
    }
  }

  const config: CanaryConfig = {
    repo: repo as string,
    ref: strings.ref,
    examplesDir: strings.examplesDir,
    template: strings.template,
    concurrency: intInRange(raw.concurrency, "concurrency", 1, 32, problems, DEFAULTS.concurrency),
    timeoutMs: intInRange(raw.timeoutMs, "timeoutMs", 1_000, 3_600_000, problems, DEFAULTS.timeoutMs),
    cpu: raw.cpu === undefined ? undefined : intInRange(raw.cpu, "cpu", 1, 16, problems, 2),
    memMb: raw.memMb === undefined ? undefined : intInRange(raw.memMb, "memMb", 2_048, 65_536, problems, 2_048),
    maxMachineMinutes: intInRange(raw.maxMachineMinutes, "maxMachineMinutes", 1, 10_000, problems, DEFAULTS.maxMachineMinutes),
    retries: intInRange(raw.retries, "retries", 0, 5, problems, DEFAULTS.retries),
    secrets,
    overrides,
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** Identity helper so a `canary.config.ts` gets editor completion. */
export function defineConfig(config: Partial<CanaryConfig> & { repo: string }): CanaryConfig {
  return parseConfig(config);
}

