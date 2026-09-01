/**
 * The markdown report — the artifact a human actually reads, in a PR comment or
 * a job summary.
 *
 * Two rules shape it. Failures come first, because nobody scrolls past thirty
 * green rows to find the one red one. And every failure carries its stderr tail
 * inline, because a report that only says "example X failed" makes the reader do
 * the run again themselves.
 */

import { Outcome } from "../util/classify.ts";
import type { ExampleResult, RunSummary } from "../runner.ts";

const GLYPH: Record<Outcome, string> = {
  pass: "✅",
  fail: "❌",
  skipped: "⏭️",
  flake: "⚠️",
  timeout: "⏱️",
};

const ORDER: Outcome[] = [Outcome.Fail, Outcome.Timeout, Outcome.Flake, Outcome.Skipped, Outcome.Pass];

function seconds(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

function headline(summary: RunSummary): string {
  const { totals } = summary;
  const broken = totals.fail + totals.timeout;
  if (broken === 0 && totals.pass > 0) {
    const one = totals.pass === 1;
    return `**All ${totals.pass} runnable example${one ? "" : "s"} still work${one ? "s" : ""}.**`;
  }
  if (broken === 0) return "**Nothing was run.**";
  return `**${broken} example${broken === 1 ? " is" : "s are"} broken.**`;
}

function detailBlock(result: ExampleResult): string {
  const lines: string[] = [];
  lines.push(`<details><summary><code>${result.name}</code> — ${result.reason}</summary>`, "");
  lines.push(`- machine: \`${result.machineId ?? "none"}\` (${result.machineKind})`);
  if (result.attempts > 1) lines.push(`- attempts: ${result.attempts}`);
  if (result.preview) lines.push(`- preview answered \`${result.preview.status}\` after ${result.preview.attempts} poll(s)`);
  if (result.visual?.missing.length) lines.push(`- page was missing: ${result.visual.missing.map((m) => `\`${m}\``).join(", ")}`);
  if (result.visual?.replayUrl) lines.push(`- [session replay](${result.visual.replayUrl})`);
  if (result.streamUrl) lines.push(`- [live desktop stream](${result.streamUrl})`);

  const stderr = result.run?.stderrTail?.trim();
  const stdout = result.run?.stdoutTail?.trim();
  const install = result.install?.exitCode !== 0 ? result.install?.stderrTail?.trim() : undefined;
  if (install) lines.push("", "Install output:", "```", install, "```");
  if (stderr) lines.push("", "stderr:", "```", stderr, "```");
  else if (stdout) lines.push("", "stdout:", "```", stdout, "```");

  if (result.visual?.screenshotBase64) {
    // A desktop example gets a picture of a screen, not of a page.
    const subject = result.machineKind === "desktop" ? "screen" : "page";
    lines.push("", `![what the ${subject} looked like](data:image/png;base64,${result.visual.screenshotBase64})`);
  }
  lines.push("", "</details>");
  return lines.join("\n");
}

export function renderMarkdown(summary: RunSummary): string {
  const out: string[] = [];
  const repoName = summary.repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");

  out.push(`## Cookbook canary — ${repoName}`, "");
  out.push(headline(summary), "");
  out.push(
    `\`${summary.ref}\`${summary.prep.headSha ? ` at \`${summary.prep.headSha}\`` : ""} · ` +
      `${seconds(summary.durationMs)} wall clock · ${summary.machineMinutes} machine-minutes`,
    "",
  );

  const counts = ORDER.filter((outcome) => summary.totals[outcome] > 0)
    .map((outcome) => `${GLYPH[outcome]} ${summary.totals[outcome]} ${outcome}`)
    .join(" · ");
  if (counts) out.push(counts, "");

  out.push("| | example | result | time |", "| --- | --- | --- | --- |");
  const sorted = [...summary.results].sort(
    (a, b) => ORDER.indexOf(a.outcome) - ORDER.indexOf(b.outcome) || a.name.localeCompare(b.name),
  );
  for (const result of sorted) {
    out.push(
      `| ${GLYPH[result.outcome]} | \`${result.name}\` | ${result.reason} | ${seconds(result.durationMs)} |`,
    );
  }
  out.push("");

  const interesting = sorted.filter(
    (result) => result.outcome === Outcome.Fail || result.outcome === Outcome.Timeout,
  );
  if (interesting.length > 0) {
    out.push("### What broke", "");
    for (const result of interesting) out.push(detailBlock(result), "");
  }

  out.push(
    "<sub>",
    `Each example ran alone on its own microVM, forked from one prepared snapshot ` +
      `(${seconds(summary.prep.installMs)} of installs done once instead of ${summary.results.length} ` +
      `time${summary.results.length === 1 ? "" : "s"}). ` +
      `Credentials were passed to the run step only and scrubbed from this report.`,
    "</sub>",
  );
  return out.join("\n");
}
