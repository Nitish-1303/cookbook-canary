/**
 * Adapters onto the real Solari SDKs.
 *
 * This is the only file that imports `@solarisdk/*`, and it does so lazily: the
 * packages are optional peers, so `canary --dry-run`, the unit tests, and report
 * rendering all work in an install that never pulled them in.
 *
 * Each mapping below is annotated with the SDK surface it targets. If a method
 * name drifts, this file is the single place to fix — nothing above it knows
 * whether it is talking to a sandbox, a desktop, or a fake.
 */

import type {
  BackgroundProcess,
  BrowserProbe,
  CommandResult,
  DesktopSpec,
  ExecOptions,
  Machine,
  MachinePool,
  PageCapture,
  PreviewUrl,
  MachineSpec,
} from "./types.ts";
import { shellQuote } from "../util/command.ts";

export interface SolariCredentials {
  apiKey: string;
  baseUrl?: string;
  /** Browser-only: `@solarisdk/browser` resolves a region to a URL. Ignored by the others. */
  region?: string;
}

/**
 * `SandboxClientOptions.baseUrl` and `DesktopClientOptions.baseUrl` are required,
 * not optional, and neither client understands `region` — only the browser client
 * does. Omitting it leaves `HttpTransport` with an undefined base, so every call
 * goes to `undefined/sandboxes` and the run dies on the first request.
 */
const DEFAULT_BASE_URL = "https://api.getsolari.com";

/** Structural views of the SDK objects, so this file needs no generated types. */
interface SandboxHandle {
  id?: string;
  sandboxId?: string;
  connect?(): Promise<void>;
  commands: {
    run(cmd: string, opts?: Record<string, unknown>): Promise<CommandResult>;
    start(cmd: string, opts?: Record<string, unknown>): Promise<StartHandle>;
  };
  files: {
    write(path: string, contents: string): Promise<void>;
    readText(path: string): Promise<string>;
  };
  previewUrl(port: number): Promise<PreviewUrl>;
  snapshot(label: string): Promise<string>;
  setTimeout(ms: number): Promise<void>;
  kill(): Promise<void>;
}

interface StartHandle {
  onData(handler: (chunk: { stream: string; data: string }) => void): void;
  kill(): Promise<void>;
}

interface DesktopHandle {
  sessionId: string;
  streamUrl?: string;
  connect?(): Promise<void>;
  health?(): Promise<{ ready: boolean }>;
  exec(cmd: string, opts?: Record<string, unknown>): Promise<CommandResult>;
  fs: { write(path: string, contents: string): Promise<void>; readText(path: string): Promise<string> };
  screenshot(opts?: Record<string, unknown>): Promise<Uint8Array>;
  setTimeout(ms: number): Promise<void>;
  close(): Promise<void>;
}

async function load<T>(specifier: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch (cause) {
    throw new Error(
      `cookbook-canary needs ${specifier} for this run. Install it with \`npm i ${specifier}\`.`,
      { cause },
    );
  }
}

