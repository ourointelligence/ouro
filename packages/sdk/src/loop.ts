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
  LLMPricing,
  LLMUsageTotal,
  Outcome,
  ReplayMode,
  ReplayResult,
  Scorer,
  Strategy,
  TakeoffRow,
} from './types.js';
import type { Executor, LLM, Plugin, PrimitivePack, Source } from './plugins.js';
import { isExecutor, isLLM, isPrimitivePack, isSource } from './plugins.js';
import { OURO_DIR, OURO_NAME } from './constants.js';
import { openLog, type EpisodeLog, type LogOptions } from './log.js';
import { Sandbox, type SandboxOptions } from './sandbox.js';
import { median, replay, split, type Replayable } from './trial.js';
import { replayBars } from './replay.js';
import { check as guardCheck, resolveGuards } from './guards.js';
import { Population, type PendingPromotion } from './population.js';
import { computeFeatures, featureKeys as allFeatureKeys, primitiveDocs, INDICATOR_LOOKBACK } from './primitives/index.js';
import { resolveLLM } from './llm/index.js';
import { LLMOutputError, type LLMCallInfo } from './llm/json.js';
import { withRetry } from './llm/wrap.js';
import * as gen from './generator.js';
import { diagnose, EMPTY_DIAGNOSIS } from './critic.js';
import { bestCI as bestCIOf, capabilityIndex, ceilingDetected, populationCI as populationCIOf, takeoff as takeoffOf, writeTakeoff } from './si.js';
import { paperExecutor, outcomeAsset, type PaperConfig } from './executors/paper.js';
import { TypedEmitter, type EventMap, type EventName, type Handler, type CandidateStage, type LLMPurpose } from './events.js';
import { canonical } from './export.js';

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
  /**
   * Longest wait between cycles, for example '6h'. A cycle also fires when this much bar time has passed since
   * the last cycle and at least one new episode exists, even if some strategies have fewer than cycleEvery.
   */
  cycleMaxWait?: string;
  /** A strategy with fewer closed trades than this since the last cycle ranks weakest (reason 'inactive'). Default 3. */
  minTradesPerWindow?: number;
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
  /**
   * How trial and validation score a strategy. 'bars' (default) re-runs decide over the stored bars with the paper
   * fill model; 'outcome' (0.1.0 behaviour) re-runs decide on stored episode inputs and credits the stored outcome
   * when the side matches.
   */
  replay?: ReplayMode;
  /** Fill model for bar replay. Defaults to the paper executor's own defaults (or its config when executor is a PaperExecutor). */
  replayPaper?: PaperConfig;
  /** Price per million tokens, to report dollars in cycle:end. */
  llmPricing?: LLMPricing;
  /** Retries when an adapter throws (network, 5xx). Default 2 retries with 1 s base backoff. */
  llmRetry?: { retries?: number; baseMs?: number };
  /** Delay before seeding is retried after the model failed. Default 60000 ms. */
  seedRetryMs?: number;
};

export type DecideResult = { perStrategy: Record<string, Decision>; ensemble: Decision };

/** Legacy untyped events on loop.events (0.1.0). Kept for compatibility; prefer loop.on(). */
export type LoopEvents = {
  log: [message: string];
  seed: [strategies: Strategy[]];
  bar: [bar: Bar];
  decision: [x: Input, result: DecideResult];
  episode: [ep: Episode];
  cycle: [result: CycleResult];
  error: [err: Error];
};

export type LoopStatus = {
  running: boolean;
  paused: boolean;
  cycle: number;
  live: number;
  strategies: number;
  episodes: number;
  pendingCycle: number | null;
  approval: boolean;
  lastBarTs: number | null;
  lastCycleTs: number | null;
  lastCycleAt: number | null;
  backfilling: boolean;
  subscribed: boolean;
  dir: string;
};

export type LoopExport = {
  schemaVersion: 1;
  name: string;
  goal: string;
  createdAt: number;
  cycle: number;
  population: Strategy[];
  history: { strategies: Strategy[]; cycles: CycleResult[] };
  takeoff: TakeoffRow[];
};

