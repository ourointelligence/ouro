import { backoffDelay, sleep } from './backoff.js';
import type { RateBudget } from './budget.js';

export type HyperliquidCandle = { t: number; T: number; s: string; i: string; o: string; c: string; h: string; l: string; v: string; n: number };

export type FundingEntry = { coin: string; fundingRate: string; premium: string; time: number };

export type AssetCtx = {
  funding: string;
  openInterest: string;
  prevDayPx?: string;
  dayNtlVlm?: string;
  premium: string;
  oraclePx: string;
  markPx: string;
  midPx?: string | null;
  impactPxs?: string[] | null;
};

export type MetaAndAssetCtxs = [{ universe: Array<{ name: string }> }, AssetCtx[]];

export type InfoEvent = { type: 'rateLimit'; waitMs: number; reason: 'budget' | '429' };

export type InfoClientOptions = {
  infoUrl: string;
  fetch: typeof globalThis.fetch;
  budget?: RateBudget;
  onEvent?: (e: InfoEvent) => void;
  random?: () => number;
  /** Initial and maximum backoff after an HTTP 429. Default 1000 and 60000. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Retries after a 429 before giving up. Default 5. */
  maxRetries?: number;
};

/** Base weight of every info request Arena uses, per the Hyperliquid rate limit rules. */
export const BASE_WEIGHT = 20;
/** One extra unit of weight per this many items in a candleSnapshot or fundingHistory response. */
export const ITEMS_PER_EXTRA_WEIGHT = 60;

export function extraWeight(items: number): number {
  return Math.floor(items / ITEMS_PER_EXTRA_WEIGHT);
}

/**
 * Thin POST /info client: declares a weight to the budget before each call, charges the per-item surcharge after,
 * and backs off on HTTP 429. Counts requests for stats().
 */
export class InfoClient {
  requests = 0;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxRetries: number;

  constructor(private readonly opts: InfoClientOptions) {
    this.backoffMs = opts.backoffMs ?? 1_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 60_000;
    this.maxRetries = opts.maxRetries ?? 5;
  }

  async post<T>(body: Record<string, unknown>, weight = BASE_WEIGHT, itemsOf?: (res: T) => number): Promise<T> {
    if (this.opts.budget) await this.opts.budget.acquire(weight, (waitMs) => this.opts.onEvent?.({ type: 'rateLimit', waitMs, reason: 'budget' }));
    const label = String(body['type']);
    for (let attempt = 1; ; attempt++) {
      this.requests++;
      const res = await this.opts.fetch(this.opts.infoUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 429) {
        if (attempt > this.maxRetries) throw new Error(`hyperliquid: ${label} rate limited (HTTP 429) after ${this.maxRetries} retries`);
        const waitMs = backoffDelay(attempt, this.backoffMs, this.maxBackoffMs, this.opts.random);
        this.opts.onEvent?.({ type: 'rateLimit', waitMs, reason: '429' });
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) throw new Error(`hyperliquid: ${label} failed with HTTP ${res.status}`);
      const parsed = (await res.json()) as T;
      if (itemsOf && this.opts.budget) this.opts.budget.charge(extraWeight(itemsOf(parsed)));
      return parsed;
    }
  }

  candleSnapshot(coin: string, interval: string, startTime: number, endTime: number): Promise<HyperliquidCandle[]> {
    return this.post<HyperliquidCandle[]>({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } }, BASE_WEIGHT, (r) =>
      Array.isArray(r) ? r.length : 0,
    ).then((r) => {
      if (!Array.isArray(r)) throw new Error('hyperliquid: unexpected candleSnapshot response');
      return r;
    });
  }

  metaAndAssetCtxs(): Promise<MetaAndAssetCtxs> {
    return this.post<MetaAndAssetCtxs>({ type: 'metaAndAssetCtxs' }, BASE_WEIGHT).then((r) => {
      if (!Array.isArray(r) || r.length < 2 || !Array.isArray(r[1])) throw new Error('hyperliquid: unexpected metaAndAssetCtxs response');
      return r;
    });
  }

  fundingHistory(coin: string, startTime: number, endTime: number): Promise<FundingEntry[]> {
    return this.post<FundingEntry[]>({ type: 'fundingHistory', coin, startTime, endTime }, BASE_WEIGHT, (r) => (Array.isArray(r) ? r.length : 0)).then(
      (r) => {
        if (!Array.isArray(r)) throw new Error('hyperliquid: unexpected fundingHistory response');
        return r;
      },
    );
  }

  /** Every funding entry for `coin` between the two times, paged forward. */
  async fundingHistoryAll(coin: string, startTime: number, endTime: number): Promise<FundingEntry[]> {
    const out: FundingEntry[] = [];
    let from = startTime;
    let guard = 0;
    while (from <= endTime && guard++ < 200) {
      const page = await this.fundingHistory(coin, from, endTime);
      if (!page.length) break;
      const sorted = [...page].sort((a, b) => a.time - b.time);
      for (const e of sorted) if (e.time >= from && e.time <= endTime) out.push(e);
      const last = sorted[sorted.length - 1]!.time;
      if (last < from) break;
      from = last + 1;
    }
    return out;
  }
}
