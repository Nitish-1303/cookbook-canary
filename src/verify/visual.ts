/**
 * Confirming that an example which serves a page actually serves a *working*
 * page.
 *
 * Exit code 0 proves a process started. It does not prove the server rendered
 * anything, and "the demo boots but the page is blank" is the failure mode
 * users actually hit. So Canary drives a real cloud browser at the preview URL
 * and asserts on what the DOM says, then keeps the screenshot for the report —
 * a picture of the broken page saves the maintainer a reproduction.
 */

import type { BrowserProbe } from "../solari/types.ts";
import { findMissing } from "./expect.ts";

export interface VisualEvidence {
  ok: boolean;
  title: string;
  missing: string[];
  png: Uint8Array | undefined;
  sessionId: string | undefined;
  replayUrl: string | undefined;
  reason: string | undefined;
}

export async function verifyRenders(
  probe: BrowserProbe,
  url: string,
  expectText: readonly string[],
  headers?: Record<string, string>,
): Promise<VisualEvidence> {
  const capture = await probe.capture(url, headers ? { headers } : undefined);
  const haystacks = [capture.title, ...capture.texts];
  const missing = findMissing(haystacks, expectText);

  const blank = capture.texts.every((text) => text.trim().length === 0);
  const reason =
    missing.length > 0
      ? `page did not contain ${missing.map((m) => JSON.stringify(m)).join(", ")}`
      : blank && expectText.length === 0
        ? "page rendered blank"
        : undefined;

  return {
    ok: reason === undefined,
    title: capture.title,
    missing,
    png: capture.png,
    sessionId: capture.sessionId,
    replayUrl: capture.replayUrl,
    reason,
  };
}
