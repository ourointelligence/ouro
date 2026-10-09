import fs from 'node:fs';
import path from 'node:path';
import type { CycleResult, Strategy, TakeoffRow } from './types.js';
import { mean } from './trial.js';

/**
 * Capability Index: how much better a strategy is than the seed generation on the same unseen episodes.
 * (holdoutScore / baselineHoldout) - 1 for a positive baseline. The equivalent form (score - baseline) / |baseline|
 * keeps "better is higher" when the baseline is negative. `scale` (the seed generation's mean absolute holdout
 * score) bounds the denominator so a baseline near zero does not blow the ratio up; when both are zero the raw
 * gap is returned.
 */
export function capabilityIndex(strategy: Pick<Strategy, 'trial'>, baselineHoldout: number, scale = 0): number {
  const score = strategy.trial?.ownHoldoutScore ?? strategy.trial?.holdoutScore;
  if (score === undefined || !Number.isFinite(score)) return 0;
  const base = Number.isFinite(baselineHoldout) ? baselineHoldout : 0;
  const denom = Math.max(Math.abs(base), Number.isFinite(scale) ? Math.abs(scale) : 0);
  if (denom === 0) return score - base;
  return (score - base) / denom;
}

/** Mean CI over the live strategies. */
export function populationCI(live: Array<Pick<Strategy, 'ci'>>): number {
  const cis = live.map((s) => s.ci).filter((c): c is number => typeof c === 'number' && Number.isFinite(c));
  return mean(cis);
}

export function bestCI(live: Array<Pick<Strategy, 'ci'>>): number {
  const cis = live.map((s) => s.ci).filter((c): c is number => typeof c === 'number' && Number.isFinite(c));
  return cis.length ? Math.max(...cis) : 0;
}

/** The takeoff curve: population CI, best CI and velocity (CI gain since the previous cycle) per cycle. */
export function takeoff(cycles: Array<Pick<CycleResult, 'cycle' | 'populationCI'> & { bestCI?: number }>): TakeoffRow[] {
  const rows: TakeoffRow[] = [];
  let prev: number | null = null;
  for (const c of cycles) {
    const pci = Number.isFinite(c.populationCI) ? c.populationCI : 0;
    const velocity = prev === null ? 0 : pci - prev;
    rows.push({ cycle: c.cycle, populationCI: pci, bestCI: c.bestCI ?? pci, velocity });
    prev = pci;
  }
  return rows;
}

/** True when the last k velocities are all below the threshold: the population has hit its ceiling. */
export function ceilingDetected(rows: TakeoffRow[], k = 3, threshold = 0.01): boolean {
  if (rows.length < k + 1) return false;
  return rows.slice(-k).every((r) => r.velocity < threshold);
}

export function takeoffFile(dir: string): string {
  return path.join(dir, 'takeoff.json');
}

export function writeTakeoff(dir: string, rows: TakeoffRow[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(takeoffFile(dir), JSON.stringify(rows, null, 2));
}

export function readTakeoff(dir: string): TakeoffRow[] {
  const f = takeoffFile(dir);
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, 'utf8')) as TakeoffRow[];
}

export function formatTakeoff(rows: TakeoffRow[], k = 3, threshold = 0.01): string {
  const lines = ['cycle  populationCI  bestCI   velocity'];
  for (const r of rows) {
    lines.push(`${String(r.cycle).padEnd(6)} ${signed(r.populationCI).padEnd(13)} ${signed(r.bestCI).padEnd(8)} ${signed(r.velocity)}`);
  }
  if (ceilingDetected(rows, k, threshold)) {
    lines.push(`ceiling: velocity below ${threshold} for ${k} cycles. Add primitive packs or loosen allow/bounds/freeze.`);
  }
  return lines.join('\n');
}

function signed(v: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(2);
}
