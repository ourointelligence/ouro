import type { Bar, FeatureValue } from '../types.js';
import type { PrimitivePack } from '../plugins.js';
import { nz, sma } from './math.js';
import { seriesCache } from './cache.js';

const series = seriesCache((bars: Bar[]) => {
  const v = bars.map((b) => b.v);
  return { v, volSma20: sma(v, 20) };
});

/** Volume pack: raw volume, 20-bar average and the ratio between them. */
export const volume: PrimitivePack = {
  name: 'volume',
  compute(bars, i) {
    const s = series(bars);
    const out: Record<string, FeatureValue> = {};
    const vol = nz(s.v[i]);
    const avg = nz(s.volSma20[i]);
    out['vol'] = vol;
    out['volSma20'] = avg;
    out['volRatio'] = vol === null || avg === null || avg === 0 ? null : vol / avg;
    return out;
  },
  describe() {
    return [
      { key: 'vol', doc: 'Volume of the current bar.' },
      { key: 'volSma20', doc: 'Simple average volume over the last 20 bars.' },
      { key: 'volRatio', doc: 'vol / volSma20. Above 1 means above-average activity.' },
    ];
  },
};
