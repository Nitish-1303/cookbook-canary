/**
 * The adapter onto the real Solari SDKs — the one file `FakePool` exists to
 * stand in for, and therefore the one file nothing else covered.
 *
 * These tests do not talk to the service. They inject a module loader and hand
 * back objects shaped like the ones `@solarisdk/*` 0.1.2 actually returns, then
 * assert on what `real.ts` sent them: which option keys, argv or a shell string,
 * `kill` or `close`, a resolution tuple or the string the gateway wants,
 * `recording` at launch or after. Those are the things a live run finds first,
 * and finding them here costs no machine-minutes.
 *
 * The fakes are deliberately shaped from the shipped typings rather than from
 * what the adapter wishes were true — including the parts that are easy to get
 * wrong: `previewUrl` may omit its token, `setTimeout` resolves an object, and
 * `close()` is a different thing from `kill()`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeClock } from "../src/solari/fake.ts";
import { createBrowserProbe, createSolariPool } from "../src/solari/real.ts";
import type { ModuleLoader } from "../src/solari/real.ts";

const CREDS = { apiKey: "slr_live_notreal" };
const GATEWAY = "https://api.getsolari.com";

type Chunk = { stream: "stdout" | "stderr"; data: string };
type Opts = Record<string, unknown>;

/** Records every specifier asked for, so laziness itself can be asserted. */
function loaderFor(modules: Record<string, unknown>): ModuleLoader & { seen: string[] } {
  const seen: string[] = [];
  const load = (async (specifier: string) => {
    seen.push(specifier);
    const mod = modules[specifier];
    if (mod === undefined) throw new Error(`Cannot find package '${specifier}'`);
    return mod;
  }) as ModuleLoader & { seen: string[] };
  load.seen = seen;
  return load;
}

/** Stand-in for `Sandbox`, the `SessionHandle` subclass `SandboxClient.create` returns. */
function sandboxHarness(config: { idField?: "id" | "sandboxId"; previewToken?: string } = {}) {
  const log = {
    clientOpts: undefined as Opts | undefined,
    created: [] as Opts[],
    connects: 0,
    run: [] as { cmd: string; opts: Opts }[],
    start: [] as { cmd: string; opts: Opts }[],
    writes: [] as [string, string][],
    snapshots: [] as string[],
    timeouts: [] as number[],
    kills: 0,
    closes: 0,
    startKills: 0,
    emit: undefined as ((chunk: Chunk) => void) | undefined,
  };

  const handle = {
    ...(config.idField === "sandboxId" ? { sandboxId: "sbx_legacy" } : { id: "sbx_1" }),
    async connect() {
      log.connects++;
    },
    commands: {
      async run(cmd: string, opts: Opts = {}) {
        log.run.push({ cmd, opts });
        return { exitCode: 0, stdout: "ok\n", stderr: "" };
      },
      async start(cmd: string, opts: Opts = {}) {
        log.start.push({ cmd, opts });
        return {
          cmdId: "cmd_1",
          onData(handler: (chunk: Chunk) => void) {
            log.emit = handler;
          },
          async wait() {
            return 0;
          },
          async kill() {
            log.startKills++;
          },
        };
      },
    },
    files: {
      async write(path: string, contents: string) {
        log.writes.push([path, contents]);
      },
      async readText() {
        return "contents";
      },
    },
    /** `SessionHandle.previewUrl` resolves `{ url, token? }` — signed previews only. */
    async previewUrl(port: number) {
      return {
        url: `https://p${port}.preview.test`,
        ...(config.previewToken ? { token: config.previewToken } : {}),
      };
    },
    async snapshot(label: string) {
      log.snapshots.push(label);
      return "snap_1";
    },
    /** The real one resolves `{ expiresAt }`, not `void`. */
    async setTimeout(ms: number) {
      log.timeouts.push(ms);
      return { expiresAt: "2026-01-01T00:00:00.000Z" };
    },
    async kill() {
      log.kills++;
    },
    /** Drops the control channel only. Calling this instead of `kill` leaves the VM billing. */
    close() {
      log.closes++;
    },
  };

  const module = {
    SandboxClient: class {
      constructor(clientOpts: Opts) {
        log.clientOpts = clientOpts;
      }
      async create(createOpts: Opts) {
        log.created.push(createOpts);
        return handle;
      }
    },
  };

  return { module, log };
}