function lifecycle(spec: MachineSpec | undefined): Record<string, unknown> {
  return {
    ...(spec?.template ? { template: spec.template } : {}),
    ...(spec?.cpu ? { cpu: spec.cpu } : {}),
    ...(spec?.memMb ? { memMb: spec.memMb } : {}),
    ...(spec?.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
    ...(spec?.onTimeout ? { lifecycle: { onTimeout: spec.onTimeout } } : {}),
  };
}

class SandboxMachine implements Machine {
  readonly kind = "sandbox" as const;
  readonly id: string;
  readonly #sbx: SandboxHandle;

  constructor(sbx: SandboxHandle) {
    this.#sbx = sbx;
    this.id = sbx.id ?? sbx.sandboxId ?? "sbx_unknown";
  }

  /** `commands.run` takes argv, not a shell string — that is why `args` is separate. */
  exec(cmd: string, opts: ExecOptions = {}): Promise<CommandResult> {
    return this.#sbx.commands.run(cmd, {
      ...(opts.args ? { args: opts.args } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.onStdout ? { onStdout: opts.onStdout } : {}),
      ...(opts.onStderr ? { onStderr: opts.onStderr } : {}),
    });
  }

  async startBackground(cmd: string, opts: ExecOptions = {}): Promise<BackgroundProcess> {
    let stdout = "";
    let stderr = "";
    let alive = true;
    const handle = await this.#sbx.commands.start(cmd, {
      ...(opts.args ? { args: opts.args } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    });
    handle.onData((chunk) => {
      if (chunk.stream === "stderr") stderr += chunk.data;
      else stdout += chunk.data;
    });
    return {
      output: () => ({ stdout, stderr }),
      running: () => alive,
      wait: async () => 0,
      kill: async () => {
        alive = false;
        await handle.kill();
      },
    };
  }

  writeFile(path: string, contents: string): Promise<void> {
    return this.#sbx.files.write(path, contents);
  }

  readText(path: string): Promise<string> {
    return this.#sbx.files.readText(path);
  }

  previewUrl(port: number): Promise<PreviewUrl> {
    return this.#sbx.previewUrl(port);
  }

  snapshot(label: string): Promise<string> {
    return this.#sbx.snapshot(label);
  }

  setIdleTimeout(ms: number): Promise<void> {
    return this.#sbx.setTimeout(ms);
  }

  /** `kill`, not `close`: close drops the control channel and leaves the VM running. */
  kill(): Promise<void> {
    return this.#sbx.kill();
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

class DesktopMachine implements Machine {
  readonly kind = "desktop" as const;
  readonly id: string;
  readonly streamUrl: string | undefined;
  readonly #desktop: DesktopHandle;
  readonly #destroy: (sessionId: string) => Promise<void>;

  constructor(desktop: DesktopHandle, destroy: (sessionId: string) => Promise<void>) {
    this.#desktop = desktop;
    this.#destroy = destroy;
    this.id = desktop.sessionId;
    this.streamUrl = desktop.streamUrl;
  }

  /**
   * Desktop `exec` documents `args` but not `cwd` or `env`, so those are
   * emulated with a login shell. Every interpolated value is single-quoted and
   * env names are checked against an identifier pattern, so a value containing
   * `; rm -rf /` is passed as data.
   */
  async exec(cmd: string, opts: ExecOptions = {}): Promise<CommandResult> {
    const args = opts.args ?? [];
    if (!opts.cwd && !opts.env) return this.#desktop.exec(cmd, { args });

    const pieces: string[] = [];
    if (opts.cwd) pieces.push("cd", shellQuote(opts.cwd), "&&");
    const assignments = Object.entries(opts.env ?? {}).map(([name, value]) => {
      if (!ENV_NAME.test(name)) throw new Error(`refusing to pass unsafe env var name: ${name}`);
      return `${name}=${shellQuote(value)}`;
    });
    if (assignments.length > 0) pieces.push("env", ...assignments);
    pieces.push(...[cmd, ...args].map(shellQuote));
    return this.#desktop.exec("sh", { args: ["-lc", pieces.join(" ")] });
  }

  writeFile(path: string, contents: string): Promise<void> {
    return this.#desktop.fs.write(path, contents);
  }

  readText(path: string): Promise<string> {
    return this.#desktop.fs.readText(path);
  }

  screenshot(): Promise<Uint8Array> {
    // JPEG would be cheaper in a loop; a report keeps one frame, so take the lossless one.
    return this.#desktop.screenshot({ format: "png" });
  }

  setIdleTimeout(ms: number): Promise<void> {
    return this.#desktop.setTimeout(ms);
  }

  /** `destroy`, not `close`: these VMs are disposable and must not linger. */
  kill(): Promise<void> {
    return this.#destroy(this.#desktop.sessionId);
  }
}

interface SandboxClientModule {
  SandboxClient: new (opts: Record<string, unknown>) => {
    create(opts: Record<string, unknown>): Promise<SandboxHandle>;
  };
}

interface DesktopClientModule {
  DesktopClient: new (opts: Record<string, unknown>) => {
    create(opts: Record<string, unknown>): Promise<DesktopHandle>;
    destroy(sessionId: string): Promise<void>;
  };
}

export function createSolariPool(creds: SolariCredentials): MachinePool {
  const clientOpts = {
    apiKey: creds.apiKey,
    baseUrl: creds.baseUrl ?? DEFAULT_BASE_URL,
  };

  let sandboxes: InstanceType<SandboxClientModule["SandboxClient"]> | undefined;
  let desktops: InstanceType<DesktopClientModule["DesktopClient"]> | undefined;

  const sandboxClient = async () => {
    sandboxes ??= new (await load<SandboxClientModule>("@solarisdk/sandbox")).SandboxClient(clientOpts);
    return sandboxes;
  };
  const desktopClient = async () => {
    desktops ??= new (await load<DesktopClientModule>("@solarisdk/desktop")).DesktopClient(clientOpts);
    return desktops;
  };

  const openSandbox = async (opts: Record<string, unknown>): Promise<Machine> => {
    const client = await sandboxClient();
    const sbx = await client.create(opts);
    await sbx.connect?.();
    return new SandboxMachine(sbx);
  };

  return {
    createSandbox: (spec) => openSandbox(lifecycle(spec)),
    createFromSnapshot: (snapshotId, spec) => openSandbox({ fromSnapshot: snapshotId, ...lifecycle(spec) }),
    async createDesktop(spec?: DesktopSpec): Promise<Machine> {
      const client = await desktopClient();
      const desktop = await client.create({
        ...lifecycle(spec),
        ...(spec?.resolution ? { resolution: spec.resolution } : {}),
      });
      await desktop.connect?.();
      await desktop.health?.();
      return new DesktopMachine(desktop, (sessionId) => client.destroy(sessionId));
    },
  };
}

interface PageHandle {
  setExtraHTTPHeaders?(headers: Record<string, string>): Promise<void>;
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  title(): Promise<string>;
  locator(selector: string): { allInnerTexts(): Promise<string[]> };
  screenshot(opts?: Record<string, unknown>): Promise<Uint8Array>;
  close?(): Promise<void>;
}

interface BrowserModule {
  Solari: new (opts: Record<string, unknown>) => {
    launch(opts?: Record<string, unknown>): Promise<{
      id: string;
      newPage(): Promise<PageHandle>;
      close(): Promise<void>;
    }>;
    sessions: { getReplayUrl(sessionId: string): Promise<{ url: string }> };
  };
}

export async function createBrowserProbe(creds: SolariCredentials): Promise<BrowserProbe> {
  const mod = await load<BrowserModule>("@solarisdk/browser");
  const client = new mod.Solari({
    apiKey: creds.apiKey,
    ...(creds.baseUrl ? { baseUrl: creds.baseUrl } : {}),
    ...(creds.region ? { region: creds.region } : {}),
  });
  // `recording` has to be set at session creation; asking for a replay later
  // when it was not enabled up front just returns a 404.
  const browser = await client.launch({ stealth: true, recording: true });
  let closed = false;

  return {
    async capture(url: string, opts?: { headers?: Record<string, string> }): Promise<PageCapture> {
      const page = await browser.newPage();
      try {
        if (opts?.headers) await page.setExtraHTTPHeaders?.(opts.headers);
        await page.goto(url, { waitUntil: "networkidle" });
        return {
          title: await page.title(),
          texts: await page.locator("body").allInnerTexts(),
          png: await page.screenshot({ fullPage: true }),
          sessionId: browser.id,
        };
      } finally {
        await page.close?.().catch(() => {});
      }
    },

    /** Replays upload asynchronously after release, so this only works post-close. */
    async replayUrlFor(sessionId: string): Promise<string | undefined> {
      if (!closed) return undefined;
      try {
        return (await client.sessions.getReplayUrl(sessionId)).url;
      } catch {
        return undefined;
      }
    },

    async close(): Promise<void> {
      // Awaiting is not optional: the client holds a loopback proxy open for
      // connection retries and the process will hang if this is skipped.
      await browser.close();
      closed = true;
    },
  };
}
