/**
 * Preview polling and browser verification — the part that decides whether an
 * example that *serves* something actually works.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeClock } from "../src/solari/fake.ts";
import type { BrowserProbe, PageCapture } from "../src/solari/types.ts";
import { PreviewNeverCameUp, PreviewUnauthorized, waitForPreview } from "../src/verify/http.ts";
import { verifyRenders } from "../src/verify/visual.ts";

const URL_UNDER_TEST = "https://p3000.preview.test/?pt_token=pt_abc";

/** Replays a scripted sequence of statuses; `null` means a transport failure. */
function scriptedFetch(statuses: (number | null)[], body = "<h1>ok</h1>") {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const index = Math.min(calls.length, statuses.length - 1);
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const status = statuses[index];
    if (status === null || status === undefined) throw new Error("connect ECONNREFUSED");
    return { status, text: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("waitForPreview", () => {
  it("polls through 425 until the port answers", async () => {
    // 425 is the documented "reached the machine, nothing listening yet" state:
    // the normal first second or two of an example's life.
    const clock = new FakeClock();
    const { impl, calls } = scriptedFetch([425, 425, 200]);
    const result = await waitForPreview(URL_UNDER_TEST, { fetchImpl: impl, clock, delayMs: 500 });

    assert.equal(result.status, 200);
    assert.equal(result.attempts, 3);
    assert.equal(result.body, "<h1>ok</h1>");
    assert.equal(result.elapsedMs, 1_000);
    assert.deepEqual(clock.slept, [500, 500]);
    assert.equal(calls.length, 3);
  });

  it("gives up on 401 immediately, because polling cannot fix a bad token", async () => {
    const clock = new FakeClock();
    const { impl, calls } = scriptedFetch([401]);
    await assert.rejects(waitForPreview(URL_UNDER_TEST, { fetchImpl: impl, clock }), PreviewUnauthorized);
    assert.equal(calls.length, 1, "should not have retried");
    assert.deepEqual(clock.slept, []);
  });

  it("keeps polling through 5xx and connection failures", async () => {
    const clock = new FakeClock();
    const { impl } = scriptedFetch([null, 502, 503, 200]);
    const result = await waitForPreview(URL_UNDER_TEST, { fetchImpl: impl, clock, delayMs: 10 });
    assert.equal(result.status, 200);
    assert.equal(result.attempts, 4);
  });

  it("reports what it last saw when the port never comes up", async () => {
    const clock = new FakeClock();
    const { impl, calls } = scriptedFetch([425]);
    await assert.rejects(
      waitForPreview(URL_UNDER_TEST, { fetchImpl: impl, clock, attempts: 4, delayMs: 100 }),
      (error: Error) => {
        assert.ok(error instanceof PreviewNeverCameUp);
        assert.equal(error.attempts, 4);
        assert.equal(error.lastStatus, 425);
        assert.match(error.message, /nothing was listening on the port after 4 attempts/);
        return true;
      },
    );
    assert.equal(calls.length, 4);
    // Three sleeps for four attempts: no point waiting after the last one.
    assert.deepEqual(clock.slept, [100, 100, 100]);
  });

  it("distinguishes never-answered from answered-with-an-error", async () => {
    const clock = new FakeClock();
    const { impl } = scriptedFetch([null]);
    await assert.rejects(
      waitForPreview(URL_UNDER_TEST, { fetchImpl: impl, clock, attempts: 2, delayMs: 1 }),
      /never returned a success status after 2 attempts \(last: no response\)/,
    );
  });

  it("hands a 4xx back to the caller rather than treating it as not-up-yet", async () => {
    const clock = new FakeClock();
    const { impl } = scriptedFetch([404], "Cannot GET /health");
    const result = await waitForPreview(URL_UNDER_TEST, { fetchImpl: impl, clock });
    assert.equal(result.status, 404);
    assert.equal(result.attempts, 1);
  });

  it("sends the token as a header, keeping it out of the far side's access log", async () => {
    const clock = new FakeClock();
    const { impl, calls } = scriptedFetch([200]);
    await waitForPreview(URL_UNDER_TEST, { fetchImpl: impl, clock, token: "pt_secrettoken" });
    assert.deepEqual(calls[0]?.headers, { "x-pinetree-preview-token": "pt_secrettoken" });
  });

  it("honours an abort signal", async () => {
    const clock = new FakeClock();
    const { impl } = scriptedFetch([200]);
    await assert.rejects(
      waitForPreview(URL_UNDER_TEST, { fetchImpl: impl, clock, signal: AbortSignal.abort() }),
      { name: "AbortError" },
    );
  });
});

function fakeProbe(capture: Partial<PageCapture>): BrowserProbe & { seen: unknown[] } {
  const seen: unknown[] = [];
  return {
    seen,
    async capture(url, opts) {
      seen.push({ url, opts });
      return {
        title: "",
        texts: [],
        png: new Uint8Array([137, 80, 78, 71]),
        sessionId: "sess_1",
        ...capture,
      };
    },
    async close() {},
  };
}

describe("verifyRenders", () => {
  it("passes when the rendered page contains everything expected", async () => {
    const probe = fakeProbe({ title: "Solari Cookbook", texts: ["Scraped 3 pages", "Done"] });
    const evidence = await verifyRenders(probe, URL_UNDER_TEST, ["scraped 3 pages", "Solari Cookbook"]);
    assert.equal(evidence.ok, true);
    assert.equal(evidence.reason, undefined);
    assert.deepEqual(evidence.missing, []);
    assert.equal(evidence.sessionId, "sess_1");
  });

  it("names exactly what was missing, so the report does not just say 'failed'", async () => {
    const probe = fakeProbe({ title: "Error", texts: ["500 Internal Server Error"] });
    const evidence = await verifyRenders(probe, URL_UNDER_TEST, ["Scraped", "Done"]);
    assert.equal(evidence.ok, false);
    assert.deepEqual(evidence.missing, ["Scraped", "Done"]);
    assert.equal(evidence.reason, 'page did not contain "Scraped", "Done"');
    assert.ok(evidence.png, "keeps the screenshot as evidence");
  });

  it("catches the boots-but-blank failure when there is nothing to assert on", async () => {
    // Exit code 0 and a blank page is the failure users actually hit.
    const probe = fakeProbe({ title: "", texts: ["   \n "] });
    const evidence = await verifyRenders(probe, URL_UNDER_TEST, []);
    assert.equal(evidence.ok, false);
    assert.equal(evidence.reason, "page rendered blank");
  });

  it("forwards the preview token header to the browser", async () => {
    const probe = fakeProbe({ title: "ok", texts: ["ok"] });
    await verifyRenders(probe, URL_UNDER_TEST, ["ok"], { "x-pinetree-preview-token": "pt_x" });
    assert.deepEqual(probe.seen, [
      { url: URL_UNDER_TEST, opts: { headers: { "x-pinetree-preview-token": "pt_x" } } },
    ]);
  });
});
