import { randomUUID } from 'node:crypto';
import type { Bar, Decision, Episode, Input, ReplayResult, Scorer } from './types.js';
import type { PrimitivePack } from './plugins.js';
import type { Sandbox } from './sandbox.js';
import type { Replayable } from './trial.js';
import { computeFeatures, INDICATOR_LOOKBACK } from './primitives/index.js';
import { paperExecutor, outcomeAsset, type PaperConfig } from './executors/paper.js';

export type BarReplayOptions = {
  /** Closed bars for every asset of the loop, any order; grouped and sorted here. */
  bars: Bar[];
  packs: PrimitivePack[];
  scorer: Scorer;
  sandbox: Sandbox;
  strategy: Replayable;
  /** Decide only on bars with ts >= from ... */
  from: number;
  /** ... and ts <= to. Positions still open at `to` are closed at the last bar's price. */
  to: number;
  /** Fill model. Defaults match the built-in paper executor. */
  paper?: PaperConfig;
  /** Bars before `from` that are fed to the indicators but never decided on. Default INDICATOR_LOOKBACK. */
  lookback?: number;
};

export type BarReplayResult = ReplayResult & { episodes: Episode[] };

/**
 * Bar-level replay: run a strategy's decide over stored bars with exactly the paper executor's fill model
 * (decide on the closed bar, fill at the next bar's open, fee and slippage, stop and take profit against each
 * later bar's high and low, stop first when both are hit). Features come from the same primitive packs and only
 * from bars up to and including the decision bar. Deterministic: same bars and params, same result.
 */
export async function replayBars(opts: BarReplayOptions): Promise<BarReplayResult> {
  const { strategy, sandbox, scorer } = opts;
  const lookback = opts.lookback ?? INDICATOR_LOOKBACK;
  await sandbox.compile(strategy.code, strategy.id);
  const byAsset = new Map<string, Bar[]>();
  for (const b of opts.bars) {
    const arr = byAsset.get(b.asset) ?? [];
    arr.push(b);
    byAsset.set(b.asset, arr);
  }
  const episodes: Episode[] = [];
  let maxSize = 0;
  for (const [asset, raw] of byAsset) {
    const seen = new Set<number>();
    const bars = raw
      .filter((b) => (seen.has(b.ts) ? false : (seen.add(b.ts), true)))
      .sort((a, b) => a.ts - b.ts);
    // keep the window plus the warm-up before it; everything else is irrelevant to this replay
    let start = bars.findIndex((b) => b.ts >= opts.from);
    if (start < 0) continue;
    start = Math.max(0, start - lookback);
    const series = bars.slice(start);
    const firstDecide = series.findIndex((b) => b.ts >= opts.from);
    let lastDecide = -1;
    for (let i = series.length - 1; i >= 0; i--) {
      if (series[i]!.ts <= opts.to) {
        lastDecide = i;
        break;
      }
    }
    if (firstDecide < 0 || lastDecide < firstDecide) continue;

    // 1. decisions for every bar in the window, computed in one sandbox call, features only from bars <= i
    const inputs: Input[] = [];
    const indexOf: number[] = [];
    for (let i = firstDecide; i <= lastDecide; i++) {
      const bar = series[i]!;
      if (bar.stale) continue;
      inputs.push({ ts: bar.ts, asset, bar, features: computeFeatures(opts.packs, series, i) });
      indexOf.push(i);
    }
    const decisions: Decision[] = inputs.length ? await sandbox.runMany(strategy.id, inputs, strategy.params) : [];

    // 2. run the fill model bar by bar
    const exec = paperExecutor(opts.paper);
    const entries = new Map<string, { input: Input; decision: NonNullable<Decision> }>();
    const closed: Episode[] = [];
    exec.onClose((_sid, outcome) => {
      const a = outcomeAsset(outcome) ?? asset;
      const entry = entries.get(a);
      if (!entry) return;
      entries.delete(a);
      const ep: Episode = {
        id: randomUUID(),
        ts: outcome.closedTs,
        strategyId: strategy.id,
        input: entry.input,
        decision: entry.decision,
        outcome,
        tags: [entry.decision.side, outcome.pnl - outcome.fees >= 0 ? 'win' : 'loss'],
      };
      ep.score = scorer(ep);
      closed.push(ep);
    });
    let k = 0;
    for (let i = 0; i < series.length; i++) {
      const bar = series[i]!;
      exec.onBar(bar);
      if (k < indexOf.length && indexOf[k] === i) {
        const d = decisions[k];
        const x = inputs[k]!;
        k++;
        if (d) {
          if (d.size > maxSize) maxSize = d.size;
          if (d.side !== 'flat') {
            const prev = entries.get(asset);
            if (!prev || prev.decision.side !== d.side) entries.set(asset, { input: x, decision: d });
          }
          await exec.place(d, { ...x, meta: { strategyId: strategy.id } });
        }
      }
      if (i === lastDecide) {
        // the window is over: flat out at this bar's close so late positions count
        exec.stop(bar.ts);
        break;
      }
    }
    episodes.push(...closed);
  }
  episodes.sort((a, b) => a.ts - b.ts);
  let total = 0;
  let cum = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const ep of episodes) {
    let s = typeof ep.score === 'number' ? ep.score : scorer(ep);
    if (!Number.isFinite(s)) s = 0;
    total += s;
    cum += s;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  const n = episodes.length;
  return { score: n ? total / n : 0, maxDrawdown, n, maxSize, matched: n, episodes };
}
