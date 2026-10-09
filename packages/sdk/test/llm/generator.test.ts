import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crossbreed, fresh, mutate, seed, systemPrompt, MODULE_CONTRACT } from '../../src/generator.js';
import { diagnose, buildCriticPrompt } from '../../src/critic.js';
import { LLMOutputError, completeJson, extractJson } from '../../src/llm/json.js';
import { Sandbox } from '../../src/sandbox.js';
import { primitiveDocs, primitives } from '../../src/primitives/index.js';
import type { Episode, Strategy } from '../../src/types.js';
import { scriptedLLM } from '../helpers/fakeLlm.js';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(here, '..', 'fixtures', name), 'utf8');

const docs = primitiveDocs([primitives.ta, primitives.volume, primitives.time]);
const sandbox = new Sandbox();
afterAll(() => sandbox.close());

const seedFix = JSON.parse(fixture('seed.json')) as { strategies: Array<{ code: string; params: Record<string, number>; rationale: string }> };
const s1: Strategy = { id: 's-0001', parentIds: [], origin: 'seed', cycleBorn: 0, code: seedFix.strategies[0]!.code, params: seedFix.strategies[0]!.params, rationale: seedFix.strategies[0]!.rationale, status: 'live', describe: 'RSI dips' };
const s2: Strategy = { id: 's-0002', parentIds: [], origin: 'seed', cycleBorn: 0, code: seedFix.strategies[1]!.code, params: seedFix.strategies[1]!.params, rationale: seedFix.strategies[1]!.rationale, status: 'live', describe: 'Hull crosses' };
const diagnosis = JSON.parse(fixture('diagnose.json'));

describe('generator prompts', () => {
  it('state the module contract verbatim, the feature keys and the rules', () => {
    const sys = systemPrompt({ llm: scriptedLLM({}), primitiveDocs: docs, maxSize: 0.1 });
    expect(sys).toContain(MODULE_CONTRACT);
    expect(sys).toContain("x.features['ta.hull21.crossUp']");
    expect(sys).toContain('No imports');
    expect(sys).toContain('pure function');
    expect(sys).toContain('params contains numbers only');
    expect(sys).toContain('Every key in params must appear in bounds');
    expect(sys).toContain('between 0 and 0.1');
  });
  it('include the constraints section when configured', async () => {
    const llm = scriptedLLM({ mutate: fixture('mutate.json') });
    let captured = '';
    const spy = { ...llm, complete: async (r: any) => ((captured = r.user), llm.complete(r)) };
    await mutate(s1, diagnosis, { llm: spy, primitiveDocs: docs, constraints: { allow: { entry: ['ta.rsi14'] }, bounds: { rsiLow: { min: 20, max: 40, step: 5 } }, freeze: ['size'] }, goal: 'g' });
    expect(captured).toContain('CONSTRAINTS');
    expect(captured).toContain('ta.rsi14');
    expect(captured).toContain('rsiLow must stay within [20, 40]');
    expect(captured).toContain('frozen keys');
    expect(captured).toContain('TASK: mutate');
    expect(captured).toContain(s1.code);
  });
});

describe('generator against recorded fixtures', () => {
  it('seed returns k validated proposals that compile in the sandbox', async () => {
    const llm = scriptedLLM({ seed: fixture('seed.json') });
    const out = await seed('goal', docs, 2, { llm });
    expect(out).toHaveLength(2);
    expect(out[0]!.origin).toBe('seed');
    for (const p of out) {
      const m = await sandbox.compile(p.code);
      expect(m.params).toEqual(p.params);
    }
  });
  it('mutate, crossbreed and fresh return one proposal each with the right origin and parents', async () => {
    const llm = scriptedLLM({ mutate: fixture('mutate.json'), crossbreed: fixture('crossbreed.json'), fresh: fixture('fresh.json') });
    const deps = { llm, primitiveDocs: docs, goal: 'goal' };
    const m = await mutate(s1, diagnosis, deps);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ origin: 'mutate', parentIds: ['s-0001'] });
    const c = await crossbreed(s1, s2, diagnosis, deps);
    expect(c[0]).toMatchObject({ origin: 'crossbreed', parentIds: ['s-0001', 's-0002'] });
    const f = await fresh('goal', diagnosis, docs, [{ id: 's-0001', describe: 'RSI dips', params: s1.params }], { llm });
    expect(f[0]).toMatchObject({ origin: 'fresh', parentIds: [] });
    for (const p of [...m, ...c, ...f]) await expect(sandbox.compile(p.code)).resolves.toBeTruthy();
    expect(llm.tasks).toEqual(['mutate', 'crossbreed', 'fresh']);
  });
});

