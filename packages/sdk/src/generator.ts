import { z } from 'zod';
import type { Bounds, Diagnosis, Proposal, SeedProposal, Strategy } from './types.js';
import type { LLM } from './plugins.js';
import { OURO_NAME } from './constants.js';
import { completeJson, type LLMCallInfo } from './llm/json.js';

export type PrimitiveDoc = { key: string; doc: string };

export type Constraints = { allow?: Record<string, string[]>; bounds?: Bounds; freeze?: string[] };

export type GeneratorDeps = {
  llm: LLM;
  /** Prefixed feature docs, the only keys a strategy may read. */
  primitiveDocs: PrimitiveDoc[];
  constraints?: Constraints;
  /** Upper bound for Decision.size, as a fraction (0.1 = 10%). */
  maxSize?: number;
  goal?: string;
  maxTokens?: number;
  /** The strongest live strategies, shown to mutate and crossbreed as a reference point. */
  strongSummaries?: LiveSummary[];
  /** Called after every model call with its usage. */
  onCall?: (info: LLMCallInfo) => void;
};

export type LiveSummary = { id: string; describe: string; params: Record<string, number>; holdoutScore?: number };

function liveSection(title: string, items: LiveSummary[] | undefined): string {
  if (!items?.length) return '';
  const rows = items.map(
    (s) => `- ${s.id}: ${s.describe} params ${JSON.stringify(s.params)}${s.holdoutScore !== undefined ? ` holdout ${s.holdoutScore.toFixed(4)}` : ''}`,
  );
  return `${title}\n${rows.join('\n')}\n`;
}

const BoundsSchema = z.record(z.string(), z.object({ min: z.number(), max: z.number(), step: z.number() }));

const ProposalOut = z.object({
  code: z.string().min(40),
  params: z.record(z.string(), z.number()),
  bounds: BoundsSchema.optional(),
  rationale: z.string().min(1),
});

const SeedOut = z.object({ strategies: z.array(ProposalOut).min(1) });

/** The strategy module contract, stated verbatim in every generator prompt. */
export const MODULE_CONTRACT = `export const params: Record<string, number>;
export const bounds: Record<string, { min: number; max: number; step: number }>;
export function decide(x: Input, p: typeof params): Decision;
export const describe: string;   // one sentence, plain English`;

export const CONTRACT_TYPES = `type Bar = { ts: number; asset: string; tf: string; o: number; h: number; l: number; c: number; v: number };
type Input = { ts: number; asset: string; bar: Bar; features: Record<string, number | boolean | null>; meta?: Record<string, unknown> };
type Decision = { side: 'long' | 'short' | 'flat'; size: number; stop?: number; tp?: number; tag?: string } | null;`;

export function systemPrompt(deps: GeneratorDeps): string {
  const maxSize = deps.maxSize ?? 0.1;
  const keys = deps.primitiveDocs.map((d) => `- x.features['${d.key}']: ${d.doc}`).join('\n');
  return `You are the Generator inside ${OURO_NAME}, a recursive self-improvement loop. You write small, pure strategy modules in TypeScript. Each module is compiled and run in a locked-down sandbox, replayed on real episodes, and promoted only if it beats the population on data it has never seen.

MODULE CONTRACT. Every module has exactly these four exports and nothing else:
${MODULE_CONTRACT}

Types in scope (do not declare them, do not import them):
${CONTRACT_TYPES}

RULES
- No imports, no require, no fetch, no process, no globalThis, no eval, no Function, no while(true), no for(;;), no timers. The only globals are Math, Number and JSON. Do not use the words import, require, fetch, process, eval or Function anywhere in the file, not even in strings or comments.
- decide must be a pure function of (x, p): same input and params, same output. No state outside the call, no randomness, no Date.
- params contains numbers only. Every key in params must appear in bounds with min, max and step, and the default value must sit inside [min, max]. Never reference a key in p that is not in params.
- Read features only through x.features['<key>'] with the exact keys listed below. A feature is null when its indicator has no data yet: treat null as unknown and return null (no trade) rather than guess. Compare numbers only after checking typeof === 'number'.
- Decision: side 'long' or 'short' opens or holds a position; 'flat' closes any open position; null means no opinion (hold whatever is open). size is the fraction of equity to commit, a number between 0 and ${maxSize}. stop and tp are optional distances from the entry price in price units (for example 1.5 * atr14). Prefer explicit stops.
- describe is one plain-English sentence a non-coder understands.
- Keep the module under 60 lines. Prefer two or three conditions over ten.

ALLOWED FEATURE KEYS (the only keys that exist):
${keys}

OUTPUT. Reply with one JSON document and nothing else, in the shape the task asks for. Each strategy is an object:
{ "code": "<the full TypeScript module as one string>", "params": { "<key>": <number> }, "bounds": { "<key>": { "min": <number>, "max": <number>, "step": <number> } }, "rationale": "<two sentences on why this should score well>" }
"params" and "bounds" must match the module's exports exactly.`;
}

