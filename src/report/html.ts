/**
 * Standalone HTML dashboard — one file, no assets, no network. Drop it on Pages
 * or open it from a CI artifact and it works, including the failure screenshots,
 * which are inlined as data URIs.
 */

import type { ExampleResult, RunSummary } from "../runner.ts";
import { Outcome } from "../util/classify.ts";

const ORDER: Outcome[] = [Outcome.Fail, Outcome.Timeout, Outcome.Flake, Outcome.Skipped, Outcome.Pass];

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function seconds(ms: number): string {
  return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

const STYLE = `
:root {
  --bg: #ffffff; --fg: #16181d; --muted: #6b7280; --line: #e5e7eb; --card: #f9fafb;
  --pass: #15803d; --fail: #b91c1c; --warn: #b45309; --skip: #6b7280;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #262b33; --card: #151a21;
    --pass: #3fb950; --fail: #f85149; --warn: #d29922; --skip: #8b949e;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2.5rem 1.25rem; background: var(--bg); color: var(--fg);
  font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
}
main { max-width: 60rem; margin: 0 auto; }
h1 { font-size: 1.35rem; margin: 0 0 .35rem; letter-spacing: -.01em; }
.sub { color: var(--muted); font-size: .875rem; margin: 0 0 1.75rem; }
.tiles { display: flex; flex-wrap: wrap; gap: .625rem; margin-bottom: 1.75rem; }
.tile {
  border: 1px solid var(--line); border-radius: .625rem; padding: .7rem .95rem;
  background: var(--card); min-width: 7rem;
}
.tile b { display: block; font-size: 1.5rem; font-weight: 620; line-height: 1.1; }
.tile span { color: var(--muted); font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; }
table { width: 100%; border-collapse: collapse; font-size: .875rem; }
th { text-align: left; color: var(--muted); font-weight: 500; font-size: .75rem;
     text-transform: uppercase; letter-spacing: .05em; padding: .5rem .6rem; }
td { padding: .6rem; border-top: 1px solid var(--line); vertical-align: top; }
code { font: .8125rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
.dot { display: inline-block; width: .55rem; height: .55rem; border-radius: 50%; margin-right: .45rem; }
.pass { color: var(--pass); } .pass .dot { background: var(--pass); }
.fail, .timeout { color: var(--fail); } .fail .dot, .timeout .dot { background: var(--fail); }
.flake { color: var(--warn); } .flake .dot { background: var(--warn); }
.skipped { color: var(--skip); } .skipped .dot { background: var(--skip); }
pre {
  background: var(--card); border: 1px solid var(--line); border-radius: .5rem;
  padding: .7rem .85rem; overflow-x: auto; font-size: .78125rem; margin: .6rem 0 0;
}
details { margin-top: .5rem; }
summary { cursor: pointer; color: var(--muted); font-size: .8125rem; }
img { max-width: 100%; border: 1px solid var(--line); border-radius: .5rem; margin-top: .6rem; }
footer { margin-top: 2.5rem; color: var(--muted); font-size: .78125rem; }
`;

function evidence(result: ExampleResult): string {
  const parts: string[] = [];
  const stderr = result.run?.stderrTail?.trim();
  const stdout = result.run?.stdoutTail?.trim();
  const install = result.install && result.install.exitCode !== 0 ? result.install.stderrTail.trim() : "";
  if (install) parts.push(`<pre>${escapeHtml(install)}</pre>`);
  if (stderr) parts.push(`<pre>${escapeHtml(stderr)}</pre>`);
  else if (stdout) parts.push(`<pre>${escapeHtml(stdout)}</pre>`);
  if (result.visual?.screenshotBase64) {
    const subject = result.machineKind === "desktop" ? "desktop screen" : "rendered page";
    parts.push(`<img alt="${subject} for ${escapeHtml(result.name)}" src="data:image/png;base64,${result.visual.screenshotBase64}">`);
  }
  if (parts.length === 0) return "";
  return `<details><summary>evidence</summary>${parts.join("")}</details>`;
}

export function renderHtml(summary: RunSummary): string {
  const repoName = summary.repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const sorted = [...summary.results].sort(
    (a, b) => ORDER.indexOf(a.outcome) - ORDER.indexOf(b.outcome) || a.name.localeCompare(b.name),
  );

  const tiles = ORDER.filter((outcome) => summary.totals[outcome] > 0)
    .map((outcome) => `<div class="tile ${outcome}"><b>${summary.totals[outcome]}</b><span>${outcome}</span></div>`)
    .join("");

  const rows = sorted
    .map(
      (result) => `<tr>
      <td class="${result.outcome}"><span class="dot"></span>${result.outcome}</td>
      <td><code>${escapeHtml(result.name)}</code><br><span style="color:var(--muted);font-size:.78125rem">${escapeHtml(result.reason)}</span>${evidence(result)}</td>
      <td>${escapeHtml(result.runtime)} · ${escapeHtml(result.machineKind)}</td>
      <td>${seconds(result.durationMs)}</td>
    </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cookbook canary — ${escapeHtml(repoName)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>${escapeHtml(repoName)}</h1>
  <p class="sub">
    <code>${escapeHtml(summary.ref)}</code>${summary.prep.headSha ? ` at <code>${escapeHtml(summary.prep.headSha)}</code>` : ""}
    · ${seconds(summary.durationMs)} wall clock
    · ${summary.machineMinutes} machine-minutes
    · ${escapeHtml(summary.finishedAt)}
  </p>
  <div class="tiles">${tiles}</div>
  <table>
    <thead><tr><th>result</th><th>example</th><th>ran on</th><th>time</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <footer>
    Every example ran alone on its own hardware-isolated microVM, forked from a single
    prepared snapshot. Dependency installs happened once (${seconds(summary.prep.installMs)}),
    not once per example. Credentials reached the run step only and are scrubbed from this page.
  </footer>
</main>
</body>
</html>
`;
}
