import Anthropic from '@anthropic-ai/sdk';
import type { LLM } from '../plugins.js';

export type AnthropicOptions = { apiKey?: string; model?: string; baseUrl?: string; fetch?: typeof globalThis.fetch };

export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5-5';

/**
 * Claude 4.6 and later reject sampling parameters (temperature, top_p, top_k) with a 400 and always run at their
 * own setting, so temperature 0 is only sent to the models that still accept it.
 */
export function acceptsTemperature(model: string): boolean {
  return /claude-(3[-.]|haiku-4-5|sonnet-4-5|sonnet-4(-0)?$|opus-4-5|opus-4-1|opus-4(-0)?$)/.test(model);
}

/** Anthropic Messages API adapter. Temperature 0, JSON requested through the system prompt. */
export function anthropic(opts: AnthropicOptions = {}): LLM {
  const model = opts.model ?? process.env['OURO_MODEL'] ?? ANTHROPIC_DEFAULT_MODEL;
  const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) throw new Error('anthropic adapter: set ANTHROPIC_API_KEY or pass apiKey');
  const client = new Anthropic({
    apiKey,
    baseURL: opts.baseUrl ?? process.env['ANTHROPIC_BASE_URL'],
    fetch: ((url: any, init?: any) => (opts.fetch ?? globalThis.fetch)(url, init)) as typeof globalThis.fetch,
    maxRetries: 2,
  });
  return {
    name: `anthropic:${model}`,
    async complete(req) {
      const res = await client.messages.create({
        model,
        max_tokens: req.maxTokens ?? 4096,
        ...(acceptsTemperature(model) ? { temperature: 0 } : {}),
        system: `${req.system}\n\nReply with a single JSON document and nothing else.`,
        messages: [{ role: 'user', content: req.user }],
      });
      return res.content
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join('');
    },
  };
}
