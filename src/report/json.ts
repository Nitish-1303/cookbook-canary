/**
 * Machine-readable output. Versioned because people build on artifacts: a
 * dashboard that graphs "examples broken over time" should be able to tell that
 * the shape changed rather than silently mis-reading it.
 */

import type { RunSummary } from "../runner.ts";
import { createRedactor } from "../util/redact.ts";

export const SCHEMA_VERSION = 1;

export interface CanaryArtifact {
  schemaVersion: number;
  generator: string;
  summary: RunSummary;
}

/**
 * Redaction runs again on the whole tree here, on purpose. Every field was
 * scrubbed on the way in; this is the belt to that braces, because this is the
 * object that gets committed to a branch or uploaded as a public artifact.
 */
export function toArtifact(summary: RunSummary, secretValues: readonly (string | undefined)[] = []): CanaryArtifact {
  const redactor = createRedactor(secretValues);
  return {
    schemaVersion: SCHEMA_VERSION,
    generator: "cookbook-canary",
    summary: redactor.deep(summary),
  };
}

export function toJson(summary: RunSummary, secretValues: readonly (string | undefined)[] = []): string {
  return `${JSON.stringify(toArtifact(summary, secretValues), null, 2)}\n`;
}
