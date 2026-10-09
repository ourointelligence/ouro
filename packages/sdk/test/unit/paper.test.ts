import { describe, expect, it } from 'vitest';
import { paperExecutor } from '../../src/executors/paper.js';
import type { Bar, Input, Outcome } from '../../src/types.js';

function bar(ts: number, o: number, h: number, l: number, c: number, asset = 'BTC'): Bar {
  return { ts, asset, tf: '15m', o, h, l, c, v: 1 };
}
function input(b: Bar, strategyId: string): Input {
  return { ts: b.ts, asset: b.asset, bar: b, features: {}, meta: { strategyId } };
}

describe('paper executor', () => {
  it('fills at next bar open with slippage, charges fees both ways and closes on tp', async () => {
    const ex = paperExecutor({ feeBps: 3.5, slippageBps: 2 });
    const closes: Array<[string, Outcome]> = [];
    ex.onClose((id, o) => closes.push([id, o]));
    const b1 = bar(1, 100, 101, 99, 100);
    ex.onBar(b1);
    await ex.place({ side: 'long', size: 0.1, stop: 5, tp: 10 }, input(b1, 's-0001'));
    expect(ex.positions()).toHaveLength(0);
    const b2 = bar(2, 100, 104, 99, 103);
    ex.onBar(b2);
    const pos = ex.positions()[0]!;
    expect(pos.entry).toBeCloseTo(100 * (1 + 2 / 10_000), 10);
    expect(pos.stop).toBeCloseTo(pos.entry - 5, 10);
    expect(pos.tp).toBeCloseTo(pos.entry + 10, 10);
    expect(pos.bars).toBe(1);
    expect(pos.maxAdverse).toBeCloseTo((pos.entry - 99) / pos.entry, 10);
    ex.onBar(bar(3, 103, 112, 102, 111));
    expect(closes).toHaveLength(1);
    const [id, o] = closes[0]!;
    expect(id).toBe('s-0001');
    const exit = (pos.entry + 10) * (1 - 2 / 10_000);
    expect(o.pnl).toBeCloseTo(0.1 * (exit / pos.entry - 1) * 100, 10);
    expect(o.fees).toBeCloseTo(0.1 * (3.5 / 10_000) * 2 * 100, 10);
    expect(o.drawdown).toBeCloseTo(0.1 * ((pos.entry - 99) / pos.entry) * 100, 10);
    expect(o.holdBars).toBe(2);
    expect(o.closedTs).toBe(3);
    expect((o.raw as { reason: string }).reason).toBe('tp');
    expect(ex.positions()).toHaveLength(0);
    expect(ex.closed()).toBe(1);
  });

  it('closes on stop at the stop price (or worse on a gap), measuring drawdown bar by bar', async () => {
    const ex = paperExecutor({ slippageBps: 0, feeBps: 0 });
    const closes: Outcome[] = [];
    ex.onClose((_, o) => closes.push(o));
    const b1 = bar(1, 100, 100, 100, 100);
    ex.onBar(b1);
    await ex.place({ side: 'short', size: 0.05, stop: 3 }, input(b1, 's'));
    ex.onBar(bar(2, 100, 101, 99, 100));
    ex.onBar(bar(3, 100, 102, 99, 101));
    expect(closes).toHaveLength(0);
    ex.onBar(bar(4, 105, 106, 104, 105)); // gaps through the stop at 103: filled at the open 105
    expect(closes).toHaveLength(1);
    const o = closes[0]!;
    expect((o.raw as { reason: string }).reason).toBe('stop');
    expect(o.pnl).toBeCloseTo(0.05 * (1 - 105 / 100) * 100, 10);
    expect(o.drawdown).toBeCloseTo(0.05 * ((106 - 100) / 100) * 100, 10);
  });

  it('closes on flat, flips on the opposite side, and closes everything on stop()', async () => {
    const ex = paperExecutor();
    const reasons: string[] = [];
    ex.onClose((_, o) => reasons.push((o.raw as { reason: string }).reason));
    const b1 = bar(1, 100, 100, 100, 100);
    ex.onBar(b1);
    await ex.place({ side: 'long', size: 0.05 }, input(b1, 's'));
    ex.onBar(bar(2, 100, 100, 100, 100));
    await ex.place({ side: 'long', size: 0.05 }, input(bar(2, 100, 100, 100, 100), 's')); // hold
    ex.onBar(bar(3, 100, 100, 100, 100));
    expect(ex.positions()).toHaveLength(1);
    await ex.place({ side: 'flat', size: 0 }, input(bar(3, 100, 100, 100, 100), 's'));
    ex.onBar(bar(4, 100, 100, 100, 100));
    expect(reasons).toEqual(['flat']);
    await ex.place({ side: 'long', size: 0.05 }, input(bar(4, 100, 100, 100, 100), 's'));
    ex.onBar(bar(5, 100, 100, 100, 100));
    await ex.place({ side: 'short', size: 0.05 }, input(bar(5, 100, 100, 100, 100), 's'));
    ex.onBar(bar(6, 100, 100, 100, 100));
    expect(reasons).toEqual(['flat', 'flip']);
    expect(ex.positions()[0]!.side).toBe('short');
    await ex.place({ side: 'long', size: 0.05 }, input(bar(6, 50, 50, 50, 50, 'ETH'), 'other'));
    ex.onBar(bar(7, 50, 50, 50, 50, 'ETH'));
    expect(ex.positions()).toHaveLength(2);
    ex.stop();
    expect(reasons).toEqual(['flat', 'flip', 'shutdown', 'shutdown']);
    expect(ex.positions()).toHaveLength(0);
  });

  it('keeps positions per strategy per asset separate', async () => {
    const ex = paperExecutor();
    const b1 = bar(1, 100, 100, 100, 100);
    ex.onBar(b1);
    await ex.place({ side: 'long', size: 0.05 }, input(b1, 'a'));
    await ex.place({ side: 'short', size: 0.02 }, input(b1, 'b'));
    ex.onBar(bar(2, 100, 100, 100, 100));
    expect(ex.positions().map((p) => `${p.strategyId}:${p.side}`).sort()).toEqual(['a:long', 'b:short']);
  });
});
