/**
 * In-memory stand-in for Solari.
 *
 * This exists so the orchestration logic — planning, fan-out, retries,
 * classification, budget enforcement, redaction — can be tested exhaustively
 * with no API key, no network, and no billable microVMs. Failure modes that are
 * awkward to provoke against the real service (a 425 that never clears, a
 * server that dies on boot, a quota error mid-fan-out) are one line here.
 */

import type {
  BackgroundProcess,
  Clock,
  CommandResult,
  DesktopSpec,
  ExecOptions,
  Machine,
  MachineKind,
  MachineSpec,
  PreviewUrl,
} from "./types.ts";

export interface ScriptedResponse {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** For `startBackground`: keep the process alive until killed. */
  stayAlive?: boolean;
  /** Throw instead of returning, to simulate transport failure. */
  throws?: string;
}

export interface ExecRecord {
  machineId: string;
  line: string;
  cwd: string | undefined;
  env: Record<string, string> | undefined;
  background: boolean;
}

export type Responder = ScriptedResponse | ((argv: string[]) => ScriptedResponse);

export interface FakePoolOptions {
  /** First matching pattern wins; unmatched commands succeed silently. */
  handlers?: Array<{ match: RegExp; respond: Responder }>;
  files?: Record<string, string>;
  /** When false, `snapshot` is absent and the runner must fall back. */
  snapshots?: boolean;
  /** When false, `previewUrl`/`startBackground` are absent. */
  previews?: boolean;
  /** Throw on the nth (1-based) machine creation, to exercise error paths. */
  failCreateAt?: number;
}

export class FakeClock implements Clock {
  #now: number;
  readonly slept: number[] = [];

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  /** Advances virtual time instead of waiting, so tests stay instant. */
  async sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    this.#now += ms;
  }

  advance(ms: number): void {
    this.#now += ms;
  }
}

function resolve(responder: Responder, argv: string[]): ScriptedResponse {
  return typeof responder === "function" ? responder(argv) : responder;
}

class FakeBackgroundProcess implements BackgroundProcess {
  #stdout: string;
  #stderr: string;
  #exitCode: number;
  #running: boolean;

  constructor(response: ScriptedResponse) {
    this.#stdout = response.stdout ?? "";
    this.#stderr = response.stderr ?? "";
    this.#exitCode = response.exitCode ?? 0;
    this.#running = response.stayAlive ?? true;
  }

  output(): { stdout: string; stderr: string } {
    return { stdout: this.#stdout, stderr: this.#stderr };
  }

  running(): boolean {
    return this.#running;
  }

  async wait(): Promise<number> {
    this.#running = false;
    return this.#exitCode;
  }

  async kill(): Promise<void> {
    this.#running = false;
  }
}

export class FakeMachine implements Machine {
  readonly id: string;
  readonly kind: MachineKind;
  readonly #pool: FakePool;
  killed = false;
  fromSnapshot: string | undefined;
  streamUrl: string | undefined;

  // Assigned in the constructor rather than declared as methods so that a pool
  // configured without snapshots or previews produces machines where those
  // capabilities are genuinely absent, exactly as a real template mismatch would.
  snapshot?: (label: string) => Promise<string>;
  previewUrl?: (port: number) => Promise<PreviewUrl>;
  startBackground?: (cmd: string, opts?: ExecOptions) => Promise<BackgroundProcess>;
  screenshot?: () => Promise<Uint8Array>;

