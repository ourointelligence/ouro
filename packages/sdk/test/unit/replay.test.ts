import { describe, expect, it, afterAll } from 'vitest';
import { replayBars } from '../../src/replay.js';
import { Sandbox } from '../../src/sandbox.js';
import { paperExecutor } from '../../src/executors/paper.js';
import type { Bar, Episode, Input } from '../../src/types.js';
import type { PrimitivePack } from '../../src/plugins.js';
import { rng } from '../helpers/synthetic.js';

const sandbox = new Sandbox({ backend: 'worker' });
afterAll(() => sandbox.close());

const score = (ep: Episode) => ep.outcome.pnl - ep.outcome.fees - 0.5 * ep.outcome.drawdown;

/** A pack that exposes the close, the previous close and a 3-bar mean; honest by construction. */
const closePack: PrimitivePack = {
  name: 'px',
  compute(bars, i) {
    const b = bars[i]!;
    const prev = bars[i - 1];
    const m3 = i >= 2 ? (bars[i]!.c + bars[i - 1]!.c + bars[i - 2]!.c) / 3 : null;
    return { close: b.c, prev: prev ? prev.c : null, mean3: m3 };
  },
  describe() {
    return [
      { key: 'close', doc: 'close' },
      { key: 'prev', doc: 'previous close' },
      { key: 'mean3', doc: '3 bar mean close' },
    ];
  },
};

/** A pack that cheats: it reads the next bar. The look-ahead test must catch it. */
const cheatPack: PrimitivePack = {
  name: 'cheat',
  compute(bars, i) {
    const next = bars[i + 1];
    return { nextUp: next ? next.c > bars[i]!.c : null };
  },
  describe() {
    return [{ key: 'nextUp', doc: 'whether the next bar closes up (illegal)' }];
  },
};

function series(n: number, seed = 3, asset = 'BTC'): Bar[] {
  const rand = rng(seed);
  const out: Bar[] = [];
  let price = 100;
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i++) {
    const o = price;
    const c = price * (1 + (rand() - 0.5) * 0.02);
    const h = Math.max(o, c) * (1 + rand() * 0.005);
    const l = Math.min(o, c) * (1 - rand() * 0.005);
    out.push({ ts: t0 + i * 60_000, asset, tf: '1m', o, h, l, c, v: 1 });
    price = c;
  }
  return out;
}

const momentum = `export const params = { size: 0.05, stop: 0 };
export const bounds = { size: { min: 0.01, max: 0.1, step: 0.01 }, stop: { min: 0, max: 10, step: 0.5 } };
export function decide(x: Input, p: typeof params): Decision {
  const c = x.features['px.close'];
  const m = x.features['px.mean3'];
  if (typeof c !== 'number' || typeof m !== 'number') return null;
  if (c > m) return { side: 'long', size: p.size, stop: p.stop > 0 ? p.stop : undefined };
  if (c < m) return { side: 'short', size: p.size, stop: p.stop > 0 ? p.stop : undefined };
  return { side: 'flat', size: 0 };
}
export const describe = 'Momentum against the 3 bar mean.';`;

const cheater = `export const params = { size: 0.05 };
export const bounds = { size: { min: 0.01, max: 0.1, step: 0.01 } };
export function decide(x: Input, p: typeof params): Decision {
  const up = x.features['cheat.nextUp'];
  if (up === true) return { side: 'long', size: p.size };
  if (up === false) return { side: 'short', size: p.size };
  return null;
}
export const describe = 'Cheats by reading the next bar.';`;

