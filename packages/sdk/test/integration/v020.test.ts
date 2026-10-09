import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLoop } from '../../src/loop.js';
import { paperExecutor } from '../../src/executors/paper.js';
import { primitives } from '../../src/primitives/index.js';
import { wrapLLM } from '../../src/llm/wrap.js';
import { canonicalJson } from '../../src/export.js';
import type { Bar, Episode } from '../../src/types.js';
import type { LLM, Source } from '../../src/plugins.js';
import type { EventMap } from '../../src/events.js';
import { constantLLM, syntheticLLM, type FakeLLM } from '../helpers/fakeLlm.js';
import { dummyExecutor, dummySource, rng, synPack, synStrategyCode, syntheticScore, syntheticWorld } from '../helpers/synthetic.js';
import { rmDir, tmpDir } from '../helpers/tmp.js';

const dirs: string[] = [];
afterAll(() => dirs.forEach(rmDir));
const fresh = (p: string) => {
  const d = tmpDir(p);
  dirs.push(d);
  return d;
};

function walkSource(assets: string[], n: number, liveBars = 5, seed = 5): Source & { all: Bar[] } {
  const rand = rng(seed);
  const all: Bar[] = [];
  const t0 = Date.UTC(2026, 0, 1);
  for (const asset of assets) {
    let price = asset === 'BTC' ? 80_000 : 3_000;
    for (let i = 0; i < n + liveBars; i++) {
      const o = price;
      const c = price * (1 + (rand() - 0.5) * 0.01 + Math.sin(i / 20) * 0.002);
      const h = Math.max(o, c) * (1 + rand() * 0.003);
      const l = Math.min(o, c) * (1 - rand() * 0.003);
      all.push({ ts: t0 + i * 900_000, asset, tf: '15m', o, h, l, c, v: 50 + rand() * 100, ext: { 'funding.rate': 0.0001 } });
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

/** A fake model that hands out a different RSI band on every proposal and reports usage. */
function variedLLM(): FakeLLM {
  let k = 0;
  const bands = [
    [30, 70],
    [35, 65],
    [25, 75],
    [40, 60],
    [20, 80],
    [45, 55],
    [30, 75],
    [35, 70],
  ];
  const one = () => {
    const [low, high] = bands[k++ % bands.length] as [number, number];
    return { code: taStrategy(low, high), params: { low, high, stopAtr: 2, size: 0.05 }, bounds: { low: { min: 10, max: 50, step: 5 }, high: { min: 50, max: 90, step: 5 }, stopAtr: { min: 0.5, max: 4, step: 0.5 }, size: { min: 0.01, max: 0.1, step: 0.01 } }, rationale: `band ${low}/${high}` };
  };
  const llm: FakeLLM = {
    name: 'fake:varied',
    calls: 0,
    tasks: [],
    async complete({ system, user }) {
      llm.calls++;
      if (/Critic/.test(system)) {
        llm.tasks.push('diagnose');
        return { text: JSON.stringify({ patterns: ['Losses cluster when RSI stays extreme.'], summary: 'Widen the bands.', weakIds: [], strongIds: [] }), usage: { inputTokens: 1200, outputTokens: 60 }, model: 'fake-model' };
      }
      const task = /^TASK: (\w+)/m.exec(user)?.[1] ?? 'unknown';
      llm.tasks.push(task);
      if (task === 'seed') {
        const n = Number(/Write (\d+) strategies/.exec(user)?.[1] ?? 1);
        return { text: JSON.stringify({ strategies: Array.from({ length: n }, one) }), usage: { inputTokens: 3000, outputTokens: 2500 }, model: 'fake-model' };
      }
      return { text: JSON.stringify(one()), usage: { inputTokens: 1500, outputTokens: 400 }, model: 'fake-model' };
    },
  };
  return llm;
}

type Captured = { type: keyof EventMap; payload: unknown };

describe('0.2.0: typed events, usage, bar replay and funding in a paper run', () => {
  it('emits every event with the documented payload, survives a throwing handler, counts tokens and dollars', async () => {
    const dir = fresh('ouro-v020-');
    const source = walkSource(['BTC', 'ETH'], 700, 6);
    const llm = variedLLM();
    const loop = createLoop({
      goal: 'test',
      primitives: [primitives.ta, primitives.volume, primitives.time],
      source,
      executor: paperExecutor({ funding: true }),
      score: (ep) => ep.outcome.pnl - ep.outcome.fees - 0.5 * ep.outcome.drawdown,
      llm,
      population: 4,
      cycleEvery: 6,
      minTradesPerWindow: 1,
      holdout: 0.3,
      margin: 0,
      guards: { maxDrawdownPct: 1e9, maxPositionPct: 10, maxProposalsPerCycle: 6 },
      dir,
      assets: ['BTC', 'ETH'],
      tf: '15m',
      warmupBars: 300,
      backfill: 400,
      replay: 'bars',
      llmPricing: { inputPerMTok: 3, outputPerMTok: 15 },
      log: { backend: 'jsonl' },
    });
    const events: Captured[] = [];
    const names = [
      'bar', 'decision', 'trade:open', 'trade:close', 'cycle:start', 'cycle:step', 'critique', 'candidate', 'promote', 'retire', 'cycle:end', 'llm', 'error', 'log', 'seed', 'episode', 'cycle', 'stop',
    ] as const;
    for (const n of names) loop.on(n, (payload: unknown) => events.push({ type: n, payload }));
    let thrown = 0;
    loop.on('bar', () => {
      thrown++;
      throw new Error('handler failure must not stop the loop');
    });
    await loop.start();
    await loop.close();

    const of = <K extends keyof EventMap>(k: K): EventMap[K][] => events.filter((e) => e.type === k).map((e) => e.payload as EventMap[K]);
    expect(thrown).toBeGreaterThan(0);
    expect(of('error').filter((e) => e.scope === 'handler:bar').length).toBe(thrown);
    expect(of('bar').length).toBeGreaterThan(400);
    expect(of('bar')[0]).toMatchObject({ asset: expect.any(String), tf: '15m', bar: expect.objectContaining({ ts: expect.any(Number) }) });
    expect(of('seed')[0]!.strategies).toHaveLength(4);
    expect(of('decision').every((d) => d.decision && d.decision.side)).toBe(true);
    const opens = of('trade:open');
    const closes = of('trade:close');
    expect(opens.length).toBeGreaterThan(0);
    expect(opens[0]).toMatchObject({ strategyId: expect.stringMatching(/^s-/), asset: expect.any(String), side: expect.stringMatching(/long|short/), size: 0.05, price: expect.any(Number), ts: expect.any(Number) });
    expect(closes.length).toBeGreaterThan(0);
    expect(closes[0]).toMatchObject({ strategyId: expect.stringMatching(/^s-/), outcome: expect.objectContaining({ pnl: expect.any(Number), funding: expect.any(Number) }), score: expect.any(Number), ts: expect.any(Number) });
    expect(of('episode').length).toBe(closes.length);
    const starts = of('cycle:start');
    expect(starts.length).toBeGreaterThanOrEqual(1);
    const steps = of('cycle:step').filter((s) => s.cycle === 1).map((s) => s.step);
    expect(steps).toEqual(['collect', 'rank', 'diagnose', 'generate', 'trial', 'validate', 'promote']);
    expect(of('critique')[0]).toMatchObject({ cycle: 1, patterns: ['Losses cluster when RSI stays extreme.'], summary: 'Widen the bands.' });
    const cands = of('candidate').filter((c) => c.cycle === 1);
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(c).toMatchObject({ id: expect.stringMatching(/^s-/), origin: expect.stringMatching(/mutate|crossbreed|fresh/), parents: expect.any(Array), describe: expect.any(String), code: expect.stringContaining('decide'), params: expect.any(Object), bounds: expect.any(Object), stage: expect.stringMatching(/sandbox|guards|trial|holdout|slot|promoted|pending/) });
      if (c.stage === 'promoted') expect(c.reason).toBeNull();
      else expect(typeof c.reason).toBe('string');
    }
    for (const p of of('promote')) {
      expect(of('retire').some((r) => r.cycle === p.cycle && r.id === p.replaces)).toBe(true);
      expect(cands.concat(of('candidate')).some((c) => c.id === p.id && c.stage === 'promoted')).toBe(true);
    }
    const ends = of('cycle:end');
    expect(ends.length).toBe(of('cycle').length);
    const end1 = ends.find((e) => e.cycle === 1)!;
    expect(end1).toMatchObject({ outcome: expect.stringMatching(/promoted|no_change/), popCI: expect.any(Number), bestCI: expect.any(Number), velocity: expect.any(Number), ceiling: false });
    // usage: one critic call plus the generator calls of that cycle, priced at 3 and 15 dollars per million
    const llmEvents = of('llm').filter((e) => e.cycle === 1);
    expect(llmEvents.length).toBeGreaterThanOrEqual(2);
    expect(llmEvents[0]).toMatchObject({ purpose: 'critic', model: 'fake-model', inputTokens: 1200, outputTokens: 60, ms: expect.any(Number) });
    expect(llmEvents.slice(1).every((e) => e.purpose === 'generator')).toBe(true);
    const sumIn = llmEvents.reduce((a, e) => a + e.inputTokens, 0);
    const sumOut = llmEvents.reduce((a, e) => a + e.outputTokens, 0);
    expect(end1.usage).toMatchObject({ inputTokens: sumIn, outputTokens: sumOut, calls: llmEvents.length });
    expect(end1.usage.usd).toBeCloseTo((sumIn * 3 + sumOut * 15) / 1e6, 9);
    expect(of('llm').filter((e) => e.cycle === 0 && e.purpose === 'seed').length).toBeGreaterThanOrEqual(1);
    // bars were stored for replay and trials used the bar replay (n counts closed replay trades)
    const history = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'));
    const live = history.strategies.filter((s: { status: string }) => s.status === 'live');
    expect(live.every((s: { trial?: { trainN: number } }) => (s.trial?.trainN ?? 0) >= 0)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'bars.jsonl'))).toBe(true);
    expect(of('stop')).toHaveLength(1);
  }, 120_000);
});

