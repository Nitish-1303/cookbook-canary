/**
 * Canary's whole output is meant to be published — a markdown report in a PR
 * comment, an HTML dashboard on Pages, JSON in an artifact. It also has to
 * hand real credentials to the examples it runs, because Solari examples call
 * Solari. Those two facts together mean every string that leaves this process
 * goes through here first.
 *
 * Patterns are matched by shape, not by knowing the values, so a credential
 * the config never declared still gets caught.
 */

interface Pattern {
  label: string;
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  { label: "solari-key", re: /slr_live_[A-Za-z0-9_-]{4,}/g },
  { label: "solari-key", re: /slr_test_[A-Za-z0-9_-]{4,}/g },
  { label: "preview-token", re: /pt_token=[A-Za-z0-9._~-]+/g },
  { label: "github-token", re: /gh[pousr]_[A-Za-z0-9]{16,}/g },
  { label: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { label: "openai-key", re: /sk-(?:proj-)?[A-Za-z0-9]{32,}/g },
  { label: "aws-key-id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g },
  { label: "preview-header", re: /\bx-pinetree-preview-token:\s*\S+/gi },
  { label: "url-credentials", re: /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g },
];

const MIN_LITERAL_LENGTH = 6;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface Redactor {
  (input: string): string;
  deep<T>(value: T): T;
}

/**
 * @param literals Known secret values (e.g. `process.env.SOLARI_API_KEY`).
 *   Short ones are ignored: redacting a 3-character value would shred
 *   unrelated text and make reports unreadable.
 */
export function createRedactor(literals: readonly (string | undefined)[] = []): Redactor {
  const escaped = literals
    .filter((value): value is string => typeof value === "string" && value.length >= MIN_LITERAL_LENGTH)
    .map(escapeRegExp);

  const literalRe = escaped.length > 0 ? new RegExp(escaped.join("|"), "g") : undefined;

  const redact = ((input: string): string => {
    if (typeof input !== "string" || input.length === 0) return input;
    let out = input;
    if (literalRe) out = out.replace(literalRe, "[redacted]");
    for (const { label, re } of PATTERNS) {
      out = out.replace(re, (match) =>
        label === "url-credentials" ? `${match.split("//")[0]}//[redacted]@` : `[redacted:${label}]`,
      );
    }
    return out;
  }) as Redactor;

  redact.deep = <T,>(value: T): T => {
    if (typeof value === "string") return redact(value) as unknown as T;
    if (Array.isArray(value)) return value.map((item) => redact.deep(item)) as unknown as T;
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) out[key] = redact.deep(item);
      return out as T;
    }
    return value;
  };

  return redact;
}

/** Redactor with no declared literals — shape-based patterns only. */
export const redact = createRedactor();