describe('malformed model output', () => {
  it('is retried once, then thrown as LLMOutputError, and never produces a proposal', async () => {
    const llm = scriptedLLM({ '*': fixture('malformed.txt') });
    await expect(mutate(s1, diagnosis, { llm, primitiveDocs: docs })).rejects.toBeInstanceOf(LLMOutputError);
    expect(llm.calls).toBe(2);
  });
  it('succeeds when the retry is valid and tells the model what was wrong', async () => {
    const llm = scriptedLLM({ mutate: [fixture('malformed.txt'), fixture('mutate.json')] });
    const seen: string[] = [];
    const spy = { ...llm, complete: async (r: any) => (seen.push(r.user), llm.complete(r)) };
    const out = await mutate(s1, diagnosis, { llm: spy, primitiveDocs: docs });
    expect(out).toHaveLength(1);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatch(/previous reply was not valid/);
  });
  it('extractJson tolerates fences and prose', () => {
    expect(JSON.parse(extractJson('Here you go:\n```json\n{"a": 1}\n```\nthanks'))).toEqual({ a: 1 });
    expect(JSON.parse(extractJson('prefix [1,2] suffix'))).toEqual([1, 2]);
  });
  it('completeJson rejects schema violations after a retry', async () => {
    const llm = scriptedLLM({ '*': '{"patterns": "not-an-array"}' });
    await expect(completeJson(llm, { system: 'Critic', user: 'x', schema: z.object({ patterns: z.array(z.string()) }) })).rejects.toThrow(/invalid JSON after 2 attempts/);
    expect(llm.calls).toBe(2);
  });
});

describe('critic', () => {
  function ep(i: number, strategyId: string, pnl: number): Episode {
    const ts = Date.UTC(2026, 0, 1, (i * 3) % 24, 0) + i * 60_000;
    return {
      id: `${strategyId}-${i}`,
      ts,
      strategyId,
      input: { ts, asset: i % 2 ? 'BTC' : 'ETH', bar: { ts, asset: 'BTC', tf: '15m', o: 1, h: 1, l: 1, c: 1, v: 1 }, features: { 'ta.rsi14': 20 + i, 'ta.atr14': 100, 'time.hour': (i * 3) % 24, 'volume.volRatio': 0.5 + i / 10, 'ta.hull21.crossUp': i % 3 === 0 } },
      decision: { side: 'long', size: 0.05 },
      outcome: { pnl, fees: 0.007, drawdown: Math.max(0, -pnl), holdBars: i, closedTs: ts + 900_000 },
      score: pnl - 0.007,
    };
  }
  const weak = { 's-0001': Array.from({ length: 30 }, (_, i) => ep(i, 's-0001', i % 2 ? -0.3 : 0.1)) };
  const strong = { 's-0002': Array.from({ length: 30 }, (_, i) => ep(i, 's-0002', i % 3 ? 0.2 : -0.1)) };

  it('summarises episodes into compact rows within the token budget', () => {
    const prompt = buildCriticPrompt(weak, strong, [s1, s2], 'goal', 4000);
    expect(prompt.length).toBeLessThanOrEqual(16000);
    expect(prompt).toContain('s-0001 (weak) worst 10 of 30');
    expect(prompt).toContain('s-0002 (strong) best 5 of 30');
    expect(prompt).toMatch(/BTC long pnl=-0.300 hold=\d+ hour=\d+ volRatio=\d\.\d+ rsi14=/);
    const tight = buildCriticPrompt(weak, strong, [s1, s2], 'goal', 400);
    expect(tight.length).toBeLessThanOrEqual(1600);
  });
  it('returns a validated diagnosis from the fixture, capped at 5 patterns and 60 words', async () => {
    const llm = scriptedLLM({ diagnose: fixture('diagnose.json') });
    const d = await diagnose(weak, strong, [s1, s2], { llm });
    expect(d.patterns.length).toBeLessThanOrEqual(5);
    expect(d.summary.split(/\s+/).length).toBeLessThanOrEqual(60);
    expect(d.weakIds).toEqual(['s-0001']);
    expect(d.strongIds).toEqual(['s-0002']);
  });
  it('throws LLMOutputError after one retry on malformed output', async () => {
    const llm = scriptedLLM({ diagnose: fixture('malformed.txt') });
    await expect(diagnose(weak, strong, [s1, s2], { llm })).rejects.toBeInstanceOf(LLMOutputError);
    expect(llm.calls).toBe(2);
  });
});
