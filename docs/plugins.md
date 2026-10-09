# Writing OURO plugins

Four interfaces, all in `@ourointelligence/sdk`. A plugin is a plain object; no base class, no registration file. Hand it to `createLoop` (`source`, `executor`, `primitives`, `llm`) or register it later with `loop.use(plugin)`, which replaces the source, executor or LLM and appends (or replaces by name) a primitive pack.

```ts
import type { Source, Executor, PrimitivePack, LLM } from '@ourointelligence/sdk';
```

## Source

A Source pulls history for warm-up and backfill and streams live bars. Bars are `{ ts, asset, tf, o, h, l, c, v }` with `ts` in milliseconds. `history` must return closed bars only, sorted by time, for every asset asked for; `subscribe` must yield each bar once, when it has closed. The loop calls `iterator.return()` on stop, so release sockets there.

```ts
import type { Bar, Source } from '@ourointelligence/sdk';

/** Any venue with a REST candle endpoint and a websocket fits this shape. */
export function myVenue(opts: { rest: string; ws: string }): Source {
  return {
    name: 'my-venue',

    async history({ assets, tf, bars }) {
      const out: Bar[] = [];
      for (const asset of assets) {
        const res = await fetch(`${opts.rest}/candles?symbol=${asset}&tf=${tf}&limit=${bars}`);
        if (!res.ok) throw new Error(`my-venue: HTTP ${res.status}`);
        const rows = (await res.json()) as Array<[number, string, string, string, string, string]>;
        for (const [ts, o, h, l, c, v] of rows) {
          out.push({ ts, asset, tf, o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v) });
        }
      }
      return out.sort((a, b) => a.ts - b.ts);
    },

    subscribe({ assets, tf }) {
      const queue: Bar[] = [];
      const waiting: Array<(r: IteratorResult<Bar>) => void> = [];
      let closed = false;
      const socket = new WebSocket(opts.ws);
      socket.onopen = () => socket.send(JSON.stringify({ op: 'subscribe', channels: assets.map((a) => `candles:${tf}:${a}`) }));
      socket.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data)) as { closed?: boolean; bar?: Bar };
        if (!m.closed || !m.bar) return; // only closed candles
        const w = waiting.shift();
        if (w) w({ value: m.bar, done: false });
        else queue.push(m.bar);
      };
      const it: AsyncIterator<Bar> & AsyncIterable<Bar> = {
        next() {
          if (closed) return Promise.resolve({ value: undefined, done: true });
          const b = queue.shift();
          if (b) return Promise.resolve({ value: b, done: false });
          return new Promise((resolve) => waiting.push(resolve));
        },
        return() {
          closed = true;
          socket.close();
          for (const w of waiting.splice(0)) w({ value: undefined, done: true });
          return Promise.resolve({ value: undefined, done: true });
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      return it;
    },
  };
}
```

A file or a generator function works too: `async *subscribe() { for (const bar of rows) yield bar; }`. The shipped `@ourointelligence/source-hyperliquid` is the reference implementation, including paging and reconnects.

## Executor

An Executor receives decisions and reports closed outcomes. The loop tags every order with the strategy that made it in `x.meta.strategyId` (the string `'ensemble'` under `dispatch: 'ensemble'`). When a position closes, call every `onClose` listener with that strategy id and an `Outcome`; put the asset in `outcome.raw.asset` so the loop can attribute the close when a strategy trades several assets. Two optional hooks: `onBar(bar)` is called with every new bar before any decision is made on it (use it to simulate fills, mark positions, check stops), and `stop()` is called on shutdown.

Units are yours to choose but must be consistent with the scorer and the guards: the built-in paper executor reports `pnl`, `fees` and `drawdown` in percent of equity, treats `size` as a fraction of equity, and `stop`/`tp` as price distances from entry.

```ts
import type { Bar, Decision, Executor, Input, Outcome } from '@ourointelligence/sdk';

type Position = { strategyId: string; asset: string; side: 'long' | 'short'; size: number; entry: number; openedTs: number; bars: number; worst: number };

/** A webhook executor: posts orders to your own service, which calls back when they close. */
export function webhookExecutor(url: string): Executor {
  const listeners: Array<(strategyId: string, outcome: Outcome) => void> = [];
  const open = new Map<string, Position>();
  const key = (strategyId: string, asset: string) => `${strategyId}:${asset}`;

  function close(pos: Position, exit: number, ts: number, reason: string) {
    const dir = pos.side === 'long' ? 1 : -1;
    const pnl = pos.size * (exit / pos.entry - 1) * dir * 100;
    const outcome: Outcome = { pnl, fees: pos.size * 0.001 * 100, drawdown: pos.size * pos.worst * 100, holdBars: pos.bars, closedTs: ts, raw: { asset: pos.asset, reason } };
    open.delete(key(pos.strategyId, pos.asset));
    for (const l of listeners) l(pos.strategyId, outcome);
  }

  return {
    name: 'webhook',
    async place(d: NonNullable<Decision>, x: Input) {
      const strategyId = String(x.meta?.['strategyId'] ?? 'unknown');
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ strategyId, asset: x.asset, decision: d, ts: x.ts }) });
      const { orderId, fill } = (await res.json()) as { orderId: string; fill?: number };
      const k = key(strategyId, x.asset);
      const pos = open.get(k);
      if (d.side === 'flat' || (pos && pos.side !== d.side)) {
        if (pos) close(pos, fill ?? x.bar.c, x.ts, d.side === 'flat' ? 'flat' : 'flip');
      }
      if (d.side !== 'flat' && !open.has(k) && fill !== undefined) {
        open.set(k, { strategyId, asset: x.asset, side: d.side, size: d.size, entry: fill, openedTs: x.ts, bars: 0, worst: 0 });
      }
      return { orderId };
    },
    onClose(cb) {
      listeners.push(cb);
    },
    onBar(bar: Bar) {
      for (const pos of open.values()) {
        if (pos.asset !== bar.asset) continue;
        pos.bars++;
        const adverse = pos.side === 'long' ? (pos.entry - bar.l) / pos.entry : (bar.h - pos.entry) / pos.entry;
        if (adverse > pos.worst) pos.worst = adverse;
      }
    },
    async stop() {
      for (const pos of [...open.values()]) close(pos, pos.entry, Date.now(), 'shutdown');
    },
  };
}
```

