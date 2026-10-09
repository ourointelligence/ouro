import type { Bar, Bounds, CycleResult, Decision, Episode, LLMUsageTotal, Origin, Outcome, Strategy } from './types.js';

export type CycleStep = 'collect' | 'rank' | 'diagnose' | 'generate' | 'trial' | 'validate' | 'promote';

export type CandidateStage = 'sandbox' | 'guards' | 'trial' | 'holdout' | 'slot' | 'promoted' | 'pending';

export type CycleOutcome = 'promoted' | 'no_change' | 'pending' | 'error';

export type LLMPurpose = 'seed' | 'critic' | 'generator';

/**
 * Every event a loop emits, with its payload. `loop.on(name, handler)` is typed against this map.
 * A handler that throws never breaks the loop: the error is reported through the `error` event instead.
 */
export type EventMap = {
  /** A closed bar arrived (history, backfill or live). */
  bar: { asset: string; tf: string; bar: Bar };
  /** One live strategy decided on one bar. Null decisions are not reported. */
  decision: { strategyId: string; asset: string; decision: NonNullable<Decision> };
  /** The executor opened a position for a strategy. */
  'trade:open': { strategyId: string; asset: string; side: 'long' | 'short'; size: number; price: number; ts: number };
  /** The executor closed a position; `score` is the scorer applied to the resulting episode. */
  'trade:close': { strategyId: string; asset: string; outcome: Outcome; score: number; ts: number };
  'cycle:start': { cycle: number };
  'cycle:step': { cycle: number; step: CycleStep; detail: string };
  /** The Critic's diagnosis for the cycle. */
  critique: { cycle: number; patterns: string[]; summary: string };
  /** One proposal and how far it got. `reason` is null when it was promoted or is pending. */
  candidate: {
    cycle: number;
    id: string;
    origin: Origin;
    parents: string[];
    describe: string;
    code: string;
    params: Record<string, number>;
    bounds: Bounds;
    stage: CandidateStage;
    reason: string | null;
    trainScore: number | null;
    holdoutScore: number | null;
  };
  promote: { cycle: number; id: string; replaces: string };
  retire: { cycle: number; id: string; reason: string };
  'cycle:end': {
    cycle: number;
    outcome: CycleOutcome;
    popCI: number;
    bestCI: number;
    velocity: number;
    ceiling: boolean;
    usage: LLMUsageTotal;
    /** Set when outcome is 'error' (for example 'llm_error') or 'no_change'. */
    reason: string | null;
  };
  pending: { cycle: number };
  approved: { cycle: number };
  rejected: { cycle: number };
  rollback: { toCycle: number };
  /** One model call. */
  llm: { cycle: number; purpose: LLMPurpose; model: string; inputTokens: number; outputTokens: number; ms: number };
  error: { scope: string; message: string };
  /** Plain-text progress lines, the same ones the CLI prints. */
  log: { message: string };
  /** The first generation was written. */
  seed: { strategies: Strategy[] };
  /** An episode was recorded (after trade:close). */
  episode: { episode: Episode };
  /** A cycle finished, with the full CycleResult. */
  cycle: { result: CycleResult };
  pause: { reason: string | null };
  resume: Record<string, never>;
  stop: Record<string, never>;
};

export type EventName = keyof EventMap;
export type Handler<K extends EventName> = (payload: EventMap[K]) => void;

/** Minimal typed emitter whose handlers can never break the emitter's caller. */
export class TypedEmitter {
  private readonly handlers = new Map<EventName, Set<(payload: unknown) => void>>();

  on<K extends EventName>(event: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (payload: unknown) => void);
    return () => this.off(event, handler);
  }

  off<K extends EventName>(event: K, handler: Handler<K>): void {
    this.handlers.get(event)?.delete(handler as (payload: unknown) => void);
  }

  listenerCount(event: EventName): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  emit<K extends EventName>(event: K, payload: EventMap[K]): void {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;
    for (const h of [...set]) {
      try {
        h(payload);
      } catch (err) {
        if (event === 'error') continue; // never recurse on a failing error handler
        this.emit('error', { scope: `handler:${event}`, message: (err as Error)?.message ?? String(err) });
      }
    }
  }

  removeAll(): void {
    this.handlers.clear();
  }
}
