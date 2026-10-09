import WebSocket from 'ws';
import type { Bar } from '@ourointelligence/sdk';
import { backoffDelay } from './backoff.js';
import { RateBudget } from './budget.js';
import { InfoClient, type HyperliquidCandle, type InfoEvent } from './info.js';
import { withAssetCtx, type AssetCtxOptions } from './assetctx.js';
import {
  HYPERLIQUID_INFO_URL,
  HYPERLIQUID_WS_URL,
  INTERNALS,
  SNAPSHOT_LIMIT,
  intervalMs,
  toBar,
  type HyperliquidEvent,
  type HyperliquidInternals,
  type HyperliquidSource,
  type HyperliquidStats,
} from './internals.js';

export { HYPERLIQUID_INFO_URL, HYPERLIQUID_WS_URL, INTERVALS, INTERNALS, SNAPSHOT_LIMIT, intervalMs, toBar } from './internals.js';
export type { HyperliquidEvent, HyperliquidInternals, HyperliquidSource, HyperliquidStats } from './internals.js';

export { backoffDelay, sleep } from './backoff.js';
export { RateBudget, type RateBudgetOptions } from './budget.js';
export { InfoClient, BASE_WEIGHT, ITEMS_PER_EXTRA_WEIGHT, extraWeight } from './info.js';
export type { HyperliquidCandle, FundingEntry, AssetCtx, MetaAndAssetCtxs, InfoEvent } from './info.js';
export { withAssetCtx, applyFundingHistory, EXT_KEYS } from './assetctx.js';
export type { AssetCtxOptions } from './assetctx.js';

export type HyperliquidOptions = {
  wsUrl?: string;
  infoUrl?: string;
  /** Injected for tests. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injected for tests. Defaults to the ws package. */
  WebSocket?: typeof WebSocket;
  /** Milliseconds between keep-alive pings. Default 30000. */
  pingMs?: number;
  /** First reconnect delay after a dropped socket. Doubles each attempt. Default 1000. */
  reconnectMs?: number;
  /** Cap on the reconnect delay. Default 60000. */
  maxReconnectMs?: number;
  /** A socket that stays open this long resets the backoff. Default 30000. */
  stableMs?: number;
  /** A closed candle emitted more than this many intervals after its end is marked stale. Default 2. */
  staleAfterIntervals?: number;
  /** Request weight budget per minute for every info call this instance makes. Default: no limit. */
  rateLimit?: { weightPerMinute: number };
  /** Receives connection, gap, stale and rate limit notices. */
  onEvent?: (e: HyperliquidEvent) => void;
  /** Fill bar.ext with funding, open interest, premium, mark and oracle (see withAssetCtx). Default false. */
  assetCtx?: boolean | AssetCtxOptions;
  /** Clock, injected for tests. */
  now?: () => number;
  /** Random source for jitter, injected for tests. */
  random?: () => number;
};

type Listener = { resolve: (v: IteratorResult<Bar>) => void };

/**
 * Hyperliquid public candle source. No API key.
 * history() pages candleSnapshot backwards until it has `bars` closed candles per asset.
 * subscribe() keeps one websocket open, yields each candle once it has closed, pings to stay alive, reconnects with
 * exponential backoff, refills any gap from candleSnapshot before emitting newer bars, and marks late bars stale.
 */
