import type { Bar, FeatureValue } from '../types.js';
import type { PrimitivePack } from '../plugins.js';
import { ta } from './ta.js';
import { volume } from './volume.js';
import { time } from './time.js';
import { orderbook } from './orderbook.js';
import { onchain } from './onchain.js';

export { ta, volume, time, orderbook, onchain };

/** Built-in packs, importable as `primitives.ta` etc. */
export const primitives = { ta, volume, time, orderbook, onchain } as const;

/** Compute every pack's features for bars[i] and merge them under `${pack.name}.${key}`. */
export function computeFeatures(packs: PrimitivePack[], bars: Bar[], i: number): Record<string, FeatureValue> {
  const out: Record<string, FeatureValue> = {};
  for (const pack of packs) {
    const f = pack.compute(bars, i);
    for (const [k, v] of Object.entries(f)) out[`${pack.name}.${k}`] = v;
  }
  return out;
}

/** Prefixed docs for every pack; this is what the Generator is shown. */
export function primitiveDocs(packs: PrimitivePack[]): Array<{ key: string; doc: string }> {
  const out: Array<{ key: string; doc: string }> = [];
  for (const pack of packs) for (const d of pack.describe()) out.push({ key: `${pack.name}.${d.key}`, doc: d.doc });
  return out;
}

/** Every feature key a set of packs can produce. */
export function featureKeys(packs: PrimitivePack[]): string[] {
  return primitiveDocs(packs).map((d) => d.key);
}

/** Bars needed before every built-in indicator is defined (ema200 plus the longest Hull window). */
export const INDICATOR_LOOKBACK = 260;
