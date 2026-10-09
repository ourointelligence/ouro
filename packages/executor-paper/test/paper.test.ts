import { describe, expect, it } from 'vitest';
import type { Bar, Executor, Input, Outcome } from '@ourointelligence/sdk';
import { paper, PAPER_DEFAULTS } from '../src/index.js';

function bar(ts: number, o: number, h: number, l: number, c: number): Bar {
  return { ts, asset: 'BTC', tf: '15m', o, h, l, c, v: 1 };
}

describe('@ourointelligence/executor-paper', () => {
  it('implements Executor with the reference defaults and fills at next bar open', async () => {
    const ex: Executor = paper();
    expect(ex.name).toBe('paper');
    expect(PAPER_DEFAULTS).toEqual({ feeBps: 3.5, slippageBps: 2 });
    const closes: Outcome[] = [];
    ex.onClose((_, o) => closes.push(o));
    const b1 = bar(1, 100, 100, 100, 100);
    ex.onBar?.(b1);
    const x: Input = { ts: 1, asset: 'BTC', bar: b1, features: {}, meta: { strategyId: 's-0001' } };
    const { orderId } = await ex.place({ side: 'long', size: 0.1, tp: 10 }, x);
    expect(orderId).toMatch(/^paper:s-0001:BTC:1$/);
    ex.onBar?.(bar(2, 100, 100, 100, 100));
    ex.onBar?.(bar(3, 100, 115, 100, 112));
    expect(closes).toHaveLength(1);
    const entry = 100 * (1 + 2 / 10_000);
    const exit = (entry + 10) * (1 - 2 / 10_000);
    expect(closes[0]!.pnl).toBeCloseTo(0.1 * (exit / entry - 1) * 100, 10);
    expect(closes[0]!.fees).toBeCloseTo(0.1 * (3.5 / 10_000) * 2 * 100, 10);
    expect(closes[0]!.holdBars).toBe(2);
  });

  it('accepts overrides', () => {
    const ex = paper({ feeBps: 0, slippageBps: 0, maxHoldBars: 3 });
    expect(ex.positions()).toEqual([]);
  });
});
