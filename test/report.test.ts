/**
 * Report rendering. These reports are the product — the thing a maintainer
 * actually reads — so what matters here is that failures surface first, that the
 * evidence survives, and that nothing secret does.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderHtml } from "../src/report/html.ts";
import { SCHEMA_VERSION, toArtifact, toJson, type CanaryArtifact } from "../src/report/json.ts";
import { renderMarkdown } from "../src/report/markdown.ts";
import type { ExampleResult, RunSummary } from "../src/runner.ts";
import type { Outcome } from "../src/util/classify.ts";

const KEY = "slr_live_reportkey1234567890";
const PNG = Buffer.from([137, 80, 78, 71]).toString("base64");

function result(name: string, outcome: Outcome, over: Partial<ExampleResult> = {}): ExampleResult {
  return {
    name,
    dir: `examples/${name}`,
    runtime: "node",
    machineKind: "sandbox",
    machineId: `fork_${name}`,
    outcome,
    reason: outcome === "pass" ? "ok" : "exited 1",
    durationMs: 4_200,
    attempts: 1,
    install: undefined,
    run: undefined,
    preview: undefined,
    visual: undefined,
    streamUrl: undefined,
    solariPackages: ["@solarisdk/sandbox"],
    ...over,
  };
}

const SUMMARY: RunSummary = {
  repo: "https://github.com/solari-sdk/solari-cookbook",
  ref: "main",
  startedAt: "2026-09-01T10:00:00.000Z",
  finishedAt: "2026-09-01T10:03:20.000Z",
  durationMs: 200_000,
  prep: {
    machineId: "sbx_prep",
    snapshotId: "snap_1",
    cloneMs: 1_800,
    installMs: 74_000,
    examplesFound: 6,
    headSha: "abcdef123456",
  },
  results: [
    result("aaa-passing", "pass"),
    result("broken-web", "fail", {
      reason: 'page did not contain "Scraped 3 pages"',
      run: { exitCode: 0, durationMs: 9_000, stdoutTail: "listening on :3000", stderrTail: "" },
      preview: { url: "https://p3000.preview.test/?[redacted:preview-token]", status: 200, attempts: 4 },
      visual: {
        title: "Error",
        missing: ["Scraped 3 pages"],
        screenshotBase64: PNG,
        sessionId: "sess_9",
        replayUrl: "https://replay.test/sess_9",
      },
    }),
    result("dead-install", "fail", {
      reason: "install: exited 1",
      install: { exitCode: 1, durationMs: 12_000, stdoutTail: "", stderrTail: `npm ERR! 404 (key ${KEY})` },
    }),
    result("desktop-tour", "timeout", {
      machineKind: "desktop",
      reason: "timed out",
      attempts: 2,
      streamUrl: "https://stream.test/dsk_1",
      visual: { title: "", missing: [], screenshotBase64: PNG, sessionId: "dsk_1", replayUrl: undefined },
      run: { exitCode: 0, durationMs: 240_000, stdoutTail: "", stderrTail: "xdotool: no window" },
    }),
    result("flaky-net", "flake", { reason: "network or upstream error", durationMs: 800 }),
    result("no-entrypoint", "skipped", { reason: "no entrypoint found for a node example", durationMs: 0 }),
  ],
  totals: { pass: 1, fail: 2, skipped: 1, flake: 1, timeout: 1 },
  machineMinutes: 6.4,
  exitCode: 1,
};

describe("renderMarkdown", () => {
  const md = renderMarkdown(SUMMARY);

  it("leads with the verdict and the commit, not with a wall of rows", () => {
    const head = md.split("\n").slice(0, 6).join("\n");
    assert.match(head, /## Cookbook canary — solari-sdk\/solari-cookbook/);
    assert.match(head, /\*\*3 examples are broken\.\*\*/);
    assert.match(head, /`main` at `abcdef123456` · 200\.0s wall clock · 6\.4 machine-minutes/);
  });

  it("orders the table worst-first, because nobody scrolls past thirty green rows", () => {
    const rows = md.split("\n").filter((line) => line.startsWith("| ") && line.includes("`"));
    assert.deepEqual(
      rows.map((row) => row.split("`")[1]),
      ["broken-web", "dead-install", "desktop-tour", "flaky-net", "no-entrypoint", "aaa-passing"],
    );
  });

  it("puts every failure's own evidence inline", () => {
    assert.match(md, /### What broke/);
    assert.match(md, /<details><summary><code>broken-web<\/code> — page did not contain/);
    assert.match(md, /- preview answered `200` after 4 poll\(s\)/);
    assert.match(md, /- page was missing: `Scraped 3 pages`/);
    assert.match(md, /- \[session replay\]\(https:\/\/replay\.test\/sess_9\)/);
    assert.match(md, /!\[what the page looked like\]\(data:image\/png;base64,iVBORw==\)/);
    // A desktop example photographs a screen, not a page.
    assert.match(md, /!\[what the screen looked like\]\(data:image\/png;base64,iVBORw==\)/);
    assert.match(md, /Install output:/);
    assert.match(md, /- attempts: 2/);
    assert.match(md, /- \[live desktop stream\]\(https:\/\/stream\.test\/dsk_1\)/);
    // Flakes and skips are reported but never get a detail block.
    assert.doesNotMatch(md, /<code>flaky-net<\/code>/);
  });

  it("quantifies what the install-once design bought", () => {
    assert.match(md, /74\.0s of installs done once instead of 6 times/);
  });

  it("says nothing was run when a repo has no runnable examples", () => {
    const empty = renderMarkdown({
      ...SUMMARY,
      results: [],
      totals: { pass: 0, fail: 0, skipped: 0, flake: 0, timeout: 0 },
    });
    assert.match(empty, /\*\*Nothing was run\.\*\*/);
  });

  it("uses the singular when exactly one example works", () => {
    const one = renderMarkdown({
      ...SUMMARY,
      results: [result("solo", "pass")],
      totals: { pass: 1, fail: 0, skipped: 0, flake: 0, timeout: 0 },
    });
    assert.match(one, /\*\*All 1 runnable example still works\.\*\*/);
  });
});

