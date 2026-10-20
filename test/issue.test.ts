/** The tracking issue: opened once, updated while red, closed on recovery. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ISSUE_LABEL, ISSUE_MARKER, githubIssueApi, syncIssue, type IssueApi, type TrackedIssue } from "../src/issue.ts";
import type { RunSummary } from "../src/runner.ts";

function summary(exitCode: number, failed: string[] = []): RunSummary {
  return {
    repo: "https://example.test/cookbook",
    ref: "main",
    startedAt: "2026-10-20T06:15:00Z",
    finishedAt: "2026-10-20T06:20:00Z",
    durationMs: 1,
    prep: {} as RunSummary["prep"],
    results: failed.map((name) => ({ name, outcome: "fail", reason: "exited 1" }) as RunSummary["results"][number]),
    totals: {} as RunSummary["totals"],
    machineMinutes: 0,
    exitCode,
  };
}

function fakeApi(open: TrackedIssue[] = []) {
  const calls: string[] = [];
  const api: IssueApi = {
    async findOpen(label) {
      calls.push(`find ${label}`);
      return open;
    },
    async create(input) {
      calls.push(`create ${input.labels.join(",")}`);
      assert.ok(input.body.includes(ISSUE_MARKER));
      return 7;
    },
    async comment(n) {
      calls.push(`comment ${n}`);
    },
    async close(n) {
      calls.push(`close ${n}`);
    },
  };
  return { api, calls };
}

describe("syncIssue", () => {
  it("opens one labelled issue on the first red run", async () => {
    const { api, calls } = fakeApi();
    assert.deepEqual(await syncIssue(summary(1, ["a"]), api), { kind: "created", number: 7 });
    assert.deepEqual(calls, [`find ${ISSUE_LABEL}`, `create ${ISSUE_LABEL}`]);
  });

  it("comments on the existing issue instead of opening a duplicate", async () => {
    const { api, calls } = fakeApi([{ number: 3, body: `${ISSUE_MARKER}\nold` }]);
    assert.deepEqual(await syncIssue(summary(1, ["a"]), api), { kind: "commented", number: 3 });
    assert.ok(!calls.some((c) => c.startsWith("create")));
  });

  it("ignores labelled issues that lack the marker", async () => {
    const { api } = fakeApi([{ number: 2, body: "someone else's issue" }]);
    assert.deepEqual(await syncIssue(summary(1, ["a"]), api), { kind: "created", number: 7 });
  });

  it("keeps the oldest issue when more than one is open", async () => {
    const { api } = fakeApi([
      { number: 9, body: ISSUE_MARKER },
      { number: 4, body: ISSUE_MARKER },
    ]);
    assert.deepEqual(await syncIssue(summary(1, ["a"]), api), { kind: "commented", number: 4 });
  });

  it("comments and closes on recovery", async () => {
    const { api, calls } = fakeApi([{ number: 3, body: ISSUE_MARKER }]);
    assert.deepEqual(await syncIssue(summary(0), api), { kind: "closed", number: 3 });
    assert.deepEqual(calls.slice(1), ["comment 3", "close 3"]);
  });

  it("does nothing when green and nothing is open", async () => {
    const { api, calls } = fakeApi();
    assert.deepEqual(await syncIssue(summary(0), api), { kind: "none" });
    assert.equal(calls.length, 1);
  });
});

describe("githubIssueApi", () => {
  it("lists open issues by label and drops pull requests", async () => {
    let url = "";
    const fake = (async (input: string | URL | Request) => {
      url = String(input);
      return new Response(
        JSON.stringify([
          { number: 1, body: "x" },
          { number: 2, body: null, pull_request: {} },
        ]),
        { status: 200 },
      );
    }) as typeof fetch;
    const found = await githubIssueApi("o/r", "tok", fake).findOpen("canary-red");
    assert.equal(url, "https://api.github.com/repos/o/r/issues?state=open&labels=canary-red&per_page=100");
    assert.deepEqual(found, [{ number: 1, body: "x" }]);
  });

  it("fails loudly on an API error", async () => {
    const fake = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    await assert.rejects(githubIssueApi("o/r", "tok", fake).close(1), /403/);
  });
});