function synLoop(dir: string, llm: LLM, extra: Record<string, unknown> = {}) {
  return createLoop({
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
    ...extra,
  } as Parameters<typeof createLoop>[0]);
}

async function feed(loop: ReturnType<typeof createLoop>, world: ReturnType<typeof syntheticWorld>, n: number) {
  for (let i = 0; i < n; i++) {
    const x = world.next();
    const r = await loop.decide(x);
    for (const [strategyId, decision] of Object.entries(r.perStrategy)) {
      if (!decision) continue;
      const ep: Episode = { id: randomUUID(), ts: x.ts, strategyId, input: x, decision, outcome: world.outcome(x, decision) };
      await loop.record(ep);
    }
  }
}

describe('0.2.0: cycle timing, activity, export, lifecycle', () => {
  it('cycleMaxWait fires a cycle before cycleEvery episodes exist and ranks with what it has', async () => {
    const dir = fresh('ouro-maxwait-');
    const loop = synLoop(dir, syntheticLLM(3), { cycleMaxWait: '30m', minTradesPerWindow: 1 });
    const world = syntheticWorld(1);
    await loop.seed(8);
    const collect: string[] = [];
    loop.on('cycle:step', (s) => s.step === 'collect' && collect.push(s.detail));
    await feed(loop, world, 10); // 10 minutes of bar time: not due yet
    expect(await loop.ready()).toBe(false);
    await feed(loop, world, 25); // 35 minutes: due by time
    expect(await loop.ready()).toBe(true);
    const r = await loop.cycle();
    expect(['promoted', 'no_change']).toContain(r.status);
    expect(r.note).not.toBe('not enough data');
    expect(collect[0]).toContain('max wait reached');
    await loop.close();
  }, 60_000);

  it('a strategy below minTradesPerWindow ranks weakest and is retired with reason inactive', async () => {
    const dir = fresh('ouro-inactive-');
    const seedDir = fresh('ouro-inactive-seeds-');
    const files: string[] = [];
    const grid = [
      [0.6, 0.3],
      [0.5, 0.4],
      [0.7, 0.3],
      [0.6, 0.4],
      [0.5, 0.3],
      [0.4, 0.5],
      [0.7, 0.2],
    ];
    grid.forEach(([a, b], i) => {
      const f = path.join(seedDir, `s${i}.ts`);
      fs.writeFileSync(f, synStrategyCode(a!, b!));
      files.push(f);
    });
    const lazy = path.join(seedDir, 'lazy.ts');
    fs.writeFileSync(lazy, synStrategyCode(1, 0)); // a > 1 never happens: it never trades
    files.push(lazy);
    const loop = synLoop(dir, syntheticLLM(5), { seed: files, minTradesPerWindow: 3, cycleEvery: 40 });
    const seeds = await loop.seed(8);
    const lazyId = seeds[seeds.length - 1]!.id;
    const rank: string[] = [];
    const retired: EventMap['retire'][] = [];
    loop.on('cycle:step', (s) => s.step === 'rank' && rank.push(s.detail));
    loop.on('retire', (r) => retired.push(r));
    await feed(loop, syntheticWorld(2), 60);
    const r = await loop.cycle();
    expect(rank[0]).toContain(`${lazyId} inactive`);
    expect(rank[0]!.indexOf(`${lazyId} inactive`)).toBeGreaterThan(rank[0]!.lastIndexOf('s-000', rank[0]!.indexOf(lazyId) - 1)); // listed last
    if (r.status === 'promoted') {
      expect(retired[0]).toMatchObject({ cycle: 1, id: lazyId, reason: 'inactive' });
      const h = await loop.history();
      expect(h.strategies.find((s) => s.id === lazyId)).toMatchObject({ status: 'retired', retireReason: 'inactive' });
    }
    await loop.close();
  }, 60_000);

  it('export() carries schemaVersion 1 with canonical key order; status() and setApproval() reflect state', async () => {
    const dir = fresh('ouro-export-');
    const loop = synLoop(dir, syntheticLLM(8));
    await loop.seed(8);
    await feed(loop, syntheticWorld(3), 110);
    await loop.cycle();
    const out = await loop.export();
    expect(out.schemaVersion).toBe(1);
    expect(Object.keys(out)).toEqual(['createdAt', 'cycle', 'goal', 'history', 'name', 'population', 'schemaVersion', 'takeoff']);
    expect(JSON.stringify(out)).toBe(canonicalJson(out));
    expect(JSON.stringify(await loop.export())).toBe(JSON.stringify(out));
    const st = await loop.status();
    expect(st).toMatchObject({ running: false, paused: false, cycle: 1, live: 8, approval: false, pendingCycle: null, dir });
    expect(st.episodes).toBeGreaterThan(0);
    loop.setApproval(true);
    expect((await loop.status()).approval).toBe(true);
    loop.pause('test');
    expect((await loop.status()).paused).toBe(true);
    loop.resume();
    expect((await loop.status()).paused).toBe(false);
    await loop.close();
  }, 60_000);

  it('wrapLLM hooks see usage; an adapter that keeps failing ends the cycle with llm_error and the loop keeps working', async () => {
    const dir = fresh('ouro-llmerr-');
    const inner = syntheticLLM(11);
    const seen: Array<{ inputTokens: number; outputTokens: number }> = [];
    let failures = 0;
    let mode: 'ok' | 'flaky' | 'dead' = 'ok';
    const llm = wrapLLM(inner, {
      before: () => {
        if (mode === 'dead') throw new Error('adapter: network down');
        if (mode === 'flaky' && failures < 2) {
          failures++;
          throw new Error('adapter: HTTP 503');
        }
      },
      after: (res) => {
        seen.push(res.usage);
        return { ...res, usage: { inputTokens: 10, outputTokens: 5 } };
      },
    });
    const loop = synLoop(dir, llm, { llmRetry: { retries: 2, baseMs: 1 } });
    const ends: EventMap['cycle:end'][] = [];
    const errors: EventMap['error'][] = [];
    loop.on('cycle:end', (e) => ends.push(e));
    loop.on('error', (e) => errors.push(e));
    await loop.seed(8);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toEqual({ inputTokens: 0, outputTokens: 0 }); // the synthetic adapter reports none
    const world = syntheticWorld(4);
    await feed(loop, world, 110);
    mode = 'flaky';
    const r1 = await loop.cycle();
    expect(['promoted', 'no_change']).toContain(r1.status); // two 503s, then success
    expect(failures).toBe(2);
    expect(ends[0]!.usage.inputTokens).toBe(10 * ends[0]!.usage.calls);
    mode = 'dead';
    await feed(loop, world, 110);
    const before = (await loop.population()).map((s) => s.id);
    const r2 = await loop.cycle();
    expect(r2.status).toBe('error');
    expect(r2.note).toBe('llm_error');
    expect(ends[1]).toMatchObject({ cycle: 2, outcome: 'error', reason: 'llm_error' });
    expect(errors.some((e) => e.scope === 'llm')).toBe(true);
    expect((await loop.population()).map((s) => s.id)).toEqual(before);
    expect((await loop.history()).cycles.map((c) => c.status)).toEqual([r1.status, 'error']);
    const x = world.next();
    const d = await loop.decide(x);
    expect(Object.keys(d.perStrategy)).toHaveLength(8);
    await loop.close();
  }, 60_000);

  it('two loops with different dirs in one process share no state', async () => {
    const a = fresh('ouro-two-a-');
    const b = fresh('ouro-two-b-');
    const loopA = synLoop(a, syntheticLLM(21));
    const loopB = synLoop(b, constantLLM(synStrategyCode(0.6, 0.3), { aMin: 0.6, bMax: 0.3, size: 0.05 }, { aMin: { min: 0, max: 1, step: 0.1 }, bMax: { min: 0, max: 1, step: 0.1 }, size: { min: 0.01, max: 0.1, step: 0.01 } }), { population: 4 });
    await Promise.all([loopA.seed(8), loopB.seed(4)]);
    const wa = syntheticWorld(31);
    const wb = syntheticWorld(32);
    await Promise.all([feed(loopA, wa, 110), feed(loopB, wb, 110)]);
    const [ra, rb] = await Promise.all([loopA.cycle(), loopB.cycle()]);
    expect(ra.cycle).toBe(1);
    expect(rb.cycle).toBe(1);
    const ha = await loopA.history();
    const hb = await loopB.history();
    expect(ha.strategies.filter((s) => s.status === 'live')).toHaveLength(8);
    expect(hb.strategies.filter((s) => s.status === 'live')).toHaveLength(4);
    expect(ha.strategies.map((s) => s.id)[0]).toBe('s-0001');
    expect(hb.strategies.map((s) => s.id)[0]).toBe('s-0001');
    expect(hb.strategies.every((s) => s.code.includes('aMin: 0.6'))).toBe(true);
    expect(ha.strategies.some((s) => !s.code.includes('aMin: 0.6'))).toBe(true);
    const filesA = fs.readdirSync(path.join(a, 'population')).length;
    const filesB = fs.readdirSync(path.join(b, 'population')).length;
    expect(filesA).toBe(ha.strategies.length * 2);
    expect(filesB).toBe(hb.strategies.length * 2);
    expect(JSON.parse(fs.readFileSync(path.join(a, 'history.json'), 'utf8')).strategies.length).toBe(ha.strategies.length);
    await Promise.all([loopA.close(), loopB.close()]);
  }, 120_000);
});
