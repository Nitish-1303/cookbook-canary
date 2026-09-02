/**
 * The narrow slice of Solari that Canary actually depends on.
 *
 * Everything below the runner talks to these interfaces rather than to
 * `@solarisdk/*` directly. Two reasons, in order of importance:
 *
 *  1. The orchestration logic — planning, fan-out, classification, reporting —
 *     is the part most likely to have bugs, and it becomes unit-testable
 *     against `fake.ts` with no API key and no network.
 *  2. Sandboxes and desktops expose different shapes for the same idea
 *     (`commands.run` vs `exec`, `kill` vs `destroy`). Normalizing once here
 *     keeps that difference out of every call site.
 */

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/** Signed, short-lived URL onto a port inside a machine. */
export interface PreviewUrl {
  url: string;
  /**
   * Absent when the gateway does not sign the preview — `SessionHandle.previewUrl`
   * declares it optional, and a public port needs no token. Anything putting this
   * in a header has to check first: an undefined header value is rejected outright
   * by the browser client rather than skipped.
   */
  token?: string;
}

export type MachineKind = "sandbox" | "desktop";

/**
 * A process still running inside a machine. Needed because an example that
 * serves a port never exits on its own: you have to start it, poke it from
 * outside, and then stop it.
 */
export interface BackgroundProcess {
  /** Output captured so far. */
  output(): { stdout: string; stderr: string };
  /** Resolves with the exit code once the process ends by itself. */
  wait(): Promise<number>;
  /** True until the process exits or is killed. */
  running(): boolean;
  kill(): Promise<void>;
}

/**
 * One running microVM. Sandboxes and desktops both satisfy this; only
 * desktops implement `screenshot`, only sandboxes implement `snapshot`.
 */
export interface Machine {
  readonly id: string;
  readonly kind: MachineKind;

  exec(cmd: string, opts?: ExecOptions): Promise<CommandResult>;
  writeFile(path: string, contents: string): Promise<void>;
  readText(path: string): Promise<string>;

  /** Idle window. Every action resets it, so an active machine never expires. */
  setIdleTimeout(ms: number): Promise<void>;

  /** Tears the VM down. Distinct from dropping the local control channel. */
  kill(): Promise<void>;

  previewUrl?(port: number): Promise<PreviewUrl>;
  snapshot?(label: string): Promise<string>;
  screenshot?(): Promise<Uint8Array>;
  /** Long-running process, for examples that serve rather than exit. */
  startBackground?(cmd: string, opts?: ExecOptions): Promise<BackgroundProcess>;
  /** Watchable stream, for putting a live link in the report. */
  streamUrl?: string;
}

export interface MachineSpec {
  template?: string;
  cpu?: number;
  memMb?: number;
  timeoutMs?: number;
  /** `pause` keeps the VM resumable and off the running-VM quota. */
  onTimeout?: "pause" | "kill";
}

export interface DesktopSpec extends MachineSpec {
  resolution?: [number, number];
}

/**
 * Machine supply. `fromSnapshot` is the load-bearing one: Canary installs
 * every example's dependencies once in a prep machine, snapshots it, then
 * forks that snapshot per example instead of repeating the installs.
 */
export interface MachinePool {
  createSandbox(spec?: MachineSpec): Promise<Machine>;
  createFromSnapshot(snapshotId: string, spec?: MachineSpec): Promise<Machine>;
  createDesktop(spec?: DesktopSpec): Promise<Machine>;
}

export interface PageCapture {
  title: string;
  texts: string[];
  png: Uint8Array;
  sessionId: string;
  replayUrl?: string;
}

/**
 * A real browser, used to confirm that examples which serve a port actually
 * render — an exit code of 0 does not prove a web example works.
 */
export interface BrowserProbe {
  capture(url: string, opts?: { headers?: Record<string, string> }): Promise<PageCapture>;
  /**
   * Session replays upload asynchronously after the session is released, so
   * this returns nothing until after {@link BrowserProbe.close}.
   */
  replayUrlFor?(sessionId: string): Promise<string | undefined>;
  close(): Promise<void>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
