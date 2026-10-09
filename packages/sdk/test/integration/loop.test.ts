import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLoop, ensembleDecision, parseEvery } from '../../src/loop.js';
import { paperExecutor } from '../../src/executors/paper.js';
import { primitives, INDICATOR_LOOKBACK } from '../../src/primitives/index.js';
import type { Bar, Decision, Episode, Strategy } from '../../src/types.js';
import type { Source } from '../../src/plugins.js';
import { constantLLM, scriptedLLM, syntheticLLM } from '../helpers/fakeLlm.js';
import { dummyExecutor, dummySource, rng, synPack, synStrategyCode, syntheticScore, syntheticWorld } from '../helpers/synthetic.js';
import { rmDir, tmpDir } from '../helpers/tmp.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmDir(d);
});

/** A random-walk candle source with history and a short live tail. */
function walkSource(assets: string[], n: number, liveBars = 5, seed = 5): Source & { all: Bar[] } {
  const rand = rng(seed);
  const all: Bar[] = [];
  const t0 = Date.UTC(2026, 0, 1);
  for (const asset of assets) {
    let price = asset === 'BTC' ? 80_000 : 3_000;
    for (let i = 0; i < n + liveBars; i++) {
      const o = price;
      const c = price * (1 + (rand() - 0.5) * 0.01 + (Math.sin(i / 20) * 0.002));
      const h = Math.max(o, c) * (1 + rand() * 0.003);
      const l = Math.min(o, c) * (1 - rand() * 0.003);
      all.push({ ts: t0 + i * 900_000, asset, tf: '15m', o, h, l, c, v: 50 + rand() * 100 });
      price = c;
    }
  }
  all.sort((a, b) => a.ts - b.ts);
  return {
    name: 'walk',
    all,
    async history({ bars }) {
      const perAsset = new Map<string, Bar[]>();
      for (const b of all) {
        const arr = perAsset.get(b.asset) ?? [];
        arr.push(b);
        perAsset.set(b.asset, arr);
      }
      return [...perAsset.values()].flatMap((arr) => arr.slice(Math.max(0, arr.length - liveBars - bars), arr.length - liveBars));
    },
    async *subscribe() {
      const tail = all.slice(all.length - liveBars * assets.length);
      for (const b of tail) yield b;
    },
  };
}

const taStrategy = (low: number, high: number) => `export const params = { low: ${low}, high: ${high}, stopAtr: 2, size: 0.05 };
export const bounds = { low: { min: 10, max: 50, step: 5 }, high: { min: 50, max: 90, step: 5 }, stopAtr: { min: 0.5, max: 4, step: 0.5 }, size: { min: 0.01, max: 0.1, step: 0.01 } };
export function decide(x: Input, p: typeof params): Decision {
  const rsi = x.features['ta.rsi14'];
  const atr = x.features['ta.atr14'];
  if (typeof rsi !== 'number' || typeof atr !== 'number') return null;
  if (rsi < p.low) return { side: 'long', size: p.size, stop: p.stopAtr * atr, tp: 2 * p.stopAtr * atr };
  if (rsi > p.high) return { side: 'short', size: p.size, stop: p.stopAtr * atr, tp: 2 * p.stopAtr * atr };
  return null;
}
export const describe = 'RSI mean reversion in both directions with ATR stop and 2R target.';`;