export interface Loop {
  readonly config: Readonly<LoopConfig>;
  readonly dir: string;
  /** Legacy emitter (0.1.0). */
  readonly events: EventEmitter<LoopEvents>;
  /** Subscribe to a typed event. Returns an unsubscribe function. */
  on<K extends EventName>(event: K, handler: Handler<K>): () => void;
  off<K extends EventName>(event: K, handler: Handler<K>): void;
  /** Open the log and population store. Called automatically by every other method. */
  init(): Promise<void>;
  seed(k?: number): Promise<Strategy[]>;
  decide(x: Input): Promise<DecideResult>;
  record(ep: Episode): Promise<Episode>;
  cycle(): Promise<CycleResult>;
  start(opts?: { every?: string }): Promise<void>;
  /** Stop: waits for a running cycle, closes the subscription, flushes the store, calls executor.stop(). */
  stop(): Promise<void>;
  /** Keep receiving bars but make no decisions and run no cycles until resume(). */
  pause(reason?: string): void;
  resume(): void;
  /** Turn the approval switch on or off at runtime. */
  setApproval(on: boolean): void;
  approve(cycle: number): Promise<CycleResult>;
  reject(cycle: number): Promise<CycleResult>;
  population(): Promise<Strategy[]>;
  history(): Promise<{ strategies: Strategy[]; cycles: CycleResult[] }>;
  rollback(cycle: number): Promise<{ restored: string[]; rolledBack: string[] }>;
  explain(id: string): Promise<string>;
  takeoff(): Promise<TakeoffRow[]>;
  /** The versioned export (schemaVersion 1) with stable key order. */
  export(): Promise<LoopExport>;
  status(): Promise<LoopStatus>;
  use(plugin: Plugin): Loop;
  /** Number of completed cycles. */
  cycleCount(): Promise<number>;
  /** True when a cycle is due: every live strategy has cycleEvery new episodes, or cycleMaxWait has passed. */
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

function emptyUsage(): LLMUsageTotal {
  return { inputTokens: 0, outputTokens: 0, calls: 0 };
}

class LoopImpl implements Loop {
  readonly events = new EventEmitter<LoopEvents>();
  readonly dir: string;
  readonly config: LoopConfig;
  private readonly emitter = new TypedEmitter();
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
  private readonly cycleMaxWaitMs: number | null;
  private readonly minTrades: number;
  private readonly holdoutRatio: number;
  private readonly margin: number;
  private readonly ensembleMode: EnsembleMode;
  private readonly replayMode: ReplayMode;
  private readonly intervalMs: number | null;
  private running = false;
  private paused = false;
  private backfilling = false;
  private subscribed = false;
  private cycling: Promise<CycleResult> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private subscription: AsyncIterator<Bar> | null = null;
  private readonly bars = new Map<string, Bar[]>();
  private lastBarTs: number | null = null;
  /** Per strategy, per asset: the input and decision that opened the current position. */
  private readonly lastEntry = new Map<string, Map<string, { input: Input; decision: NonNullable<Decision> }>>();
  /** For ensemble dispatch: which strategies voted with the ensemble side, per asset. */
  private readonly ensembleVoters = new Map<string, string[]>();
  private runPromise: Promise<void> | null = null;
  /** Usage of the cycle in progress (or of seeding, under cycle 0). */
  private cycleUsage: LLMUsageTotal = emptyUsage();
  private currentCycle = 0;
  private currentPurpose: LLMPurpose = 'generator';

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
    this.cycleMaxWaitMs = config.cycleMaxWait ? parseEvery(config.cycleMaxWait) : null;
    this.minTrades = config.minTradesPerWindow ?? 3;
    this.holdoutRatio = config.holdout ?? 0.3;
    this.margin = config.margin ?? 0.05;
    this.ensembleMode = config.ensemble ?? 'weighted';
    this.replayMode = config.replay ?? 'bars';
    this.intervalMs = safeInterval(config.tf);
    this.guards = resolveGuards({
      ...(config.guards ?? {}),
      holdout: config.guards?.holdout ?? this.holdoutRatio,
      margin: config.guards?.margin ?? this.margin,
      allow: config.guards?.allow ?? config.allow,
      bounds: config.guards?.bounds ?? config.bounds,
      freeze: config.guards?.freeze ?? config.freeze,
    });
  }

  /* ------------------------------------- events ------------------------------------- */

  on<K extends EventName>(event: K, handler: Handler<K>): () => void {
    return this.emitter.on(event, handler);
  }

  off<K extends EventName>(event: K, handler: Handler<K>): void {
    this.emitter.off(event, handler);
  }

