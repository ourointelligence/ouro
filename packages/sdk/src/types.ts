/**
 * Core data model. Every record the SDK stores or exchanges with plugins is one of these.
 */

export type Bar = {
  ts: number;
  asset: string;
  tf: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** Extra numeric fields a Source may attach (funding rate, open interest, premium...). Stored with the bar and visible to primitive packs. */
  ext?: Record<string, number>;
  /** Set by a Source when the bar arrived more than two intervals late; the loop records it but does not trade on it. */
  stale?: boolean;
};

export type FeatureValue = number | boolean | null;

export type Input = {
  ts: number;
  asset: string;
  bar: Bar;
  features: Record<string, FeatureValue>;
  meta?: Record<string, unknown>;
};

export type Side = 'long' | 'short' | 'flat';

export type Decision = { side: Side; size: number; stop?: number; tp?: number; tag?: string } | null;

export type Outcome = {
  pnl: number;
  fees: number;
  drawdown: number;
  holdBars: number;
  closedTs: number;
  /** Funding paid (negative) or received (positive) while the position was open, in percent of equity. Already included in pnl. */
  funding?: number;
  raw?: unknown;
};

export type Episode = {
  id: string;
  ts: number;
  strategyId: string;
  input: Input;
  decision: Decision;
  outcome: Outcome;
  score?: number;
  tags?: string[];
};

export type StrategyStatus = 'live' | 'retired' | 'rejected' | 'rolled_back' | 'pending';

export type Trial = {
  /** Mean score per episode when replayed on the pooled train slice. */
  trainScore: number;
  /** Mean score per episode when replayed on the pooled holdout slice; what promotion decisions compare. */
  holdoutScore: number;
  trainN: number;
  holdoutN: number;
  maxDrawdown: number;
  /** Mean score per episode over the newest slice of the strategy's own episodes; what the Capability Index uses. */
  ownHoldoutScore?: number;
  ownHoldoutN?: number;
};

export type Origin = 'seed' | 'mutate' | 'crossbreed' | 'fresh' | 'user';

export type Bounds = Record<string, { min: number; max: number; step: number }>;

export type Strategy = {
  id: string;
  parentIds: string[];
  origin: Origin;
  cycleBorn: number;
  code: string;
  params: Record<string, number>;
  rationale: string;
  status: StrategyStatus;
  trial?: Trial;
  ci?: number;
  /** Parameter bounds declared by the strategy module. */
  bounds?: Bounds;
  /** One-sentence plain-English description declared by the strategy module. */
  describe?: string;
  /** Cycle in which the strategy left the live set, if it did. */
  cycleRetired?: number;
  /** Why it left the live set: 'replaced' by a better candidate, 'inactive' (too few trades), 'rolled_back', 'compile'. */
  retireReason?: string;
};

export type Diagnosis = { patterns: string[]; summary: string; weakIds: string[]; strongIds: string[] };

export type CycleResult = {
  cycle: number;
  status: 'promoted' | 'no_change' | 'pending' | 'error';
  promoted: Strategy[];
  retired: Strategy[];
  rejected: Array<{ strategy: Strategy; reason: string }>;
  diagnosis: Diagnosis;
  populationCI: number;
  /** Best CI among live strategies at the end of the cycle. */
  bestCI?: number;
  /** Mean holdout score of the seed generation replayed on this cycle's holdout episodes. */
  baselineHoldout?: number;
  /** Human-readable note, e.g. why a cycle made no change. */
  note?: string;
  /** Wall-clock time the cycle finished. */
  ts?: number;
  /** Wall-clock time the cycle started. */
  startedAt?: number;
  /** LLM usage summed over the cycle. */
  usage?: LLMUsageTotal;
};

/** Token usage reported by one LLM call. */
export type LLMUsage = { inputTokens: number; outputTokens: number };

/** Usage summed over several calls, with a cost when pricing is configured. */
export type LLMUsageTotal = LLMUsage & { calls: number; usd?: number };

/** Price per million tokens, used to turn usage into dollars. */
export type LLMPricing = { inputPerMTok: number; outputPerMTok: number };

export type Proposal = {
  origin: 'mutate' | 'crossbreed' | 'fresh';
  parentIds: string[];
  code: string;
  params: Record<string, number>;
  rationale: string;
};

/** A proposal for the first generation. Same shape as Proposal with origin 'seed'. */
export type SeedProposal = Omit<Proposal, 'origin'> & { origin: 'seed' };

export type AnyProposal = Proposal | SeedProposal;

export type Scorer = (ep: Episode) => number;

export type ReplayResult = { score: number; maxDrawdown: number; n: number; maxSize: number; matched: number };

export type ReplayMode = 'bars' | 'outcome';

export type TakeoffRow = { cycle: number; populationCI: number; bestCI: number; velocity: number };

export type GuardConfig = {
  maxDrawdownPct: number;
  maxPositionPct: number;
  margin: number;
  holdout: number;
  requireApproval: boolean;
  allow?: Record<string, string[]>;
  bounds?: Bounds;
  freeze?: string[];
  maxProposalsPerCycle: number;
};

export type EnsembleMode = 'majority' | 'weighted' | 'none';