describe('bar-level replay', () => {
  it('fills at the next bar open with fee and slippage, exactly like the paper executor', async () => {
    const bars = series(40);
    const r = await replayBars({ bars, packs: [closePack], scorer: score, sandbox, strategy: { id: 'm1', code: momentum, params: { size: 0.05, stop: 0 } }, from: bars[5]!.ts, to: bars[39]!.ts, lookback: 5 });
    expect(r.n).toBeGreaterThan(0);
    expect(r.matched).toBe(r.n);
    // the same decisions pushed through a real paper executor give the same outcomes
    const exec = paperExecutor();
    const outcomes: number[] = [];
    exec.onClose((_id, o) => outcomes.push(o.pnl));
    const inputs: Input[] = bars.map((b, i) => ({
      ts: b.ts,
      asset: b.asset,
      bar: b,
      features: Object.fromEntries(Object.entries(closePack.compute(bars, i)).map(([k, v]) => [`px.${k}`, v])),
    }));
    const decisions = await sandbox.runMany('m1', inputs, { size: 0.05, stop: 0 });
    for (let i = 0; i < bars.length; i++) {
      exec.onBar(bars[i]!);
      const d = decisions[i];
      if (i >= 5 && d) await exec.place(d, { ts: bars[i]!.ts, asset: 'BTC', bar: bars[i]!, features: {}, meta: { strategyId: 'm1' } });
      if (i === 39) exec.stop(bars[i]!.ts);
    }
    expect(r.episodes.map((e) => Number(e.outcome.pnl.toFixed(10)))).toEqual(outcomes.map((p) => Number(p.toFixed(10))));
  });

  it('is deterministic: same bars, same params, same result', async () => {
    const bars = series(120, 9);
    const opts = { bars, packs: [closePack], scorer: score, sandbox, strategy: { id: 'm2', code: momentum, params: { size: 0.03, stop: 1 } }, from: bars[10]!.ts, to: bars[119]!.ts, lookback: 10 };
    const a = await replayBars(opts);
    const b = await replayBars({ ...opts, bars: [...bars].reverse() });
    expect(a.score).toBe(b.score);
    expect(a.maxDrawdown).toBe(b.maxDrawdown);
    expect(a.n).toBe(b.n);
    expect(a.episodes.map((e) => [e.ts, e.decision?.side, e.outcome.pnl])).toEqual(b.episodes.map((e) => [e.ts, e.decision?.side, e.outcome.pnl]));
  });

  it('look-ahead: no feature or decision inside the window may change when later bars change', async () => {
    const bars = series(80, 11);
    const from = bars[20]!.ts;
    const to = bars[50]!.ts;
    const base = await replayBars({ bars, packs: [closePack], scorer: score, sandbox, strategy: { id: 'm3', code: momentum, params: { size: 0.05, stop: 0 } }, from, to, lookback: 10 });
    // rewrite every bar after the window with wild prices
    const tampered = bars.map((b) => (b.ts > to ? { ...b, o: b.o * 3, h: b.h * 3, l: b.l * 3, c: b.c * 3 } : b));
    const again = await replayBars({ bars: tampered, packs: [closePack], scorer: score, sandbox, strategy: { id: 'm3', code: momentum, params: { size: 0.05, stop: 0 } }, from, to, lookback: 10 });
    expect(again.episodes.map((e) => [e.input.ts, e.input.features, e.decision?.side])).toEqual(base.episodes.map((e) => [e.input.ts, e.input.features, e.decision?.side]));
    // a pack or strategy that peeks at the next bar is caught by the same check: decisions inside the window move
    const cheat1 = await replayBars({ bars, packs: [cheatPack], scorer: score, sandbox, strategy: { id: 'c1', code: cheater, params: { size: 0.05 } }, from, to, lookback: 10 });
    const flipped = bars.map((b, i) => (i > 20 && i <= 51 && i % 2 === 0 ? { ...b, c: b.c * 1.5, h: b.h * 1.5 } : b));
    const cheat2 = await replayBars({ bars: flipped, packs: [cheatPack], scorer: score, sandbox, strategy: { id: 'c1', code: cheater, params: { size: 0.05 } }, from, to, lookback: 10 });
    const sidesAt = (r: typeof cheat1, ts: number) => r.episodes.filter((e) => e.input.ts === ts).map((e) => e.decision?.side);
    // the cheater's decision on bar 21 depends on bar 22, which the tampering changed: the decisions differ
    const differs = cheat1.episodes.some((e) => JSON.stringify(sidesAt(cheat1, e.input.ts)) !== JSON.stringify(sidesAt(cheat2, e.input.ts)) || JSON.stringify(e.input.features) !== JSON.stringify(cheat2.episodes.find((f) => f.input.ts === e.input.ts)?.input.features));
    expect(differs).toBe(true);
  });

  it('resolves a bar that touches both stop and target as a stop', async () => {
    const t0 = Date.UTC(2026, 0, 1);
    const mk = (i: number, o: number, h: number, l: number, c: number): Bar => ({ ts: t0 + i * 60_000, asset: 'X', tf: '1m', o, h, l, c, v: 1 });
    const bars = [mk(0, 100, 100, 100, 100), mk(1, 100, 100, 100, 100), mk(2, 100, 100, 100, 100), mk(3, 100, 130, 70, 100), mk(4, 100, 100, 100, 100)];
    const code = `export const params = { size: 0.1 };
export const bounds = { size: { min: 0.01, max: 0.1, step: 0.01 } };
export function decide(x: Input, p: typeof params): Decision {
  if (x.features['px.close'] === 100 && x.ts === ${t0 + 2 * 60_000}) return { side: 'long', size: p.size, stop: 10, tp: 10 };
  return null;
}
export const describe = 'one trade with equal stop and target';`;
    const r = await replayBars({ bars, packs: [closePack], scorer: score, sandbox, strategy: { id: 'both', code, params: { size: 0.1 } }, from: bars[0]!.ts, to: bars[4]!.ts, lookback: 0, paper: { feeBps: 0, slippageBps: 0 } });
    expect(r.n).toBe(1);
    expect((r.episodes[0]!.outcome.raw as { reason: string }).reason).toBe('stop');
    expect(r.episodes[0]!.outcome.pnl).toBeCloseTo(-1, 6); // 10% position, 10% move against
  });
});

