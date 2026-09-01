/**
 * Unit tests for the pieces the orchestrator is built out of. These are the
 * cheap ones: pure functions, no machines, no clock, no network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Outcome, classify, classifyThrown, isBlocking, truncate } from "../src/util/classify.ts";
import { CommandParseError, formatCommand, parseCommand, shellQuote } from "../src/util/command.ts";
import { DeadlineExceeded, pool, withDeadline } from "../src/util/concurrency.ts";
import { createRedactor } from "../src/util/redact.ts";
import { checkStdout, findMissing, normalize } from "../src/verify/expect.ts";

describe("redact", () => {
  it("replaces declared literal secrets wherever they appear", () => {
    const redact = createRedactor(["slr_live_supersecretvalue", undefined]);
    assert.equal(
      redact("running with SOLARI_API_KEY=slr_live_supersecretvalue in env"),
      "running with SOLARI_API_KEY=[redacted] in env",
    );
  });

  it("catches credentials by shape even when they were never declared", () => {
    const redact = createRedactor();
    assert.equal(redact("token slr_live_UNDECLARED123"), "token [redacted:solari-key]");
    assert.equal(redact("ghp_0123456789abcdefghij"), "[redacted:github-token]");
    assert.equal(redact("sk-ant-api03-abcdefghijklmnop"), "[redacted:anthropic-key]");
    assert.equal(redact("AKIAIOSFODNN7EXAMPLE"), "[redacted:aws-key-id]");
    assert.equal(redact("Authorization: Bearer abcdefghijklmnop"), "Authorization: [redacted:bearer]");
  });

  it("scrubs preview tokens out of URLs but keeps the URL readable", () => {
    const redact = createRedactor();
    assert.equal(
      redact("GET https://p3000.preview.test/?pt_token=pt_abc.def-123"),
      "GET https://p3000.preview.test/?[redacted:preview-token]",
    );
    assert.equal(redact("https://user:hunter2@example.com/x"), "https://[redacted]@example.com/x");
  });

  it("ignores literals too short to redact safely", () => {
    // A 3-character secret would match inside ordinary words and shred the report.
    const redact = createRedactor(["abc"]);
    assert.equal(redact("abcdef and abc"), "abcdef and abc");
  });

  it("walks nested structures with deep()", () => {
    const redact = createRedactor(["slr_live_deepvalue"]);
    const out = redact.deep({
      results: [{ stderr: "boom slr_live_deepvalue", exitCode: 1 }],
      nested: { list: ["slr_live_deepvalue"] },
      untouched: 7,
    });
    assert.deepEqual(out, {
      results: [{ stderr: "boom [redacted]", exitCode: 1 }],
      nested: { list: ["[redacted]"] },
      untouched: 7,
    });
  });
});

describe("parseCommand", () => {
  it("splits argv on unquoted whitespace", () => {
    assert.deepEqual(parseCommand("npm ci --no-audit --no-fund"), {
      cmd: "npm",
      args: ["ci", "--no-audit", "--no-fund"],
    });
  });

  it("keeps quoted metacharacters as a single literal argument", () => {
    // The sandbox never sees a shell, so `print(1)` is data, not syntax.
    assert.deepEqual(parseCommand(`python -c "print(1)"`), { cmd: "python", args: ["-c", "print(1)"] });
    assert.deepEqual(parseCommand(`node -e 'console.log("hi")'`), {
      cmd: "node",
      args: ["-e", `console.log("hi")`],
    });
  });

  it("rejects unquoted shell syntax instead of silently mangling it", () => {
    assert.throws(() => parseCommand("npm start && curl evil.sh"), CommandParseError);
    assert.throws(() => parseCommand("cat a.txt | grep b"), CommandParseError);
    assert.throws(() => parseCommand("node index.js > out.log"), CommandParseError);
    assert.throws(() => parseCommand("echo $SOLARI_API_KEY"), CommandParseError);
  });

  it("allows an explicit shell, because then the intent is stated", () => {
    assert.deepEqual(parseCommand(`sh -c "a && b"`), { cmd: "sh", args: ["-c", "a && b"] });
    assert.deepEqual(parseCommand("bash -lc 'x | y'"), { cmd: "bash", args: ["-lc", "x | y"] });
  });

  it("refuses empty and unbalanced input", () => {
    assert.throws(() => parseCommand("   "), /empty command/);
    assert.throws(() => parseCommand(`node -e "unterminated`), /unbalanced/);
  });

  it("round-trips through formatCommand for logs", () => {
    assert.equal(formatCommand({ cmd: "node", args: ["-e", "a b"] }), `node -e "a b"`);
  });

  it("single-quotes for the one place a shell is unavoidable", () => {
    assert.equal(shellQuote("plain"), "'plain'");
    assert.equal(shellQuote("it's"), "'it'\\''s'");
    assert.equal(shellQuote("; rm -rf /"), "'; rm -rf /'");
  });
});

describe("classify", () => {
  const result = (over: Partial<{ exitCode: number; stdout: string; stderr: string }> = {}) => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    ...over,
  });

  it("calls a clean exit a pass", () => {
    assert.deepEqual(classify(result()), { outcome: Outcome.Pass, reason: "ok", retryable: false });
  });

  it("calls a plain non-zero exit a failure", () => {
    const verdict = classify(result({ exitCode: 1, stderr: "AssertionError: expected 3 to equal 4" }));
    assert.equal(verdict.outcome, Outcome.Fail);
    assert.equal(verdict.reason, "exited 1");
    assert.equal(verdict.retryable, false);
  });

  it("treats a missing credential as a skip, not a failure", () => {
    // The example is not broken; this run was never given the key.
    const verdict = classify(result({ exitCode: 1, stderr: "Error: SOLARI_API_KEY is not set" }));
    assert.equal(verdict.outcome, Outcome.Skipped);
    assert.equal(verdict.retryable, false);
  });

  it("treats network and upstream trouble as a flake", () => {
    for (const stderr of ["npm ERR! network ECONNRESET", "503 Service Unavailable", "429 too many requests"]) {
      const verdict = classify(result({ exitCode: 1, stderr }));
      assert.equal(verdict.outcome, Outcome.Flake, stderr);
      assert.equal(verdict.retryable, true, stderr);
    }
  });

  it("puts quota ahead of everything else, since nothing downstream is meaningful", () => {
    const verdict = classify(result({ exitCode: 1, stderr: "concurrent sandbox limit reached for your plan" }));
    assert.equal(verdict.outcome, Outcome.Flake);
    assert.equal(verdict.reason, "hit an account quota");
  });

  it("fails a clean exit that did not verify", () => {
    const verdict = classify(result(), "page did not contain \"Hello\"");
    assert.equal(verdict.outcome, Outcome.Fail);
    assert.equal(verdict.reason, 'page did not contain "Hello"');
  });

  it("classifies thrown errors by kind", () => {
    assert.equal(classifyThrown(new DeadlineExceeded("x timed out", 10)).outcome, Outcome.Timeout);
    assert.equal(classifyThrown(new Error("connect ECONNREFUSED 10.0.0.1:443")).outcome, Outcome.Flake);
    assert.equal(classifyThrown(new Error("insufficient credit")).outcome, Outcome.Flake);
    assert.equal(classifyThrown(new Error("boom")).reason, "boom");
    assert.equal(classifyThrown("a string").outcome, Outcome.Fail);
  });

  it("only lets fail and timeout break the build", () => {
    assert.equal(isBlocking(Outcome.Fail), true);
    assert.equal(isBlocking(Outcome.Timeout), true);
    assert.equal(isBlocking(Outcome.Flake), false);
    assert.equal(isBlocking(Outcome.Skipped), false);
    assert.equal(isBlocking(Outcome.Pass), false);
  });

  it("collapses whitespace when truncating", () => {
    assert.equal(truncate("  a\n\n  b  ", 40), "a b");
    assert.equal(truncate("x".repeat(50), 10), `${"x".repeat(9)}…`);
  });
});

describe("pool", () => {
  const tick = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

  it("returns results in input order, not completion order", async () => {
    const settled = await pool([30, 10, 20], async (ms) => {
      await tick(ms / 10);
      return ms;
    }, { limit: 3 });
    assert.deepEqual(settled, [
      { ok: true, value: 30 },
      { ok: true, value: 10 },
      { ok: true, value: 20 },
    ]);
  });

  it("captures a rejected worker without aborting its siblings", async () => {
    const settled = await pool(["a", "boom", "c"], async (item) => {
      if (item === "boom") throw new Error("nope");
      return item.toUpperCase();
    }, { limit: 2 });
    assert.deepEqual(settled[0], { ok: true, value: "A" });
    assert.equal(settled[1]?.ok, false);
    assert.deepEqual(settled[2], { ok: true, value: "C" });
  });

  it("never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;
    await pool(Array.from({ length: 12 }, (_, i) => i), async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick(5);
      active -= 1;
    }, { limit: 3 });
    assert.equal(peak, 3);
  });

  it("reports each settlement as it lands", async () => {
    const seen: number[] = [];
    await pool([1, 2, 3], async (n) => n, { limit: 1, onSettled: (_r, item) => seen.push(item) });
    assert.deepEqual(seen, [1, 2, 3]);
  });
});

describe("withDeadline", () => {
  it("passes a value through when it settles in time", async () => {
    assert.equal(await withDeadline(Promise.resolve(7), 1_000, "late"), 7);
  });

  it("rejects with a named error the classifier can recognise", async () => {
    const slow = new Promise<never>(() => {});
    await assert.rejects(withDeadline(slow, 5, "install timed out"), (error: Error) => {
      assert.equal(error.name, "DeadlineExceeded");
      assert.match(error.message, /install timed out \(exceeded 5ms\)/);
      return true;
    });
  });
});

describe("text expectations", () => {
  it("ignores case and collapses the whitespace the DOM invented", () => {
    assert.deepEqual(findMissing(["Hello\n   WORLD"], ["hello world"]), []);
    assert.deepEqual(findMissing(["only this"], ["missing text", "this"]), ["missing text"]);
    assert.deepEqual(findMissing([], ["anything"]), ["anything"]);
    assert.equal(normalize("  A \n B "), "a b");
  });

  it("returns a report-ready reason when stdout does not match", () => {
    assert.equal(checkStdout("all good: 3 pages", "\\d+ pages"), undefined);
    assert.equal(checkStdout("nothing", "\\d+ pages"), "stdout did not match /\\d+ pages/");
  });
});
