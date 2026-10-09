import type { Bar, Source } from '@ourointelligence/sdk';
import type { HyperliquidCandle } from './info.js';
import type { InfoClient } from './info.js';
import type { RateBudget } from './budget.js';

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

export function intervalMs(tf: string): number {
  const ms = INTERVALS[tf];
  if (!ms) throw new Error(`hyperliquid: unsupported interval "${tf}". Use one of ${Object.keys(INTERVALS).join(', ')}`);
  return ms;
}

export function toBar(c: HyperliquidCandle): Bar {
  return { ts: c.t, asset: c.s, tf: c.i, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v) };
}

/** Notices the source reports through `onEvent`. */
export type HyperliquidEvent =
  | { type: 'open' }
  | { type: 'close'; code?: number }
  | { type: 'reconnect'; attempt: number; delayMs: number }
  | { type: 'gap'; asset: string; from: number; to: number; filled: number }
  | { type: 'stale'; asset: string; ts: number }
  | { type: 'rateLimit'; waitMs: number; reason: 'budget' | '429' }
  | { type: 'error'; message: string };

export type HyperliquidStats = {
  weightUsedLastMinute: number;
  requests: number;
  reconnects: number;
  gapsFilled: number;
  lastBarTs: Record<string, number>;
  connected: boolean;
};

/** A Source with health counters. */
export interface HyperliquidSource extends Source {
  stats(): HyperliquidStats;
}

/** Internal handle the asset context wrapper uses to share the info client and budget. */
export const INTERNALS: unique symbol = Symbol('hyperliquid.internals');

export type HyperliquidInternals = {
  info: InfoClient;
  budget: RateBudget | undefined;
  now: () => number;
  onEvent?: (e: HyperliquidEvent) => void;
  stats: () => HyperliquidStats;
};