describe('paper executor funding', () => {
  it('accrues hourly funding from bar.ext when enabled, longs pay a positive rate, shorts receive it', async () => {
    const t0 = Date.UTC(2026, 0, 1);
    const bar = (i: number, ext?: Record<string, number>): Bar => ({ ts: t0 + i * 900_000, asset: 'BTC', tf: '15m', o: 100, h: 100, l: 100, c: 100, v: 1, ext });
    for (const side of ['long', 'short'] as const) {
      const exec = paperExecutor({ feeBps: 0, slippageBps: 0, funding: true });
      let out: { pnl: number; funding?: number } | null = null;
      exec.onClose((_id, o) => (out = o));
      await exec.place({ side, size: 0.1 }, { ts: t0, asset: 'BTC', bar: bar(0), features: {}, meta: { strategyId: 's' } });
      exec.onBar(bar(1)); // fill at 00:15
      for (let i = 2; i <= 9; i++) exec.onBar(bar(i, { 'funding.rate': 0.0001 })); // through 02:15: two hour boundaries crossed
      exec.stop(t0 + 9 * 900_000);
      expect(out).not.toBeNull();
      const expected = 0.0001 * 2 * 0.1 * 100 * (side === 'long' ? -1 : 1);
      expect(out!.funding).toBeCloseTo(expected, 10);
      expect(out!.pnl).toBeCloseTo(expected, 10);
    }
    // default off: no funding key, pnl unchanged
    const plain = paperExecutor({ feeBps: 0, slippageBps: 0 });
    let o2: { pnl: number; funding?: number } | null = null;
    plain.onClose((_id, o) => (o2 = o));
    await plain.place({ side: 'long', size: 0.1 }, { ts: t0, asset: 'BTC', bar: bar(0), features: {}, meta: { strategyId: 's' } });
    for (let i = 1; i <= 9; i++) plain.onBar(bar(i, { 'funding.rate': 0.0001 }));
    plain.stop(t0 + 9 * 900_000);
    expect(o2!.funding).toBeUndefined();
    expect(o2!.pnl).toBe(0);
  });
});
