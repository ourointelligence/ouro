import OpenAI from 'openai';
import type { LLM, LLMResponse } from '../plugins.js';

export type OpenAIOptions = { apiKey?: string; model?: string; baseUrl?: string; fetch?: typeof globalThis.fetch };

export const OPENAI_DEFAULT_MODEL = 'gpt-4o';

/**
 * OpenAI Chat Completions adapter. Temperature 0, JSON mode on.
 * Honours OPENAI_BASE_URL so any OpenAI-compatible server (LM Studio, vLLM, OpenRouter) works too.
 */
export function openai(opts: OpenAIOptions = {}): LLM {
  const model = opts.model ?? process.env['OURO_MODEL'] ?? OPENAI_DEFAULT_MODEL;
  const baseURL = opts.baseUrl ?? process.env['OPENAI_BASE_URL'];
  const apiKey = opts.apiKey ?? process.env['OPENAI_API_KEY'] ?? (baseURL ? 'local' : undefined);
  if (!apiKey) throw new Error('openai adapter: set OPENAI_API_KEY or pass apiKey');
  const client = new OpenAI({
    apiKey,
    baseURL,
    fetch: ((url: any, init?: any) => (opts.fetch ?? globalThis.fetch)(url, init)) as typeof globalThis.fetch,
    maxRetries: 2,
  });
  return {
    name: `openai:${model}`,
    async complete(req) {
      const res = await client.chat.completions.create({
        model,
        temperature: 0,
        max_tokens: req.maxTokens ?? 4096,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `${req.system}\n\nReply with a single JSON object and nothing else.` },
          { role: 'user', content: req.user },
        ],
      });
      const out: LLMResponse = {
        text: res.choices[0]?.message?.content ?? '',
        usage: { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 },
        model: res.model ?? model,
      };
      return out;
    },
  };
}
