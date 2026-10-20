/**
 * Standalone HTML dashboard — one file, no assets, no network. Drop it on Pages
 * or open it from a CI artifact and it works, including the failure screenshots,
 * which are inlined as data URIs.
 *
 * The visual language matches the landing page: warm paper, near-black ink, a
 * flat mustard accent, hard rules, square edges. Fonts stay on system stacks so
 * the file never reaches for the network; code and log output sit on a black
 * terminal band, the only dark surface on the light page.
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
  --paper: #FAF7F2; --ink: #17140F; --ink-soft: #4A453C; --muted: #7A7264;
  --mustard: #E9B83A; --line: #17140F; --band: #14110C; --band-ink: #EDE6D8;
  --pass: #1E6B34; --fail: #B3261E; --warn: #8A5A00; --skip: #7A7264;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #14110C; --ink: #EDE6D8; --ink-soft: #C9C1B0; --muted: #8C8574;
    --mustard: #E9B83A; --line: #EDE6D8; --band: #0B0906; --band-ink: #EDE6D8;
    --pass: #5FA86F; --fail: #E0705C; --warn: #E9B83A; --skip: #8C8574;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0 0 3rem; background: var(--paper); color: var(--ink);
  font: 15px/1.55 "Archivo", "Helvetica Neue", Arial, ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
}
.topline { border-bottom: 2px solid var(--line); padding: .9rem 1.25rem; font-size: .8rem;
  font-weight: 700; text-transform: uppercase; letter-spacing: .12em; }
.topline .swatch { display: inline-block; width: .7rem; height: .7rem; background: var(--mustard); margin-right: .55rem; }
main { max-width: 62rem; margin: 0 auto; padding: 2.5rem 1.25rem 0; }
h1 { font-size: clamp(1.8rem, 4vw, 2.6rem); margin: 0 0 .5rem; letter-spacing: -.03em; font-weight: 900; line-height: 1.05; }
.sub { color: var(--muted); font-size: .875rem; margin: 0 0 1.25rem; }
.verdict { font-size: clamp(1.2rem, 2.6vw, 1.7rem); font-weight: 800; letter-spacing: -.015em; margin: 0 0 1.75rem; }
.verdict mark { background: var(--mustard); color: #17140F; padding: 0 .18em; }
.tiles { display: flex; flex-wrap: wrap; margin-bottom: 2rem; border: 2px solid var(--line); }
.tile {
  flex: 1 0 6.5rem; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line);
  margin: 0 -1px -1px 0; padding: .8rem 1.1rem; background: var(--paper);
}
.tile.fail, .tile.timeout { background: var(--mustard); }
.tile.fail span, .tile.timeout span { color: #17140F; }
.tile b { display: block; font-size: 1.9rem; font-weight: 900; line-height: 1.05; letter-spacing: -.02em; }
.tile span { color: var(--muted); font-size: .72rem; text-transform: uppercase; letter-spacing: .1em; font-weight: 700; }
table { width: 100%; border-collapse: collapse; font-size: .875rem; border-top: 2px solid var(--line); }
th { text-align: left; color: var(--muted); font-weight: 700; font-size: .72rem;
     text-transform: uppercase; letter-spacing: .1em; padding: .6rem .6rem .5rem; border-bottom: 1px solid var(--line); }
td { padding: .65rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
code { font: .8125rem/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dot { display: inline-block; width: .55rem; height: .55rem; margin-right: .45rem; }
.pass { color: var(--pass); } .pass .dot { background: var(--pass); }
.fail, .timeout { color: var(--fail); } .fail .dot, .timeout .dot { background: var(--fail); }
.flake { color: var(--warn); } .flake .dot { background: var(--warn); }
.skipped { color: var(--skip); } .skipped .dot { background: var(--skip); }
pre {
  background: var(--band); color: var(--band-ink); border: 1px solid var(--line);
  padding: .75rem .9rem; overflow-x: auto; font-size: .78125rem; margin: .6rem 0 0;
}
details { margin-top: .5rem; }
summary { cursor: pointer; color: var(--muted); font-size: .8125rem; font-weight: 600; }
summary:hover { color: var(--ink); background: var(--mustard); width: fit-content; }
img { max-width: 100%; border: 1px solid var(--line); margin-top: .6rem; }
footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 2px solid var(--line); color: var(--muted); font-size: .78125rem; }
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

function verdict(summary: RunSummary): string {
  const { totals } = summary;
  const broken = totals.fail + totals.timeout;
  if (broken === 0 && totals.pass > 0) {
    const one = totals.pass === 1;
    return `<mark>All ${totals.pass} runnable example${one ? "" : "s"} still work${one ? "s" : ""}.</mark>`;
  }
  if (broken === 0) return "<mark>Nothing was run.</mark>";
  return `<mark>${broken} example${broken === 1 ? " is" : "s are"} broken.</mark>`;
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
<div class="topline"><span class="swatch"></span>cookbook-canary · report</div>
<main>
  <h1>${escapeHtml(repoName)}</h1>
  <p class="sub">
    <code>${escapeHtml(summary.ref)}</code>${summary.prep.headSha ? ` at <code>${escapeHtml(summary.prep.headSha)}</code>` : ""}
    · ${seconds(summary.durationMs)} wall clock
    · ${summary.machineMinutes} machine-minutes
    · ${escapeHtml(summary.finishedAt)}
  </p>
  <p class="verdict">${verdict(summary)}</p>
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
