import { GoogleGenerativeAI } from '@google/generative-ai';
import type { LLM, LLMResponse } from '../plugins.js';

export type GeminiOptions = { apiKey?: string; model?: string; baseUrl?: string; fetch?: typeof globalThis.fetch };

export const GEMINI_DEFAULT_MODEL = 'gemini-2.0-flash';

/** Google Gemini adapter. Temperature 0, JSON response MIME type. Uses the global fetch. */
export function gemini(opts: GeminiOptions = {}): LLM {
  const model = opts.model ?? process.env['OURO_MODEL'] ?? GEMINI_DEFAULT_MODEL;
  const apiKey = opts.apiKey ?? process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'];
  if (!apiKey) throw new Error('gemini adapter: set GEMINI_API_KEY or pass apiKey');
  const client = new GoogleGenerativeAI(apiKey);
  return {
    name: `gemini:${model}`,
    async complete(req) {
      const m = client.getGenerativeModel(
        {
          model,
          systemInstruction: `${req.system}\n\nReply with a single JSON document and nothing else.`,
          generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: req.maxTokens ?? 4096 },
        },
        { baseUrl: opts.baseUrl ?? process.env['GEMINI_BASE_URL'] },
      );
      const original = globalThis.fetch;
      if (opts.fetch) globalThis.fetch = opts.fetch;
      try {
        const res = await m.generateContent(req.user);
        const meta = res.response.usageMetadata;
        const out: LLMResponse = {
          text: res.response.text(),
          usage: { inputTokens: meta?.promptTokenCount ?? 0, outputTokens: meta?.candidatesTokenCount ?? 0 },
          model,
        };
        return out;
      } finally {
        if (opts.fetch) globalThis.fetch = original;
      }
    },
  };
}
