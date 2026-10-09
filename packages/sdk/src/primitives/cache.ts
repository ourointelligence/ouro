import type { Bar } from '../types.js';

/**
 * Per-pack memo of indicator series keyed by bar-array identity.
 * Series are recomputed when the array grows. Packs call compute(bars, i) once per bar, so this keeps
 * streaming cost at one O(n) pass per new bar instead of one pass per indicator per call.
 */
export function seriesCache<T>(build: (bars: Bar[]) => T): (bars: Bar[]) => T {
  const cache = new WeakMap<Bar[], { len: number; lastTs: number; value: T }>();
  return (bars: Bar[]) => {
    const lastTs = bars.length ? bars[bars.length - 1]!.ts : -1;
    const hit = cache.get(bars);
    if (hit && hit.len === bars.length && hit.lastTs === lastTs) return hit.value;
    const value = build(bars);
    cache.set(bars, { len: bars.length, lastTs, value });
    return value;
  };
}
