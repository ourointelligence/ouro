import type { Episode, Outcome, ReplayResult, Scorer } from './types.js';
import type { Sandbox } from './sandbox.js';

/**
 * Chronological split. Holdout is always the newest slice, never random, so the loop can never
 * diagnose or generate from the data it validates on.
 */
export function split<T extends { ts: number }>(episodes: T[], holdoutRatio: number): { train: T[]; holdout: T[] } {
  const sorted = [...episodes].sort((a, b) => a.ts - b.ts);
  if (sorted.length === 0) return { train: [], holdout: [] };
  const ratio = Math.min(Math.max(holdoutRatio, 0), 1);
  let holdoutN = Math.round(sorted.length * ratio);
  if (ratio > 0 && holdoutN === 0 && sorted.length > 1) holdoutN = 1;
  if (holdoutN >= sorted.length && sorted.length > 1) holdoutN = sorted.length - 1;
  const cut = sorted.length - holdoutN;
  return { train: sorted.slice(0, cut), holdout: sorted.slice(cut) };
}

export type Replayable = { id: string; code: string; params: Record<string, number> };

/** The outcome credited when a replayed decision does not match the stored one. */
export function zeroOutcome(closedTs: number): Outcome {
  return { pnl: 0, fees: 0, drawdown: 0, holdBars: 0, closedTs };
}

/**
 * Re-run `decide` on each episode's stored input and credit the stored outcome when the decision side matches
 * the original; otherwise credit a zero outcome. Returns mean score, max drawdown of the cumulative score curve,
 * the largest position size requested and the number of matched episodes.
 *
 * This is a documented simplification: a candidate is only ever credited with trades that some live strategy
 * actually took. Full re-simulation against stored bars is a later upgrade.
 */
export async function replay(episodes: Episode[], strategy: Replayable, scorer: Scorer, sandbox: Sandbox): Promise<ReplayResult> {
  await sandbox.compile(strategy.code, strategy.id);
  const ordered = [...episodes].sort((a, b) => a.ts - b.ts);
  let total = 0;
  let cum = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let maxSize = 0;
  let matched = 0;
  for (const ep of ordered) {
    const d = await sandbox.run(strategy.id, ep.input, strategy.params);
    if (d && d.size > maxSize) maxSize = d.size;
    const same = !!d && !!ep.decision && d.side === ep.decision.side && d.side !== 'flat';
    let s: number;
    if (same) {
      s = scorer(ep);
      matched++;
    } else {
      s = scorer({ ...ep, decision: d, outcome: zeroOutcome(ep.outcome.closedTs) });
    }
    if (!Number.isFinite(s)) s = 0;
    total += s;
    cum += s;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  const n = ordered.length;
  return { score: n ? total / n : 0, maxDrawdown, n, maxSize, matched };
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}
