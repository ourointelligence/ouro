import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLoop } from '../../src/loop.js';
import type { Episode, Input } from '../../src/types.js';
import { constantLLM } from '../helpers/fakeLlm.js';
import { dummyExecutor, dummySource, rng, synPack } from '../helpers/synthetic.js';
import { rmDir, tmpDir } from '../helpers/tmp.js';

const dir = tmpDir('ouro-curvefit-');
afterAll(() => rmDir(dir));

/** Trades on feature b (independent of the regime): the live baseline. */
const noiseTrader = (threshold: number) => `export const params = { bMin: ${threshold} };
export const bounds = { bMin: { min: 0, max: 1, step: 0.1 } };
export function decide(x: Input, p: typeof params): Decision {
  const b = x.features['syn.b'];
  if (typeof b !== 'number') return null;
  return b > p.bMin ? { side: 'long', size: 0.05 } : null;
}
export const describe = 'Long when b is above bMin.';`;

/** The curve-fit candidate: trades on a, which pays in the train period and loses in the holdout period. */
const overfit = `export const params = { aMin: 0.5 };
export const bounds = { aMin: { min: 0, max: 1, step: 0.1 } };
export function decide(x: Input, p: typeof params): Decision {
  const a = x.features['syn.a'];
  if (typeof a !== 'number') return null;
  return a > p.aMin ? { side: 'long', size: 0.05 } : null;
}
export const describe = 'Long when a is above aMin.';`;

describe('curve-fit rejection', () => {
  it('rejects a candidate that beats train by 20%+ but loses on holdout with reason "holdout"', async () => {
    fs.writeFileSync(path.join(dir, 'noise1.ts'), noiseTrader(0.5));
    fs.writeFileSync(path.join(dir, 'noise2.ts'), noiseTrader(0.7));
    const llm = constantLLM(overfit, { aMin: 0.5 }, { aMin: { min: 0, max: 1, step: 0.1 } });
    const loop = createLoop({
      goal: 'curve fit test',
      primitives: [synPack],
      source: dummySource,
      executor: dummyExecutor,
      score: (ep) => ep.outcome.pnl - ep.outcome.fees,
      llm,
      population: 2,
      cycleEvery: 40,
      holdout: 0.3,
      margin: 0.05,
      guards: { maxDrawdownPct: 1e9, maxPositionPct: 10 },
      seed: [path.join(dir, 'noise1.ts'), path.join(dir, 'noise2.ts')],
      dir,
      assets: ['SYN'],
      tf: '1m',
      autoCycle: false,
      log: { backend: 'jsonl' },
    });
    const seeds = await loop.seed(2);
    expect(seeds.map((s) => s.origin)).toEqual(['user', 'user']);
    expect(llm.calls).toBe(0);

    // 100 episodes per strategy: first 70% is the regime where a > 0.5 pays, last 30% flips
    const rand = rng(11);
    const N = 100;
    let ts = 1_700_000_000_000;
    for (let i = 0; i < N; i++) {
      ts += 60_000;
      const a = rand();
      const b = rand();
      const x: Input = { ts, asset: 'SYN', bar: { ts, asset: 'SYN', tf: '1m', o: 1, h: 1, l: 1, c: 1, v: 1 }, features: { 'syn.a': a, 'syn.b': b } };
      const r = await loop.decide(x);
      const trainRegime = i < N * 0.7;
      for (const [strategyId, decision] of Object.entries(r.perStrategy)) {
        if (!decision) continue;
        const pays = trainRegime ? a > 0.5 : a <= 0.5;
        const ep: Episode = { id: randomUUID(), ts, strategyId, input: x, decision, outcome: { pnl: pays ? 1 : -1, fees: 0, drawdown: 0, holdBars: 1, closedTs: ts } };
        await loop.record(ep);
      }
    }

    const res = await loop.cycle();
    expect(res.status).toBe('no_change');
    expect(res.promoted).toHaveLength(0);
    expect(res.rejected.length).toBeGreaterThan(0);
    const reasons = res.rejected.map((r) => r.reason);
    expect(reasons).toContain('holdout');
    // every rejected candidate was the overfit one and all of them beat the train bar comfortably
    for (const r of res.rejected) {
      expect(r.strategy.code).toBe(overfit);
      expect(r.reason).toBe('holdout');
      expect(r.strategy.trial!.trainScore).toBeGreaterThan(0);
      expect(r.strategy.trial!.holdoutScore).toBeLessThan(0);
    }
    const live = await loop.population();
    const medianTrain = live.map((s) => s.trial!.trainScore).sort((a, b) => a - b)[0]!;
    expect(res.rejected[0]!.strategy.trial!.trainScore).toBeGreaterThan(medianTrain * 1.2);
    expect(live.map((s) => s.origin)).toEqual(['user', 'user']);
    await loop.close();
  });
});
