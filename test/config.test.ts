/**
 * Config validation and example discovery. Both are pure, and both are where a
 * mistake is cheapest to catch — a bad config caught here costs nothing, and the
 * same mistake caught after fan-out costs thirty microVMs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError, DEFAULTS, parseConfig, type CanaryConfig } from "../src/config.ts";
import { collectDirEntries, discoverExamples, type DirEntry } from "../src/discover.ts";
import { FakePool } from "../src/solari/fake.ts";
import type { Machine } from "../src/solari/types.ts";

const REPO = "https://github.com/solari-sdk/solari-cookbook";

function config(over: Partial<CanaryConfig> = {}): CanaryConfig {
  return parseConfig({ repo: REPO, ...over });
}

describe("parseConfig", () => {
  it("fills in defaults around a bare repo URL", () => {
    const parsed = config();
    assert.equal(parsed.ref, DEFAULTS.ref);
    assert.equal(parsed.examplesDir, DEFAULTS.examplesDir);
    assert.equal(parsed.concurrency, DEFAULTS.concurrency);
    assert.deepEqual(parsed.secrets, ["SOLARI_API_KEY"]);
    assert.deepEqual(parsed.overrides, {});
    assert.equal(parsed.cpu, undefined);
  });

  it("accepts both URL shapes git actually takes", () => {
    for (const repo of [REPO, `${REPO}.git`, "git@github.com:solari-sdk/solari-cookbook.git"]) {
      assert.equal(parseConfig({ repo }).repo, repo);
    }
  });

  it("reports every problem at once instead of one per run", () => {
    // Six minutes of microVMs and then "concurrency must be an integer" is
    // exactly the failure this is guarding against.
    try {
      parseConfig({ repo: "not a url", concurrency: 99, retries: -1, timeoutMs: "soon" });
      assert.fail("expected ConfigError");
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.problems.length, 4);
      assert.match(error.message, /repo must be a git URL/);
      assert.match(error.message, /concurrency must be an integer between 1 and 32/);
    }
  });

  it("refuses a skip with no reason", () => {
    assert.throws(
      () => parseConfig({ repo: REPO, overrides: { flaky: { skip: true } } }),
      /a silent skip is how examples rot/,
    );
    assert.equal(
      parseConfig({ repo: REPO, overrides: { flaky: { skip: true, reason: "needs a paid plan" } } })
        .overrides.flaky?.reason,
      "needs a paid plan",
    );
  });

  it("requires a port for preview verification and a regex for stdout", () => {
    assert.throws(
      () => parseConfig({ repo: REPO, overrides: { web: { verify: { kind: "preview" } } } }),
      /verify\.port is required/,
    );
    assert.throws(
      () => parseConfig({ repo: REPO, overrides: { cli: { verify: { kind: "stdout", expectStdout: "(" } } } }),
      /not a valid regular expression/,
    );
    const parsed = parseConfig({
      repo: REPO,
      overrides: { web: { verify: { kind: "preview", port: 3000, path: "/health", expectText: ["ok"] } } },
    });
    assert.deepEqual(parsed.overrides.web?.verify, {
      kind: "preview",
      port: 3000,
      path: "/health",
      expectText: ["ok"],
    });
  });

  it("rejects an unknown verify kind", () => {
    assert.throws(
      () => parseConfig({ repo: REPO, overrides: { x: { verify: { kind: "vibes" } } } }),
      /must be one of exit, stdout, preview/,
    );
  });
});

describe("discoverExamples", () => {
  it("infers npm ci when there is a lockfile and npm install when there is not", () => {
    const entries: DirEntry[] = [
      { name: "locked", files: ["package.json", "package-lock.json", "index.js"] },
      { name: "unlocked", files: ["package.json", "index.js"] },
    ];
    const [locked, unlocked] = discoverExamples(entries, config());
    assert.equal(locked?.install, "npm ci --no-audit --no-fund");
    assert.equal(unlocked?.install, "npm install --no-audit --no-fund");
    assert.equal(locked?.start, "node index.js");
  });

  it("prefers a start script over guessing an entrypoint", () => {
    const [example] = discoverExamples(
      [{ name: "web", files: ["package.json", "index.js"], packageJson: { scripts: { start: "vite" } } }],
      config(),
    );
    assert.equal(example?.start, "npm start");
    assert.equal(example?.runtime, "node");
  });

  it("handles python examples by requirements file or entrypoint", () => {
    const found = discoverExamples(
      [
        { name: "reqs", files: ["requirements.txt", "main.py"] },
        { name: "pyproject", files: ["pyproject.toml", "app.py"] },
        { name: "bare", files: ["run.py"] },
      ],
      config(),
    );
    assert.deepEqual(
      found.map((e) => [e.name, e.runtime, e.install, e.start]),
      [
        ["bare", "python", undefined, "python run.py"],
        ["pyproject", "python", "pip install --quiet .", "python app.py"],
        ["reqs", "python", "pip install --quiet -r requirements.txt", "python main.py"],
      ],
    );
  });

  it("skips a directory it cannot work out how to run, and says why", () => {
    const [example] = discoverExamples([{ name: "notes", files: ["README.md"] }], config());
    assert.equal(example?.skip, true);
    assert.equal(example?.runtime, "unknown");
    assert.match(example?.skipReason ?? "", /cannot tell how to run it/);
  });

  it("routes examples whose name hints at pixels to a desktop VM", () => {
    const found = discoverExamples(
      [
        { name: "computer-use-agent", files: ["package.json", "index.js"] },
        { name: "desktop", files: ["package.json", "index.js"] },
        { name: "vnc-replay", files: ["package.json", "index.js"] },
        { name: "sandbox-basics", files: ["package.json", "index.js"] },
      ],
      config(),
    );
    assert.deepEqual(
      found.filter((e) => e.needsDisplay).map((e) => e.name),
      ["computer-use-agent", "desktop", "vnc-replay"],
    );
  });

  it("lets an override win over every inference", () => {
    const [example] = discoverExamples(
      [{ name: "web", files: ["package.json"], packageJson: { scripts: { start: "vite" } } }],
      config({
        overrides: {
          web: {
            install: "pnpm i --frozen-lockfile",
            start: "pnpm dev",
            needsDisplay: true,
            timeoutMs: 90_000,
            secrets: ["SOLARI_API_KEY", "OPENAI_API_KEY"],
            verify: { kind: "preview", port: 5173, expectText: ["Solari"] },
          },
        },
      }),
    );
    assert.equal(example?.install, "pnpm i --frozen-lockfile");
    assert.equal(example?.start, "pnpm dev");
    assert.equal(example?.needsDisplay, true);
    assert.equal(example?.timeoutMs, 90_000);
    assert.deepEqual(example?.secrets, ["SOLARI_API_KEY", "OPENAI_API_KEY"]);
    assert.equal(example?.verify.port, 5173);
  });

  it("records which Solari products an example exercises", () => {
    const [example] = discoverExamples(
      [
        {
          name: "mixed",
          files: ["package.json", "index.js"],
          packageJson: {
            dependencies: { "@solarisdk/sandbox": "^1", zod: "^3" },
            devDependencies: { "@solarisdk/browser": "^1" },
          },
        },
      ],
      config(),
    );
    assert.deepEqual(example?.solariPackages, ["@solarisdk/browser", "@solarisdk/sandbox"]);
  });

  it("ignores dot- and underscore-prefixed directories", () => {
    const found = discoverExamples(
      [
        { name: ".github", files: ["workflow.yml"] },
        { name: "_shared", files: ["package.json", "index.js"] },
        { name: "real", files: ["package.json", "index.js"] },
      ],
      config(),
    );
    assert.deepEqual(found.map((e) => e.name), ["real"]);
  });
});

describe("collectDirEntries", () => {
  const findOutput = [
    "repo/examples/browser-scrape/package.json",
    "repo/examples/browser-scrape/index.js",
    "repo/examples/deep/nested/ignored.js",
    "repo/examples/loose-file.md",
    "repo/examples/py-agent/main.py",
    "",
  ].join("\n");

  it("reads the whole tree with one find and parses the manifests it sees", async () => {
    const pool = new FakePool({
      handlers: [{ match: /^find /, respond: { stdout: findOutput } }],
      files: {
        "repo/examples/browser-scrape/package.json": JSON.stringify({
          name: "browser-scrape",
          dependencies: { "@solarisdk/browser": "^1.2.0" },
        }),
      },
    });
    const machine = (await pool.createSandbox()) as Machine;
    const entries = await collectDirEntries(machine, "repo", "examples");

    assert.deepEqual(entries.map((e) => e.name), ["browser-scrape", "py-agent"]);
    assert.deepEqual(entries[0]?.files, ["index.js", "package.json"]);
    assert.deepEqual(entries[0]?.packageJson?.dependencies, { "@solarisdk/browser": "^1.2.0" });
    // A file sitting directly in examples/ is not an example, and nothing nested
    // deeper than one level counts as one either.
    assert.equal(entries.some((e) => e.name === "loose-file.md"), false);
    assert.equal(entries.some((e) => e.name === "deep"), false);
    assert.equal(pool.lines().filter((line) => line.startsWith("find ")).length, 1);
  });

  it("falls back to ls per directory when the template has no find", async () => {
    const pool = new FakePool({
      handlers: [
        { match: /^find /, respond: { exitCode: 127, stderr: "find: not found" } },
        { match: /^ls -1 repo\/examples\/one$/, respond: { stdout: "index.js\npackage.json\n" } },
        { match: /^ls -1 repo\/examples\/two$/, respond: { stdout: "main.py\n" } },
        { match: /^ls -1 repo\/examples$/, respond: { stdout: "one\ntwo\n" } },
      ],
      files: { "repo/examples/one/package.json": "{ not json" },
    });
    const machine = (await pool.createSandbox()) as Machine;
    const entries = await collectDirEntries(machine, "repo", "examples");

    assert.deepEqual(entries.map((e) => e.name), ["one", "two"]);
    assert.deepEqual(entries[0]?.files, ["index.js", "package.json"]);
    // A malformed manifest is left for the install step to complain about.
    assert.equal(entries[0]?.packageJson, undefined);
  });

  it("throws with the real error when the examples directory is missing", async () => {
    const pool = new FakePool({
      handlers: [
        { match: /^find /, respond: { exitCode: 1, stderr: "" } },
        { match: /^ls /, respond: { exitCode: 2, stderr: "ls: cannot access 'repo/examples'" } },
      ],
    });
    const machine = (await pool.createSandbox()) as Machine;
    await assert.rejects(collectDirEntries(machine, "repo", "examples"), /cannot access/);
  });
});
