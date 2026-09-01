/**
 * Waiting for a server inside a machine to actually answer.
 *
 * The two status codes that matter here are documented Solari behaviours and
 * mean opposite things:
 *
 *   425 Too Early — the request reached the machine but nothing is listening
 *                   on that port yet. Keep polling; this is the normal state
 *                   for the first second or two of an example's life.
 *   401           — the signed token is missing, tampered with, or past its
 *                   hour. Polling will never fix it; get a fresh preview URL.
 *
 * Treating 401 as retryable is how you turn a config mistake into a two-minute
 * hang, so it is fatal here.
 */

import type { Clock } from "../solari/types.ts";
import { systemClock } from "../solari/types.ts";

export interface PreviewOptions {
  token?: string;
  attempts?: number;
  delayMs?: number;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  signal?: AbortSignal;
}

export interface PreviewResult {
  status: number;
  attempts: number;
  elapsedMs: number;
  body: string;
}

export class PreviewUnauthorized extends Error {
  constructor() {
    super("preview URL rejected with 401 — token missing, tampered with, or expired; request a new one");
    this.name = "PreviewUnauthorized";
  }
}

export class PreviewNeverCameUp extends Error {
  readonly attempts: number;
  readonly lastStatus: number | undefined;
  constructor(attempts: number, lastStatus: number | undefined) {
    super(
      lastStatus === 425
        ? `nothing was listening on the port after ${attempts} attempts`
        : `preview never returned a success status after ${attempts} attempts (last: ${lastStatus ?? "no response"})`,
    );
    this.name = "PreviewNeverCameUp";
    this.attempts = attempts;
    this.lastStatus = lastStatus;
  }
}

/**
 * Polls until the preview answers with a non-5xx, non-425 status.
 *
 * The token goes in a header rather than the query string so it stays out of
 * server access logs on the other side.
 */
export async function waitForPreview(url: string, options: PreviewOptions = {}): Promise<PreviewResult> {
  const attempts = options.attempts ?? 30;
  const delayMs = options.delayMs ?? 1_000;
  const clock = options.clock ?? systemClock;
  const doFetch = options.fetchImpl ?? fetch;
  const started = clock.now();

  const headers: Record<string, string> = {};
  if (options.token) headers["x-pinetree-preview-token"] = options.token;

  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    options.signal?.throwIfAborted();
    let status: number | undefined;
    let body = "";
    try {
      const response = await doFetch(url, { headers, redirect: "follow", signal: options.signal });
      status = response.status;
      body = await response.text().catch(() => "");
    } catch {
      // Connection-level failure while the machine is still coming up reads the
      // same as 425 for our purposes: wait and try again.
    }
    lastStatus = status ?? lastStatus;

    if (status === 401) throw new PreviewUnauthorized();
    if (status !== undefined && status < 500 && status !== 425) {
      return { status, attempts: attempt, elapsedMs: clock.now() - started, body };
    }
    if (attempt < attempts) await clock.sleep(delayMs);
  }

  throw new PreviewNeverCameUp(attempts, lastStatus);
}
