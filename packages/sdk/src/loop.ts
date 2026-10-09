import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AnyProposal,
  Bar,
  Bounds,
  CycleResult,
  Decision,
  Diagnosis,
  EnsembleMode,
  Episode,
  GuardConfig,
  Input,
  Outcome,
  Scorer,
  Strategy,
  TakeoffRow,
} from './types.js';
import type { Executor, LLM, Plugin, PrimitivePack, Source } from './plugins.js';
import { isExecutor, isLLM, isPrimitivePack, isSource } from './plugins.js';
import { OURO_DIR, OURO_NAME } from './constants.js';
import { openLog, type EpisodeLog, type LogOptions } from './log.js';
import { Sandbox, type SandboxOptions } from './sandbox.js';
import { median, replay, split } from './trial.js';
import { check as guardCheck, resolveGuards } from './guards.js';
import { Population, type PendingPromotion } from './population.js';
import { computeFeatures, featureKeys as allFeatureKeys, primitiveDocs, INDICATOR_LOOKBACK } from './primitives/index.js';
import { resolveLLM } from './llm/index.js';
import { LLMOutputError } from './llm/json.js';
import * as gen from './generator.js';
import { diagnose, EMPTY_DIAGNOSIS } from './critic.js';
import { bestCI as bestCIOf, capabilityIndex, populationCI as populationCIOf, takeoff as takeoffOf, writeTakeoff } from './si.js';
import { paperExecutor, outcomeAsset } from './executors/paper.js';

export type LoopConfig = {
  goal: string;
  primitives: PrimitivePack[];
  source: Source;
  executor: Executor | 'paper';
  score: Scorer;
  llm?: LLM | string;
  /** Strategies alive at once. Default 8. */
  population?: number;
  /** Episodes per strategy between cycles. Default 50. */
  cycleEvery?: number;
  /** Newest share of episodes reserved for validation. Default 0.3. */
  holdout?: number;
  /** A candidate must beat the population median train score by this share. Default 0.05. */
  margin?: number;
  guards?: Partial<GuardConfig>;
  /** File paths of user-written strategy modules used as the first generation. */
  seed?: string[];
  allow?: Record<string, string[]>;
  bounds?: Bounds;
  freeze?: string[];
  ensemble?: EnsembleMode;
  /** State directory. Default '.ouro'. */
  dir?: string;
  assets: string[];
  tf: string;
  /** Bars of history pulled before subscribing so indicators are warm. Default 300. */
  warmupBars?: number;
  /**
   * Number of the most recent history bars to trade through (paper) before going live, so the population
   * accumulates episodes and cycles immediately instead of waiting for live bars. Default 0.
   */
  backfill?: number;
  /** Send every strategy's decision (default) or only the ensemble decision to the executor. */
  dispatch?: 'per-strategy' | 'ensemble';
  /** Share of the population marked for retirement each cycle. Default 0.25. */
  retireShare?: number;
  sandbox?: SandboxOptions;
  log?: LogOptions;
  /** Cycle automatically once every live strategy has cycleEvery new episodes. Default true. */
  autoCycle?: boolean;
};

export type DecideResult = { perStrategy: Record<string, Decision>; ensemble: Decision };

export type LoopEvents = {
  log: [message: string];
  seed: [strategies: Strategy[]];
  bar: [bar: Bar];
  decision: [x: Input, result: DecideResult];
  episode: [ep: Episode];
  cycle: [result: CycleResult];
  error: [err: Error];
};