  private emit<K extends EventName>(event: K, payload: EventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  private emitLog(msg: string) {
    this.events.emit('log', msg);
    this.emit('log', { message: msg });
  }

  private emitError(scope: string, err: unknown) {
    const message = (err as Error)?.message ?? String(err);
    this.emit('error', { scope, message });
    if (this.events.listenerCount('error') > 0) this.events.emit('error', err instanceof Error ? err : new Error(message));
  }

  /* -------------------------------------- setup -------------------------------------- */

  private getLLM(): LLM {
    if (!this.llm) this.llm = resolveLLM(this.llmChoice);
    return this.llm;
  }

  private onLLMCall(info: LLMCallInfo): void {
    this.cycleUsage.inputTokens += info.usage.inputTokens;
    this.cycleUsage.outputTokens += info.usage.outputTokens;
    this.cycleUsage.calls += 1;
    this.emit('llm', {
      cycle: this.currentCycle,
      purpose: this.currentPurpose,
      model: info.model,
      inputTokens: info.usage.inputTokens,
      outputTokens: info.usage.outputTokens,
      ms: info.ms,
    });
  }

  private usageWithCost(u: LLMUsageTotal): LLMUsageTotal {
    const p = this.config.llmPricing;
    if (!p) return { ...u };
    return { ...u, usd: (u.inputTokens * p.inputPerMTok + u.outputTokens * p.outputPerMTok) / 1_000_000 };
  }

  /** Run a model-backed step with retries when the adapter itself fails. */
  private llmStep<T>(purpose: LLMPurpose, fn: () => Promise<T>): Promise<T> {
    this.currentPurpose = purpose;
    return withRetry(fn, {
      retries: this.config.llmRetry?.retries ?? 2,
      baseMs: this.config.llmRetry?.baseMs ?? 1000,
      onRetry: (err, attempt, delay) => this.emitLog(`${purpose}: model call failed (${(err as Error).message}); retry ${attempt} in ${delay} ms`),
    });
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
        this.attachExecutor(this.executor);
      })();
    }
    return this.initPromise;
  }

  private attachExecutor(ex: Executor): void {
    ex.onClose((strategyId, outcome) => {
      this.onExecutorClose(strategyId, outcome).catch((err) => this.emitError('executor', err));
    });
    ex.onOpen?.((strategyId, info) => {
      const ids = strategyId === 'ensemble' ? (this.ensembleVoters.get(info.asset) ?? []) : [strategyId];
      for (const id of ids) this.emit('trade:open', { strategyId: id, ...info });
    });
  }

  use(plugin: Plugin): Loop {
    if (isSource(plugin)) this.source = plugin;
    else if (isExecutor(plugin)) {
      this.executor = plugin;
      if (this.initPromise) this.attachExecutor(plugin);
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
      onCall: (info) => this.onLLMCall(info),
    };
  }

  private async compileLive(): Promise<void> {
    for (const s of this.pop.live()) {
      try {
        await this.sandbox.compile(s.code, s.id);
      } catch (err) {
        this.emitLog(`strategy ${s.id} no longer compiles (${(err as Error).message}); retiring it`);
        s.status = 'retired';
        s.retireReason = 'compile';
        this.pop.update(s);
        this.emit('retire', { cycle: this.pop.cycle, id: s.id, reason: 'compile' });
      }
    }
  }

  /* -------------------------------------- replay -------------------------------------- */

  private paperConfig(): PaperConfig | undefined {
    if (this.config.replayPaper) return this.config.replayPaper;
    const ex = this.executor as Executor & { config?: PaperConfig };
    return ex.name === 'paper' && ex.config ? ex.config : undefined;
  }

  private barsForReplay(from: number, to: number): Bar[] {
    const out: Bar[] = [];
    for (const asset of this.config.assets) {
      const warm = this.log.bars(asset, this.config.tf, { to: from - 1, limit: INDICATOR_LOOKBACK });
      const window = this.log.bars(asset, this.config.tf, { from, to });
      out.push(...warm, ...window);
    }
    return out;
  }

  /** Score a strategy on a window: bar replay when enabled and bars exist, otherwise outcome replay on the episodes. */
  private async score(strategy: Replayable, episodes: Episode[], window: { from: number; to: number } | null): Promise<ReplayResult> {
    if (this.replayMode === 'bars' && window) {
      const bars = this.barsForReplay(window.from, window.to);
      if (bars.length) {
        const r = await replayBars({
          bars,
          packs: this.packs,
          scorer: this.config.score,
          sandbox: this.sandbox,
          strategy,
          from: window.from,
          to: window.to,
          paper: this.paperConfig(),
        });
        return { score: r.score, maxDrawdown: r.maxDrawdown, n: r.n, maxSize: r.maxSize, matched: r.matched };
      }
    }
    return replay(episodes, strategy, this.config.score, this.sandbox);
  }

  /** Decision-time window of a slice of episodes: from the earliest input ts to the latest close. */
  private windowOf(episodes: Episode[], to?: number): { from: number; to: number } | null {
    if (!episodes.length) return null;
    let from = Infinity;
    let end = 0;
    for (const e of episodes) {
      if (e.input.ts < from) from = e.input.ts;
      if (e.ts > end) end = e.ts;
    }
    return { from, to: to ?? end };
  }

  /* -------------------------------------- vetting ------------------------------------- */

  /** Turn a proposal into a Strategy record after it passed the guards. */
  private async vetProposal(
    p: AnyProposal,
    cycleBorn: number,
    episodes: Episode[],
    window: { from: number; to: number } | null,
  ): Promise<{ ok: true; strategy: Strategy; trainScore: number; maxDrawdown: number } | { ok: false; strategy: Strategy; reason: string; stage: CandidateStage }> {
    const id = this.pop.nextId();
    const parents = p.parentIds.map((pid) => this.pop.get(pid)).filter((s): s is Strategy => !!s);
    const verdict = await guardCheck(p, this.guards, {
      sandbox: this.sandbox,
      scorer: this.config.score,
      episodes,
      featureKeys: allFeatureKeys(this.packs),
      parents,
      id,
      replayFn: episodes.length || window ? (s) => this.score(s, episodes, window) : undefined,
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
      const stage: CandidateStage = verdict.reason.startsWith('sandbox:') ? 'sandbox' : 'guards';
      return { ok: false, strategy: base, reason: verdict.reason, stage };
    }
    const strategy: Strategy = { ...base, params: verdict.params, bounds: verdict.module.bounds, describe: verdict.module.describe };
    return { ok: true, strategy, trainScore: verdict.replay?.score ?? 0, maxDrawdown: verdict.replay?.maxDrawdown ?? 0 };
  }

  private emitCandidate(cycle: number, s: Strategy, stage: CandidateStage, reason: string | null, trainScore: number | null, holdoutScore: number | null): void {
    this.emit('candidate', {
      cycle,
      id: s.id,
      origin: s.origin,
      parents: [...s.parentIds],
      describe: s.describe ?? '',
      code: s.code,
      params: { ...s.params },
      bounds: s.bounds ?? {},
      stage,
      reason,
      trainScore,
      holdoutScore,
    });
  }

  async seed(k = this.K): Promise<Strategy[]> {
    await this.init();
    this.currentCycle = 0;
    this.cycleUsage = emptyUsage();
    const accepted: Strategy[] = [];
    // user-supplied seeds first
    for (const file of this.config.seed ?? []) {
      const code = fs.readFileSync(path.resolve(file), 'utf8');
      const r = await this.vetProposal({ origin: 'seed', parentIds: [], code, params: {}, rationale: `user strategy from ${path.basename(file)}` }, 0, [], null);
      if (!r.ok) {
        this.emitLog(`user seed ${file} rejected: ${r.reason}`);
        this.pop.add(r.strategy);
        this.emitCandidate(0, r.strategy, r.stage, r.reason, null, null);
        continue;
      }
      r.strategy.origin = 'user';
      r.strategy.status = 'live';
      this.pop.add(r.strategy);
      accepted.push(r.strategy);
      this.emitCandidate(0, r.strategy, 'promoted', null, null, null);
    }
    let attempts = 0;
    while (accepted.length < k && attempts < 4) {
      attempts++;
      const need = k - accepted.length;
      this.emitLog(`${OURO_NAME} seeding ${need} strategies with ${this.getLLM().name} (attempt ${attempts})`);
      let proposals: AnyProposal[];
      try {
        proposals = await this.llmStep('seed', () => gen.seed(this.config.goal, primitiveDocs(this.packs), need, this.genDeps()));
      } catch (err) {
        if (err instanceof LLMOutputError && attempts < 4) {
          this.emitLog(`seed attempt ${attempts} produced invalid JSON: ${err.message}`);
          continue;
        }
        throw err;
      }
      for (const p of proposals) {
        if (accepted.length >= k) break;
        const r = await this.vetProposal(p, 0, [], null);
        if (!r.ok) {
          this.emitLog(`seed candidate rejected: ${r.reason}`);
          this.pop.add(r.strategy);
          this.emitCandidate(0, r.strategy, r.stage, r.reason, null, null);
          continue;
        }
        r.strategy.status = 'live';
        this.pop.add(r.strategy);
        accepted.push(r.strategy);
        this.emitCandidate(0, r.strategy, 'promoted', null, null, null);
        this.emitLog(`seeded ${r.strategy.id}: ${r.strategy.describe}`);
      }
    }
    if (accepted.length === 0) throw new Error('seeding failed: no proposal passed the sandbox and guards');
    if (accepted.length < k) this.emitLog(`seeded ${accepted.length} of ${k}; the population will fill up as cycles promote candidates`);
    this.pop.snapshot(0);
    this.events.emit('seed', accepted);
    this.emit('seed', { strategies: accepted });
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
      const d = perStrategy[s.id];
      if (d) this.emit('decision', { strategyId: s.id, asset: x.asset, decision: d });
    }
    const result = { perStrategy, ensemble: ensembleDecision(perStrategy, live, this.ensembleMode) };
    this.events.emit('decision', x, result);
    return result;
  }

  async record(ep: Episode): Promise<Episode> {
    await this.init();
    if (ep.score === undefined) ep.score = this.config.score(ep);
    this.log.append(ep);
    // loops driven through record() without a bar stream still need a clock for cycleMaxWait
    if (this.lastBarTs === null || ep.ts > this.lastBarTs) this.lastBarTs = ep.ts;
    this.events.emit('episode', ep);
    this.emit('episode', { episode: ep });
    return ep;
  }

  /** True when the max-wait rule says a cycle is due: enough bar time passed since the last cycle and new episodes exist. */
  private maxWaitDue(): boolean {
    if (this.cycleMaxWaitMs === null || this.lastBarTs === null) return false;
    const ref = this.pop.lastCycleTs > 0 ? this.pop.lastCycleTs : (this.log.firstTs() ?? Infinity);
    if (!Number.isFinite(ref)) return false;
    if (this.lastBarTs - ref < this.cycleMaxWaitMs) return false;
    return this.pop.live().some((s) => this.log.countSince(s.id, this.pop.lastCycleTs) > 0);
  }

  async ready(): Promise<boolean> {
    await this.init();
    const live = this.pop.live();
    if (!live.length) return false;
    if (live.every((s) => this.log.countSince(s.id, this.pop.lastCycleTs) >= this.cycleEvery)) return true;
    return this.maxWaitDue();
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

  private step(cycle: number, step: EventMap['cycle:step']['step'], detail: string): void {
    this.emit('cycle:step', { cycle, step, detail });
  }

  private async runCycle(): Promise<CycleResult> {
    await this.init();
    const live = this.pop.live();
    if (!live.length) throw new Error('no live population; call seed() first');
    if (this.pop.pending) throw new Error(`cycle ${this.pop.pending.result.cycle} is pending approval; approve or reject it first`);
    const cycleNo = this.pop.cycle + 1;
    const startedAt = Date.now();
    this.currentCycle = cycleNo;
    this.cycleUsage = emptyUsage();
    const forced = this.maxWaitDue();
    this.emit('cycle:start', { cycle: cycleNo });
    try {
      return await this.runCycleBody(cycleNo, live, startedAt, forced);
    } catch (err) {
      if (err instanceof LLMOutputError || isLLMFailure(err)) {
        // the model is unreachable or keeps answering nonsense: record the cycle as an error and keep trading
        this.emitLog(`cycle ${cycleNo}: ${(err as Error).message}; recorded as llm_error, population unchanged`);
        this.emitError('llm', err);
        const result = this.errorResult(cycleNo, 'llm_error', startedAt);
        this.finishCycle(result, Math.max(this.pop.lastCycleTs, this.lastBarTs ?? this.pop.lastCycleTs), 'llm_error');
        return result;
      }
      this.emitError('cycle', err);
      throw err;
    }
  }

  private errorResult(cycleNo: number, note: string, startedAt: number): CycleResult {
    return {
      cycle: cycleNo,
      status: 'error',
      promoted: [],
      retired: [],
      rejected: [],
      diagnosis: EMPTY_DIAGNOSIS,
      populationCI: populationCIOf(this.pop.live()),
      bestCI: bestCIOf(this.pop.live()),
      note,
      ts: Date.now(),
      startedAt,
    };
  }

  private async runCycleBody(cycleNo: number, live: Strategy[], startedAt: number, forced: boolean): Promise<CycleResult> {
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
    const fresh = episodes.filter((e) => e.ts > this.pop.lastCycleTs).length;
    this.step(cycleNo, 'collect', `${episodes.length} pooled episodes, ${fresh} new${forced ? ', max wait reached' : ''}`);
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
        startedAt,
      };
      if (record) this.finishCycle(result, newest, note);
      else {
        result.usage = this.usageWithCost(this.cycleUsage);
        this.emitCycleEnd(result, note);
      }
      return result;
    };
    const enough = forced ? episodes.length >= 2 : episodes.length >= this.cycleEvery;
    if (!enough || fresh === 0) {
      this.emitLog(`cycle ${cycleNo}: not enough data (${episodes.length} pooled episodes, ${fresh} new; need ${this.cycleEvery})`);
      return noChange('not enough data', EMPTY_DIAGNOSIS, false);
    }

    // 2. split chronologically; holdout is the newest slice
    const { train, holdout } = split(episodes, this.holdoutRatio);
    const trainWindow = this.windowOf(train, holdout[0] ? holdout[0].input.ts - 1 : undefined);
    const holdoutWindow = this.windowOf(holdout, this.lastBarTs ?? undefined);
    this.emitLog(`cycle ${cycleNo}: ${episodes.length} episodes (${train.length} train, ${holdout.length} holdout) across ${live.length} strategies`);

    // 3. rank every live strategy on the holdout window (and train, for the median); also score each strategy on
    //    the newest slice of its own episodes, which is what the Capability Index compares against the seeds
    const holdoutScores: Record<string, number> = {};
    const trainScores: number[] = [];
    const inactive = new Set<string>();
    for (const s of live) {
      const tr = await this.score(s, train, trainWindow);
      const ho = await this.score(s, holdout, holdoutWindow);
      s.trial = { trainScore: tr.score, holdoutScore: ho.score, trainN: tr.n, holdoutN: ho.n, maxDrawdown: Math.max(tr.maxDrawdown, ho.maxDrawdown) };
      const own = split(perStrategy[s.id] ?? [], this.holdoutRatio).holdout;
      if (own.length >= MIN_OWN_HOLDOUT) {
        s.trial.ownHoldoutScore = own.reduce((a, e) => a + (typeof e.score === 'number' ? e.score : scorer(e)), 0) / own.length;
        s.trial.ownHoldoutN = own.length;
      }
      const tradesInWindow = this.log.countSince(s.id, this.pop.lastCycleTs);
      if (tradesInWindow < this.minTrades) {
        inactive.add(s.id);
        holdoutScores[s.id] = -Infinity;
      } else holdoutScores[s.id] = ho.score;
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
    const strong = ranked.filter((s) => !inactive.has(s.id)).slice(0, 2);
    const medianTrain = median(trainScores);
    const trainThreshold = medianTrain + this.margin * Math.abs(medianTrain);
    this.step(
      cycleNo,
      'rank',
      `${ranked.map((s) => `${s.id} ${inactive.has(s.id) ? 'inactive' : fmt(holdoutScores[s.id] ?? NaN)}`).join(', ')}; weak ${weak.map((s) => s.id).join(', ') || 'none'}; train threshold ${fmt(trainThreshold)}`,
    );

    // 4. diagnose
    let diagnosis: Diagnosis;
    try {
      diagnosis = await this.llmStep('critic', () =>
        diagnose(
          Object.fromEntries(weak.map((s) => [s.id, perStrategy[s.id] ?? []])),
          Object.fromEntries(strong.map((s) => [s.id, perStrategy[s.id] ?? []])),
          live,
          { llm: this.getLLM(), goal: this.config.goal, onCall: (info) => this.onLLMCall(info) },
        ),
      );
    } catch (err) {
      if (!(err instanceof LLMOutputError)) throw err;
      this.emitLog(`critic produced invalid JSON twice; continuing without a diagnosis (${err.message})`);
      diagnosis = { ...EMPTY_DIAGNOSIS, weakIds: weak.map((s) => s.id), strongIds: strong.map((s) => s.id) };
    }
    this.emitLog(`diagnosis: ${diagnosis.summary || '(none)'}`);
    this.step(cycleNo, 'diagnose', diagnosis.summary || 'no diagnosis');
    this.emit('critique', { cycle: cycleNo, patterns: [...diagnosis.patterns], summary: diagnosis.summary });

    // 5. generate: one mutate per weak, one crossbreed of the top two, one fresh
    const proposals: AnyProposal[] = [];
    const summarise = (s: Strategy) => ({ id: s.id, describe: s.describe ?? '', params: s.params, holdoutScore: s.trial?.holdoutScore });
    const deps: gen.GeneratorDeps = { ...this.genDeps(), strongSummaries: strong.map(summarise) };
    const tryGen = async (label: string, f: () => Promise<AnyProposal[]>) => {
      if (proposals.length >= this.guards.maxProposalsPerCycle) return;
      try {
        proposals.push(...(await this.llmStep('generator', f)));
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
    this.step(cycleNo, 'generate', `${capped.length} proposals (${capped.map((p) => p.origin).join(', ') || 'none'})`);

    // 6 + 7. trial on train, validate on holdout, each winner replaces the weakest strategy not yet replaced
    const rejected: CycleResult['rejected'] = [];
    const promotions: PendingPromotion[] = [];
    const replaceable = [...ranked].reverse();
    let trialPassed = 0;
    for (const p of capped) {
      const r = await this.vetProposal(p, cycleNo, train, trainWindow);
      if (!r.ok) {
        rejected.push({ strategy: r.strategy, reason: r.reason });
        this.pop.add(r.strategy);
        this.emitCandidate(cycleNo, r.strategy, r.stage, r.reason, null, null);
        this.emitLog(`${r.strategy.id} (${p.origin}) rejected: ${r.reason}`);
        continue;
      }
      const s = r.strategy;
      if (r.trainScore <= trainThreshold) {
        s.trial = { trainScore: r.trainScore, holdoutScore: NaN, trainN: train.length, holdoutN: 0, maxDrawdown: r.maxDrawdown };
        rejected.push({ strategy: s, reason: 'train margin' });
        this.pop.add(s);
        this.sandbox.dispose(s.id);
        this.emitCandidate(cycleNo, s, 'trial', 'train margin', r.trainScore, null);
        this.emitLog(`${s.id} (${p.origin}) rejected: train margin (${fmt(r.trainScore)} <= ${fmt(trainThreshold)})`);
        continue;
      }
      trialPassed++;
      const target = replaceable[0];
      if (!target) {
        rejected.push({ strategy: s, reason: 'no slot' });
        this.pop.add(s);
        this.sandbox.dispose(s.id);
        this.emitCandidate(cycleNo, s, 'slot', 'no slot', r.trainScore, null);
        continue;
      }
      const ho = await this.score(s, holdout, holdoutWindow);
      s.trial = { trainScore: r.trainScore, holdoutScore: ho.score, trainN: train.length, holdoutN: ho.n, maxDrawdown: Math.max(r.maxDrawdown, ho.maxDrawdown) };
      const targetHoldout = inactive.has(target.id) ? -Infinity : (target.trial?.holdoutScore ?? -Infinity);
      if (ho.score <= targetHoldout) {
        rejected.push({ strategy: s, reason: 'holdout' });
        this.pop.add(s);
        this.sandbox.dispose(s.id);
        this.emitCandidate(cycleNo, s, 'holdout', 'holdout', r.trainScore, ho.score);
        this.emitLog(`${s.id} (${p.origin}) rejected: holdout (${fmt(ho.score)} <= ${fmt(targetHoldout)} of ${target.id})`);
        continue;
      }
      replaceable.shift();
      promotions.push({ candidate: s, retireId: target.id });
      this.emitLog(`${s.id} (${p.origin}) passes: train ${fmt(r.trainScore)} > ${fmt(trainThreshold)}, holdout ${fmt(ho.score)} > ${fmt(targetHoldout)}; replaces ${target.id}`);
    }
    this.step(cycleNo, 'trial', `${trialPassed} of ${capped.length} candidates beat the train threshold`);
    this.step(cycleNo, 'validate', `${promotions.length} candidate(s) beat a live strategy on holdout, ${rejected.filter((r) => r.reason === 'holdout').length} failed on holdout`);

    if (promotions.length === 0) {
      this.emitLog(`cycle ${cycleNo}: no change (${capped.length} proposals, ${rejected.length} rejected)`);
      const note = capped.length ? 'no candidate survived' : 'no proposals';
      this.step(cycleNo, 'promote', 'nothing promoted');
      const res = noChange(note, diagnosis);
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
      startedAt,
    };
    for (const p of promotions) {
      const target = this.pop.get(p.retireId);
      if (target) target.retireReason = inactive.has(target.id) ? 'inactive' : 'replaced';
    }

    if (this.guards.requireApproval) {
      for (const p of promotions) {
        p.candidate.status = 'pending';
        this.pop.add(p.candidate);
        this.emitCandidate(cycleNo, p.candidate, 'pending', null, p.candidate.trial?.trainScore ?? null, p.candidate.trial?.holdoutScore ?? null);
      }
      result.status = 'pending';
      result.usage = this.usageWithCost(this.cycleUsage);
      this.pop.pending = { result, promotions };
      this.pop.lastCycleTs = newest;
      this.pop.save();
      this.emitLog(`cycle ${cycleNo}: ${promotions.length} promotion(s) pending approval`);
      this.step(cycleNo, 'promote', `${promotions.length} promotion(s) pending approval`);
      this.events.emit('cycle', result);
      this.emit('cycle', { result });
      this.emit('pending', { cycle: cycleNo });
      this.emitCycleEnd(result, null);
      return result;
    }
    return this.applyPromotions(result, promotions, newest);
  }

  private applyPromotions(result: CycleResult, promotions: PendingPromotion[], newestTs: number): CycleResult {
    for (const p of promotions) {
      const target = this.pop.get(p.retireId);
      const reason = target?.retireReason ?? 'replaced';
      this.pop.promote(p.candidate, p.retireId, result.cycle);
      if (target) {
        target.retireReason = reason;
        this.pop.update(target);
      }
      this.emitCandidate(result.cycle, p.candidate, 'promoted', null, p.candidate.trial?.trainScore ?? null, p.candidate.trial?.holdoutScore ?? null);
      this.emit('promote', { cycle: result.cycle, id: p.candidate.id, replaces: p.retireId });
      this.emit('retire', { cycle: result.cycle, id: p.retireId, reason });
    }
    result.status = 'promoted';
    result.retired = promotions.map((p) => this.pop.get(p.retireId)!);
    this.step(result.cycle, 'promote', `promoted ${promotions.map((p) => `${p.candidate.id} over ${p.retireId}`).join(', ')}`);
    this.finishCycle(result, newestTs, null);
    this.emitLog(`cycle ${result.cycle}: promoted ${promotions.map((p) => p.candidate.id).join(', ')}; population CI ${fmt(result.populationCI, 3)}`);
    return result;
  }

  /** Recompute CI, append history, write takeoff.json, emit cycle and cycle:end. */
  private finishCycle(result: CycleResult, newestTs: number, reason: string | null): void {
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
    result.usage = this.usageWithCost(this.cycleUsage);
    this.pop.lastCycleTs = Math.max(this.pop.lastCycleTs, newestTs);
    this.pop.pending = null;
    this.pop.recordCycle(result);
    writeTakeoff(this.dir, takeoffOf(this.pop.cycles()));
    this.events.emit('cycle', result);
    this.emit('cycle', { result });
    this.emitCycleEnd(result, reason);
  }

  private emitCycleEnd(result: CycleResult, reason: string | null): void {
    const rows = takeoffOf(this.pop.cycles());
    const last = rows[rows.length - 1];
    const velocity = last && last.cycle === result.cycle ? last.velocity : 0;
    this.emit('cycle:end', {
      cycle: result.cycle,
      outcome: result.status,
      popCI: result.populationCI,
      bestCI: result.bestCI ?? 0,
      velocity,
      ceiling: ceilingDetected(rows),
      usage: result.usage ?? this.usageWithCost(this.cycleUsage),
      reason,
    });
  }

  async approve(cycle: number): Promise<CycleResult> {
    await this.init();
    const pending = this.pop.pending;
    if (!pending || pending.result.cycle !== cycle) throw new Error(`no pending cycle ${cycle}`);
    for (const p of pending.promotions) await this.sandbox.compile(p.candidate.code, p.candidate.id);
    this.cycleUsage = pending.result.usage ?? emptyUsage();
    this.emit('approved', { cycle });
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
      this.emitCandidate(cycle, p.candidate, 'holdout', 'rejected by user', p.candidate.trial?.trainScore ?? null, p.candidate.trial?.holdoutScore ?? null);
    }
    result.status = 'no_change';
    result.promoted = [];
    result.retired = [];
    result.note = 'rejected by user';
    this.cycleUsage = result.usage ?? emptyUsage();
    this.emit('rejected', { cycle });
    this.finishCycle(result, this.pop.lastCycleTs, 'rejected by user');
    return result;
  }

  setApproval(on: boolean): void {
    this.guards.requireApproval = on;
    this.emitLog(`approval switch ${on ? 'on' : 'off'}`);
  }

  pause(reason?: string): void {
    if (this.paused) return;
    this.paused = true;
    this.emitLog(`paused${reason ? `: ${reason}` : ''}`);
    this.emit('pause', { reason: reason ?? null });
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.emitLog('resumed');
    this.emit('resume', {});
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

  async export(): Promise<LoopExport> {
    await this.init();
    const out: LoopExport = {
      schemaVersion: 1,
      name: OURO_NAME,
      goal: this.config.goal,
      createdAt: this.pop.createdAt,
      cycle: this.pop.cycle,
      population: this.pop.live(),
      history: { strategies: this.pop.all(), cycles: this.pop.cycles() },
      takeoff: takeoffOf(this.pop.cycles()),
    };
    return canonical(out) as LoopExport;
  }

  async status(): Promise<LoopStatus> {
    await this.init();
    const cycles = this.pop.cycles();
    const last = cycles[cycles.length - 1];
    return {
      running: this.running,
      paused: this.paused,
      cycle: this.pop.cycle,
      live: this.pop.live().length,
      strategies: this.pop.all().length,
      episodes: this.log.total(),
      pendingCycle: this.pop.pending?.result.cycle ?? null,
      approval: this.guards.requireApproval,
      lastBarTs: this.lastBarTs,
      lastCycleTs: this.pop.lastCycleTs || null,
      lastCycleAt: last?.ts ?? null,
      backfilling: this.backfilling,
      subscribed: this.subscribed,
      dir: this.dir,
    };
  }

  async rollback(cycle: number): Promise<{ restored: string[]; rolledBack: string[] }> {
    await this.init();
    const r = this.pop.rollback(cycle);
    for (const id of r.rolledBack) {
      this.sandbox.dispose(id);
      const s = this.pop.get(id);
      if (s) {
        s.retireReason = 'rolled_back';
        this.pop.update(s);
      }
    }
    await this.compileLive();
    writeTakeoff(this.dir, takeoffOf(this.pop.cycles()));
    this.emitLog(`rolled back to cycle ${cycle}: restored ${r.restored.join(', ') || 'nothing'}; rolled back ${r.rolledBack.join(', ') || 'nothing'}`);
    this.emit('rollback', { toCycle: cycle });
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
    if (s.cycleRetired !== undefined) lines.push(`It was retired in cycle ${s.cycleRetired}${s.retireReason ? ` (${s.retireReason})` : ''}.`);
    return lines.join('\n');
  }

  /* ------------------------------------ run flow ------------------------------------ */

  async start(opts: { every?: string } = {}): Promise<void> {
    await this.init();
    if (this.running) return;
    this.running = true;
    while (this.running && !this.pop.live().length) {
      try {
        await this.seed(this.K);
      } catch (err) {
        if (err instanceof LLMOutputError || isLLMFailure(err) || /seeding failed/.test((err as Error).message)) {
          const wait = this.config.seedRetryMs ?? 60_000;
          this.emitError('seed', err);
          this.emitLog(`seeding failed (${(err as Error).message}); retrying in ${wait} ms`);
          await sleep(wait);
          continue;
        }
        this.running = false;
        throw err;
      }
    }
    if (!this.running) return;
    await this.compileLive();
    if (opts.every) {
      const ms = parseEvery(opts.every);
      this.timer = setInterval(() => {
        if (!this.running || this.paused) return;
        this.cycle().catch((err) => this.emitError('cycle', err));
      }, ms);
      this.timer.unref?.();
    }
    this.runPromise = this.runData().catch((err) => {
      this.emitError('run', err);
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
      for (const b of warm) this.log.appendBar(b);
      this.emitLog(`${asset}: ${warm.length} warm bars, ${arr.length - warm.length} to trade through`);
    }
    if (backfill > 0) {
      this.backfilling = true;
      const tail: Bar[] = [];
      for (const [, arr] of byAsset) tail.push(...arr.slice(Math.max(0, arr.length - backfill)));
      tail.sort((a, b) => a.ts - b.ts || a.asset.localeCompare(b.asset));
      for (const bar of tail) {
        if (!this.running) return;
        await this.processBar(bar);
      }
      this.backfilling = false;
      this.emitLog(`backfill done: ${this.log.total()} episodes recorded`);
    }
    if (!this.running) return;
    this.emitLog(`subscribing to live ${tf} bars for ${assets.join(', ')}`);
    const it = this.source.subscribe({ assets, tf })[Symbol.asyncIterator]();
    this.subscription = it;
    this.subscribed = true;
    try {
      while (this.running) {
        const next = await it.next();
        if (next.done) break;
        await this.processBar(next.value);
      }
    } finally {
      this.subscribed = false;
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
    this.log.appendBar(bar);
    if (this.lastBarTs === null || bar.ts > this.lastBarTs) this.lastBarTs = bar.ts;
    this.events.emit('bar', bar);
    this.emit('bar', { asset: bar.asset, tf: bar.tf, bar });
    this.executor.onBar?.(bar);
    if (bar.stale) {
      this.emitLog(`${bar.asset} bar ${new Date(bar.ts).toISOString()} is stale; no decisions on it`);
      return;
    }
    if (this.paused) return;
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
        await this.place(d, x, 'ensemble');
      }
    } else {
      for (const [id, d] of Object.entries(result.perStrategy)) {
        if (!d) continue;
        this.remember(id, bar.asset, x, d);
        await this.place(d, x, id);
      }
    }
    if ((this.config.autoCycle ?? true) && !this.cycling && !this.paused && (await this.ready())) {
      await this.cycle();
    }
  }

  private async place(d: NonNullable<Decision>, x: Input, strategyId: string): Promise<void> {
    await this.executor.place(d, { ...x, meta: { ...(x.meta ?? {}), strategyId } });
    if (!this.executor.onOpen && d.side !== 'flat' && d.size > 0) {
      // executors without an onOpen hook: report the intent at the decision price
      const ids = strategyId === 'ensemble' ? (this.ensembleVoters.get(x.asset) ?? []) : [strategyId];
      for (const id of ids) this.emit('trade:open', { strategyId: id, asset: x.asset, side: d.side, size: d.size, price: x.bar.c, ts: x.ts });
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
      this.emit('trade:close', { strategyId: id, asset: asset ?? entry.input.asset, outcome, score: ep.score ?? 0, ts: outcome.closedTs });
    }
  }

  async stop(): Promise<void> {
    const wasRunning = this.running;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.cycling) await this.cycling.catch(() => undefined);
    try {
      await this.subscription?.return?.(undefined);
    } catch {
      // ignore
    }
    this.subscription = null;
    await this.executor.stop?.();
    if (this.runPromise) await this.runPromise.catch(() => undefined);
    this.runPromise = null;
    if (this.initPromise) {
      await this.initPromise.catch(() => undefined);
      this.log?.flush();
      this.pop?.save();
    }
    if (wasRunning) this.emit('stop', {});
  }

  async close(): Promise<void> {
    await this.stop();
    this.sandbox.close();
    this.log?.close();
    this.emitter.removeAll();
  }
}

function safeInterval(tf: string): number | null {
  try {
    return parseEvery(tf);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Errors thrown by an adapter (network, HTTP, timeout, budget) rather than by the loop's own checks. */
function isLLMFailure(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | undefined;
  if (!e) return false;
  if (e.name === 'BudgetExceeded' || e.name === 'LLMOutputError') return true;
  return /adapter|network|fetch|ECONN|ETIMEDOUT|ENOTFOUND|HTTP \d|status code|rate limit|overloaded|timed out|timeout|llm/i.test(e.message ?? '');
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
