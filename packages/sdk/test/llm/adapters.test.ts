import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropic } from '../../src/llm/anthropic.js';
import { openai } from '../../src/llm/openai.js';
import { gemini } from '../../src/llm/gemini.js';
import { ollama } from '../../src/llm/ollama.js';
import { resolveLLM } from '../../src/llm/index.js';

type Captured = { url: string; init: RequestInit & { headers?: any }; body: any };

function mockFetch(responseBody: unknown, status = 200): { fetch: typeof globalThis.fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let body: any = null;
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    if (typeof raw === 'string') {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    calls.push({ url, init: init ?? {}, body });
    return new Response(JSON.stringify(responseBody), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const req = { system: 'sys', user: 'usr', json: true as const, maxTokens: 256 };

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['OURO_LLM'];
});

describe('anthropic adapter', () => {
  it('posts to /v1/messages without a temperature for current models and returns the text block', async () => {
    const m = mockFetch({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text: '{"ok":true}' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const llm = anthropic({ apiKey: 'k', fetch: m.fetch });
    expect(llm.name).toBe('anthropic:claude-sonnet-5-5');
    const reply = await llm.complete(req);
    expect(reply).toMatchObject({ text: '{"ok":true}', usage: { inputTokens: 1, outputTokens: 1 } });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.url).toMatch(/\/v1\/messages$/);
    expect(m.calls[0]!.body.temperature).toBeUndefined();
    expect(m.calls[0]!.body.max_tokens).toBe(256);
    expect(m.calls[0]!.body.system).toContain('sys');
    expect(m.calls[0]!.body.messages[0]).toEqual({ role: 'user', content: 'usr' });
  });
  it('sends temperature 0 to models that still accept it', async () => {
    const m = mockFetch({
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: '{}' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const llm = anthropic({ apiKey: 'k', model: 'claude-sonnet-4-5', fetch: m.fetch });
    await llm.complete(req);
    expect(m.calls[0]!.body.temperature).toBe(0);
  });
  it('requires a key', () => {
    const saved = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    expect(() => anthropic()).toThrow(/ANTHROPIC_API_KEY/);
    if (saved) process.env['ANTHROPIC_API_KEY'] = saved;
  });
});

describe('openai adapter', () => {
  it('posts to /chat/completions with json mode and temperature 0', async () => {
    const m = mockFetch({ id: 'c', object: 'chat.completion', created: 1, model: 'gpt-4o', choices: [{ index: 0, message: { role: 'assistant', content: '{"a":1}' }, finish_reason: 'stop' }] });
    const llm = openai({ apiKey: 'k', fetch: m.fetch });
    expect(llm.name).toBe('openai:gpt-4o');
    expect(await llm.complete(req)).toMatchObject({ text: '{"a":1}' });
    expect(m.calls[0]!.url).toMatch(/\/chat\/completions$/);
    expect(m.calls[0]!.body.temperature).toBe(0);
    expect(m.calls[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(m.calls[0]!.body.messages[1]).toEqual({ role: 'user', content: 'usr' });
  });
  it('honours a base URL for OpenAI-compatible servers without a key', async () => {
    const m = mockFetch({ choices: [{ message: { content: '{}' } }] });
    const llm = openai({ baseUrl: 'http://localhost:1234/v1', model: 'local-model', fetch: m.fetch });
    await llm.complete(req);
    expect(m.calls[0]!.url).toBe('http://localhost:1234/v1/chat/completions');
    expect(m.calls[0]!.body.model).toBe('local-model');
  });
});

describe('gemini adapter', () => {
  it('posts to generateContent with a JSON mime type and temperature 0', async () => {
    const m = mockFetch({ candidates: [{ content: { role: 'model', parts: [{ text: '{"g":1}' }] }, finishReason: 'STOP', index: 0 }] });
    vi.stubGlobal('fetch', m.fetch);
    const llm = gemini({ apiKey: 'k' });
    expect(llm.name).toBe('gemini:gemini-2.0-flash');
    expect(await llm.complete(req)).toMatchObject({ text: '{"g":1}' });
    expect(m.calls[0]!.url).toMatch(/models\/gemini-2.0-flash:generateContent/);
    expect(m.calls[0]!.body.generationConfig.temperature).toBe(0);
    expect(m.calls[0]!.body.generationConfig.responseMimeType).toBe('application/json');
    expect(JSON.stringify(m.calls[0]!.body.systemInstruction)).toContain('sys');
  });
});

describe('ollama adapter', () => {
  it('posts to /api/chat with format json and temperature 0', async () => {
    const m = mockFetch({ message: { role: 'assistant', content: '{"o":1}' }, done: true });
    const llm = ollama({ url: 'http://localhost:11434/', fetch: m.fetch });
    expect(llm.name).toBe('ollama:llama3.1');
    expect(await llm.complete(req)).toMatchObject({ text: '{"o":1}' });
    expect(m.calls[0]!.url).toBe('http://localhost:11434/api/chat');
    expect(m.calls[0]!.body.format).toBe('json');
    expect(m.calls[0]!.body.stream).toBe(false);
    expect(m.calls[0]!.body.options.temperature).toBe(0);
  });
  it('throws on non-2xx', async () => {
    const m = mockFetch({ error: 'no model' }, 404);
    await expect(ollama({ fetch: m.fetch }).complete(req)).rejects.toThrow(/HTTP 404/);
  });
});

describe('resolveLLM', () => {
  it('uses an object as is, a name, then the OURO_LLM env var', () => {
    const custom = { name: 'custom', complete: async () => '{}' };
    expect(resolveLLM(custom)).toBe(custom);
    expect(resolveLLM('ollama').name).toMatch(/^ollama:/);
    process.env['OURO_LLM'] = 'ollama';
    expect(resolveLLM().name).toMatch(/^ollama:/);
    expect(() => resolveLLM('nope')).toThrow(/unknown LLM adapter/);
  });
});