describe('run flow with the paper executor', () => {
  it('seeds, warms up, trades through backfill, records episodes and cycles, then stops', async () => {
    const dir = tmpDir('ouro-run-');
    dirs.push(dir);
    const source = walkSource(['BTC', 'ETH'], 1200, 4);
    const strategies = [taStrategy(30, 70), taStrategy(40, 60), taStrategy(45, 55)];
    let i = 0;
    const llm = scriptedLLM({
      seed: JSON.stringify({ strategies: strategies.map((code, k) => ({ code, params: { low: [30, 40, 45][k], high: [70, 60, 55][k], stopAtr: 2, size: 0.05 }, rationale: `seed ${k}` })) }),
      diagnose: JSON.stringify({ patterns: ['p'], summary: 'rsi thresholds too wide', weakIds: [], strongIds: [] }),
      '*': JSON.stringify({ code: taStrategy(35, 65), params: { low: 35, high: 65, stopAtr: 2, size: 0.05 }, rationale: `child ${i++}` }),
    });
    const paper = paperExecutor({ feeBps: 3.5, slippageBps: 2 });
    const loop = createLoop({
      goal: 'test goal',
      primitives: [primitives.ta, primitives.volume, primitives.time],
      source,
      executor: paper,
      score: (ep) => ep.outcome.pnl - ep.outcome.fees - 0.5 * ep.outcome.drawdown,
      llm,
      population: 3,
      cycleEvery: 10,
      holdout: 0.3,
      margin: 0.05,
      guards: { maxDrawdownPct: 100, maxPositionPct: 10 },
      dir,
      assets: ['BTC', 'ETH'],
      tf: '15m',
      warmupBars: INDICATOR_LOOKBACK + 10,
      backfill: 900,
      log: { backend: 'jsonl' },
    });
    const logs: string[] = [];
    const episodes: Episode[] = [];
    const cycles: number[] = [];
    loop.events.on('log', (m) => logs.push(m));
    loop.events.on('episode', (e) => episodes.push(e));
    loop.events.on('cycle', (c) => cycles.push(c.cycle));
    loop.events.on('error', (e) => {
      throw e;
    });
    await loop.start();
    expect(llm.tasks[0]).toBe('seed');
    expect((await loop.population()).length).toBe(3);
    expect(episodes.length).toBeGreaterThan(30);
    for (const ep of episodes) {
      expect(ep.input.features['ta.rsi14']).toBeTypeOf('number');
      expect(ep.decision?.side).toMatch(/long|short/);
      expect(typeof ep.score).toBe('number');
      expect(ep.outcome.holdBars).toBeGreaterThan(0);
    }
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    expect(logs.some((l) => /subscribing to live/.test(l))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'history.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'takeoff.json'))).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'population')).filter((f) => f.endsWith('.ts')).length).toBeGreaterThanOrEqual(3);
    const h = await loop.history();
    expect(h.cycles.length).toBe(cycles.length);
    const explained = await loop.explain(h.strategies[0]!.id);
    expect(explained).toMatch(/first generation/);
    await loop.close();
  }, 120_000);
});

describe('approval, rollback and the not-enough-data path', () => {
  it('returns pending with requireApproval, approve applies, reject discards; rollback restores', async () => {
    const dir = tmpDir('ouro-approve-');
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'weak.ts'), synStrategyCode(0.8, 0.5));
    fs.writeFileSync(path.join(dir, 'ok.ts'), synStrategyCode(0.0, 0.1));
    const llm = constantLLM(synStrategyCode(0.6, 0.3), { aMin: 0.6, bMax: 0.3, size: 0.05 }, { aMin: { min: 0, max: 1, step: 0.1 }, bMax: { min: 0, max: 1, step: 0.1 }, size: { min: 0.01, max: 0.1, step: 0.01 } });
    const world = syntheticWorld(3);
    const make = () =>
      createLoop({
        goal: 'approval test',
        primitives: [synPack],
        source: dummySource,
        executor: dummyExecutor,
        score: syntheticScore,
        llm,
        population: 2,
        cycleEvery: 20,
        holdout: 0.3,
        guards: { maxDrawdownPct: 1e9, maxPositionPct: 10, requireApproval: true },
        seed: [path.join(dir, 'weak.ts'), path.join(dir, 'ok.ts')],
        dir,
        assets: ['SYN'],
        tf: '1m',
        autoCycle: false,
        log: { backend: 'jsonl' },
      });
    const loop = make();
    await loop.seed(2);
    expect((await loop.cycle()).note).toBe('not enough data');
    for (let i = 0; i < 300; i++) {
      const x = world.next();
      const r = await loop.decide(x);
      for (const [strategyId, decision] of Object.entries(r.perStrategy)) {
        if (!decision) continue;
        await loop.record({ id: randomUUID(), ts: x.ts, strategyId, input: x, decision, outcome: world.outcome(x, decision) });
      }
    }
    expect(await loop.ready()).toBe(true);
    const pending = await loop.cycle();
    expect(pending.status).toBe('pending');
    expect(pending.promoted.length).toBeGreaterThan(0);
    const liveBefore = (await loop.population()).map((s) => s.id).sort();
    expect(liveBefore).toEqual(['s-0001', 's-0002']);
    await expect(loop.cycle()).rejects.toThrow(/pending approval/);
    await expect(loop.approve(99)).rejects.toThrow(/no pending cycle/);
    await loop.close();

    // a fresh process (new loop over the same dir) can approve it
    const loop2 = make();
    const applied = await loop2.approve(pending.cycle);
    expect(applied.status).toBe('promoted');
    const liveAfter = (await loop2.population()).map((s) => s.id).sort();
    expect(liveAfter).not.toEqual(liveBefore);
    const rows = await loop2.takeoff();
    expect(rows).toHaveLength(1);
    expect(Number.isFinite(rows[0]!.populationCI)).toBe(true);

    // rollback to cycle 0 restores the user seeds and marks the promoted child rolled_back
    const rb = await loop2.rollback(0);
    expect(rb.restored.length + rb.rolledBack.length).toBeGreaterThan(0);
    expect((await loop2.population()).map((s) => s.id).sort()).toEqual(liveBefore);
    const h = await loop2.history();
    expect(h.strategies.some((s) => s.status === 'rolled_back')).toBe(true);

    // reject path: next cycle pending, then rejected
    for (let i = 0; i < 100; i++) {
      const x = world.next();
      const r = await loop2.decide(x);
      for (const [strategyId, decision] of Object.entries(r.perStrategy)) {
        if (!decision) continue;
        await loop2.record({ id: randomUUID(), ts: x.ts, strategyId, input: x, decision, outcome: world.outcome(x, decision) });
      }
    }
    const pending2 = await loop2.cycle();
    if (pending2.status === 'pending') {
      const rejected = await loop2.reject(pending2.cycle);
      expect(rejected.status).toBe('no_change');
      expect(rejected.rejected.some((r) => r.reason === 'rejected by user')).toBe(true);
      expect((await loop2.population()).map((s) => s.id).sort()).toEqual(liveBefore);
    }
    await loop2.close();
  }, 120_000);
});

