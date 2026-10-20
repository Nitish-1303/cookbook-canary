/** Reads canary-out/report.json and syncs the tracking issue. Run by the scheduled workflow. */

import { readFile } from "node:fs/promises";

import { githubIssueApi, syncIssue } from "./issue.ts";
import type { CanaryArtifact } from "./report/json.ts";

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!repo || !token) {
  console.error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");
  process.exit(2);
}

const file = process.argv[2] ?? "canary-out/report.json";
const artifact = JSON.parse(await readFile(file, "utf8")) as CanaryArtifact;
const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
const runUrl = process.env.GITHUB_RUN_ID ? `${server}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;

const action = await syncIssue(artifact.summary, githubIssueApi(repo, token), runUrl ? { runUrl } : {});
console.log(action.kind === "none" ? "canary green, no open issue" : `${action.kind} issue #${action.number}`);
