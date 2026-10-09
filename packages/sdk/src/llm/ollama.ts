import type { LLM, LLMResponse } from '../plugins.js';

export type OllamaOptions = { model?: string; url?: string; fetch?: typeof globalThis.fetch };

export const OLLAMA_DEFAULT_MODEL = 'llama3.1';
export const OLLAMA_DEFAULT_URL = 'http://localhost:11434';

/** Ollama chat adapter. Temperature 0, format json, no streaming. */
export function ollama(opts: OllamaOptions = {}): LLM {
  const model = opts.model ?? process.env['OURO_MODEL'] ?? OLLAMA_DEFAULT_MODEL;
  const url = (opts.url ?? process.env['OLLAMA_URL'] ?? OLLAMA_DEFAULT_URL).replace(/\/$/, '');
  return {
    name: `ollama:${model}`,
    async complete(req) {
      const f = opts.fetch ?? globalThis.fetch;
      const res = await f(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          format: 'json',
          options: { temperature: 0, num_predict: req.maxTokens ?? 4096 },
          messages: [
            { role: 'system', content: `${req.system}\n\nReply with a single JSON document and nothing else.` },
            { role: 'user', content: req.user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`ollama: HTTP ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number; model?: string };
      const out: LLMResponse = {
        text: body.message?.content ?? '',
        usage: { inputTokens: body.prompt_eval_count ?? 0, outputTokens: body.eval_count ?? 0 },
        model: body.model ?? model,
      };
      return out;
    },
  };
}