export interface Loop {
  readonly config: Readonly<LoopConfig>;
  readonly dir: string;
  readonly events: EventEmitter<LoopEvents>;
  /** Open the log and population store. Called automatically by every other method. */
  init(): Promise<void>;
  seed(k?: number): Promise<Strategy[]>;
  decide(x: Input): Promise<DecideResult>;
  record(ep: Episode): Promise<Episode>;
  cycle(): Promise<CycleResult>;
  start(opts?: { every?: string }): Promise<void>;
  stop(): Promise<void>;
  approve(cycle: number): Promise<CycleResult>;
  reject(cycle: number): Promise<CycleResult>;
  population(): Promise<Strategy[]>;
  history(): Promise<{ strategies: Strategy[]; cycles: CycleResult[] }>;
  rollback(cycle: number): Promise<{ restored: string[]; rolledBack: string[] }>;
  explain(id: string): Promise<string>;
  takeoff(): Promise<TakeoffRow[]>;
  use(plugin: Plugin): Loop;
  /** Number of completed cycles. */
  cycleCount(): Promise<number>;
  /** True when every live strategy has cycleEvery new episodes since the last cycle. */
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

/** Own-episode holdout slices smaller than this are too noisy to score. */
export const MIN_OWN_HOLDOUT = 3;

export function parseEvery(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i.exec(s.trim());
  if (!m) throw new Error(`cannot parse interval "${s}"; use e.g. 30m, 1h, 2d`);
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * mult;
}

/** Combine per-strategy decisions into one. */
export function ensembleDecision(perStrategy: Record<string, Decision>, strategies: Strategy[], mode: EnsembleMode): Decision {
  if (mode === 'none') return null;
  const byId = new Map(strategies.map((s) => [s.id, s]));
  const weights: Record<'long' | 'short' | 'flat', number> = { long: 0, short: 0, flat: 0 };
  const voters: Record<'long' | 'short' | 'flat', NonNullable<Decision>[]> = { long: [], short: [], flat: [] };
  let total = 0;
  for (const [id, d] of Object.entries(perStrategy)) {
    if (!d) continue;
    const ci = byId.get(id)?.ci ?? 0;
    const w = mode === 'weighted' ? Math.max(0.05, (Number.isFinite(ci) ? ci : 0) + 1) : 1;
    weights[d.side] += w;
    voters[d.side].push(d);
    total += w;
  }
  if (total === 0) return null;
  const sides: Array<'long' | 'short' | 'flat'> = ['long', 'short', 'flat'];
  sides.sort((a, b) => weights[b] - weights[a]);
  const top = sides[0]!;
  const share = weights[top] / total;
  const needed = mode === 'weighted' ? 0.55 : 0.5;
  if (share <= needed) return { side: 'flat', size: 0, tag: 'ensemble:split' };
  const winners = voters[top];
  const meanOf = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
  const size = meanOf(winners.map((d) => d.size)) ?? 0;
  const stop = meanOf(winners.map((d) => d.stop).filter((v): v is number => typeof v === 'number'));
  const tp = meanOf(winners.map((d) => d.tp).filter((v): v is number => typeof v === 'number'));
  const out: NonNullable<Decision> = { side: top, size, tag: 'ensemble' };
  if (stop !== undefined) out.stop = stop;
  if (tp !== undefined) out.tp = tp;
  return out;
}

function fmt(n: number, d = 4): string {
  return Number.isFinite(n) ? n.toFixed(d) : 'n/a';
}

class LoopImpl implements Loop {
  readonly events = new EventEmitter<LoopEvents>();
  readonly dir: string;
  readonly config: LoopConfig;
  private packs: PrimitivePack[];
  private source: Source;
  private executor: Executor;
  private llm: LLM | null = null;
  private llmChoice: LLM | string | undefined;
  private readonly sandbox: Sandbox;
  private log!: EpisodeLog;
  private pop!: Population;
  private initPromise: Promise<void> | null = null;
  private readonly guards: GuardConfig;
  private readonly K: number;
  private readonly cycleEvery: number;
  private readonly holdoutRatio: number;
  private readonly margin: number;
  private readonly ensembleMode: EnsembleMode;
  private running = false;
  private cycling: Promise<CycleResult> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private subscription: AsyncIterator<Bar> | null = null;
  private readonly bars = new Map<string, Bar[]>();
  /** Per strategy, per asset: the input and decision that opened the current position. */
  private readonly lastEntry = new Map<string, Map<string, { input: Input; decision: NonNullable<Decision> }>>();
  /** For ensemble dispatch: which strategies voted with the ensemble side, per asset. */
  private readonly ensembleVoters = new Map<string, string[]>();
  private runPromise: Promise<void> | null = null;

  constructor(config: LoopConfig) {
    this.config = config;
    this.dir = path.resolve(config.dir ?? OURO_DIR);
    this.packs = [...config.primitives];
    this.source = config.source;
    this.executor = config.executor === 'paper' ? paperExecutor() : config.executor;
    this.llmChoice = config.llm;
    this.sandbox = new Sandbox(config.sandbox);
    this.K = config.population ?? 8;
    this.cycleEvery = config.cycleEvery ?? 50;
    this.holdoutRatio = config.holdout ?? 0.3;
    this.margin = config.margin ?? 0.05;
    this.ensembleMode = config.ensemble ?? 'weighted';
    this.guards = resolveGuards({
      ...(config.guards ?? {}),
      holdout: config.guards?.holdout ?? this.holdoutRatio,
      margin: config.guards?.margin ?? this.margin,
      allow: config.guards?.allow ?? config.allow,
      bounds: config.guards?.bounds ?? config.bounds,
      freeze: config.guards?.freeze ?? config.freeze,
    });
  }

  private emitLog(msg: string) {
    this.events.emit('log', msg);
  }

