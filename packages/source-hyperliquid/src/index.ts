import WebSocket from 'ws';
import type { Bar, Source } from '@ourointelligence/sdk';

export const HYPERLIQUID_WS_URL = 'wss://api.hyperliquid.xyz/ws';
export const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';

/** Candle intervals Hyperliquid accepts, with their length in milliseconds. */
export const INTERVALS: Record<string, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
  '1M': 2_592_000_000,
};

/** Largest number of candles one candleSnapshot request returns. */
export const SNAPSHOT_LIMIT = 5000;

export type HyperliquidCandle = { t: number; T: number; s: string; i: string; o: string; c: string; h: string; l: string; v: string; n: number };

export type HyperliquidOptions = {
  wsUrl?: string;
  infoUrl?: string;
  /** Injected for tests. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injected for tests. Defaults to the ws package. */
  WebSocket?: typeof WebSocket;
  /** Milliseconds between keep-alive pings. Default 30000. */
  pingMs?: number;
  /** Reconnect delay after a dropped socket. Default 2000. */
  reconnectMs?: number;
  /** Clock, injected for tests. */
  now?: () => number;
};

export function toBar(c: HyperliquidCandle): Bar {
  return { ts: c.t, asset: c.s, tf: c.i, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v) };
}

export function intervalMs(tf: string): number {
  const ms = INTERVALS[tf];
  if (!ms) throw new Error(`hyperliquid: unsupported interval "${tf}". Use one of ${Object.keys(INTERVALS).join(', ')}`);
  return ms;
}

type Listener = { resolve: (v: IteratorResult<Bar>) => void };

/**
 * Hyperliquid public candle source. No API key.
 * history() pages candleSnapshot backwards until it has `bars` closed candles per asset.
 * subscribe() keeps a websocket open, yields each candle once it has closed, pings to stay alive and reconnects.
 */
export function hyperliquid(opts: HyperliquidOptions = {}): Source {
  const wsUrl = opts.wsUrl ?? HYPERLIQUID_WS_URL;
  const infoUrl = opts.infoUrl ?? HYPERLIQUID_INFO_URL;
  const f = opts.fetch ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args));
  const WS = opts.WebSocket ?? WebSocket;
  const now = opts.now ?? (() => Date.now());
  const pingMs = opts.pingMs ?? 30_000;
  const reconnectMs = opts.reconnectMs ?? 2_000;

  async function snapshot(coin: string, interval: string, startTime: number, endTime: number): Promise<HyperliquidCandle[]> {
    const res = await f(infoUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } }),
    });
    if (!res.ok) throw new Error(`hyperliquid: candleSnapshot ${coin} ${interval} failed with HTTP ${res.status}`);
    const body = (await res.json()) as HyperliquidCandle[];
    if (!Array.isArray(body)) throw new Error('hyperliquid: unexpected candleSnapshot response');
    return body;
  }

  return {
    name: 'hyperliquid',

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
          const candles = await snapshot(coin, tf, startTime, endTime);
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
      intervalMs(tf);
      const queue: Bar[] = [];
      const waiting: Listener[] = [];
      const last = new Map<string, HyperliquidCandle>();
      let ws: WebSocket | null = null;
      let pingTimer: NodeJS.Timeout | null = null;
      let reconnectTimer: NodeJS.Timeout | null = null;
      let closed = false;

      const push = (bar: Bar) => {
        const w = waiting.shift();
        if (w) w.resolve({ value: bar, done: false });
        else queue.push(bar);
      };

      const onCandle = (c: HyperliquidCandle) => {
        if (c.i !== tf || !assets.includes(c.s)) return;
        const prev = last.get(c.s);
        if (prev && c.t > prev.t) push(toBar(prev));
        if (!prev || c.t >= prev.t) last.set(c.s, c);
        // a candle whose end time has passed is closed even if the next one has not ticked yet
        if (c.T <= now()) {
          push(toBar(c));
          last.delete(c.s);
        }
      };

      const connect = () => {
        if (closed) return;
        ws = new WS(wsUrl);
        ws.on('open', () => {
          for (const coin of assets) ws?.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'candle', coin, interval: tf } }));
          pingTimer = setInterval(() => {
            if (ws?.readyState === WS.OPEN) ws.send(JSON.stringify({ method: 'ping' }));
          }, pingMs);
          pingTimer.unref?.();
        });
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString()) as { channel?: string; data?: HyperliquidCandle };
            if (msg.channel === 'candle' && msg.data) onCandle(msg.data);
          } catch {
            // ignore malformed frames
          }
        });
        const scheduleReconnect = () => {
          if (pingTimer) clearInterval(pingTimer);
          pingTimer = null;
          ws = null;
          if (closed) return;
          reconnectTimer = setTimeout(connect, reconnectMs);
          reconnectTimer.unref?.();
        };
        ws.on('close', scheduleReconnect);
        ws.on('error', () => {
          try {
            ws?.close();
          } catch {
            // already closing
          }
        });
      };

      const stop = () => {
        closed = true;
        if (pingTimer) clearInterval(pingTimer);
        if (reconnectTimer) clearTimeout(reconnectTimer);
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
}

export default hyperliquid;
