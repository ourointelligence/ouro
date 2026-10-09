import type { FeatureValue } from '../types.js';
import type { PrimitivePack } from '../plugins.js';

const FUNDING_CADENCE_MS = 8 * 60 * 60 * 1000;

/** Time pack: UTC hour, day of week, weekend flag and minutes to the next (approximate, 8h cadence) funding. */
export const time: PrimitivePack = {
  name: 'time',
  compute(bars, i) {
    const bar = bars[i];
    const out: Record<string, FeatureValue> = { hour: null, dow: null, isWeekend: null, minutesToFundingHl: null };
    if (!bar) return out;
    const d = new Date(bar.ts);
    const hour = d.getUTCHours();
    const dow = d.getUTCDay();
    out['hour'] = hour;
    out['dow'] = dow;
    out['isWeekend'] = dow === 0 || dow === 6;
    const sinceEpoch = bar.ts % FUNDING_CADENCE_MS;
    out['minutesToFundingHl'] = Math.round((FUNDING_CADENCE_MS - sinceEpoch) / 60000);
    return out;
  },
  describe() {
    return [
      { key: 'hour', doc: 'UTC hour of the bar, 0..23.' },
      { key: 'dow', doc: 'UTC day of week, 0 = Sunday .. 6 = Saturday.' },
      { key: 'isWeekend', doc: 'true on Saturday and Sunday (UTC).' },
      { key: 'minutesToFundingHl', doc: 'Approximate minutes until the next 8-hourly funding timestamp (00:00, 08:00, 16:00 UTC).' },
    ];
  },
};
