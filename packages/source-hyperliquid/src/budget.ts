import { sleep } from './backoff.js';

export type RateBudgetOptions = {
  /** Request weight allowed per minute. Hyperliquid allows 1200 per IP; share it between processes. */
  weightPerMinute: number;
  now?: () => number;
};

/**
 * Token bucket over request weight. `acquire(w)` waits until `w` units are available and takes them;
 * `charge(w)` takes units without waiting (used for the per-item surcharge known only after a response),
 * which can push the bucket negative so the next acquire waits longer.
 */
export class RateBudget {
  private tokens: number;
  private lastRefill: number;
  private readonly perMs: number;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly used: Array<{ ts: number; weight: number }> = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: RateBudgetOptions) {
    this.capacity = opts.weightPerMinute;
    this.perMs = opts.weightPerMinute / 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  private refill(): void {
    const t = this.now();
    const dt = Math.max(0, t - this.lastRefill);
    this.lastRefill = t;
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.perMs);
  }

  private record(weight: number): void {
    const t = this.now();
    this.used.push({ ts: t, weight });
    while (this.used.length && this.used[0]!.ts < t - 60_000) this.used.shift();
  }

  /** Weight taken in the last 60 seconds. */
  usedLastMinute(): number {
    const t = this.now();
    while (this.used.length && this.used[0]!.ts < t - 60_000) this.used.shift();
    return this.used.reduce((a, u) => a + u.weight, 0);
  }

  /** Milliseconds until `weight` units are available, 0 when they already are. */
  waitFor(weight: number): number {
    this.refill();
    if (this.tokens >= weight) return 0;
    return Math.ceil((weight - this.tokens) / this.perMs);
  }

  /** Wait until `weight` is available, then take it. Callers are served in order. */
  acquire(weight: number, onWait?: (ms: number) => void): Promise<void> {
    const run = async () => {
      const ms = this.waitFor(weight);
      if (ms > 0) {
        onWait?.(ms);
        await sleep(ms);
        this.refill();
      }
      this.tokens -= weight;
      this.record(weight);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Take `weight` immediately, even into the negative. */
  charge(weight: number): void {
    if (weight <= 0) return;
    this.refill();
    this.tokens -= weight;
    this.record(weight);
  }
}