function named(artifact: CanaryArtifact, name: string): ExampleResult {
  const found = artifact.summary.results.find((entry) => entry.name === name);
  assert.ok(found, `no result called ${name}`);
  return found;
}

describe("toArtifact / toJson", () => {
  it("stamps a schema version, because people build dashboards on this", () => {
    const artifact = toArtifact(SUMMARY);
    assert.equal(artifact.schemaVersion, SCHEMA_VERSION);
    assert.equal(artifact.generator, "cookbook-canary");
    assert.equal(artifact.summary.prep.headSha, "abcdef123456");
    assert.equal(artifact.summary.results.length, 6);
  });

  it("scrubs a key that leaked into install output, declared or not", () => {
    assert.equal(named(toArtifact(SUMMARY, [KEY]), "dead-install").install?.stderrTail, "npm ERR! 404 (key [redacted])");
    // Nothing was declared in this second call: the shape alone is enough.
    assert.equal(
      named(toArtifact(SUMMARY), "dead-install").install?.stderrTail,
      "npm ERR! 404 (key [redacted:solari-key])",
    );
  });

  it("leaves no trace of the secret anywhere in the serialised tree", () => {
    const json = toJson(SUMMARY, [KEY]);
    assert.equal(json.includes(KEY), false);
    assert.equal(json.includes("slr_live_"), false);
    assert.match(json, /\n$/);
  });

  it("keeps the screenshot, which is evidence rather than noise", () => {
    const parsed = JSON.parse(toJson(SUMMARY, [KEY])) as CanaryArtifact;
    assert.equal(named(parsed, "broken-web").visual?.screenshotBase64, PNG);
    assert.equal(parsed.summary.exitCode, 1);
    assert.deepEqual(parsed.summary.totals, { pass: 1, fail: 2, skipped: 1, flake: 1, timeout: 1 });
  });

  it("does not mutate the caller's summary while scrubbing it", () => {
    toArtifact(SUMMARY, [KEY]);
    assert.match(SUMMARY.results[2]?.install?.stderrTail ?? "", /slr_live_reportkey/);
  });
});

describe("renderHtml", () => {
  const html = renderHtml(SUMMARY);

  it("is one standalone file, so it works from a CI artifact with no network", () => {
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<title>Cookbook canary — solari-sdk\/solari-cookbook<\/title>/);
    assert.match(html, /@media \(prefers-color-scheme: dark\)/);
    // Nothing is fetched: no scripts, no stylesheets, no remote images.
    assert.doesNotMatch(html, /<script|<link|src="http/);
  });

  it("tiles only the outcomes that actually happened, worst first", () => {
    const tiles = [...html.matchAll(/<div class="tile (\w+)"><b>(\d+)<\/b>/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(tiles, [
      ["fail", "2"],
      ["timeout", "1"],
      ["flake", "1"],
      ["skipped", "1"],
      ["pass", "1"],
    ]);
  });

  it("sorts the table failures-first and inlines each one's evidence", () => {
    assert.deepEqual(
      [...html.matchAll(/<td><code>([^<]+)<\/code>/g)].map((m) => m[1]),
      ["broken-web", "dead-install", "desktop-tour", "flaky-net", "no-entrypoint", "aaa-passing"],
    );
    assert.match(html, /<details><summary>evidence<\/summary>/);
    assert.match(html, /<img alt="rendered page for broken-web" src="data:image\/png;base64,iVBORw==">/);
    assert.match(html, /<img alt="desktop screen for desktop-tour" src="data:image\/png;base64,iVBORw==">/);
    assert.match(html, /<pre>xdotool: no window<\/pre>/);
    // A passing example has nothing to show, so it gets no disclosure widget.
    assert.equal(html.split("aaa-passing")[1]?.includes("<details>"), false);
  });

  it("escapes hostile text instead of rendering it", () => {
    const hostile = renderHtml({
      ...SUMMARY,
      results: [result("<img src=x onerror=alert(1)>", "fail", { reason: '</td><script>alert("xss")</script>' })],
    });
    assert.doesNotMatch(hostile, /<script>/);
    assert.match(hostile, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(hostile, /&lt;\/td&gt;&lt;script&gt;alert\(&quot;xss&quot;\)&lt;\/script&gt;/);
  });

  it("publishes no secret once it is handed the scrubbed summary", () => {
    // This is the pipeline's actual contract: `writeReports` scrubs once and
    // renders three views of that one tree, so the dashboard cannot leak a
    // credential just because it is a different code path from the JSON.
    const scrubbed = renderHtml(toArtifact(SUMMARY, [KEY]).summary);
    assert.equal(scrubbed.includes(KEY), false);
    assert.match(scrubbed, /<pre>npm ERR! 404 \(key \[redacted\]\)<\/pre>/);
  });
});

