// Crash-test child: runs one cycle of a synthetic loop against the built SDK and kills itself at a given step.
// usage: node crash-child.mjs <dir> <killStep|none>
/* global process, console */
import { createLoop } from '../../dist/index.js';
import { randomUUID } from 'node:crypto';

const [dir, killStep] = process.argv.slice(2);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const snap = (v) => Number(Math.min(1, Math.max(0, Math.round(v * 10) / 10)).toFixed(2));
const code = (aMin, bMax) => `export const params = { aMin: ${aMin}, bMax: ${bMax}, size: 0.05 };
export const bounds = { aMin: { min: 0, max: 1, step: 0.1 }, bMax: { min: 0, max: 1, step: 0.1 }, size: { min: 0.01, max: 0.1, step: 0.01 } };
export function decide(x: Input, p: typeof params): Decision {
  const a = x.features['syn.a']; const b = x.features['syn.b'];
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  if (a > p.aMin && b < p.bMax) return { side: 'long', size: p.size };
  return null;
}
export const describe = 'Long when a > ${aMin} and b < ${bMax}.';`;
const rand = rng(99);
const one = () => {
  const aMin = snap(rand());
  const bMax = snap(rand());
  return { code: code(aMin, bMax), params: { aMin, bMax, size: 0.05 }, bounds: { aMin: { min: 0, max: 1, step: 0.1 }, bMax: { min: 0, max: 1, step: 0.1 }, size: { min: 0.01, max: 0.1, step: 0.01 } }, rationale: 'random grid point' };
};
const llm = {
  name: 'fake:crash',
  async complete({ system, user }) {
    if (/Critic/.test(system)) return JSON.stringify({ patterns: ['p'], summary: 'move thresholds', weakIds: [], strongIds: [] });
    if (/^TASK: seed/m.test(user)) {
      const n = Number(/Write (\d+) strategies/.exec(user)?.[1] ?? 1);
      return JSON.stringify({ strategies: Array.from({ length: n }, one) });
    }
    return JSON.stringify(one());
  },
};
const synPack = {
  name: 'syn',
  compute: () => ({ a: null, b: null }),
  describe: () => [
    { key: 'a', doc: 'a' },
    { key: 'b', doc: 'b' },
  ],
};
const loop = createLoop({
  goal: 'synthetic',
  primitives: [synPack],
  source: { name: 'none', async *subscribe() {}, async history() { return []; } },
  executor: { name: 'none', async place() { return { orderId: 'x' }; }, onClose() {} },
  score: (ep) => ep.outcome.pnl - ep.outcome.fees,
  llm,
  population: 8,
  cycleEvery: 100,
  dir,
  assets: ['SYN'],
  tf: '1m',
  autoCycle: false,
  log: { backend: 'jsonl' },
  guards: { maxDrawdownPct: 1e9, maxPositionPct: 10, maxProposalsPerCycle: 6 },
});
loop.on('cycle:step', (s) => {
  if (s.step === killStep) process.kill(process.pid, 'SIGKILL');
});
const status = await loop.status();
if (status.live === 0) await loop.seed(8);
if (status.episodes < 150) {
  const world = rng(7);
  let ts = 1_700_000_000_000;
  for (let i = 0; i < 150; i++) {
    ts += 60_000;
    const a = snap(world());
    const b = snap(world());
    const x = { ts, asset: 'SYN', bar: { ts, asset: 'SYN', tf: '1m', o: 1, h: 1, l: 1, c: 1, v: 1 }, features: { 'syn.a': a, 'syn.b': b } };
    const r = await loop.decide(x);
    for (const [strategyId, decision] of Object.entries(r.perStrategy)) {
      if (!decision) continue;
      const good = a > 0.6 && b < 0.3;
      const pnl = (good ? 1 : -0.4) + (world() - 0.5) * 0.2;
      await loop.record({ id: randomUUID(), ts, strategyId, input: x, decision, outcome: { pnl, fees: 0.02, drawdown: 0, holdBars: 1, closedTs: ts + 60_000 } });
    }
  }
}
const r = await loop.cycle();
const h = await loop.history();
console.log(JSON.stringify({ cycle: r.cycle, status: r.status, cycles: h.cycles.map((c) => c.cycle), live: h.strategies.filter((s) => s.status === 'live').length, ids: h.strategies.map((s) => s.id), episodes: (await loop.status()).episodes }));
await loop.close();
