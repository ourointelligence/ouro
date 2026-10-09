import type { LLM } from '../../src/plugins.js';
import { rng, snap, synStrategyCode } from './synthetic.js';

type Params = { aMin: number; bMax: number; size?: number };

function parseParamsBlocks(text: string): Params[] {
  const out: Params[] = [];
  const re = /params:?\s*(\{[^\n}]*\})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    try {
      const p = JSON.parse(m[1]!) as Params;
      if (typeof p.aMin === 'number' && typeof p.bMax === 'number') out.push(p);
    } catch {
      // not a params block we understand
    }
  }
  return out;
}

function parseStrongest(text: string): Params | null {
  const section = text.split('STRONGEST LIVE STRATEGIES')[1]?.split('\n\n')[0] ?? '';
  const blocks = parseParamsBlocks(section.replace(/params \{/g, 'params: {'));
  return blocks[0] ?? null;
}

function strategyJson(p: Params, rationale: string) {
  const aMin = snap(p.aMin);
  const bMax = snap(p.bMax);
  return {
    code: synStrategyCode(aMin, bMax, p.size ?? 0.05),
    params: { aMin, bMax, size: p.size ?? 0.05 },
    bounds: { aMin: { min: 0, max: 1, step: 0.1 }, bMax: { min: 0, max: 1, step: 0.1 }, size: { min: 0.01, max: 0.1, step: 0.01 } },
    rationale,
  };
}

export type FakeLLM = LLM & { calls: number; tasks: string[] };

/**
 * A deterministic stand-in for a model, answering the real Generator and Critic prompts for the synthetic domain.
 * seed: random grid points. mutate: step the parent one grid step toward the strongest live strategy (random
 * step when there is none). crossbreed: aMin from parent A, bMax from parent B. fresh: a random grid point.
 */
export function syntheticLLM(seed = 1): FakeLLM {
  const rand = rng(seed);
  const randomParams = (): Params => ({ aMin: snap(rand()), bMax: snap(rand()) });
  const step = (from: number, to: number) => (to > from ? snap(from + 0.1) : to < from ? snap(from - 0.1) : snap(from + (rand() < 0.5 ? -0.1 : 0.1)));
  const llm: FakeLLM = {
    name: 'fake:synthetic',
    calls: 0,
    tasks: [],
    async complete({ system, user }) {
      llm.calls++;
      if (/Critic/.test(system)) {
        llm.tasks.push('diagnose');
        const weakIds = [...user.matchAll(/^(s-\d+) \(weak\)/gm)].map((m) => m[1]!);
        const strongIds = [...user.matchAll(/^(s-\d+) \(strong\)/gm)].map((m) => m[1]!);
        return JSON.stringify({
          patterns: ['Losses cluster where a is small or b is large.', 'Wins need a above 0.6 and b below 0.3.'],
          summary: 'Weak strategies trade outside the profitable region; move aMin up and bMax down.',
          weakIds,
          strongIds,
        });
      }
      const task = /^TASK: (\w+)/m.exec(user)?.[1] ?? 'unknown';
      llm.tasks.push(task);
      if (task === 'seed') {
        const k = Number(/Write (\d+) strategies/.exec(user)?.[1] ?? 1);
        const strategies = Array.from({ length: k }, (_, i) => strategyJson(randomParams(), `seed ${i}: random grid point`));
        return JSON.stringify({ strategies });
      }
      if (task === 'mutate') {
        const parent = parseParamsBlocks(user.split('PARENT')[1] ?? '')[0] ?? randomParams();
        const best = parseStrongest(user);
        const which = rand() < 0.5 ? 'aMin' : 'bMax';
        const child: Params = { ...parent };
        if (best && (best.aMin !== parent.aMin || best.bMax !== parent.bMax)) {
          const key = best.aMin !== parent.aMin && (best.bMax === parent.bMax || which === 'aMin') ? 'aMin' : 'bMax';
          child[key] = step(parent[key], best[key]);
        } else {
          child[which] = step(parent[which], parent[which]);
        }
        return JSON.stringify(strategyJson(child, `mutate: moved ${which} from ${parent[which]} to ${child[which]}`));
      }
      if (task === 'crossbreed') {
        const a = parseParamsBlocks(user.split('PARENT A')[1]?.split('PARENT B')[0] ?? '')[0] ?? randomParams();
        const b = parseParamsBlocks(user.split('PARENT B')[1] ?? '')[0] ?? randomParams();
        const child: Params = rand() < 0.5 ? { aMin: a.aMin, bMax: b.bMax } : { aMin: b.aMin, bMax: a.bMax };
        return JSON.stringify(strategyJson(child, 'crossbreed: entry threshold from A, filter from B'));
      }
      // fresh or unknown
      return JSON.stringify(strategyJson(randomParams(), 'fresh: new random grid point'));
    },
  };
  return llm;
}

/** An LLM that always returns the same strategy for every generator task and a fixed diagnosis for the critic. */
export function constantLLM(code: string, params: Record<string, number>, bounds: Record<string, { min: number; max: number; step: number }>): FakeLLM {
  const llm: FakeLLM = {
    name: 'fake:constant',
    calls: 0,
    tasks: [],
    async complete({ system, user }) {
      llm.calls++;
      if (/Critic/.test(system)) {
        llm.tasks.push('diagnose');
        return JSON.stringify({ patterns: ['fixed'], summary: 'fixed diagnosis', weakIds: [], strongIds: [] });
      }
      const task = /^TASK: (\w+)/m.exec(user)?.[1] ?? 'unknown';
      llm.tasks.push(task);
      const one = { code, params, bounds, rationale: 'constant candidate' };
      if (task === 'seed') {
        const k = Number(/Write (\d+) strategies/.exec(user)?.[1] ?? 1);
        return JSON.stringify({ strategies: Array.from({ length: k }, () => one) });
      }
      return JSON.stringify(one);
    },
  };
  return llm;
}

/** Replies with recorded text per task; used for fixture-driven tests. */
export function scriptedLLM(replies: Record<string, string | string[]>): FakeLLM {
  const cursors: Record<string, number> = {};
  const llm: FakeLLM = {
    name: 'fake:scripted',
    calls: 0,
    tasks: [],
    async complete({ system, user }) {
      llm.calls++;
      const task = /Critic/.test(system) ? 'diagnose' : (/^TASK: (\w+)/m.exec(user)?.[1] ?? 'unknown');
      llm.tasks.push(task);
      const r = replies[task] ?? replies['*'];
      if (r === undefined) throw new Error(`scriptedLLM: no reply for task ${task}`);
      if (Array.isArray(r)) {
        const i = cursors[task] ?? 0;
        cursors[task] = i + 1;
        return r[Math.min(i, r.length - 1)]!;
      }
      return r;
    },
  };
  return llm;
}