describe("createSolariPool — constructing the clients", () => {
  it("passes the gateway baseUrl both clients declare as required", async () => {
    // `SandboxClientOptions.baseUrl` is `string`, not `string | undefined`.
    // Omitting it left HttpTransport resolving every call against `undefined`.
    const { module, log } = sandboxHarness();
    const load = loaderFor({ "@solarisdk/sandbox": module });
    await createSolariPool(CREDS, { load }).createSandbox();
    assert.deepEqual(log.clientOpts, { apiKey: "slr_live_notreal", baseUrl: GATEWAY });
  });

  it("never passes region to the sandbox or desktop client", async () => {
    // Only `@solarisdk/browser` resolves a region to a URL; the other two would
    // silently ignore it, which reads like it works until it does not.
    const { module, log } = sandboxHarness();
    const load = loaderFor({ "@solarisdk/sandbox": module });
    await createSolariPool({ ...CREDS, region: "us-west" }, { load }).createSandbox();
    assert.deepEqual(Object.keys(log.clientOpts ?? {}).sort(), ["apiKey", "baseUrl"]);
  });

  it("prefers an explicit baseUrl, for staging and self-hosted gateways", async () => {
    const { module, log } = sandboxHarness();
    const load = loaderFor({ "@solarisdk/sandbox": module });
    await createSolariPool({ ...CREDS, baseUrl: "https://staging.internal" }, { load }).createSandbox();
    assert.equal(log.clientOpts?.baseUrl, "https://staging.internal");
  });

  it("loads each peer once and only the peers a run actually uses", async () => {
    // The desktop package is an optional peer: a repo with no desktop examples
    // must never need it installed.
    const { module } = sandboxHarness();
    const load = loaderFor({ "@solarisdk/sandbox": module });
    const pool = createSolariPool(CREDS, { load });
    await pool.createSandbox();
    await pool.createFromSnapshot("snap_1");
    assert.deepEqual(load.seen, ["@solarisdk/sandbox"]);
  });

  it("names the package and the install command when a peer is missing", async () => {
    const pool = createSolariPool(CREDS, { load: loaderFor({}) });
    await assert.rejects(pool.createDesktop(), (error: Error) => {
      assert.match(error.message, /needs @solarisdk\/desktop for this run/);
      assert.match(error.message, /npm i @solarisdk\/desktop/);
      assert.ok(error.cause, "keeps the resolution failure as the cause");
      return true;
    });
  });
});

