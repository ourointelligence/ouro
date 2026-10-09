import type { Bar, Source } from '@ourointelligence/sdk';
import type { FundingEntry, MetaAndAssetCtxs } from './info.js';
import { INTERNALS, intervalMs, type HyperliquidInternals, type HyperliquidSource } from './internals.js';

/** The ext keys withAssetCtx writes on live bars. History bars only get 'funding.rate'. */
export const EXT_KEYS = ['funding.rate', 'oi', 'oi.change', 'premium', 'mark', 'oracle'] as const;

export type AssetCtxOptions = {
  /** Backfill 'funding.rate' on history() bars from fundingHistory. Default true. */
  fundingHistory?: boolean;
  /** Fill ext on live bars from metaAndAssetCtxs. Default true. */
  live?: boolean;
};

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Attach 'funding.rate' to history bars: each bar gets the rate of the latest funding entry at or before the bar's
 * end time; bars before the first entry get no key. Entries and bars are sorted by time internally.
 */
export function applyFundingHistory(bars: Bar[], entries: FundingEntry[], intervalMs: number): void {
  const sorted = [...entries].sort((a, b) => a.time - b.time);
  const byTime = [...bars].sort((a, b) => a.ts - b.ts);
  let j = 0;
  let current: number | undefined;
  for (const bar of byTime) {
    const end = bar.ts + intervalMs - 1;
    while (j < sorted.length && sorted[j]!.time <= end) {
      current = num(sorted[j]!.fundingRate);
      j++;
    }
    if (current !== undefined) bar.ext = { ...(bar.ext ?? {}), 'funding.rate': current };
  }
}

/**
 * Wrap a hyperliquid() source so every bar carries market context in `bar.ext`:
 * live bars get funding.rate, oi, oi.change, premium, mark and oracle from one metaAndAssetCtxs poll per bar close
 * (shared by every asset closing at that time); history bars get funding.rate from fundingHistory.
 */
export function withAssetCtx(source: Source, opts: AssetCtxOptions = {}): HyperliquidSource {
  const internals = (source as { [INTERNALS]?: HyperliquidInternals })[INTERNALS];
  if (!internals) throw new Error('withAssetCtx: pass a source created by hyperliquid()');
  const { info, onEvent } = internals;
  const wantHistory = opts.fundingHistory ?? true;
  const wantLive = opts.live ?? true;
  /** Previous open interest per coin, for oi.change. */
  const prevOi = new Map<string, number>();
  /** One poll per bar close time; the promise is shared by every asset closing at that time. */
  const polls = new Map<number, Promise<Map<string, Record<string, number>>>>();

  const poll = (ts: number): Promise<Map<string, Record<string, number>>> => {
    let p = polls.get(ts);
    if (p) return p;
    p = info.metaAndAssetCtxs().then((res: MetaAndAssetCtxs) => {
      const [meta, ctxs] = res;
      const out = new Map<string, Record<string, number>>();
      meta.universe.forEach((u, i) => {
        const ctx = ctxs[i];
        if (!ctx) return;
        const ext: Record<string, number> = {};
        const funding = num(ctx.funding);
        const oi = num(ctx.openInterest);
        const premium = num(ctx.premium);
        const mark = num(ctx.markPx);
        const oracle = num(ctx.oraclePx);
        if (funding !== undefined) ext['funding.rate'] = funding;
        if (oi !== undefined) {
          ext['oi'] = oi;
          const prev = prevOi.get(u.name);
          ext['oi.change'] = prev === undefined ? 0 : oi - prev;
          prevOi.set(u.name, oi);
        }
        if (premium !== undefined) ext['premium'] = premium;
        if (mark !== undefined) ext['mark'] = mark;
        if (oracle !== undefined) ext['oracle'] = oracle;
        out.set(u.name, ext);
      });
      return out;
    });
    polls.set(ts, p);
    // keep only the two most recent polls
    for (const k of [...polls.keys()].sort((a, b) => a - b).slice(0, -2)) polls.delete(k);
    return p;
  };

  const wrapped: HyperliquidSource = {
    name: source.name,
    stats: () => internals.stats(),

    async history(req) {
      const bars = await source.history(req);
      if (!wantHistory || !bars.length) return bars;
      const ms = intervalMs(req.tf);
      for (const coin of req.assets) {
        const own = bars.filter((b) => b.asset === coin);
        if (!own.length) continue;
        const start = own[0]!.ts;
        const end = own[own.length - 1]!.ts + ms - 1;
        try {
          const entries = await info.fundingHistoryAll(coin, start, end);
          applyFundingHistory(own, entries, ms);
        } catch (err) {
          onEvent?.({ type: 'error', message: `fundingHistory ${coin} failed: ${(err as Error).message}` });
        }
      }
      return bars;
    },

    subscribe(req) {
      const inner = source.subscribe(req)[Symbol.asyncIterator]();
      const iterator: AsyncIterator<Bar> & AsyncIterable<Bar> = {
        async next() {
          const r = await inner.next();
          if (r.done || !wantLive) return r;
          const bar = r.value;
          try {
            const ctx = await poll(bar.ts);
            const ext = ctx.get(bar.asset);
            if (ext) bar.ext = { ...(bar.ext ?? {}), ...ext };
          } catch (err) {
            onEvent?.({ type: 'error', message: `metaAndAssetCtxs failed: ${(err as Error).message}` });
          }
          return { value: bar, done: false };
        },
        return(value?: unknown) {
          return inner.return ? inner.return(value) : Promise.resolve({ value: undefined, done: true });
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      return iterator;
    },
  };
  return wrapped;
}
