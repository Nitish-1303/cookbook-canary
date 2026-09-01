/**
 * Bounded fan-out. Canary runs one machine per example, so the limit here is
 * what keeps a 40-example repo from slamming into the plan's running-VM quota.
 *
 * Results come back in input order regardless of completion order, and a
 * rejected worker is captured rather than aborting its siblings — one broken
 * example must not cost you the report for the other thirty-nine.
 */

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface PoolOptions<T, R> {
  limit: number;
  onSettled?: (result: Settled<R>, item: T, index: number) => void;
}

export async function pool<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  options: PoolOptions<T, R>,
): Promise<Settled<R>[]> {
  const limit = Math.max(1, Math.floor(options.limit));
  const results = new Array<Settled<R>>(items.length);
  let next = 0;

  const drain = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index] as T;
      let settled: Settled<R>;
      try {
        settled = { ok: true, value: await worker(item, index) };
      } catch (error) {
        settled = { ok: false, error };
      }
      results[index] = settled;
      options.onSettled?.(settled, item, index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, drain));
  return results;
}

/** Rejects with `message` if `promise` has not settled within `ms`. */
export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineExceeded(message, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class DeadlineExceeded extends Error {
  readonly ms: number;
  constructor(message: string, ms: number) {
    super(`${message} (exceeded ${ms}ms)`);
    this.name = "DeadlineExceeded";
    this.ms = ms;
  }
}
