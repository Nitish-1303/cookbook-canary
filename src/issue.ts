/**
 * One tracking issue for a red canary. A scheduled run that fails opens an issue;
 * the next red run comments on that same issue instead of opening another; the
 * first green run comments and closes it. The issue is found by a label plus a
 * hidden marker in the body, so a human editing the title cannot orphan it.
 */

import type { ExampleResult, RunSummary } from "./runner.ts";

export const ISSUE_LABEL = "canary-red";
export const ISSUE_MARKER = "<!-- cookbook-canary:red -->";
const ISSUE_TITLE = "Cookbook canary is red";

export interface TrackedIssue {
  number: number;
  body: string;
}

/** The four calls this needs, so tests can use a fake and the CLI can use fetch. */
export interface IssueApi {
  findOpen(label: string): Promise<TrackedIssue[]>;
  create(input: { title: string; body: string; labels: string[] }): Promise<number>;
  comment(number: number, body: string): Promise<void>;
  close(number: number): Promise<void>;
}

export type IssueAction =
  | { kind: "created"; number: number }
  | { kind: "commented"; number: number }
  | { kind: "closed"; number: number }
  | { kind: "none" };

function failing(summary: RunSummary): ExampleResult[] {
  return summary.results.filter((r) => r.outcome === "fail" || r.outcome === "timeout");
}

export function renderIssueBody(summary: RunSummary, runUrl?: string): string {
  const rows = failing(summary).map((r) => `- \`${r.name}\` (${r.outcome}): ${r.reason}`);
  return [
    ISSUE_MARKER,
    `The canary for \`${summary.repo}\` at \`${summary.ref}\` finished ${summary.finishedAt} with ${rows.length} failing example${rows.length === 1 ? "" : "s"}:`,
    "",
    ...(rows.length > 0 ? rows : ["- the run failed before any example finished"]),
    ...(runUrl ? ["", `Run: ${runUrl}`] : []),
    "",
    "This issue is updated on each red run and closed by the first green run.",
  ].join("\n");
}

export async function syncIssue(
  summary: RunSummary,
  api: IssueApi,
  opts: { runUrl?: string } = {},
): Promise<IssueAction> {
  const open = (await api.findOpen(ISSUE_LABEL)).filter((i) => i.body.includes(ISSUE_MARKER));
  // Oldest first: if two ever exist, the earliest one stays the canonical one.
  const existing = [...open].sort((a, b) => a.number - b.number)[0];
  const body = renderIssueBody(summary, opts.runUrl);

  if (summary.exitCode !== 0) {
    if (existing) {
      await api.comment(existing.number, body);
      return { kind: "commented", number: existing.number };
    }
    const number = await api.create({ title: ISSUE_TITLE, body, labels: [ISSUE_LABEL] });
    return { kind: "created", number };
  }

  if (existing) {
    const url = opts.runUrl ? ` Run: ${opts.runUrl}` : "";
    await api.comment(existing.number, `All examples pass again as of ${summary.finishedAt}. Closing.${url}`);
    await api.close(existing.number);
    return { kind: "closed", number: existing.number };
  }
  return { kind: "none" };
}

/** GitHub REST over `fetch`, so the workflow needs no dependencies. */
export function githubIssueApi(repo: string, token: string, fetchImpl: typeof fetch = fetch): IssueApi {
  const base = `https://api.github.com/repos/${repo}`;
  const call = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path} failed: ${res.status}`);
    return res.json();
  };
  return {
    async findOpen(label) {
      const list = (await call(`/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`)) as {
        number: number;
        body: string | null;
        pull_request?: unknown;
      }[];
      return list.filter((i) => !i.pull_request).map((i) => ({ number: i.number, body: i.body ?? "" }));
    },
    async create(input) {
      const made = (await call("/issues", { method: "POST", body: JSON.stringify(input) })) as { number: number };
      return made.number;
    },
    async comment(number, body) {
      await call(`/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
    },
    async close(number) {
      await call(`/issues/${number}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
    },
  };
}