describe("createSolariPool — sandbox mapping", () => {
  const poolWith = (config?: Parameters<typeof sandboxHarness>[0]) => {
    const { module, log } = sandboxHarness(config);
    return { pool: createSolariPool(CREDS, { load: loaderFor({ "@solarisdk/sandbox": module }) }), log };
  };

  it("sends the spec as CreateSandboxOptions and omits what was not asked for", async () => {
    const { pool, log } = poolWith();
    await pool.createSandbox({ template: "base", cpu: 2, timeoutMs: 60_000, onTimeout: "kill" });
    assert.deepEqual(log.created[0], {
      template: "base",
      cpu: 2,
      timeoutMs: 60_000,
      lifecycle: { onTimeout: "kill" },
    });
  });

  it("boots a fork from the snapshot id", async () => {
    // The whole cost argument rests on this key reaching the gateway.
    const { pool, log } = poolWith();
    await pool.createFromSnapshot("snap_abc", { cpu: 4 });
    assert.deepEqual(log.created[0], { fromSnapshot: "snap_abc", cpu: 4 });
  });

  it("opens the control channel before handing the machine over", async () => {
    const { pool, log } = poolWith();
    const machine = await pool.createSandbox();
    assert.equal(log.connects, 1);
    assert.equal(machine.id, "sbx_1");
    assert.equal(machine.kind, "sandbox");
  });

  it("falls back to sandboxId when the handle does not expose id", async () => {
    const { pool } = poolWith({ idField: "sandboxId" });
    assert.equal((await pool.createSandbox()).id, "sbx_legacy");
  });

  it("forwards argv and streaming callbacks as CommandOptions, inventing nothing", async () => {
    const { pool, log } = poolWith();
    const onStdout = () => {};
    const machine = await pool.createSandbox();
    await machine.exec("npm", { args: ["ci"], cwd: "/repo/examples/a", env: { CI: "1" }, onStdout });

    const call = log.run[0];
    assert.ok(call);
    assert.equal(call.cmd, "npm", "commands.run takes argv — the program is not a shell string");
    assert.deepEqual(Object.keys(call.opts).sort(), ["args", "cwd", "env", "onStdout"]);
    assert.deepEqual(call.opts.args, ["ci"]);
    assert.equal(call.opts.onStdout, onStdout, "passes the callback through, not a wrapper");
  });

  it("sends no options at all when there are none", async () => {
    const { pool, log } = poolWith();
    await (await pool.createSandbox()).exec("true");
    assert.deepEqual(log.run[0]?.opts, {});
  });

  it("kills the VM rather than dropping the control channel", async () => {
    // `close()` stops the local socket and leaves the machine billing. Getting
    // this backwards is invisible in a passing test and expensive in a bill.
    const { pool, log } = poolWith();
    await (await pool.createSandbox()).kill();
    assert.equal(log.kills, 1);
    assert.equal(log.closes, 0);
  });

  it("returns the snapshot id, which is what the fan-out forks from", async () => {
    const { pool, log } = poolWith();
    const id = await (await pool.createSandbox()).snapshot?.("after-installs");
    assert.equal(id, "snap_1");
    assert.deepEqual(log.snapshots, ["after-installs"]);
  });

  it("passes an unsigned preview through instead of inventing a token", async () => {
    // `previewUrl` resolves `token?`. A public port has none, and anything that
    // then puts it in a header has to cope with that.
    const { pool } = poolWith();
    const preview = await (await pool.createSandbox()).previewUrl?.(3000);
    assert.equal(preview?.url, "https://p3000.preview.test");
    assert.equal(preview?.token, undefined);
  });

  it("passes a signed preview token through untouched", async () => {
    const { pool } = poolWith({ previewToken: "pt_signed" });
    assert.equal((await (await pool.createSandbox()).previewUrl?.(3000))?.token, "pt_signed");
  });

  it("forwards the idle window, which every action then resets", async () => {
    const { pool, log } = poolWith();
    await (await pool.createSandbox()).setIdleTimeout(90_000);
    assert.deepEqual(log.timeouts, [90_000]);
  });

  it("collects both streams of a background process and stops it on demand", async () => {
    // An example that serves never exits, so this is the only way to see its
    // output and the only thing that stops it.
    const { pool, log } = poolWith();
    const machine = await pool.createSandbox();
    const proc = await machine.startBackground?.("npm", { args: ["start"], cwd: "/repo" });
    assert.ok(proc);
    assert.deepEqual(log.start[0]?.opts, { args: ["start"], cwd: "/repo" });

    log.emit?.({ stream: "stdout", data: "listening on 3000\n" });
    log.emit?.({ stream: "stderr", data: "deprecation warning\n" });
    assert.deepEqual(proc.output(), { stdout: "listening on 3000\n", stderr: "deprecation warning\n" });
    assert.equal(proc.running(), true);

    await proc.kill();
    assert.equal(proc.running(), false);
    assert.equal(log.startKills, 1);
  });
});

