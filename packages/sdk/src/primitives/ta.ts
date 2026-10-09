import type { Bar, FeatureValue } from '../types.js';
import type { PrimitivePack } from '../plugins.js';
import { adx, atr, bbWidth, crossDown, crossUp, ema, hull, nz, qqe, rsi } from './math.js';
import { seriesCache } from './cache.js';

const HULLS = [9, 21, 34, 55] as const;
const EMAS = [20, 50, 200] as const;

const series = seriesCache((bars: Bar[]) => {
  const c = bars.map((b) => b.c);
  const h = bars.map((b) => b.h);
  const l = bars.map((b) => b.l);
  const hulls = Object.fromEntries(HULLS.map((n) => [n, hull(c, n)])) as Record<number, number[]>;
  const emas = Object.fromEntries(EMAS.map((n) => [n, ema(c, n)])) as Record<number, number[]>;
  return {
    c,
    hulls,
    emas,
    qqe: qqe(c, 14),
    atr14: atr(h, l, c, 14),
    rsi14: rsi(c, 14),
    adx14: adx(h, l, c, 14),
    bbWidth20: bbWidth(c, 20),
  };
});

/** Technical-analysis pack: Hull MAs, QQE, ATR, EMAs, RSI, ADX and Bollinger width. */
export const ta: PrimitivePack = {
  name: 'ta',
  compute(bars, i) {
    const s = series(bars);
    const out: Record<string, FeatureValue> = {};
    for (const n of HULLS) {
      const hs = s.hulls[n]!;
      out[`hull${n}.value`] = nz(hs[i]);
      out[`hull${n}.crossUp`] = crossUp(s.c, hs, i);
      out[`hull${n}.crossDown`] = crossDown(s.c, hs, i);
    }
    out['qqe14.value'] = nz(s.qqe.value[i]);
    out['qqe14.crossUp'] = crossUp(s.qqe.value, s.qqe.trail, i);
    out['qqe14.crossDown'] = crossDown(s.qqe.value, s.qqe.trail, i);
    out['atr14'] = nz(s.atr14[i]);
    for (const n of EMAS) out[`ema${n}`] = nz(s.emas[n]![i]);
    out['rsi14'] = nz(s.rsi14[i]);
    out['adx14'] = nz(s.adx14[i]);
    out['bbWidth20'] = nz(s.bbWidth20[i]);
    return out;
  },
  describe() {
    const docs: Array<{ key: string; doc: string }> = [];
    for (const n of HULLS) {
      docs.push({ key: `hull${n}.value`, doc: `Hull moving average of close over ${n} bars (price units).` });
      docs.push({ key: `hull${n}.crossUp`, doc: `true on the bar where close crosses above hull${n}.` });
      docs.push({ key: `hull${n}.crossDown`, doc: `true on the bar where close crosses below hull${n}.` });
    }
    docs.push({ key: 'qqe14.value', doc: 'QQE smoothed RSI(14) centred on zero; positive is bullish momentum.' });
    docs.push({ key: 'qqe14.crossUp', doc: 'true when the QQE smoothed RSI crosses above its trailing line (momentum turning up).' });
    docs.push({ key: 'qqe14.crossDown', doc: 'true when the QQE smoothed RSI crosses below its trailing line (momentum turning down).' });
    docs.push({ key: 'atr14', doc: 'Average true range over 14 bars (price units). Use for stop distance.' });
    for (const n of EMAS) docs.push({ key: `ema${n}`, doc: `Exponential moving average of close over ${n} bars (price units).` });
    docs.push({ key: 'rsi14', doc: 'Relative strength index over 14 bars, 0..100.' });
    docs.push({ key: 'adx14', doc: 'Average directional index over 14 bars, 0..100; above 25 means trending.' });
    docs.push({ key: 'bbWidth20', doc: 'Bollinger band width over 20 bars as a fraction of the middle band (volatility).' });
    return docs;
  },
};
