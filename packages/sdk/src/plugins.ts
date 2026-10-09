import type { Bar, Decision, Input, Outcome, FeatureValue, LLMUsage } from './types.js';

/** Where inputs come from: a venue websocket, a chain RPC, an API, a file, a synthetic generator. */
export interface Source {
  name: string;
  subscribe(opts: { assets: string[]; tf: string }): AsyncIterable<Bar>;
  history(opts: { assets: string[]; tf: string; bars: number }): Promise<Bar[]>;
}

/** Where decisions go: paper, a venue, a contract, a webhook. */
export interface Executor {
  name: string;
  place(d: NonNullable<Decision>, x: Input): Promise<{ orderId: string }>;
  onClose(cb: (strategyId: string, outcome: Outcome) => void): void;
  /** Optional: report a filled entry so the loop can emit trade:open with the real fill price. */
  onOpen?(cb: (strategyId: string, info: { asset: string; side: 'long' | 'short'; size: number; price: number; ts: number }) => void): void;
  /**
   * Optional: the loop calls this with every new bar before any decision is made on it.
   * Executors that simulate fills (paper) or need mark prices for stops use it.
   */
  onBar?(bar: Bar): void;
  /** Optional: close every open position and release resources. */
  stop?(): Promise<void> | void;
}

/** A set of named features computed from a bar series. Keys are flat and get prefixed with the pack name. */
export interface PrimitivePack {
  name: string;
  compute(bars: Bar[], i: number): Record<string, FeatureValue>;
  describe(): Array<{ key: string; doc: string }>;
}

export type LLMRequest = { system: string; user: string; json: true; maxTokens?: number };

/** What an adapter may return besides a plain string: the text plus token usage and the model that answered. */
export type LLMResponse = { text: string; usage?: LLMUsage; model?: string };

/**
 * One model behind one method. Adapters return the model's reply, which must be a JSON document, either as a plain
 * string (0.1.0 adapters) or as { text, usage, model } so the loop can account for tokens.
 */
export interface LLM {
  name: string;
  complete(req: LLMRequest): Promise<string | LLMResponse>;
}

export type Plugin = Source | Executor | PrimitivePack | LLM;

export function isSource(p: unknown): p is Source {
  return !!p && typeof (p as Source).subscribe === 'function' && typeof (p as Source).history === 'function';
}
export function isExecutor(p: unknown): p is Executor {
  return !!p && typeof (p as Executor).place === 'function' && typeof (p as Executor).onClose === 'function';
}
export function isPrimitivePack(p: unknown): p is PrimitivePack {
  return !!p && typeof (p as PrimitivePack).compute === 'function' && typeof (p as PrimitivePack).describe === 'function';
}
export function isLLM(p: unknown): p is LLM {
  return !!p && typeof (p as LLM).complete === 'function' && !isSource(p) && !isExecutor(p) && !isPrimitivePack(p);
}
