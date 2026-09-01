/**
 * Turning a raw command result into a verdict.
 *
 * The distinction that makes this tool usable rather than annoying: a non-zero
 * exit is not automatically "your example is broken". It might be a missing
 * credential the CI job was never given, or the registry having a bad minute.
 * Reporting those as failures trains people to ignore the report, which is the
 * only real failure mode a canary has.
 */

import type { CommandResult } from "../solari/types.ts";

export const Outcome = {
  Pass: "pass",
  Fail: "fail",
  Skipped: "skipped",
  Flake: "flake",
  Timeout: "timeout",
} as const;

export type Outcome = (typeof Outcome)[keyof typeof Outcome];

export interface Verdict {
  outcome: Outcome;
  /** Short human-readable cause, safe to put in a report table. */
  reason: string;
  /** Whether re-running unchanged code could plausibly go green. */
  retryable: boolean;
}

const MISSING_CREDENTIAL =
  /(?:missing|not set|unset|undefined|required)[^\n]{0,40}(?:api[_ -]?key|token|credential|env)|SOLARI_API_KEY\b[^\n]{0,30}(?:missing|not set|required|undefined)|\b401\b[^\n]{0,20}unauthor|invalid api key|authentication failed|no credentials/i;

const INFRASTRUCTURE =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network is unreachable|TLS handshake|tunneling socket|\b50[234]\b|\b429\b|too many requests|rate limit|npm ERR! network|ERR_SOCKET_TIMEOUT|temporary failure in name resolution|could not resolve host/i;

const OUT_OF_QUOTA = /quota|plan limit|concurrent (?:vm|sandbox|session)s? limit|insufficient credit/i;

/** Reason strings are kept short and stable so report diffs stay readable. */
export function classify(result: CommandResult, verifyError?: string): Verdict {
  const haystack = `${result.stderr}\n${result.stdout}`;

  if (OUT_OF_QUOTA.test(haystack)) {
    return { outcome: Outcome.Flake, reason: "hit an account quota", retryable: true };
  }
  if (MISSING_CREDENTIAL.test(haystack)) {
    return { outcome: Outcome.Skipped, reason: "needs a credential this run does not have", retryable: false };
  }
  if (INFRASTRUCTURE.test(haystack)) {
    return { outcome: Outcome.Flake, reason: "network or upstream error", retryable: true };
  }
  if (result.exitCode !== 0) {
    return { outcome: Outcome.Fail, reason: `exited ${result.exitCode}`, retryable: false };
  }
  if (verifyError) {
    return { outcome: Outcome.Fail, reason: verifyError, retryable: false };
  }
  return { outcome: Outcome.Pass, reason: "ok", retryable: false };
}

/** Classifies a thrown error (deadline, transport failure) rather than an exit code. */
export function classifyThrown(error: unknown): Verdict {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === "DeadlineExceeded") {
    return { outcome: Outcome.Timeout, reason: "timed out", retryable: true };
  }
  if (OUT_OF_QUOTA.test(message)) {
    return { outcome: Outcome.Flake, reason: "hit an account quota", retryable: true };
  }
  if (INFRASTRUCTURE.test(message)) {
    return { outcome: Outcome.Flake, reason: "network or upstream error", retryable: true };
  }
  return { outcome: Outcome.Fail, reason: truncate(message, 120), retryable: false };
}

/** Does this run count against the build? Skips and flakes deliberately do not. */
export function isBlocking(outcome: Outcome): boolean {
  return outcome === Outcome.Fail || outcome === Outcome.Timeout;
}

export function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
