import type { Decision, Episode, Input, Outcome } from '../../src/types.js';
import type { Executor, PrimitivePack, Source } from '../../src/plugins.js';

/** mulberry32: small, fast, deterministic. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const OPTIMUM = { aMin: 0.6, bMax: 0.3 };

/**
 * The synthetic world: two uniform features a and b. Going long pays +1 when a > 0.6 and b < 0.3,
 * -0.4 otherwise, plus uniform noise of +-0.3. Shorts get the opposite sign.
 */
export function syntheticWorld(seed = 7) {
  const rand = rng(seed);
  let ts = 1_700_000_000_000;
  let n = 0;
  return {
    next(): Input {
      ts += 60_000;
      n++;
      const a = Math.round(rand() * 100) / 100;
      const b = Math.round(rand() * 100) / 100;
      const bar = { ts, asset: 'SYN', tf: '1m', o: 1, h: 1, l: 1, c: 1, v: 1 };
      return { ts, asset: 'SYN', bar, features: { 'syn.a': a, 'syn.b': b, 'syn.n': n } };
    },
    outcome(x: Input, d: Decision): Outcome {
      if (!d || d.side === 'flat' || d.size <= 0) return { pnl: 0, fees: 0, drawdown: 0, holdBars: 0, closedTs: x.ts + 60_000 };
      const a = x.features['syn.a'] as number;
      const b = x.features['syn.b'] as number;
      const good = a > OPTIMUM.aMin && b < OPTIMUM.bMax;
      const noise = (rand() - 0.5) * 0.2;
      let r = (good ? 1 : -0.4) + noise;
      if (d.side === 'short') r = -r;
      return { pnl: r, fees: 0.02, drawdown: r < 0 ? -r : 0, holdBars: 1, closedTs: x.ts + 60_000 };
    },
  };
}

export const syntheticScore = (ep: Episode) => ep.outcome.pnl - ep.outcome.fees - 0.5 * ep.outcome.drawdown;

/** Pack that documents the synthetic features; compute is unused because tests build Inputs directly. */
export const synPack: PrimitivePack = {
  name: 'syn',
  compute(bars, i) {
    const bar = bars[i];
    return { a: bar ? (bar.o % 1) : null, b: bar ? (bar.c % 1) : null, n: i };
  },
  describe() {
    return [
      { key: 'a', doc: 'Feature a, uniform in [0, 1].' },
      { key: 'b', doc: 'Feature b, uniform in [0, 1].' },
      { key: 'n', doc: 'Bar counter.' },
    ];
  },
};

export const dummySource: Source = {
  name: 'dummy',
  async *subscribe() {
    // yields nothing
  },
  async history() {
    return [];
  },
};

export const dummyExecutor: Executor = {
  name: 'dummy',
  async place() {
    return { orderId: 'dummy' };
  },
  onClose() {
    // never closes
  },
};

/** Strategy module for the synthetic domain with the given grid params. */
export function synStrategyCode(aMin: number, bMax: number, size = 0.05, extra = ''): string {
  return `export const params = { aMin: ${aMin}, bMax: ${bMax}, size: ${size} };
export const bounds = { aMin: { min: 0, max: 1, step: 0.1 }, bMax: { min: 0, max: 1, step: 0.1 }, size: { min: 0.01, max: 0.1, step: 0.01 } };
export function decide(x: Input, p: typeof params): Decision {
  const a = x.features['syn.a'];
  const b = x.features['syn.b'];
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  ${extra}
  if (a > p.aMin && b < p.bMax) return { side: 'long', size: p.size };
  return null;
}
export const describe = 'Long when a is above aMin (${aMin}) and b is below bMax (${bMax}).';
`;
}

export function snap(v: number, step = 0.1, min = 0, max = 1): number {
  const x = Math.min(max, Math.max(min, Math.round(v / step) * step));
  return Number(x.toFixed(2));
}