export function hyperliquid(opts: HyperliquidOptions = {}): HyperliquidSource {
  const wsUrl = opts.wsUrl ?? HYPERLIQUID_WS_URL;
  const infoUrl = opts.infoUrl ?? HYPERLIQUID_INFO_URL;
  const f = opts.fetch ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args));
  const WS = opts.WebSocket ?? WebSocket;
  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? Math.random;
  const pingMs = opts.pingMs ?? 30_000;
  const reconnectMs = opts.reconnectMs ?? 1_000;
  const maxReconnectMs = opts.maxReconnectMs ?? 60_000;
  const stableMs = opts.stableMs ?? 30_000;
  const staleAfter = opts.staleAfterIntervals ?? 2;
  const onEvent = opts.onEvent;
  const budget = opts.rateLimit ? new RateBudget({ weightPerMinute: opts.rateLimit.weightPerMinute, now }) : undefined;
  const info = new InfoClient({
    infoUrl,
    fetch: f,
    budget,
    random,
    backoffMs: reconnectMs,
    maxBackoffMs: maxReconnectMs,
    onEvent: (e: InfoEvent) => onEvent?.(e),
  });

  const counters = { reconnects: 0, gapsFilled: 0, connected: false };
  const lastBarTs: Record<string, number> = {};

  const stats = (): HyperliquidStats => ({
    weightUsedLastMinute: budget ? budget.usedLastMinute() : 0,
    requests: info.requests,
    reconnects: counters.reconnects,
    gapsFilled: counters.gapsFilled,
    lastBarTs: { ...lastBarTs },
    connected: counters.connected,
  });

  /** Closed candles for `coin` with open time in [from, to], oldest first. */
  async function closedCandles(coin: string, tf: string, from: number, to: number): Promise<HyperliquidCandle[]> {
    const ms = intervalMs(tf);
    const collected = new Map<number, HyperliquidCandle>();
    let endTime = to + ms - 1;
    let guard = 0;
    while (guard++ < 50) {
      const candles = await info.candleSnapshot(coin, tf, from, endTime);
      if (!candles.length) break;
      let earliest = Infinity;
      for (const c of candles) {
        if (c.T > now()) continue; // still forming
        if (c.t < from || c.t > to) continue;
        collected.set(c.t, c);
        if (c.t < earliest) earliest = c.t;
      }
      if (!Number.isFinite(earliest) || earliest <= from || candles.length < SNAPSHOT_LIMIT) break;
      endTime = earliest - 1;
    }
    return [...collected.values()].sort((a, b) => a.t - b.t);
  }

  const source: HyperliquidSource & { [INTERNALS]: HyperliquidInternals } = {
    name: 'hyperliquid',
    stats,
    [INTERNALS]: { info, budget, now, onEvent, stats },

    async history({ assets, tf, bars }) {
      const ms = intervalMs(tf);
      const out: Bar[] = [];
      for (const coin of assets) {
        const collected = new Map<number, Bar>();
        let endTime = now();
        let guard = 0;
        while (collected.size < bars && guard++ < 50) {
          const want = Math.min(SNAPSHOT_LIMIT, bars - collected.size + 1);
          const startTime = endTime - want * ms;
          const candles = await info.candleSnapshot(coin, tf, startTime, endTime);
          if (!candles.length) break;
          let earliest = Infinity;
          for (const c of candles) {
            if (c.T > now()) continue; // still forming
            collected.set(c.t, toBar(c));
            if (c.t < earliest) earliest = c.t;
          }
          if (!Number.isFinite(earliest) || earliest >= endTime) break;
          endTime = earliest - 1;
        }
        const sorted = [...collected.values()].sort((a, b) => a.ts - b.ts);
        out.push(...sorted.slice(Math.max(0, sorted.length - bars)));
      }
      return out.sort((a, b) => a.ts - b.ts || a.asset.localeCompare(b.asset));
    },

    subscribe({ assets, tf }) {
      const ms = intervalMs(tf);
      const queue: Bar[] = [];
      const waiting: Listener[] = [];
      /** Candle still forming, per coin. */
      const forming = new Map<string, HyperliquidCandle>();
      /** Open time of the last bar handed to the consumer, per coin. */
      const emitted = new Map<string, number>();
      let ws: WebSocket | null = null;
      let pingTimer: NodeJS.Timeout | null = null;
      let stableTimer: NodeJS.Timeout | null = null;
      let reconnectTimer: NodeJS.Timeout | null = null;
      let attempt = 0;
      let closed = false;
      /** Serialises closed-candle handling so gap refills (async) keep bars in order. */
      let chain: Promise<void> = Promise.resolve();

      const push = (bar: Bar) => {
        const w = waiting.shift();
        if (w) w.resolve({ value: bar, done: false });
        else queue.push(bar);
      };

      const emit = (c: HyperliquidCandle, live: boolean) => {
        const prev = emitted.get(c.s);
        if (prev !== undefined && c.t <= prev) return; // duplicate or out of order
        const bar = toBar(c);
        if (live && now() - (c.T + 1) > staleAfter * ms) {
          bar.stale = true;
          onEvent?.({ type: 'stale', asset: c.s, ts: c.t });
        }
        emitted.set(c.s, c.t);
        lastBarTs[c.s] = c.t;
        push(bar);
      };

      const handleClosed = async (c: HyperliquidCandle) => {
        if (closed) return;
        const prev = emitted.get(c.s);
        if (prev !== undefined && c.t > prev + ms) {
          const from = prev + ms;
          const to = c.t - ms;
          try {
            const fill = await closedCandles(c.s, tf, from, to);
            for (const g of fill) emit(g, false);
            counters.gapsFilled += fill.length;
            onEvent?.({ type: 'gap', asset: c.s, from, to, filled: fill.length });
          } catch (err) {
            onEvent?.({ type: 'error', message: `gap refill ${c.s} failed: ${(err as Error).message}` });
          }
        }
        emit(c, true);
      };

      const closeCandle = (c: HyperliquidCandle) => {
        chain = chain.then(() => handleClosed(c)).catch(() => undefined);
      };

      const onCandle = (c: HyperliquidCandle) => {
        if (c.i !== tf || !assets.includes(c.s)) return;
        const prev = forming.get(c.s);
        if (prev && c.t > prev.t) {
          forming.delete(c.s);
          closeCandle(prev);
        }
        // a candle whose end time has passed is closed even if the next one has not ticked yet
        if (c.T <= now()) {
          forming.delete(c.s);
          closeCandle(c);
          return;
        }
        if (!prev || c.t >= prev.t) forming.set(c.s, c);
      };

      const clearTimers = () => {
        if (pingTimer) clearInterval(pingTimer);
        if (stableTimer) clearTimeout(stableTimer);
        pingTimer = null;
        stableTimer = null;
      };

      const connect = () => {
        if (closed) return;
        reconnectTimer = null;
        ws = new WS(wsUrl);
        ws.on('open', () => {
          counters.connected = true;
          onEvent?.({ type: 'open' });
          for (const coin of assets) ws?.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'candle', coin, interval: tf } }));
          pingTimer = setInterval(() => {
            if (ws?.readyState === WS.OPEN) ws.send(JSON.stringify({ method: 'ping' }));
          }, pingMs);
          pingTimer.unref?.();
          stableTimer = setTimeout(() => {
            attempt = 0;
          }, stableMs);
          stableTimer.unref?.();
        });
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString()) as { channel?: string; data?: HyperliquidCandle };
            if (msg.channel === 'candle' && msg.data) onCandle(msg.data);
          } catch {
            // ignore malformed frames
          }
        });
        const scheduleReconnect = (code?: number) => {
          clearTimers();
          ws = null;
          const wasConnected = counters.connected;
          counters.connected = false;
          // the candle that was forming when the socket dropped is incomplete: let the gap refill fetch it whole
          forming.clear();
          if (closed) return;
          if (wasConnected) onEvent?.({ type: 'close', code });
          attempt++;
          counters.reconnects++;
          const delayMs = backoffDelay(attempt, reconnectMs, maxReconnectMs, random);
          onEvent?.({ type: 'reconnect', attempt, delayMs });
          reconnectTimer = setTimeout(connect, delayMs);
          reconnectTimer.unref?.();
        };
        ws.on('close', (code?: number) => scheduleReconnect(code));
        ws.on('error', (err: Error) => {
          onEvent?.({ type: 'error', message: err?.message ?? 'socket error' });
          try {
            ws?.close();
          } catch {
            // already closing
          }
        });
      };

      const stop = () => {
        closed = true;
        clearTimers();
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        counters.connected = false;
        try {
          ws?.close();
        } catch {
          // ignore
        }
        ws = null;
        for (const w of waiting.splice(0)) w.resolve({ value: undefined, done: true });
      };

      const iterator: AsyncIterator<Bar> & AsyncIterable<Bar> = {
        next() {
          if (closed) return Promise.resolve({ value: undefined, done: true });
          if (!ws && !reconnectTimer) connect();
          const bar = queue.shift();
          if (bar) return Promise.resolve({ value: bar, done: false });
          return new Promise<IteratorResult<Bar>>((resolve) => waiting.push({ resolve }));
        },
        return() {
          stop();
          return Promise.resolve({ value: undefined, done: true });
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      return iterator;
    },
  };

  if (opts.assetCtx) return withAssetCtx(source, typeof opts.assetCtx === 'object' ? opts.assetCtx : {});
  return source;
}

export default hyperliquid;
