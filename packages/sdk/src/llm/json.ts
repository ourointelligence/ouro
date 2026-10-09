import type { z } from 'zod';
import type { LLM, LLMRequest, LLMResponse } from '../plugins.js';
import type { LLMUsage } from '../types.js';

export class LLMOutputError extends Error {
  constructor(
    message: string,
    readonly raw: string,
    readonly attempts: number,
  ) {
    super(message);
    this.name = 'LLMOutputError';
  }
}

/** Pull the first JSON object or array out of a model reply, tolerating code fences and prose around it. */
export function extractJson(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) t = fence[1].trim();
  const firstObj = t.indexOf('{');
  const firstArr = t.indexOf('[');
  let start = -1;
  if (firstObj >= 0 && (firstArr < 0 || firstObj < firstArr)) start = firstObj;
  else if (firstArr >= 0) start = firstArr;
  if (start < 0) return t;
  const open = t[start]!;
  const close = open === '{' ? '}' : ']';
  const end = t.lastIndexOf(close);
  return end > start ? t.slice(start, end + 1) : t.slice(start);
}

/** What one completed call looked like, for usage accounting. */
export type LLMCallInfo = { model: string; usage: LLMUsage; ms: number; attempt: number };

/** Normalise an adapter reply (string in 0.1.0, object since 0.2.0) to { text, usage, model }. */
export function normaliseResponse(reply: string | LLMResponse, fallbackModel: string): Required<LLMResponse> {
  if (typeof reply === 'string') return { text: reply, usage: { inputTokens: 0, outputTokens: 0 }, model: fallbackModel };
  return {
    text: typeof reply.text === 'string' ? reply.text : String(reply.text ?? ''),
    usage: reply.usage ?? { inputTokens: 0, outputTokens: 0 },
    model: reply.model ?? fallbackModel,
  };
}

/** Call an adapter and return the normalised reply plus timing; the one place every model call goes through. */
export async function completeText(llm: LLM, req: LLMRequest, onCall?: (info: LLMCallInfo) => void, attempt = 1): Promise<Required<LLMResponse>> {
  const t0 = Date.now();
  const reply = normaliseResponse(await llm.complete(req), llm.name.replace(/^[a-z]+:/, ''));
  onCall?.({ model: reply.model, usage: reply.usage, ms: Date.now() - t0, attempt });
  return reply;
}

export type JsonRequest<T> = {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  /** Total attempts. The spec: retry once on invalid output, then throw. */
  attempts?: number;
  /** Called after every model call with its usage. */
  onCall?: (info: LLMCallInfo) => void;
};

/**
 * Ask the model for JSON, parse it, validate it with zod. Invalid output is retried once with the validation
 * error appended to the prompt; a second failure throws LLMOutputError. Nothing invalid ever leaves this function.
 */
export async function completeJson<T>(llm: LLM, req: JsonRequest<T>): Promise<T> {
  const attempts = req.attempts ?? 2;
  let lastError = '';
  let lastRaw = '';
  for (let attempt = 0; attempt < attempts; attempt++) {
    const user =
      attempt === 0
        ? req.user
        : `${req.user}\n\nYour previous reply was not valid: ${lastError}\nReply again with only the JSON object, no prose, no code fences.`;
    const reply = await completeText(llm, { system: req.system, user, json: true, maxTokens: req.maxTokens }, req.onCall, attempt + 1);
    const raw = reply.text;
    lastRaw = raw;
    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(raw));
    } catch (err) {
      lastError = `JSON parse error: ${(err as Error).message}`;
      continue;
    }
    const result = req.schema.safeParse(parsed);
    if (result.success) return result.data;
    lastError = `schema error: ${result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '$'}: ${i.message}`)
      .join('; ')}`;
  }
  throw new LLMOutputError(`${llm.name} returned invalid JSON after ${attempts} attempts (${lastError})`, lastRaw, attempts);
}
