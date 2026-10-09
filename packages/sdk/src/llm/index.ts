import type { LLM } from '../plugins.js';
import { OURO_LLM_ENV } from '../constants.js';
import { anthropic } from './anthropic.js';
import { openai } from './openai.js';
import { gemini } from './gemini.js';
import { ollama } from './ollama.js';

export { anthropic, openai, gemini, ollama };
export { completeJson, extractJson, LLMOutputError } from './json.js';

export type LLMName = 'anthropic' | 'openai' | 'gemini' | 'ollama';

export const llmAdapters: Record<LLMName, (opts?: any) => LLM> = { anthropic, openai, gemini, ollama };

/**
 * Pick the adapter: an LLM object is used as is, a name selects a built-in adapter,
 * otherwise the OURO_LLM environment variable decides (default anthropic).
 */
export function resolveLLM(choice?: LLM | LLMName | string): LLM {
  if (choice && typeof choice === 'object') return choice;
  const name = (choice ?? process.env[OURO_LLM_ENV] ?? 'anthropic').toLowerCase() as LLMName;
  const factory = llmAdapters[name];
  if (!factory) throw new Error(`unknown LLM adapter "${name}". Use one of: ${Object.keys(llmAdapters).join(', ')}`);
  return factory();
}
