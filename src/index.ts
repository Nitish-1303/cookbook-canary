/**
 * cookbook-canary — prove every example in a repo still runs.
 *
 * Library entry point. The CLI in `cli.ts` is a thin wrapper over `runCanary`;
 * anything the CLI can do, a script can do by passing its own `MachinePool`.
 */

export { runCanary } from "./runner.ts";
export type {
  ExampleResult,
  PrepRecord,
  RunSummary,
  RunnerDeps,
  StepRecord,
} from "./runner.ts";

export { DEFAULTS, ConfigError, defineConfig, parseConfig } from "./config.ts";
export type { CanaryConfig, ExampleOverride, VerifySpec } from "./config.ts";

export { collectDirEntries, discoverExamples } from "./discover.ts";
export type { DirEntry, Example, PackageManifest, Runtime } from "./discover.ts";

export { Outcome, classify, classifyThrown, isBlocking } from "./util/classify.ts";
export type { Verdict } from "./util/classify.ts";
export { createRedactor, redact } from "./util/redact.ts";
export { parseCommand, formatCommand, shellQuote, CommandParseError } from "./util/command.ts";
export { pool, withDeadline, DeadlineExceeded } from "./util/concurrency.ts";

export { renderMarkdown } from "./report/markdown.ts";
export { renderHtml } from "./report/html.ts";
export { SCHEMA_VERSION, toArtifact, toJson } from "./report/json.ts";
export type { CanaryArtifact } from "./report/json.ts";

export { createBrowserProbe, createSolariPool } from "./solari/real.ts";
export type { AdapterOptions, ModuleLoader, SolariCredentials } from "./solari/real.ts";
export { FakeClock, FakeMachine, FakePool } from "./solari/fake.ts";
export type { FakePoolOptions, ScriptedResponse } from "./solari/fake.ts";

export { PreviewNeverCameUp, PreviewUnauthorized, waitForPreview } from "./verify/http.ts";
export { verifyRenders } from "./verify/visual.ts";
export { checkStdout, findMissing } from "./verify/expect.ts";

export { systemClock } from "./solari/types.ts";
export type {
  BackgroundProcess,
  BrowserProbe,
  Clock,
  CommandResult,
  ExecOptions,
  Machine,
  MachineKind,
  MachinePool,
  MachineSpec,
  PageCapture,
  PreviewUrl,
} from "./solari/types.ts";
