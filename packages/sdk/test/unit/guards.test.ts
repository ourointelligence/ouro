import { afterAll, describe, expect, it } from 'vitest';
import { check, clampParams, DEFAULT_GUARDS } from '../../src/guards.js';
import { Sandbox } from '../../src/sandbox.js';
import type { Episode, GuardConfig, Strategy } from '../../src/types.js';
import { synStrategyCode } from '../helpers/synthetic.js';

const sandbox = new Sandbox();
afterAll(() => sandbox.close());

const score = (e: Episode) => e.outcome.pnl - e.outcome.fees;
const cfg: GuardConfig = { ...DEFAULT_GUARDS, maxDrawdownPct: 8, maxPositionPct: 10 };
const ctx = () => ({ sandbox, scorer: score, episodes: [] as Episode[] });

function proposal(code: string, params: Record<string, number> = {}) {
  return { origin: 'fresh' as const, parentIds: [], code, params, rationale: 'test' };
}

function episode(i: number, a: number, b: number, pnl: number): Episode {
  const ts = 1000 + i;
  return {
    id: `e${i}`,
    ts,
    strategyId: 'x',
    input: { ts, asset: 'SYN', bar: { ts, asset: 'SYN', tf: '1m', o: 1, h: 1, l: 1, c: 1, v: 1 }, features: { 'syn.a': a, 'syn.b': b } },
    decision: { side: 'long', size: 0.05 },
    outcome: { pnl, fees: 0, drawdown: 0, holdBars: 1, closedTs: ts },
  };
}

describe('clampParams', () => {
  it('snaps to [min, max] and to the step grid', () => {
    const bounds = { a: { min: 0, max: 1, step: 0.1 }, b: { min: 10, max: 20, step: 5 }, c: { min: -1, max: 1, step: 0.25 } };
    expect(clampParams({ a: 0.34, b: 3, c: 0.3 }, bounds)).toEqual({ a: 0.3, b: 10, c: 0.25 });
    expect(clampParams({ a: 1.7, b: 17.6, c: -0.9 }, bounds)).toEqual({ a: 1, b: 20, c: -1 });
    expect(clampParams({ a: 0.25 }, bounds).a).toBeCloseTo(0.3, 10);
  });
  it('passes keys without bounds through', () => {
    expect(clampParams({ z: 42 }, {})).toEqual({ z: 42 });
  });
});

describe('check', () => {
  it('accepts a clean module and returns its compiled metadata', async () => {
    const v = await check(proposal(synStrategyCode(0.6, 0.3)), cfg, ctx());
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.module.describe).toMatch(/Long when/);
      expect(v.params).toEqual({ aMin: 0.6, bMax: 0.3, size: 0.05 });
    }
  });

  it('rejects imports and the other forbidden tokens', async () => {
    const bad = `import fs from 'fs';\n` + synStrategyCode(0.6, 0.3);
    const v = await check(proposal(bad), cfg, ctx());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/sandbox: forbidden token: import/);
    for (const [snippet, label] of [
      ['const r = require("fs");', 'require'],
      ['const f = fetch;', 'fetch'],
      ['const e = process.env;', 'process'],
      ['const g = globalThis;', 'globalThis'],
      ['const z = eval("1");', 'eval'],
      ['const F = Function;', 'Function'],
      ['while(true) {}', 'while(true)'],
    ]) {
      const r = await check(proposal(synStrategyCode(0.6, 0.3, 0.05, snippet)), cfg, ctx());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(label);
    }
  });

  it('rejects a changed frozen key', async () => {
    const parent: Strategy = {
      id: 's-0001',
      parentIds: [],
      origin: 'seed',
      cycleBorn: 0,
      code: synStrategyCode(0.6, 0.3),
      params: { aMin: 0.6, bMax: 0.3, size: 0.05 },
      rationale: 'parent',
      status: 'live',
    };
    const frozen: GuardConfig = { ...cfg, freeze: ['size'] };
    const changed = await check({ ...proposal(synStrategyCode(0.6, 0.3, 0.07), { size: 0.07 }), origin: 'mutate', parentIds: ['s-0001'] }, frozen, { ...ctx(), parents: [parent] });
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.reason).toMatch(/^freeze: "size" changed/);
    const kept = await check({ ...proposal(synStrategyCode(0.7, 0.3), { aMin: 0.7 }), origin: 'mutate', parentIds: ['s-0001'] }, frozen, { ...ctx(), parents: [parent] });
    expect(kept.ok).toBe(true);
  });

  it('rejects params outside module bounds and outside user bounds', async () => {
    const outside = await check(proposal(synStrategyCode(0.6, 0.3), { aMin: 1.5 }), cfg, ctx());
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.reason).toMatch(/^bounds: aMin=1.5 outside module bounds/);
    const user = await check(proposal(synStrategyCode(0.9, 0.3)), { ...cfg, bounds: { aMin: { min: 0, max: 0.8, step: 0.1 } } }, ctx());
    expect(user.ok).toBe(false);
    if (!user.ok) expect(user.reason).toMatch(/outside user bounds/);
    const missing = await check(proposal(synStrategyCode(0.6, 0.3), { extra: 1 }), cfg, ctx());
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toMatch(/has no entry in bounds/);
  });

  it('rejects a feature outside the allow list and unknown features', async () => {
    const v = await check(proposal(synStrategyCode(0.6, 0.3)), { ...cfg, allow: { entry: ['syn.a'] } }, ctx());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/^allow: feature "syn.b"/);
    const unknown = await check(proposal(synStrategyCode(0.6, 0.3)), cfg, { ...ctx(), featureKeys: ['syn.a', 'syn.b', 'syn.n'] });
    expect(unknown.ok).toBe(true);
    const unknown2 = await check(proposal(synStrategyCode(0.6, 0.3)), cfg, { ...ctx(), featureKeys: ['syn.a'] });
    expect(unknown2.ok).toBe(false);
    if (!unknown2.ok) expect(unknown2.reason).toMatch(/^unknown feature: "syn.b"/);
  });

  it('rejects oversize positions found during replay', async () => {
    const big = synStrategyCode(0.0, 1.0, 0.1).replace('size: { min: 0.01, max: 0.1, step: 0.01 }', 'size: { min: 0.01, max: 1, step: 0.01 }');
    const eps = [episode(1, 0.9, 0.1, 1)];
    const v = await check(proposal(big, { size: 0.5 }), cfg, { ...ctx(), episodes: eps });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/^size: position size 0.5 exceeds 10% cap/);
  });

  it('rejects replay drawdown above maxDrawdownPct', async () => {
    const eps = [episode(1, 0.9, 0.1, 1), episode(2, 0.9, 0.1, -5), episode(3, 0.9, 0.1, -5)];
    const v = await check(proposal(synStrategyCode(0.0, 1.0)), { ...cfg, maxDrawdownPct: 8 }, { ...ctx(), episodes: eps });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/^drawdown: replay max drawdown 10.000 exceeds 8/);
    const ok = await check(proposal(synStrategyCode(0.0, 1.0)), { ...cfg, maxDrawdownPct: 20 }, { ...ctx(), episodes: eps });
    expect(ok.ok).toBe(true);
  });
});