export function constraintsSection(c?: Constraints): string {
  if (!c || (!c.allow && !c.bounds && !c.freeze?.length)) return '';
  const lines: string[] = ['CONSTRAINTS (hard rules, candidates breaking them are rejected before trial):'];
  if (c.allow) {
    for (const [group, keys] of Object.entries(c.allow)) lines.push(`- ${group}: only these feature keys may be read: ${keys.join(', ')}`);
  }
  if (c.bounds) {
    for (const [k, b] of Object.entries(c.bounds)) lines.push(`- param ${k} must stay within [${b.min}, ${b.max}] (step ${b.step})`);
  }
  if (c.freeze?.length) lines.push(`- frozen keys, never change their value from the parent: ${c.freeze.join(', ')}`);
  return lines.join('\n') + '\n';
}

function diagnosisSection(d: Diagnosis): string {
  if (!d.summary && !d.patterns.length) return 'DIAGNOSIS: none yet (first cycle).\n';
  return `DIAGNOSIS FROM THE CRITIC (what went wrong and what worked):
summary: ${d.summary}
patterns:
${d.patterns.map((p) => `- ${p}`).join('\n')}
weak strategies: ${d.weakIds.join(', ') || 'none'}
strong strategies: ${d.strongIds.join(', ') || 'none'}
`;
}

function strategySection(label: string, s: Strategy): string {
  const t = s.trial ? `train ${s.trial.trainScore.toFixed(4)}, holdout ${s.trial.holdoutScore.toFixed(4)}, max drawdown ${s.trial.maxDrawdown.toFixed(3)}` : 'no trial yet';
  return `${label} ${s.id} (origin ${s.origin}, born cycle ${s.cycleBorn}; ${t})
params: ${JSON.stringify(s.params)}
code:
${s.code}
`;
}

function toProposal(o: z.infer<typeof ProposalOut>, origin: Proposal['origin'], parentIds: string[]): Proposal {
  return { origin, parentIds, code: o.code, params: o.params, rationale: o.rationale };
}

/** First generation: k diverse strategies written from the goal and the primitive docs alone. */
export async function seed(goal: string, primitiveDocs: PrimitiveDoc[], k: number, deps: Omit<GeneratorDeps, 'primitiveDocs'>): Promise<SeedProposal[]> {
  const d = { ...deps, primitiveDocs };
  const user = `TASK: seed
GOAL: ${goal}

Write ${k} strategies that are structurally different from each other: different core signals (trend, momentum, mean reversion, volatility breakout, time-of-day filters, volume confirmation), different holding styles (tight stop and target versus signal-to-signal) and at least one that also trades short. Each must be a complete module obeying the contract.
${constraintsSection(deps.constraints)}
Return { "strategies": [ ...${k} strategy objects... ] }.`;
  const out = await completeJson(deps.llm, { system: systemPrompt(d), user, schema: SeedOut, maxTokens: deps.maxTokens ?? 8192, onCall: deps.onCall });
  return out.strategies.slice(0, k).map((o) => ({ origin: 'seed' as const, parentIds: [], code: o.code, params: o.params, rationale: o.rationale }));
}