  private getLLM(): LLM {
    if (!this.llm) this.llm = resolveLLM(this.llmChoice);
    return this.llm;
  }

  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        fs.mkdirSync(this.dir, { recursive: true });
        this.log = await openLog(this.dir, {
          ...(this.config.log ?? {}),
          onFallback: (reason) => {
            this.emitLog(`better-sqlite3 unavailable (${reason.split('\n')[0]}); using episodes.jsonl`);
            this.config.log?.onFallback?.(reason);
          },
        });
        this.pop = new Population(this.dir, this.K, this.config.goal, this.config.retireShare ?? 0.25);
        this.executor.onClose((strategyId, outcome) => {
          this.onExecutorClose(strategyId, outcome).catch((err) => this.events.emit('error', err as Error));
        });
      })();
    }
    return this.initPromise;
  }

  use(plugin: Plugin): Loop {
    if (isSource(plugin)) this.source = plugin;
    else if (isExecutor(plugin)) {
      this.executor = plugin;
      if (this.initPromise) plugin.onClose((id, o) => void this.onExecutorClose(id, o));
    } else if (isPrimitivePack(plugin)) {
      this.packs = [...this.packs.filter((p) => p.name !== plugin.name), plugin];
    } else if (isLLM(plugin)) {
      this.llm = plugin;
    } else throw new Error('use(): not a Source, Executor, PrimitivePack or LLM');
    return this;
  }

  private genDeps(): gen.GeneratorDeps {
    return {
      llm: this.getLLM(),
      primitiveDocs: primitiveDocs(this.packs),
      constraints: { allow: this.guards.allow, bounds: this.guards.bounds, freeze: this.guards.freeze },
      maxSize: this.guards.maxPositionPct / 100,
      goal: this.config.goal,
    };
  }

  private async compileLive(): Promise<void> {
    for (const s of this.pop.live()) {
      try {
        await this.sandbox.compile(s.code, s.id);
      } catch (err) {
        this.emitLog(`strategy ${s.id} no longer compiles (${(err as Error).message}); retiring it`);
        s.status = 'retired';
        this.pop.update(s);
      }
    }
  }

  /** Turn a proposal into a Strategy record after it passed the guards. */
  private async vetProposal(
    p: AnyProposal,
    cycleBorn: number,
    episodes: Episode[],
  ): Promise<{ ok: true; strategy: Strategy; trainScore: number; maxDrawdown: number } | { ok: false; strategy: Strategy; reason: string }> {
    const id = this.pop.nextId();
    const parents = p.parentIds.map((pid) => this.pop.get(pid)).filter((s): s is Strategy => !!s);
    const verdict = await guardCheck(p, this.guards, {
      sandbox: this.sandbox,
      scorer: this.config.score,
      episodes,
      featureKeys: allFeatureKeys(this.packs),
      parents,
      id,
    });
    const base: Strategy = {
      id,
      parentIds: p.parentIds,
      origin: p.origin,
      cycleBorn,
      code: p.code,
      params: p.params,
      rationale: p.rationale,
      status: 'rejected',
    };
    if (!verdict.ok) {
      this.sandbox.dispose(id);
      return { ok: false, strategy: base, reason: verdict.reason };
    }
    const strategy: Strategy = { ...base, params: verdict.params, bounds: verdict.module.bounds, describe: verdict.module.describe };
    return { ok: true, strategy, trainScore: verdict.replay?.score ?? 0, maxDrawdown: verdict.replay?.maxDrawdown ?? 0 };
  }

  async seed(k = this.K): Promise<Strategy[]> {
    await this.init();
    const accepted: Strategy[] = [];
    // user-supplied seeds first
    for (const file of this.config.seed ?? []) {
      const code = fs.readFileSync(path.resolve(file), 'utf8');
      const r = await this.vetProposal({ origin: 'seed', parentIds: [], code, params: {}, rationale: `user strategy from ${path.basename(file)}` }, 0, []);
      if (!r.ok) {
        this.emitLog(`user seed ${file} rejected: ${r.reason}`);
        this.pop.add(r.strategy);
        continue;
      }
      r.strategy.origin = 'user';
      r.strategy.status = 'live';
      this.pop.add(r.strategy);
      accepted.push(r.strategy);
    }
    let attempts = 0;
    while (accepted.length < k && attempts < 4) {
      attempts++;
      const need = k - accepted.length;
      this.emitLog(`${OURO_NAME} seeding ${need} strategies with ${this.getLLM().name} (attempt ${attempts})`);
      let proposals: AnyProposal[];
      try {
        proposals = await gen.seed(this.config.goal, primitiveDocs(this.packs), need, this.genDeps());
      } catch (err) {
        if (err instanceof LLMOutputError && attempts < 4) {
          this.emitLog(`seed attempt ${attempts} produced invalid JSON: ${err.message}`);
          continue;
        }
        throw err;
      }
      for (const p of proposals) {
        if (accepted.length >= k) break;
        const r = await this.vetProposal(p, 0, []);
        if (!r.ok) {
          this.emitLog(`seed candidate rejected: ${r.reason}`);
          this.pop.add(r.strategy);
          continue;
        }
        r.strategy.status = 'live';
        this.pop.add(r.strategy);
        accepted.push(r.strategy);
        this.emitLog(`seeded ${r.strategy.id}: ${r.strategy.describe}`);
      }
    }
    if (accepted.length === 0) throw new Error('seeding failed: no proposal passed the sandbox and guards');
    if (accepted.length < k) this.emitLog(`seeded ${accepted.length} of ${k}; the population will fill up as cycles promote candidates`);
    this.pop.snapshot(0);
    this.events.emit('seed', accepted);
    return accepted;
  }

  async decide(x: Input): Promise<DecideResult> {
    await this.init();
    const live = this.pop.live();
    const perStrategy: Record<string, Decision> = {};
    for (const s of live) {
      try {
        if (!this.sandbox.has(s.id)) await this.sandbox.compile(s.code, s.id);
        perStrategy[s.id] = await this.sandbox.run(s.id, x, s.params);
      } catch (err) {
        perStrategy[s.id] = null;
        this.emitLog(`${s.id} decide failed: ${(err as Error).message}`);
      }
    }
    const result = { perStrategy, ensemble: ensembleDecision(perStrategy, live, this.ensembleMode) };
    this.events.emit('decision', x, result);
    return result;
  }

  async record(ep: Episode): Promise<Episode> {
    await this.init();
    if (ep.score === undefined) ep.score = this.config.score(ep);
    this.log.append(ep);
    this.events.emit('episode', ep);
    return ep;
  }

  async ready(): Promise<boolean> {
    await this.init();
    const live = this.pop.live();
    if (!live.length) return false;
    return live.every((s) => this.log.countSince(s.id, this.pop.lastCycleTs) >= this.cycleEvery);
  }

  async cycleCount(): Promise<number> {
    await this.init();
    return this.pop.cycle;
  }

  cycle(): Promise<CycleResult> {
    if (this.cycling) return this.cycling;
    this.cycling = this.runCycle().finally(() => {
      this.cycling = null;
    });
    return this.cycling;
  }

  private async runCycle(): Promise<CycleResult> {
    await this.init();
    const live = this.pop.live();
    if (!live.length) throw new Error('no live population; call seed() first');
    if (this.pop.pending) throw new Error(`cycle ${this.pop.pending.result.cycle} is pending approval; approve or reject it first`);
    const cycleNo = this.pop.cycle + 1;
    const scorer = this.config.score;

    // 1. collect: the last cycleEvery episodes per strategy, pooled
    const perStrategy: Record<string, Episode[]> = {};
    const pool = new Map<string, Episode>();
    for (const s of live) {
      const eps = this.log.recent(s.id, this.cycleEvery);
      perStrategy[s.id] = eps;
      for (const e of eps) pool.set(e.id, e);
    }
    const episodes = [...pool.values()].sort((a, b) => a.ts - b.ts);
    const newest = episodes.length ? episodes[episodes.length - 1]!.ts : this.pop.lastCycleTs;
    const noChange = (note: string, diagnosis: Diagnosis = EMPTY_DIAGNOSIS, record = true): CycleResult => {
      const result: CycleResult = {
        cycle: cycleNo,
        status: 'no_change',
        promoted: [],
        retired: [],
        rejected: [],
        diagnosis,
        populationCI: populationCIOf(this.pop.live()),
        bestCI: bestCIOf(this.pop.live()),
        note,
        ts: Date.now(),
      };
      if (record) this.finishCycle(result, newest);
      return result;
    };
    const fresh = episodes.filter((e) => e.ts > this.pop.lastCycleTs).length;
    if (episodes.length < this.cycleEvery || fresh === 0) {
      this.emitLog(`cycle ${cycleNo}: not enough data (${episodes.length} pooled episodes, ${fresh} new; need ${this.cycleEvery})`);
      return noChange('not enough data', EMPTY_DIAGNOSIS, false);
    }

    // 2. split chronologically; holdout is the newest slice
    const { train, holdout } = split(episodes, this.holdoutRatio);
    this.emitLog(`cycle ${cycleNo}: ${episodes.length} episodes (${train.length} train, ${holdout.length} holdout) across ${live.length} strategies`);

    // 3. rank every live strategy on the pooled holdout (and train, for the median); also score each strategy on
    //    the newest slice of its own episodes, which is what the Capability Index compares against the seeds
    const holdoutScores: Record<string, number> = {};
    const trainScores: number[] = [];
    for (const s of live) {
      const tr = await replay(train, s, scorer, this.sandbox);
      const ho = await replay(holdout, s, scorer, this.sandbox);
      s.trial = { trainScore: tr.score, holdoutScore: ho.score, trainN: tr.n, holdoutN: ho.n, maxDrawdown: Math.max(tr.maxDrawdown, ho.maxDrawdown) };
      const own = split(perStrategy[s.id] ?? [], this.holdoutRatio).holdout;
      if (own.length >= MIN_OWN_HOLDOUT) {
        s.trial.ownHoldoutScore = own.reduce((a, e) => a + (typeof e.score === 'number' ? e.score : scorer(e)), 0) / own.length;
        s.trial.ownHoldoutN = own.length;
      }
      holdoutScores[s.id] = ho.score;
      trainScores.push(tr.score);
      this.pop.update(s);
    }
    // CI baseline: the seed generation's own-episode holdout score, stored once (first cycle that has it)
    if (this.pop.baselineHoldout === null) {
      const seedScores = this.pop.seedIds
        .map((id) => this.pop.get(id)?.trial?.ownHoldoutScore)
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      if (seedScores.length) {
        this.pop.baselineHoldout = seedScores.reduce((a, b) => a + b, 0) / seedScores.length;
        this.pop.baselineScale = seedScores.reduce((a, b) => a + Math.abs(b), 0) / seedScores.length;
        this.emitLog(`seed-generation baseline stored: ${fmt(this.pop.baselineHoldout)} over ${seedScores.length} seeds`);
      }
    }
    const ranked = this.pop.rank(holdoutScores);
    const weak = this.pop.weak(ranked);
    const strong = ranked.slice(0, 2);
    const medianTrain = median(trainScores);
    const trainThreshold = medianTrain + this.margin * Math.abs(medianTrain);

    // 4. diagnose
    let diagnosis: Diagnosis;
    try {
      diagnosis = await diagnose(
        Object.fromEntries(weak.map((s) => [s.id, perStrategy[s.id] ?? []])),
        Object.fromEntries(strong.map((s) => [s.id, perStrategy[s.id] ?? []])),
        live,
        { llm: this.getLLM(), goal: this.config.goal },
      );
    } catch (err) {
      if (!(err instanceof LLMOutputError)) throw err;
      this.emitLog(`critic produced invalid JSON twice; continuing without a diagnosis (${err.message})`);
      diagnosis = { ...EMPTY_DIAGNOSIS, weakIds: weak.map((s) => s.id), strongIds: strong.map((s) => s.id) };
    }
    this.emitLog(`diagnosis: ${diagnosis.summary || '(none)'}`);

    // 5. generate: one mutate per weak, one crossbreed of the top two, one fresh
    const proposals: AnyProposal[] = [];
    const summarise = (s: Strategy) => ({ id: s.id, describe: s.describe ?? '', params: s.params, holdoutScore: s.trial?.holdoutScore });
    const deps: gen.GeneratorDeps = { ...this.genDeps(), strongSummaries: strong.map(summarise) };
    const tryGen = async (label: string, f: () => Promise<AnyProposal[]>) => {
      if (proposals.length >= this.guards.maxProposalsPerCycle) return;
      try {
        proposals.push(...(await f()));
      } catch (err) {
        if (!(err instanceof LLMOutputError)) throw err;
        this.emitLog(`${label} produced invalid JSON twice; skipped (${err.message})`);
      }
    };
    for (const w of weak) await tryGen(`mutate ${w.id}`, () => gen.mutate(w, diagnosis, deps));
    if (strong.length >= 2) await tryGen('crossbreed', () => gen.crossbreed(strong[0]!, strong[1]!, diagnosis, deps));
    await tryGen('fresh', () =>
      gen.fresh(
        this.config.goal,
        diagnosis,
        deps.primitiveDocs,
        live.map(summarise),
        deps,
      ),
    );
    const capped = proposals.slice(0, this.guards.maxProposalsPerCycle);

    // 6 + 7. trial on train, validate on holdout, each winner replaces the weakest strategy not yet replaced
    const rejected: CycleResult['rejected'] = [];
    const promotions: PendingPromotion[] = [];
    const replaceable = [...ranked].reverse();
    for (const p of capped) {
      const r = await this.vetProposal(p, cycleNo, train);
      if (!r.ok) {
        rejected.push({ strategy: r.strategy, reason: r.reason });
        this.pop.add(r.strategy);
        this.emitLog(`${r.strategy.id} (${p.origin}) rejected: ${r.reason}`);
        continue;
      }
      const s = r.strategy;
      if (r.trainScore <= trainThreshold) {
        s.trial = { trainScore: r.trainScore, holdoutScore: NaN, trainN: train.length, holdoutN: 0, maxDrawdown: r.maxDrawdown };
        rejected.push({ strategy: s, reason: 'train margin' });
        this.pop.add(s);
        this.sandbox.dispose(s.id);
        this.emitLog(`${s.id} (${p.origin}) rejected: train margin (${fmt(r.trainScore)} <= ${fmt(trainThreshold)})`);
        continue;
      }
      const target = replaceable[0];
      if (!target) {
        rejected.push({ strategy: s, reason: 'no slot' });
        this.pop.add(s);
        this.sandbox.dispose(s.id);
        continue;
      }
      const ho = await replay(holdout, s, scorer, this.sandbox);
      s.trial = { trainScore: r.trainScore, holdoutScore: ho.score, trainN: train.length, holdoutN: ho.n, maxDrawdown: Math.max(r.maxDrawdown, ho.maxDrawdown) };
      const targetHoldout = target.trial?.holdoutScore ?? -Infinity;
      if (ho.score <= targetHoldout) {
        rejected.push({ strategy: s, reason: 'holdout' });
        this.pop.add(s);
        this.sandbox.dispose(s.id);
        this.emitLog(`${s.id} (${p.origin}) rejected: holdout (${fmt(ho.score)} <= ${fmt(targetHoldout)} of ${target.id})`);
        continue;
      }
      replaceable.shift();
      promotions.push({ candidate: s, retireId: target.id });
      this.emitLog(`${s.id} (${p.origin}) passes: train ${fmt(r.trainScore)} > ${fmt(trainThreshold)}, holdout ${fmt(ho.score)} > ${fmt(targetHoldout)}; replaces ${target.id}`);
    }

    if (promotions.length === 0) {
      this.emitLog(`cycle ${cycleNo}: no change (${capped.length} proposals, ${rejected.length} rejected)`);
      const res = noChange(capped.length ? 'no candidate survived' : 'no proposals', diagnosis);
      res.rejected = rejected;
      return res;
    }

    const result: CycleResult = {
      cycle: cycleNo,
      status: 'promoted',
      promoted: promotions.map((p) => p.candidate),
      retired: promotions.map((p) => this.pop.get(p.retireId)!),
      rejected,
      diagnosis,
      populationCI: populationCIOf(this.pop.live()),
      ts: Date.now(),
    };

    if (this.guards.requireApproval) {
      for (const p of promotions) {
        p.candidate.status = 'pending';
        this.pop.add(p.candidate);
      }
      result.status = 'pending';
      this.pop.pending = { result, promotions };
      this.pop.lastCycleTs = newest;
      this.pop.save();
      this.emitLog(`cycle ${cycleNo}: ${promotions.length} promotion(s) pending approval`);
      this.events.emit('cycle', result);
      return result;
    }
    return this.applyPromotions(result, promotions, newest);
  }

  private applyPromotions(result: CycleResult, promotions: PendingPromotion[], newestTs: number): CycleResult {
    for (const p of promotions) this.pop.promote(p.candidate, p.retireId, result.cycle);
    result.status = 'promoted';
    result.retired = promotions.map((p) => this.pop.get(p.retireId)!);
    this.finishCycle(result, newestTs);
    this.emitLog(`cycle ${result.cycle}: promoted ${promotions.map((p) => p.candidate.id).join(', ')}; population CI ${fmt(result.populationCI, 3)}`);
    return result;
  }

  /** Recompute CI, append history, write takeoff.json. */
  private finishCycle(result: CycleResult, newestTs: number): void {
    const baseline = this.pop.baselineHoldout;
    for (const s of this.pop.live()) {
      // a strategy gets a CI once it has traded on its own; until then it does not count toward the population CI
      if (baseline === null || s.trial?.ownHoldoutScore === undefined) delete s.ci;
      else s.ci = capabilityIndex(s, baseline, this.pop.baselineScale);
      this.pop.update(s);
    }
    const live = this.pop.live();
    result.populationCI = populationCIOf(live);
    result.bestCI = bestCIOf(live);
    if (baseline !== null) result.baselineHoldout = baseline;
    result.ts = result.ts ?? Date.now();
    this.pop.lastCycleTs = Math.max(this.pop.lastCycleTs, newestTs);
    this.pop.pending = null;
    this.pop.recordCycle(result);
    writeTakeoff(this.dir, takeoffOf(this.pop.cycles()));
    this.events.emit('cycle', result);
  }

  async approve(cycle: number): Promise<CycleResult> {
    await this.init();
    const pending = this.pop.pending;
    if (!pending || pending.result.cycle !== cycle) throw new Error(`no pending cycle ${cycle}`);
    for (const p of pending.promotions) await this.sandbox.compile(p.candidate.code, p.candidate.id);
    return this.applyPromotions(pending.result, pending.promotions, this.pop.lastCycleTs);
  }

  async reject(cycle: number): Promise<CycleResult> {
    await this.init();
    const pending = this.pop.pending;
    if (!pending || pending.result.cycle !== cycle) throw new Error(`no pending cycle ${cycle}`);
    const result = pending.result;
    for (const p of pending.promotions) {
      p.candidate.status = 'rejected';
      this.pop.update(p.candidate);
      this.sandbox.dispose(p.candidate.id);
      result.rejected.push({ strategy: p.candidate, reason: 'rejected by user' });
    }
    result.status = 'no_change';
    result.promoted = [];
    result.retired = [];
    result.note = 'rejected by user';
    this.finishCycle(result, this.pop.lastCycleTs);
    return result;
  }

  async population(): Promise<Strategy[]> {
    await this.init();
    return this.pop.live();
  }

  async history(): Promise<{ strategies: Strategy[]; cycles: CycleResult[] }> {
    await this.init();
    return { strategies: this.pop.all(), cycles: this.pop.cycles() };
  }

  async takeoff(): Promise<TakeoffRow[]> {
    await this.init();
    return takeoffOf(this.pop.cycles());
  }

  async rollback(cycle: number): Promise<{ restored: string[]; rolledBack: string[] }> {
    await this.init();
    const r = this.pop.rollback(cycle);
    for (const id of r.rolledBack) this.sandbox.dispose(id);
    await this.compileLive();
    writeTakeoff(this.dir, takeoffOf(this.pop.cycles()));
    this.emitLog(`rolled back to cycle ${cycle}: restored ${r.restored.join(', ') || 'nothing'}; rolled back ${r.rolledBack.join(', ') || 'nothing'}`);
    return r;
  }

  async explain(id: string): Promise<string> {
    await this.init();
    const s = this.pop.get(id);
    if (!s) throw new Error(`unknown strategy ${id}`);
    const parents = s.parentIds.map((pid) => this.pop.get(pid)).filter((p): p is Strategy => !!p);
    const born = this.pop.cycles().find((c) => c.cycle === s.cycleBorn);
    const lines: string[] = [];
    lines.push(`${s.id} is ${s.status}. ${s.describe ?? ''}`.trim());
    const originText =
      s.origin === 'seed'
        ? `It was written by the Generator in the first generation (cycle 0) from the goal alone.`
        : s.origin === 'user'
          ? `It was supplied by you as a starting strategy.`
          : s.origin === 'mutate'
            ? `It is a mutation of ${parents.map((p) => `${p.id} (${p.describe ?? p.origin})`).join(', ') || s.parentIds.join(', ')}, born in cycle ${s.cycleBorn}.`
            : s.origin === 'crossbreed'
              ? `It crosses the entry logic of ${parents[0]?.id ?? s.parentIds[0]} with the exit and filter logic of ${parents[1]?.id ?? s.parentIds[1]}, born in cycle ${s.cycleBorn}.`
              : `It was written fresh by the Generator in cycle ${s.cycleBorn} to differ from every live strategy.`;
    lines.push(originText);
    if (born?.diagnosis.summary) lines.push(`The Critic's diagnosis that cycle: ${born.diagnosis.summary}`);
    lines.push(`Why it exists: ${s.rationale}`);
    lines.push(`Parameters: ${Object.entries(s.params).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}.`);
    if (s.trial) {
      lines.push(
        `On its last trial it scored ${fmt(s.trial.trainScore)} on ${s.trial.trainN} training episodes and ${fmt(s.trial.holdoutScore)} on ${s.trial.holdoutN} unseen holdout episodes, with a max drawdown of ${fmt(s.trial.maxDrawdown, 3)}.`,
      );
    }
    if (typeof s.ci === 'number') lines.push(`Capability Index ${(s.ci >= 0 ? '+' : '') + s.ci.toFixed(2)} against the seed generation.`);
    const rejectedIn = this.pop.cycles().flatMap((c) => c.rejected.filter((r) => r.strategy.id === id).map((r) => `cycle ${c.cycle}: ${r.reason}`));
    if (rejectedIn.length) lines.push(`It was rejected in ${rejectedIn.join('; ')}.`);
    if (s.cycleRetired !== undefined) lines.push(`It was retired in cycle ${s.cycleRetired}.`);
    return lines.join('\n');
  }

  /* ------------------------------------ run flow ------------------------------------ */

  async start(opts: { every?: string } = {}): Promise<void> {
    await this.init();
    if (this.running) return;
    this.running = true;
    if (!this.pop.live().length) await this.seed(this.K);
    await this.compileLive();
    if (opts.every) {
      const ms = parseEvery(opts.every);
      this.timer = setInterval(() => {
        if (!this.running) return;
        this.cycle().catch((err) => this.events.emit('error', err as Error));
      }, ms);
      this.timer.unref?.();
    }
    this.runPromise = this.runData().catch((err) => {
      this.events.emit('error', err as Error);
    });
    await this.runPromise;
  }

  private async runData(): Promise<void> {
    const assets = this.config.assets;
    const tf = this.config.tf;
    const warmup = this.config.warmupBars ?? 300;
    const backfill = this.config.backfill ?? 0;
    const need = warmup + backfill;
    this.emitLog(`pulling ${need} bars of ${tf} history for ${assets.join(', ')} from ${this.source.name}`);
    const history = await this.source.history({ assets, tf, bars: need });
    const byAsset = new Map<string, Bar[]>();
    for (const b of history) {
      const arr = byAsset.get(b.asset) ?? [];
      arr.push(b);
      byAsset.set(b.asset, arr);
    }
    for (const [asset, arr] of byAsset) {
      arr.sort((a, b) => a.ts - b.ts);
      const warm = arr.slice(0, Math.max(0, arr.length - backfill));
      this.bars.set(asset, warm);
      this.emitLog(`${asset}: ${warm.length} warm bars, ${arr.length - warm.length} to trade through`);
    }
    if (backfill > 0) {
      const tail: Bar[] = [];
      for (const [, arr] of byAsset) tail.push(...arr.slice(Math.max(0, arr.length - backfill)));
      tail.sort((a, b) => a.ts - b.ts || a.asset.localeCompare(b.asset));
      for (const bar of tail) {
        if (!this.running) return;
        await this.processBar(bar);
      }
      this.emitLog(`backfill done: ${this.log.total()} episodes recorded`);
    }
    if (!this.running) return;
    this.emitLog(`subscribing to live ${tf} bars for ${assets.join(', ')}`);
    const it = this.source.subscribe({ assets, tf })[Symbol.asyncIterator]();
    this.subscription = it;
    while (this.running) {
      const next = await it.next();
      if (next.done) break;
      await this.processBar(next.value);
    }
  }

  private async processBar(bar: Bar): Promise<void> {
    const arr = this.bars.get(bar.asset) ?? [];
    const last = arr[arr.length - 1];
    if (last && bar.ts < last.ts) return;
    if (last && bar.ts === last.ts) arr[arr.length - 1] = bar;
    else arr.push(bar);
    const keep = (this.config.warmupBars ?? 300) + 100;
    if (arr.length > keep) arr.splice(0, arr.length - keep);
    this.bars.set(bar.asset, arr);
    this.events.emit('bar', bar);
    this.executor.onBar?.(bar);
    if (arr.length < Math.min(INDICATOR_LOOKBACK, this.config.warmupBars ?? 300)) return;
    const features = computeFeatures(this.packs, arr, arr.length - 1);
    const x: Input = { ts: bar.ts, asset: bar.asset, bar, features };
    const result = await this.decide(x);
    const dispatch = this.config.dispatch ?? 'per-strategy';
    if (dispatch === 'ensemble') {
      const d = result.ensemble;
      if (d) {
        const voters = Object.entries(result.perStrategy)
          .filter(([, v]) => v && v.side === d.side)
          .map(([id]) => id);
        this.ensembleVoters.set(bar.asset, voters);
        for (const id of voters) this.remember(id, bar.asset, x, d);
        await this.executor.place(d, { ...x, meta: { ...(x.meta ?? {}), strategyId: 'ensemble' } });
      }
    } else {
      for (const [id, d] of Object.entries(result.perStrategy)) {
        if (!d) continue;
        this.remember(id, bar.asset, x, d);
        await this.executor.place(d, { ...x, meta: { ...(x.meta ?? {}), strategyId: id } });
      }
    }
    if ((this.config.autoCycle ?? true) && !this.cycling && (await this.ready())) {
      await this.cycle();
    }
  }

  private remember(strategyId: string, asset: string, x: Input, d: NonNullable<Decision>) {
    if (d.side === 'flat') return;
    const m = this.lastEntry.get(strategyId) ?? new Map();
    const prev = m.get(asset);
    // keep the input that opened the position: a repeated same-side signal is a hold, not a new entry
    if (prev && prev.decision.side === d.side) return;
    m.set(asset, { input: x, decision: d });
    this.lastEntry.set(strategyId, m);
  }

  private async onExecutorClose(strategyId: string, outcome: Outcome): Promise<void> {
    const asset = outcomeAsset(outcome);
    const ids = strategyId === 'ensemble' ? (asset ? (this.ensembleVoters.get(asset) ?? []) : []) : [strategyId];
    for (const id of ids) {
      const m = this.lastEntry.get(id);
      let entry = asset ? m?.get(asset) : undefined;
      if (!entry && m) entry = [...m.values()].sort((a, b) => b.input.ts - a.input.ts)[0];
      if (!entry) continue;
      if (asset) m?.delete(asset);
      const ep: Episode = {
        id: randomUUID(),
        ts: outcome.closedTs,
        strategyId: id,
        input: entry.input,
        decision: entry.decision,
        outcome,
        tags: [entry.decision.side, outcome.pnl - outcome.fees >= 0 ? 'win' : 'loss'],
      };
      await this.record(ep);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      await this.subscription?.return?.(undefined);
    } catch {
      // ignore
    }
    this.subscription = null;
    await this.executor.stop?.();
    if (this.runPromise) await this.runPromise.catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.stop();
    this.sandbox.close();
    this.log?.close();
  }
}

/** Build a loop from a goal, primitives, a scorer, a source, an executor and an LLM adapter. */
export function createLoop(config: LoopConfig): Loop {
  if (!config.goal) throw new Error('config.goal is required');
  if (!config.source) throw new Error('config.source is required');
  if (!config.executor) throw new Error('config.executor is required');
  if (typeof config.score !== 'function') throw new Error('config.score must be a function');
  if (!config.assets?.length) throw new Error('config.assets must list at least one asset');
  if (!config.tf) throw new Error('config.tf is required');
  return new LoopImpl(config);
}