  constructor(id: string, kind: MachineKind, pool: FakePool) {
    this.id = id;
    this.kind = kind;
    this.#pool = pool;

    if (pool.options.snapshots !== false && kind === "sandbox") {
      this.snapshot = async (label: string) => pool.nextSnapshotId(label);
    }
    if (pool.options.previews !== false && kind === "sandbox") {
      this.previewUrl = async (port: number) => ({
        url: `https://p${port}.preview.test/?pt_token=pt_faketoken${port}`,
        token: `pt_faketoken${port}`,
      });
      this.startBackground = async (cmd: string, opts: ExecOptions = {}) => {
        const argv = [cmd, ...(opts.args ?? [])];
        const line = argv.join(" ");
        pool.execs.push({
          machineId: this.id,
          line,
          cwd: opts.cwd,
          env: opts.env,
          background: true,
        });
        const response = pool.respond(line, argv);
        if (response.throws) throw new Error(response.throws);
        return new FakeBackgroundProcess(response);
      };
    }
    if (kind === "desktop") {
      // 8-byte PNG signature stub — enough to prove a frame came back.
      this.screenshot = async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    }
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<CommandResult> {
    if (this.killed) throw new Error(`machine ${this.id} was already killed`);
    const argv = [cmd, ...(opts.args ?? [])];
    const line = argv.join(" ");
    this.#pool.execs.push({
      machineId: this.id,
      line,
      cwd: opts.cwd,
      env: opts.env,
      background: false,
    });
    const response = this.#pool.respond(line, argv);
    if (response.throws) throw new Error(response.throws);
    const result: CommandResult = {
      exitCode: response.exitCode ?? 0,
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
    };
    if (result.stdout) opts.onStdout?.(result.stdout);
    if (result.stderr) opts.onStderr?.(result.stderr);
    return result;
  }

  async writeFile(path: string, contents: string): Promise<void> {
    this.#pool.files.set(path, contents);
  }

  async readText(path: string): Promise<string> {
    const contents = this.#pool.files.get(path);
    if (contents === undefined) throw new Error(`ENOENT: ${path}`);
    return contents;
  }

  async setIdleTimeout(): Promise<void> {}

  async kill(): Promise<void> {
    this.killed = true;
  }
}

export class FakePool {
  readonly options: FakePoolOptions;
  readonly execs: ExecRecord[] = [];
  readonly created: FakeMachine[] = [];
  readonly specs: (MachineSpec | DesktopSpec | undefined)[] = [];
  readonly snapshotLabels: string[] = [];
  readonly files = new Map<string, string>();
  #ids = 0;

  constructor(options: FakePoolOptions = {}) {
    this.options = options;
    for (const [path, contents] of Object.entries(options.files ?? {})) {
      this.files.set(path, contents);
    }
  }

  respond(line: string, argv: string[]): ScriptedResponse {
    for (const handler of this.options.handlers ?? []) {
      if (handler.match.test(line)) return resolve(handler.respond, argv);
    }
    return {};
  }

  nextSnapshotId(label: string): string {
    this.snapshotLabels.push(label);
    return `snap_${this.snapshotLabels.length}`;
  }

  #make(kind: MachineKind, prefix: string, spec: MachineSpec | undefined): FakeMachine {
    this.#ids += 1;
    this.specs.push(spec);
    if (this.options.failCreateAt === this.#ids) {
      throw new Error("ECONNRESET while creating machine");
    }
    const machine = new FakeMachine(`${prefix}_${this.#ids}`, kind, this);
    this.created.push(machine);
    return machine;
  }

  async createSandbox(spec?: MachineSpec): Promise<Machine> {
    return this.#make("sandbox", "sbx", spec);
  }

  async createFromSnapshot(snapshotId: string, spec?: MachineSpec): Promise<Machine> {
    const machine = this.#make("sandbox", "fork", spec);
    machine.fromSnapshot = snapshotId;
    return machine;
  }

  async createDesktop(spec?: DesktopSpec): Promise<Machine> {
    const machine = this.#make("desktop", "dsk", spec);
    machine.streamUrl = `https://stream.test/${machine.id}`;
    return machine;
  }

  /** Every command line seen, for assertions about cwd, env, and ordering. */
  lines(): string[] {
    return this.execs.map((record) => record.line);
  }

  liveMachines(): FakeMachine[] {
    return this.created.filter((machine) => !machine.killed);
  }
}