/** One mutation of a strategy: parameters moved inside bounds, or exactly one feature swapped. */
export async function mutate(strategy: Strategy, diagnosis: Diagnosis, deps: GeneratorDeps): Promise<Proposal[]> {
  const user = `TASK: mutate
GOAL: ${deps.goal ?? ''}

${diagnosisSection(diagnosis)}
${liveSection('STRONGEST LIVE STRATEGIES (reference for the direction to move in):', deps.strongSummaries)}
${strategySection('PARENT', strategy)}
Produce exactly ONE mutation of the parent. Choose one of:
(a) change one or more parameter values, each staying inside its bounds, in the direction the diagnosis suggests; or
(b) swap exactly one feature key for another from the allowed list, keeping the rest of the structure.
Do not rewrite the strategy. Keep the same keys in params unless you swap a feature that needs a new threshold. If the parent read a feature that was null too often, add a null guard rather than removing the idea.
${constraintsSection(deps.constraints)}
Return one strategy object { "code", "params", "bounds", "rationale" }.`;
  const out = await completeJson(deps.llm, { system: systemPrompt(deps), user, schema: ProposalOut, maxTokens: deps.maxTokens ?? 4096, onCall: deps.onCall });
  return [toProposal(out, 'mutate', [strategy.id])];
}

/** One child combining the entry logic of `a` with the exit and filter logic of `b`. */
export async function crossbreed(a: Strategy, b: Strategy, diagnosis: Diagnosis, deps: GeneratorDeps): Promise<Proposal[]> {
  const user = `TASK: crossbreed
GOAL: ${deps.goal ?? ''}

${diagnosisSection(diagnosis)}
${liveSection('STRONGEST LIVE STRATEGIES:', deps.strongSummaries)}
${strategySection('PARENT A (entry donor)', a)}
${strategySection('PARENT B (exit and filter donor)', b)}
Produce exactly ONE child: take the entry signal from parent A and the exit rules and filters (stop, tp, time or volume filters, flat conditions) from parent B. Merge params from both parents, keeping each inside its bounds. The child must still obey the contract.
${constraintsSection(deps.constraints)}
Return one strategy object { "code", "params", "bounds", "rationale" }.`;
  const out = await completeJson(deps.llm, { system: systemPrompt(deps), user, schema: ProposalOut, maxTokens: deps.maxTokens ?? 4096, onCall: deps.onCall });
  return [toProposal(out, 'crossbreed', [a.id, b.id])];
}

/** One brand-new strategy that differs structurally from every live one. */
export async function fresh(
  goal: string,
  diagnosis: Diagnosis,
  primitiveDocs: PrimitiveDoc[],
  liveSummaries: LiveSummary[],
  deps: Omit<GeneratorDeps, 'primitiveDocs'>,
): Promise<Proposal[]> {
  const d = { ...deps, primitiveDocs };
  const live = liveSummaries
    .map((s) => `- ${s.id}: ${s.describe} params ${JSON.stringify(s.params)}${s.holdoutScore !== undefined ? ` holdout ${s.holdoutScore.toFixed(4)}` : ''}`)
    .join('\n');
  const user = `TASK: fresh
GOAL: ${goal}

${diagnosisSection(diagnosis)}
LIVE POPULATION (do not copy any of these):
${live || '- none'}

Write ONE new strategy that is structurally different from every live strategy: a different core signal or a different combination of features, informed by the diagnosis. Obey the contract.
${constraintsSection(deps.constraints)}
Return one strategy object { "code", "params", "bounds", "rationale" }.`;
  const out = await completeJson(deps.llm, { system: systemPrompt(d), user, schema: ProposalOut, maxTokens: deps.maxTokens ?? 4096, onCall: deps.onCall });
  return [toProposal(out, 'fresh', [])];
}

export const generator = { seed, mutate, crossbreed, fresh };
