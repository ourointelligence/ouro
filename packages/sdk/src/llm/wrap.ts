import type { LLM, LLMRequest, LLMResponse } from '../plugins.js';
import { normaliseResponse } from './json.js';

export type WrapLLMHooks = {
  /** Runs before the call. May return a replacement request. Throw to refuse the call (for example over budget). */
  before?: (req: LLMRequest) => void | LLMRequest | Promise<void | LLMRequest>;
  /** Runs after a successful call with the normalised reply and the elapsed time. May return a replacement reply. */
  after?: (res: Required<LLMResponse>, req: LLMRequest, ms: number) => void | LLMResponse | Promise<void | LLMResponse>;
  /** Runs when the inner adapter throws; return a reply to recover, or rethrow. */
  onError?: (err: unknown, req: LLMRequest) => void | LLMResponse | Promise<void | LLMResponse>;
  /** Name for the wrapped adapter. Default: the inner name. */
  name?: string;
};

/**
 * Wrap any LLM adapter with before and after hooks, so an app can count usage, enforce budgets, log prompts or
 * swap models without touching the loop. Replies from 0.1.0 adapters (plain strings) are normalised to
 * { text, usage, model } before `after` runs, so hooks always see usage (zero when the adapter reports none).
 */
export function wrapLLM(inner: LLM, hooks: WrapLLMHooks = {}): LLM {
  const fallbackModel = inner.name.replace(/^[a-z]+:/, '');
  return {
    name: hooks.name ?? inner.name,
    async complete(req) {
      const replaced = await hooks.before?.(req);
      const effective = replaced ?? req;
      const t0 = Date.now();
      let res: Required<LLMResponse>;
      try {
        res = normaliseResponse(await inner.complete(effective), fallbackModel);
      } catch (err) {
        if (!hooks.onError) throw err;
        const recovered = await hooks.onError(err, effective);
        if (!recovered) throw err;
        res = normaliseResponse(recovered, fallbackModel);
      }
      const after = await hooks.after?.(res, effective, Date.now() - t0);
      return after ? normaliseResponse(after, res.model) : res;
    },
  };
}

/**
 * Retry an adapter call when the adapter itself throws (network, 5xx, timeout): `retries` more attempts with
 * exponential backoff starting at `baseMs`. Invalid JSON is not an adapter failure and is not retried here.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: { retries?: number; baseMs?: number; onRetry?: (err: unknown, attempt: number, delayMs: number) => void } = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const baseMs = opts.baseMs ?? 1000;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || (err as { name?: string })?.name === 'LLMOutputError' || (err as { name?: string })?.name === 'BudgetExceeded') throw err;
      attempt++;
      const delay = baseMs * 2 ** (attempt - 1);
      opts.onRetry?.(err, attempt, delay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
