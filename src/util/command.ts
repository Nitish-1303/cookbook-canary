/**
 * Sandbox `run` does not go through a shell: `run("ls -la")` looks for a
 * binary literally named "ls -la". Arguments belong in `args`. So every command
 * Canary reads from config or infers from a manifest gets tokenized here.
 *
 * This is deliberately not a shell. Pipes, redirects, globs, and `&&` are
 * rejected rather than silently mangled — if an example needs them, the config
 * should say `sh -c "..."` explicitly and mean it.
 */

export interface ParsedCommand {
  cmd: string;
  args: string[];
}

const SHELL_METACHARACTERS = /[|&;<>$`(){}*]/;

export class CommandParseError extends Error {
  readonly input: string;
  constructor(message: string, input: string) {
    super(message);
    this.name = "CommandParseError";
    this.input = input;
  }
}

/**
 * Splits on unquoted whitespace, honouring single and double quotes and
 * backslash escapes. Returns argv, not a string, because that is what the
 * machine API takes.
 */
export function parseCommand(input: string, options: { allowShell?: boolean } = {}): ParsedCommand {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new CommandParseError("empty command", input);

  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | undefined;
  // Characters seen outside quotes and escapes. `python -c "print(1)"` is a
  // legitimate argv; a bare `print(1)` is someone expecting a shell.
  let unquoted = "";

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i] as string;

    if (ch === "\\" && quote !== "'" && i + 1 < trimmed.length) {
      current += trimmed[++i];
      started = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    unquoted += ch;
    started = true;
  }

  if (quote) throw new CommandParseError(`unbalanced ${quote} quote`, input);
  if (started) tokens.push(current);
  if (tokens.length === 0) throw new CommandParseError("empty command", input);

  const isExplicitShell = tokens[0] === "sh" || tokens[0] === "bash";
  if (!options.allowShell && !isExplicitShell && SHELL_METACHARACTERS.test(unquoted)) {
    throw new CommandParseError(
      "shell syntax is not interpreted by the sandbox; wrap it in `sh -c \"...\"` if you meant it",
      input,
    );
  }

  return { cmd: tokens[0] as string, args: tokens.slice(1) };
}

/** Renders argv back to a readable single line, for logs and reports. */
export function formatCommand(parsed: ParsedCommand): string {
  return [parsed.cmd, ...parsed.args]
    .map((token) => (/\s/.test(token) ? JSON.stringify(token) : token))
    .join(" ");
}

/**
 * POSIX single-quote quoting, for the one place a shell is unavoidable: desktop
 * VMs expose `exec(cmd, {args, cwd})` with no `env` field, so env vars get
 * emulated with `sh -lc` — and `cwd` rides along the same path to keep one code
 * path instead of two. Everything interpolated goes through here.
 */
export function shellQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}
