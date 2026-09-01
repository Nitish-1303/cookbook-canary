/** Text expectations, shared by stdout and rendered-page verification. */

/**
 * Returns the needles that are absent from every haystack.
 *
 * Case-insensitive and whitespace-collapsed: rendered page text arrives with
 * whatever newlines and indentation the markup happened to have, and an
 * expectation of `"Hello world"` should not fail because the DOM said
 * `"Hello\n  world"`.
 */
export function findMissing(haystacks: readonly string[], needles: readonly string[]): string[] {
  const normalized = haystacks.map(normalize);
  return needles.filter((needle) => {
    const target = normalize(needle);
    return target.length > 0 && !normalized.some((hay) => hay.includes(target));
  });
}

export function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** `undefined` means "matched"; a string is the report-ready failure reason. */
export function checkStdout(stdout: string, pattern: string): string | undefined {
  const re = new RegExp(pattern);
  return re.test(stdout) ? undefined : `stdout did not match /${pattern}/`;
}
