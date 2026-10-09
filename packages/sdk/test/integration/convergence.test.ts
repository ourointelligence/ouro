import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createLoop } from '../../src/loop.js';
import { takeoff } from '../../src/si.js';
import type { Episode } from '../../src/types.js';
import { syntheticLLM } from '../helpers/fakeLlm.js';
import { dummyExecutor, dummySource, OPTIMUM, synPack, syntheticScore, syntheticWorld } from '../helpers/synthetic.js';
import { rmDir, tmpDir } from '../helpers/tmp.js';

const dir = tmpDir('ouro-conv-');
afterAll(() => rmDir(dir));

describe('convergence on a synthetic world (the test that proves the product)', () => {
  it('population CI rises over at least 3 consecutive cycles and the best strategy lands within one step of the optimum by cycle 10', async () => {
    const llm = syntheticLLM(42);
    const world = syntheticWorld(7);
    const loop = createLoop({
      goal: 'Maximise score on the synthetic stream',
      primitives: [synPack],
      source: dummySource,
      executor: dummyExecutor,
      score: syntheticScore,
      llm,
      population: 8,
      cycleEvery: 100,
      holdout: 0.3,
      margin: 0.05,
      guards: { maxDrawdownPct: 1e9, maxPositionPct: 10, requireApproval: false, maxProposalsPerCycle: 6 },
      dir,
      assets: ['SYN'],
      tf: '1m',
      autoCycle: false,
      log: { backend: 'jsonl' },
    });
    loop.events.on('error', (e) => {
      throw e;
    });
    const seeds = await loop.seed(8);
    expect(seeds).toHaveLength(8);

    const BARS_PER_CYCLE = 200;
    const cis: number[] = [];
    for (let cycle = 1; cycle <= 10; cycle++) {
      for (let i = 0; i < BARS_PER_CYCLE; i++) {
        const x = world.next();
        const r = await loop.decide(x);
        for (const [strategyId, decision] of Object.entries(r.perStrategy)) {
          if (!decision) continue;
          const ep: Episode = { id: randomUUID(), ts: x.ts, strategyId, input: x, decision, outcome: world.outcome(x, decision) };
          await loop.record(ep);
        }
      }
      const res = await loop.cycle();
      expect(['promoted', 'no_change']).toContain(res.status);
      cis.push(res.populationCI);
      const bestNow = [...(await loop.population())].sort((a, b) => (b.trial?.holdoutScore ?? 0) - (a.trial?.holdoutScore ?? 0))[0]!;
      console.log(`cycle ${cycle}: ${res.status} CI ${res.populationCI.toFixed(3)} best ${JSON.stringify(bestNow.params)} promoted ${res.promoted.map((p) => p.id).join(',')}`);
    }

    const rows = takeoff((await loop.history()).cycles);
    expect(rows).toHaveLength(10);
    let streak = 0;
    let best = 0;
    for (const r of rows) {
      streak = r.velocity > 0 ? streak + 1 : 0;
      best = Math.max(best, streak);
    }
    expect(best, `velocities: ${rows.map((r) => r.velocity.toFixed(3)).join(', ')}`).toBeGreaterThanOrEqual(3);

    const live = await loop.population();
    const top = [...live].sort((a, b) => (b.trial?.holdoutScore ?? -Infinity) - (a.trial?.holdoutScore ?? -Infinity))[0]!;
    expect(Math.abs(top.params['aMin']! - OPTIMUM.aMin), `best params ${JSON.stringify(top.params)}`).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(Math.abs(top.params['bMax']! - OPTIMUM.bMax), `best params ${JSON.stringify(top.params)}`).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(cis[cis.length - 1]!).toBeGreaterThan(0);
    await loop.close();
  }, 300_000);
});