describe('ensemble and helpers', () => {
  const strat = (id: string, ci: number): Strategy => ({ id, parentIds: [], origin: 'seed', cycleBorn: 0, code: '', params: {}, rationale: '', status: 'live', ci });
  it('weighted ensemble needs more than 55% of (ci + 1) weight on one side', () => {
    const live = [strat('a', 0.5), strat('b', 0), strat('c', 0)];
    const votes: Record<string, Decision> = { a: { side: 'long', size: 0.1, stop: 5 }, b: { side: 'short', size: 0.04 }, c: null };
    // long weight 1.5 vs short 1.0 => 60% => long, size = mean of winners
    expect(ensembleDecision(votes, live, 'weighted')).toEqual({ side: 'long', size: 0.1, stop: 5, tag: 'ensemble' });
    const even: Record<string, Decision> = { a: { side: 'long', size: 0.1 }, b: { side: 'short', size: 0.04 }, c: { side: 'short', size: 0.02 } };
    // long 1.5 vs short 2.0 => 57% short
    expect(ensembleDecision(even, live, 'weighted')?.side).toBe('short');
    expect(ensembleDecision(even, live, 'weighted')?.size).toBeCloseTo(0.03, 10);
    const split: Record<string, Decision> = { a: { side: 'long', size: 0.1 }, b: { side: 'short', size: 0.04 }, c: { side: 'flat', size: 0 } };
    // long 1.5 / 3.5 = 43% => flat
    expect(ensembleDecision(split, live, 'weighted')?.side).toBe('flat');
    expect(ensembleDecision({ a: null, b: null }, live, 'weighted')).toBeNull();
    expect(ensembleDecision(votes, live, 'none')).toBeNull();
    const maj = ensembleDecision({ a: { side: 'long', size: 0.1 }, b: { side: 'long', size: 0.2 }, c: { side: 'short', size: 0.1 } }, live, 'majority');
    expect(maj?.side).toBe('long');
    expect(maj?.size).toBeCloseTo(0.15, 10);
  });
  it('parseEvery understands human intervals', () => {
    expect(parseEvery('1h')).toBe(3_600_000);
    expect(parseEvery('30m')).toBe(1_800_000);
    expect(parseEvery('90s')).toBe(90_000);
    expect(() => parseEvery('soon')).toThrow();
  });
  it('decide works with a synthetic LLM-seeded population and use() swaps plugins', async () => {
    const dir = tmpDir('ouro-decide-');
    dirs.push(dir);
    const loop = createLoop({ goal: 'g', primitives: [synPack], source: dummySource, executor: dummyExecutor, score: syntheticScore, llm: syntheticLLM(1), population: 3, dir, assets: ['SYN'], tf: '1m', log: { backend: 'jsonl' } });
    loop.use({ name: 'other', complete: async () => '{}' });
    loop.use(syntheticLLM(2));
    const seeds = await loop.seed(3);
    expect(seeds).toHaveLength(3);
    const r = await loop.decide(syntheticWorld(1).next());
    expect(Object.keys(r.perStrategy).sort()).toEqual(seeds.map((s) => s.id).sort());
    await loop.close();
  });
});
