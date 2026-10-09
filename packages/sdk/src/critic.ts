import { z } from 'zod';
import type { Diagnosis, Episode, Strategy } from './types.js';
import type { LLM } from './plugins.js';
import { OURO_NAME } from './constants.js';
import { completeJson } from './llm/json.js';
import { scanFeatureKeys } from './sandbox.js';

export type CriticDeps = { llm: LLM; goal?: string; maxTokens?: number; /** Approximate prompt budget in tokens. Default 4000. */ budgetTokens?: number };

const DiagnosisOut = z.object({
  patterns: z.array(z.string()).max(8),
  summary: z.string().min(1),
  weakIds: z.array(z.string()).default([]),
  strongIds: z.array(z.string()).default([]),
});

export const WORST_PER_STRATEGY = 10;
export const BEST_PER_STRATEGY = 5;

export const CRITIC_SYSTEM = `You are the Critic inside ${OURO_NAME}, a recursive self-improvement loop. You read the agent's own worst and best episodes and explain, in plain terms, what the weak strategies get wrong and what the strong ones get right, so the Generator can rewrite them. Be concrete: name the feature, the hour, the asset, the direction, the threshold. Never suggest anything that needs data the strategies cannot see.

Reply with one JSON object: { "patterns": string[] (at most 5, one sentence each), "summary": string (at most 60 words), "weakIds": string[], "strongIds": string[] }.`;

function num(v: unknown, digits = 3): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(digits);
  if (typeof v === 'boolean') return v ? 'T' : 'F';
  return '-';
}

/** One compact row per episode: ts, asset, side, pnl, holdBars, hour, volRatio, top 3 feature values. */
export function episodeRow(ep: Episode, featureKeys: string[]): string {
  const f = ep.input.features;
  const ts = new Date(ep.ts).toISOString().slice(0, 16).replace('T', ' ');
  const hour = typeof f['time.hour'] === 'number' ? f['time.hour'] : new Date(ep.input.ts).getUTCHours();
  const top = featureKeys.slice(0, 3).map((k) => `${k.replace(/^[a-z]+\./, '')}=${num(f[k])}`);
  return `${ts} ${ep.input.asset} ${ep.decision?.side ?? 'none'} pnl=${num(ep.outcome.pnl)} hold=${ep.outcome.holdBars} hour=${hour} volRatio=${num(f['volume.volRatio'], 2)} ${top.join(' ')}`.trim();
}

function pickKeys(s: Strategy | undefined, sample: Episode | undefined): string[] {
  const fromCode = s ? scanFeatureKeys(s.code) : [];
  if (fromCode.length >= 3) return fromCode;
  const numeric = sample ? Object.entries(sample.input.features).filter(([, v]) => typeof v === 'number').map(([k]) => k) : [];
  return [...fromCode, ...numeric.filter((k) => !fromCode.includes(k))];
}

export function scoreOf(ep: Episode): number {
  return typeof ep.score === 'number' ? ep.score : ep.outcome.pnl - ep.outcome.fees;
}

/** Build the user prompt with a hard character budget (about 4 chars per token). */
export function buildCriticPrompt(
  weakEpisodes: Record<string, Episode[]>,
  strongEpisodes: Record<string, Episode[]>,
  liveStrategies: Strategy[],
  goal: string | undefined,
  budgetTokens = 4000,
): string {
  const byId = new Map(liveStrategies.map((s) => [s.id, s]));
  const live = liveStrategies.map((s) => `- ${s.id}: ${s.describe ?? s.rationale.split('.')[0]} | params ${JSON.stringify(s.params)}`).join('\n');
  let worstN = WORST_PER_STRATEGY;
  let bestN = BEST_PER_STRATEGY;
  const build = () => {
    const sections: string[] = [];
    sections.push(`GOAL: ${goal ?? '(see strategies)'}\n\nLIVE STRATEGIES:\n${live}`);
    const weak = Object.entries(weakEpisodes).map(([id, eps]) => {
      const keys = pickKeys(byId.get(id), eps[0]);
      const worst = [...eps].sort((a, b) => scoreOf(a) - scoreOf(b)).slice(0, worstN);
      return `${id} (weak) worst ${worst.length} of ${eps.length} episodes:\n${worst.map((e) => episodeRow(e, keys)).join('\n')}`;
    });
    const strong = Object.entries(strongEpisodes).map(([id, eps]) => {
      const keys = pickKeys(byId.get(id), eps[0]);
      const best = [...eps].sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, bestN);
      return `${id} (strong) best ${best.length} of ${eps.length} episodes:\n${best.map((e) => episodeRow(e, keys)).join('\n')}`;
    });
    sections.push(`WEAK STRATEGIES, WORST EPISODES (ts asset side pnl hold hour volRatio features):\n${weak.join('\n\n') || 'none'}`);
    sections.push(`STRONG STRATEGIES, BEST EPISODES:\n${strong.join('\n\n') || 'none'}`);
    sections.push('Diagnose: which conditions produce the losses, which produce the wins, and what the weak strategies should change. Name the weak and strong ids.');
    return sections.join('\n\n');
  };
  let prompt = build();
  const budgetChars = budgetTokens * 4;
  while (prompt.length > budgetChars && (worstN > 2 || bestN > 1)) {
    worstN = Math.max(2, worstN - 2);
    bestN = Math.max(1, bestN - 1);
    prompt = build();
  }
  return prompt.length > budgetChars ? prompt.slice(0, budgetChars) : prompt;
}

/** Read the worst episodes of the weak strategies and the best of the strong ones; return a short diagnosis. */
export async function diagnose(
  weakEpisodes: Record<string, Episode[]>,
  strongEpisodes: Record<string, Episode[]>,
  liveStrategies: Strategy[],
  deps: CriticDeps,
): Promise<Diagnosis> {
  const user = buildCriticPrompt(weakEpisodes, strongEpisodes, liveStrategies, deps.goal, deps.budgetTokens);
  const out = await completeJson(deps.llm, { system: CRITIC_SYSTEM, user, schema: DiagnosisOut, maxTokens: deps.maxTokens ?? 1024 });
  const known = new Set(liveStrategies.map((s) => s.id));
  const words = out.summary.split(/\s+/);
  const weakSet = new Set(Object.keys(weakEpisodes));
  const strongSet = new Set(Object.keys(strongEpisodes));
  return {
    patterns: out.patterns.slice(0, 5),
    summary: words.length > 60 ? words.slice(0, 60).join(' ') : out.summary,
    weakIds: [...new Set([...out.weakIds.filter((id) => known.has(id)), ...weakSet])],
    strongIds: [...new Set([...out.strongIds.filter((id) => known.has(id)), ...strongSet])],
  };
}

export const EMPTY_DIAGNOSIS: Diagnosis = { patterns: [], summary: '', weakIds: [], strongIds: [] };

export const critic = { diagnose };
