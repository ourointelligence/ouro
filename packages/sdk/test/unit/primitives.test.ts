import { describe, expect, it } from 'vitest';
import { computeFeatures, featureKeys, primitiveDocs, primitives, INDICATOR_LOOKBACK } from '../../src/primitives/index.js';
import { ema, hull, rsi, sma, wma } from '../../src/primitives/math.js';
import type { Bar } from '../../src/types.js';
import { rng } from '../helpers/synthetic.js';

function bars(n: number, seed = 3): Bar[] {
  const rand = rng(seed);
  const out: Bar[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const o = price;
    const c = price * (1 + (rand() - 0.5) * 0.02);
    const h = Math.max(o, c) * (1 + rand() * 0.005);
    const l = Math.min(o, c) * (1 - rand() * 0.005);
    out.push({ ts: 1_700_000_000_000 + i * 900_000, asset: 'BTC', tf: '15m', o, h, l, c, v: 100 + rand() * 50 });
    price = c;
  }
  return out;
}

describe('indicator math', () => {
  it('sma, ema and wma agree on a constant series and are NaN before their window', () => {
    const s = new Array(30).fill(5);
    expect(sma(s, 5)[3]).toBeNaN();
    expect(sma(s, 5)[4]).toBe(5);
    expect(ema(s, 5)[29]).toBeCloseTo(5, 10);
    expect(wma(s, 5)[29]).toBeCloseTo(5, 10);
    expect(hull(s, 9)[29]).toBeCloseTo(5, 10);
  });
  it('rsi is 100 on a monotonic rise and 0..100 otherwise', () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsi(up, 14)[29]).toBe(100);
    const r = rsi(bars(100).map((b) => b.c), 14);
    for (let i = 20; i < 100; i++) {
      expect(r[i]!).toBeGreaterThanOrEqual(0);
      expect(r[i]!).toBeLessThanOrEqual(100);
    }
  });
});

describe('built-in packs', () => {
  it('produce every documented key, prefixed, and all defined after the lookback', () => {
    const packs = [primitives.ta, primitives.volume, primitives.time];
    const b = bars(INDICATOR_LOOKBACK + 20);
    const f = computeFeatures(packs, b, b.length - 1);
    const keys = featureKeys(packs);
    expect(keys).toContain('ta.hull21.crossUp');
    expect(keys).toContain('volume.volRatio');
    expect(keys).toContain('time.hour');
    for (const k of keys) {
      expect(f).toHaveProperty(k);
      expect(f[k]).not.toBeNull();
    }
    expect(typeof f['ta.ema200']).toBe('number');
    expect(typeof f['ta.hull21.crossUp']).toBe('boolean');
    expect(typeof f['ta.qqe14.crossUp']).toBe('boolean');
    expect(f['time.hour']).toBe(new Date(b[b.length - 1]!.ts).getUTCHours());
  });
  it('returns nulls while indicators warm up instead of NaN', () => {
    const b = bars(5);
    const f = computeFeatures([primitives.ta, primitives.volume], b, 4);
    expect(f['ta.ema200']).toBeNull();
    expect(f['volume.volSma20']).toBeNull();
    expect(f['volume.vol']).toBeTypeOf('number');
    for (const v of Object.values(f)) expect(Number.isNaN(v as number)).toBe(false);
  });
  it('orderbook and onchain are null stubs with documented keys', () => {
    const f = computeFeatures([primitives.orderbook, primitives.onchain], bars(3), 2);
    expect(Object.keys(f).length).toBeGreaterThan(4);
    for (const v of Object.values(f)) expect(v).toBeNull();
    expect(primitiveDocs([primitives.orderbook])[0]!.key).toMatch(/^orderbook\./);
  });
  it('time pack computes minutes to the next 8h funding', () => {
    const ts = Date.UTC(2026, 0, 1, 7, 30);
    const f = primitives.time.compute([{ ts, asset: 'BTC', tf: '15m', o: 1, h: 1, l: 1, c: 1, v: 1 }], 0);
    expect(f['hour']).toBe(7);
    expect(f['minutesToFundingHl']).toBe(30);
    expect(f['dow']).toBe(4);
    expect(f['isWeekend']).toBe(false);
  });
});
