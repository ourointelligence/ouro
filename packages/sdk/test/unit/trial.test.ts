import { afterAll, describe, expect, it } from 'vitest';
import { median, replay, split } from '../../src/trial.js';
import { Sandbox } from '../../src/sandbox.js';
import type { Episode } from '../../src/types.js';

const sandbox = new Sandbox();
afterAll(() => sandbox.close());

function ep(i: number, side: 'long' | 'short' | null, pnl: number, fees = 0, a = 1): Episode {
  const ts = 1_000 + i * 10;
  return {
    id: `e${i}`,
    ts,
    strategyId: 's',
    input: { ts, asset: 'X', bar: { ts, asset: 'X', tf: '1m', o: 1, h: 1, l: 1, c: 1, v: 1 }, features: { 'f.a': a } },
    decision: side ? { side, size: 0.05 } : null,
    outcome: { pnl, fees, drawdown: 0, holdBars: 1, closedTs: ts },
  };
}

describe('split', () => {
  it('is chronological and the holdout is the newest slice', () => {
    const eps = [5, 1, 4, 2, 3, 9, 7, 8, 6, 10].map((i) => ep(i, 'long', 0));
    const { train, holdout } = split(eps, 0.3);
    expect(train.map((e) => e.ts)).toEqual([1010, 1020, 1030, 1040, 1050, 1060, 1070]);
    expect(holdout.map((e) => e.ts)).toEqual([1080, 1090, 1100]);
    expect(Math.max(...train.map((e) => e.ts))).toBeLessThan(Math.min(...holdout.map((e) => e.ts)));
  });
  it('never gives everything to holdout and keeps at least one holdout when ratio > 0', () => {
    expect(split([ep(1, 'long', 0), ep(2, 'long', 0)], 0.01).holdout).toHaveLength(1);
    expect(split([ep(1, 'long', 0), ep(2, 'long', 0)], 0.99).train).toHaveLength(1);
    expect(split([], 0.3)).toEqual({ train: [], holdout: [] });
  });
});

describe('replay', () => {
  const alwaysLong = `export const params = { size: 0.05 };
export const bounds = { size: { min: 0.01, max: 0.1, step: 0.01 } };
export function decide(x: Input, p: typeof params): Decision { return { side: 'long', size: p.size }; }
export const describe = 'Always long.';`;

  it('credits stored outcomes only when the side matches and measures drawdown on the cumulative curve', async () => {
    // stored: long +1, short +2 (mismatch -> 0), long -3, long +1  => total -1, mean -0.25, curve 1,1,-2,-1 => dd 3
    const eps = [ep(1, 'long', 1), ep(2, 'short', 2), ep(3, 'long', -3), ep(4, 'long', 1)];
    const r = await replay(eps, { id: 'always-long', code: alwaysLong, params: { size: 0.05 } }, (e) => e.outcome.pnl - e.outcome.fees, sandbox);
    expect(r.n).toBe(4);
    expect(r.matched).toBe(3);
    expect(r.score).toBeCloseTo(-0.25, 10);
    expect(r.maxDrawdown).toBeCloseTo(3, 10);
    expect(r.maxSize).toBeCloseTo(0.05, 10);
  });

  it('uses the strategy params passed in, not the module defaults', async () => {
    const eps = [ep(1, 'long', 1)];
    const r = await replay(eps, { id: 'always-long-2', code: alwaysLong, params: { size: 0.09 } }, (e) => e.outcome.pnl, sandbox);
    expect(r.maxSize).toBeCloseTo(0.09, 10);
  });

  it('replays episodes in chronological order regardless of input order', async () => {
    const eps = [ep(3, 'long', -3), ep(1, 'long', 1), ep(2, 'long', 1)];
    const r = await replay(eps, { id: 'always-long-3', code: alwaysLong, params: { size: 0.05 } }, (e) => e.outcome.pnl, sandbox);
    // chronological: +1, +1, -3 => peak 2, trough -1 => dd 3 ; reversed order would give dd 0
    expect(r.maxDrawdown).toBeCloseTo(3, 10);
  });
});

describe('median', () => {
  it('handles odd, even and empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});