/** Stand-in for `Desktop`, which extends the same `SessionHandle` but execs differently. */
function desktopHarness() {
  const log = {
    clientOpts: undefined as Opts | undefined,
    created: [] as Opts[],
    connects: 0,
    healths: 0,
    exec: [] as { cmd: string; opts: Opts }[],
    screenshots: [] as Opts[],
    destroyed: [] as string[],
    closes: 0,
  };

  const handle = {
    sessionId: "dsk_1",
    streamUrl: "wss://stream.test/dsk_1",
    async connect() {
      log.connects++;
    },
    async health() {
      log.healths++;
      return { ready: true };
    },
    /** Desktop `exec` has `args`, `cwd` and `timeoutMs` — but no `env`. */
    async exec(cmd: string, opts: Opts = {}) {
      log.exec.push({ cmd, opts });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    fs: {
      async write() {},
      async readText() {
        return "contents";
      },
    },
    async screenshot(opts: Opts = {}) {
      log.screenshots.push(opts);
      return new Uint8Array([137, 80, 78, 71]);
    },
    async setTimeout() {
      return { expiresAt: "2026-01-01T00:00:00.000Z" };
    },
    async close() {
      log.closes++;
    },
  };

  const module = {
    DesktopClient: class {
      constructor(clientOpts: Opts) {
        log.clientOpts = clientOpts;
      }
      async create(createOpts: Opts) {
        log.created.push(createOpts);
        return handle;
      }
      async destroy(sessionId: string) {
        log.destroyed.push(sessionId);
        return { sessionId, status: "terminated" };
      }
    },
  };

  return { module, log };
}

describe("createSolariPool — desktop mapping", () => {
  const poolWith = () => {
    const { module, log } = desktopHarness();
    return { pool: createSolariPool(CREDS, { load: loaderFor({ "@solarisdk/desktop": module }) }), log };
  };

  it("sends the resolution as the string the gateway wants, not a pair of numbers", async () => {
    // `CreateDesktopOptions.resolution` is `"1280x800"`. Passing the tuple
    // through unchanged is a wire mismatch on every desktop example there is.
    const { pool, log } = poolWith();
    await pool.createDesktop({ resolution: [1280, 800], timeoutMs: 300_000 });
    assert.deepEqual(log.created[0], { timeoutMs: 300_000, resolution: "1280x800" });
  });

  it("waits for the readiness probe before handing the desktop over", async () => {
    // A desktop that answers RPC before its display is up screenshots a black
    // frame, which reads in a report as a broken example.
    const { pool, log } = poolWith();
    const machine = await pool.createDesktop();
    assert.equal(log.connects, 1);
    assert.equal(log.healths, 1);
    assert.equal(machine.kind, "desktop");
    assert.equal(machine.streamUrl, "wss://stream.test/dsk_1", "the live link the report prints");
  });

  it("execs directly when there is no env to emulate", async () => {
    const { pool, log } = poolWith();
    await (await pool.createDesktop()).exec("xdotool", { args: ["key", "Return"] });
    assert.deepEqual(log.exec[0], { cmd: "xdotool", opts: { args: ["key", "Return"] } });
  });

  it("emulates env through a login shell, quoting every interpolated value", async () => {
    // The desktop API has no env field, so this is the one place a shell string
    // gets built — which makes it the one place quoting can go wrong.
    const { pool, log } = poolWith();
    await (await pool.createDesktop()).exec("npm", {
      args: ["start"],
      cwd: "/repo/my examples/a",
      env: { TOKEN: "a'b; rm -rf /" },
    });
    assert.equal(log.exec[0]?.cmd, "sh");
    assert.deepEqual(log.exec[0]?.opts, {
      args: ["-lc", "cd '/repo/my examples/a' && env TOKEN='a'\\''b; rm -rf /' 'npm' 'start'"],
    });
  });

  it("refuses an env var name that is not an identifier", async () => {
    const { pool } = poolWith();
    const machine = await pool.createDesktop();
    await assert.rejects(
      machine.exec("true", { env: { "A=B; rm -rf /": "1" } }),
      /refusing to pass unsafe env var name/,
    );
  });

  it("destroys the session instead of closing the handle", async () => {
    const { pool, log } = poolWith();
    await (await pool.createDesktop()).kill();
    assert.deepEqual(log.destroyed, ["dsk_1"]);
    assert.equal(log.closes, 0, "close() would leave the desktop running");
  });

  it("takes the lossless screenshot, since a report keeps exactly one frame", async () => {
    const { pool, log } = poolWith();
    const png = await (await pool.createDesktop()).screenshot?.();
    assert.deepEqual(log.screenshots, [{ format: "png" }]);
    assert.deepEqual(png, new Uint8Array([137, 80, 78, 71]));
  });
});

/** Stand-in for `Solari` + `BrowserSession` + a patchright `Page`. */
function browserHarness(config: { replays?: (string | null)[]; gotoError?: string } = {}) {
  const replays = [...(config.replays ?? [])];
  const log = {
    clientOpts: undefined as Opts | undefined,
    launched: [] as (Opts | undefined)[],
    pages: 0,
    headers: [] as Record<string, string>[],
    gotos: [] as { url: string; opts: Opts | undefined }[],
    locators: [] as string[],
    shots: [] as Opts[],
    pageCloses: 0,
    browserCloses: 0,
    replayAsks: [] as string[],
  };

  const page = {
    async setExtraHTTPHeaders(headers: Record<string, string>) {
      log.headers.push(headers);
    },
    async goto(url: string, opts?: Opts) {
      log.gotos.push({ url, opts });
      if (config.gotoError) throw new Error(config.gotoError);
    },
    async title() {
      return "Solari Cookbook";
    },
    locator(selector: string) {
      log.locators.push(selector);
      return { async allInnerTexts() { return ["Scraped 3 pages"]; } };
    },
    async screenshot(opts: Opts = {}) {
      log.shots.push(opts);
      return new Uint8Array([137, 80, 78, 71]);
    },
    async close() {
      log.pageCloses++;
    },
  };

  const browser = {
    id: "sess_1",
    async newPage() {
      log.pages++;
      return page;
    },
    async close() {
      log.browserCloses++;
    },
  };

  const module = {
    Solari: class {
      readonly sessions = {
        /** Available ~1–3s after release, so early asks legitimately fail. */
        async getReplayUrl(id: string) {
          log.replayAsks.push(id);
          const next = replays.shift();
          if (!next) throw new Error("404 replay not ready");
          return { url: next };
        },
      };
      constructor(clientOpts: Opts) {
        log.clientOpts = clientOpts;
      }
      async launch(launchOpts?: Opts) {
        log.launched.push(launchOpts);
        return browser;
      }
    },
  };

  return { module, log };
}

describe("createBrowserProbe", () => {
  const probeWith = async (config?: Parameters<typeof browserHarness>[0], clock?: FakeClock) => {
    const { module, log } = browserHarness(config);
    const probe = await createBrowserProbe(
      { ...CREDS, region: "us-west" },
      { load: loaderFor({ "@solarisdk/browser": module }), ...(clock ? { clock } : {}) },
    );
    return { probe, log };
  };

  it("passes the region, being the one client that resolves one", async () => {
    const { log } = await probeWith();
    assert.deepEqual(log.clientOpts, { apiKey: "slr_live_notreal", region: "us-west" });
  });

  it("enables recording at launch, because it cannot be turned on later", async () => {
    // Asking for a replay of a session not created with `recording` returns a
    // 404 — there is nothing to enable after the fact.
    const { log } = await probeWith();
    assert.deepEqual(log.launched, [{ stealth: true, recording: true }]);
  });

  it("reads the rendered page and keeps the frame as evidence", async () => {
    const { probe, log } = await probeWith();
    const capture = await probe.capture("https://p3000.preview.test/", {
      headers: { "x-pinetree-preview-token": "pt_signed" },
    });

    assert.equal(capture.title, "Solari Cookbook");
    assert.deepEqual(capture.texts, ["Scraped 3 pages"]);
    assert.equal(capture.sessionId, "sess_1");
    assert.deepEqual(capture.png, new Uint8Array([137, 80, 78, 71]));
    assert.deepEqual(log.headers, [{ "x-pinetree-preview-token": "pt_signed" }]);
    assert.deepEqual(log.gotos, [{ url: "https://p3000.preview.test/", opts: { waitUntil: "networkidle" } }]);
    assert.deepEqual(log.locators, ["body"]);
    assert.deepEqual(log.shots, [{ fullPage: true }]);
    assert.equal(log.pageCloses, 1);
  });

  it("closes the page even when the navigation fails", async () => {
    // One leaked page per failing example is one too many, given that failing
    // examples are the entire point of the run.
    const { probe, log } = await probeWith({ gotoError: "net::ERR_CONNECTION_REFUSED" });
    await assert.rejects(probe.capture("https://p3000.preview.test/"), /ERR_CONNECTION_REFUSED/);
    assert.equal(log.pageCloses, 1);
  });

  it("does not ask for a replay before the session is released", async () => {
    // The upload only starts on release, so an early ask is a guaranteed 404.
    const { probe, log } = await probeWith({ replays: ["https://replay.test/sess_1"] });
    assert.equal(await probe.replayUrlFor?.("sess_1"), undefined);
    assert.deepEqual(log.replayAsks, []);
  });

  it("waits out the upload window instead of taking the first 404 as final", async () => {
    const clock = new FakeClock();
    const { probe, log } = await probeWith({ replays: [null, null, "https://replay.test/sess_1"] }, clock);
    await probe.close();

    assert.equal(await probe.replayUrlFor?.("sess_1"), "https://replay.test/sess_1");
    assert.deepEqual(log.replayAsks, ["sess_1", "sess_1", "sess_1"]);
    // Asked immediately, then after each delay — not slept before the first ask.
    assert.deepEqual(clock.slept, [1_200, 1_200]);
    assert.equal(log.browserCloses, 1);
  });

  it("gives up quietly rather than failing a run over a missing replay", async () => {
    // A report without a replay link is worth having; a run that dies because
    // the recording never uploaded is not.
    const clock = new FakeClock();
    const { probe, log } = await probeWith({ replays: [] }, clock);
    await probe.close();

    assert.equal(await probe.replayUrlFor?.("sess_1"), undefined);
    assert.equal(log.replayAsks.length, 3);
  });
});