Register with `executor: webhookExecutor('https://...')` and run with `ouro run --live` (which requires `guards.requireApproval: true`).

## PrimitivePack

A pack turns a bar series into named features. `compute(bars, i)` returns the features for `bars[i]` given everything up to it; return `null` while an indicator has no data, never `NaN`. Keys are unprefixed inside the pack; the loop prefixes them with the pack name, so a pack named `flow` with a key `imbalance` becomes `x.features['flow.imbalance']`. `describe()` is what the Generator is shown: one entry per key, a sentence a model can act on, including units and typical ranges. Features can be numbers or booleans.

```ts
import type { Bar, FeatureValue, PrimitivePack } from '@ourointelligence/sdk';

/** Price-structure pack: distance from the N-bar high and low, range expansion, gap. */
export function structure(n = 20): PrimitivePack {
  return {
    name: 'structure',
    compute(bars: Bar[], i: number): Record<string, FeatureValue> {
      const bar = bars[i];
      if (!bar) return { highDist: null, lowDist: null, rangeRatio: null, gapPct: null, breakout: null };
      const from = Math.max(0, i - n + 1);
      let hi = -Infinity;
      let lo = Infinity;
      let rangeSum = 0;
      for (let j = from; j < i; j++) {
        const b = bars[j]!;
        hi = Math.max(hi, b.h);
        lo = Math.min(lo, b.l);
        rangeSum += b.h - b.l;
      }
      const prev = bars[i - 1];
      if (i - from < n - 1 || !prev) return { highDist: null, lowDist: null, rangeRatio: null, gapPct: null, breakout: null };
      const avgRange = rangeSum / (i - from);
      return {
        highDist: (hi - bar.c) / bar.c,
        lowDist: (bar.c - lo) / bar.c,
        rangeRatio: avgRange > 0 ? (bar.h - bar.l) / avgRange : null,
        gapPct: (bar.o - prev.c) / prev.c,
        breakout: bar.c > hi,
      };
    },
    describe() {
      return [
        { key: 'highDist', doc: `Distance from close down to the ${n}-bar high, as a fraction of close (0 means at the high).` },
        { key: 'lowDist', doc: `Distance from the ${n}-bar low up to close, as a fraction of close.` },
        { key: 'rangeRatio', doc: `This bar's range divided by the average range of the previous ${n - 1} bars; above 2 is an expansion bar.` },
        { key: 'gapPct', doc: 'Open minus the previous close, as a fraction of the previous close.' },
        { key: 'breakout', doc: `true when close is above the previous ${n - 1}-bar high.` },
      ];
    },
  };
}
```

Register with `primitives: [primitives.ta, structure(20)]` or `loop.use(structure(20))`. The built-in packs memoise indicator series per bar array; a pack that does heavy work should do the same (see `primitives/cache.ts` in the SDK).

## LLM adapter

An adapter is one method. It receives a system prompt and a user prompt, must run the model deterministically (temperature 0 where the model accepts it) and must return the model's reply as a string that contains one JSON document. The SDK extracts the JSON, validates it with zod, retries once with the error appended, and throws if the second reply is invalid; nothing invalid reaches trial. Adapters should honour `maxTokens`.

```ts
import type { LLM } from '@ourointelligence/sdk';

/** Adapter for any server that speaks the OpenAI chat-completions wire format. */
export function chatCompletions(opts: { url: string; model: string; apiKey?: string; fetch?: typeof globalThis.fetch }): LLM {
  const f = opts.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));
  return {
    name: `chat:${opts.model}`,
    async complete({ system, user, maxTokens }) {
      const res = await f(`${opts.url.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
        body: JSON.stringify({
          model: opts.model,
          temperature: 0,
          max_tokens: maxTokens ?? 4096,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: `${system}\n\nReply with a single JSON document and nothing else.` },
            { role: 'user', content: user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`chat: HTTP ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new Error('chat: empty reply');
      return text;
    },
  };
}
```

Register with `llm: chatCompletions({ url: 'http://localhost:1234/v1', model: 'my-model' })` or `loop.use(adapter)`. Without `llm`, the loop reads `OURO_LLM` (`anthropic`, `openai`, `gemini`, `ollama`) and `OURO_MODEL`.

## Checklist

- Source: closed bars only, sorted, one yield per bar, release the socket in `return()`.
- Executor: read `x.meta.strategyId`, set `outcome.raw.asset`, report `closedTs`, implement `onBar` if fills depend on the next bar, `stop` to flatten on shutdown.
- PrimitivePack: `null` not `NaN` during warm-up, unprefixed keys, docs with units.
- LLM: temperature 0 (where accepted), JSON in the reply, errors thrown not swallowed.
