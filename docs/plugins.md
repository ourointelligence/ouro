# Writing OURO plugins

Four interfaces, all in `@ourointelligence/sdk`. A plugin is a plain object; no base class, no registration file. Hand it to `createLoop` (`source`, `executor`, `primitives`, `llm`) or register it later with `loop.use(plugin)`, which replaces the source, executor or LLM and appends (or replaces by name) a primitive pack.

```ts
import type { Source, Executor, PrimitivePack, LLM } from '@ourointelligence/sdk';
```

## Source

A Source pulls history for warm-up and backfill and streams live bars. Bars are `{ ts, asset, tf, o, h, l, c, v }` with `ts` in milliseconds, plus two optional fields: `ext`, a map of extra numbers (funding rate, open interest, premium, anything your venue reports) that primitive packs can read and that the store keeps for replay, and `stale`, which a source sets on a bar that arrived more than two intervals late so the loop records it without trading on it. `history` must return closed bars only, sorted by time, for every asset asked for; `subscribe` must yield each bar once, when it has closed. The loop calls `iterator.return()` on stop, so release sockets there.

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

A file or a generator function works too: `async *subscribe() { for (const bar of rows) yield bar; }`. The shipped `@ourointelligence/source-hyperliquid` is the reference implementation: paging, reconnect with backoff, gap refill, the stale flag, a rate budget and market context.

```ts
import { hyperliquid, withAssetCtx } from '@ourointelligence/source-hyperliquid';

// one WebSocket, at most 200 request weight per minute, notices to your log
const source = hyperliquid({ rateLimit: { weightPerMinute: 200 }, onEvent: (e) => console.log(e) });

// bar.ext gets funding.rate, oi, oi.change, premium, mark and oracle from metaAndAssetCtxs once per bar close,
// and funding.rate is backfilled for history from fundingHistory
const withContext = withAssetCtx(source);   // or hyperliquid({ assetCtx: true, ... })
withContext.stats();                         // { weightUsedLastMinute, requests, reconnects, gapsFilled, lastBarTs, connected }
```

## Executor

An Executor receives decisions and reports closed outcomes. The loop tags every order with the strategy that made it in `x.meta.strategyId` (the string `'ensemble'` under `dispatch: 'ensemble'`). When a position closes, call every `onClose` listener with that strategy id and an `Outcome`; put the asset in `outcome.raw.asset` so the loop can attribute the close when a strategy trades several assets. Three optional hooks: `onBar(bar)` is called with every new bar before any decision is made on it (use it to simulate fills, mark positions, check stops), `stop()` is called on shutdown, and `onOpen(cb)` lets you report a filled entry as `{ asset, side, size, price, ts }` so the loop's `trade:open` event carries the real fill price (without it the loop reports the decision price when the order is placed).

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

Bar replay (`replay: 'bars'`, the default since 0.2.0) scores candidates with the built-in paper fill model regardless of which executor is live, reading `feeBps`, `slippageBps` and `funding` from the paper executor when that is what runs, or from `replayPaper` in the loop config otherwise. If your live executor fills differently, set `replayPaper` to the closest approximation.

## PrimitivePack

A pack turns a bar series into named features. `compute(bars, i)` returns the features for `bars[i]` given everything up to it; return `null` while an indicator has no data, never `NaN`. Never read `bars[i + 1]` or later: bar replay feeds packs the full stored series with the index of the decision bar, and the SDK's look-ahead test checks that nothing inside a window changes when later bars change. Extra fields a source attached are available as `bars[i].ext?.['funding.rate']` and so on; a pack that uses them should return `null` when the key is absent. Keys are unprefixed inside the pack; the loop prefixes them with the pack name, so a pack named `flow` with a key `imbalance` becomes `x.features['flow.imbalance']`. `describe()` is what the Generator is shown: one entry per key, a sentence a model can act on, including units and typical ranges. Features can be numbers or booleans.

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

An adapter is one method. It receives a system prompt and a user prompt, must run the model deterministically (temperature 0 where the model accepts it) and must return the model's reply, which contains one JSON document, either as a plain string or as `{ text, usage: { inputTokens, outputTokens }, model }`. Returning the object lets the loop count tokens: every call becomes an `llm` event and the cycle's usage (and dollars, with `llmPricing`) lands in `cycle:end`. The four built-in adapters return it. The SDK extracts the JSON, validates it with zod, retries once with the error appended, and throws if the second reply is invalid; nothing invalid reaches trial. Adapters should honour `maxTokens`. When an adapter throws (network, 5xx, timeout) the loop retries twice with backoff (`llmRetry`), then records the cycle as `error` with reason `llm_error` and keeps trading.

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
      return { text, usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 }, model: opts.model };
    },
  };
}
```

Register with `llm: chatCompletions({ url: 'http://localhost:1234/v1', model: 'my-model' })` or `loop.use(adapter)`. Without `llm`, the loop reads `OURO_LLM` (`anthropic`, `openai`, `gemini`, `ollama`) and `OURO_MODEL`.

### Wrapping an adapter

The built-in adapters (`anthropic`, `openai`, `gemini`, `ollama`) and `resolveLLM` are exported, and `wrapLLM(inner, hooks)` puts your own code around any of them: `before(req)` runs before the call and may throw to refuse it (a budget), `after(res, req, ms)` sees the normalised reply with its usage and may replace it, `onError(err, req)` may recover from a failure. `withRetry(fn, { retries, baseMs })` is the backoff helper the loop itself uses.

```ts
import { anthropic, wrapLLM } from '@ourointelligence/sdk';

let spentToday = 0;
const llm = wrapLLM(anthropic(), {
  before: () => {
    if (spentToday > 1) {
      const err = new Error('daily budget reached');
      err.name = 'BudgetExceeded';   // the loop does not retry this one
      throw err;
    }
  },
  after: (res, _req, ms) => {
    spentToday += (res.usage.inputTokens * 3 + res.usage.outputTokens * 15) / 1e6;
    console.log(`${res.model}: ${res.usage.inputTokens} in, ${res.usage.outputTokens} out, ${ms} ms`);
  },
});
createLoop({ llm, ... });
```

## Installing from GitHub release files

Until the packages are on the npm registry, install the packed files attached to each GitHub release. The plugin packages declare `@ourointelligence/sdk` as a peer dependency with a normal semver range, so add overrides at the root of your project to make that range resolve to the same release file:

```json
{
  "dependencies": {
    "@ourointelligence/sdk": "https://github.com/ourointelligence/ouro/releases/download/v0.2.0/ourointelligence-sdk-0.2.0.tgz",
    "@ourointelligence/source-hyperliquid": "https://github.com/ourointelligence/ouro/releases/download/v0.2.0/ourointelligence-source-hyperliquid-0.2.0.tgz",
    "@ourointelligence/executor-paper": "https://github.com/ourointelligence/ouro/releases/download/v0.2.0/ourointelligence-executor-paper-0.2.0.tgz"
  },
  "pnpm": {
    "overrides": {
      "@ourointelligence/sdk": "https://github.com/ourointelligence/ouro/releases/download/v0.2.0/ourointelligence-sdk-0.2.0.tgz",
      "@ourointelligence/source-hyperliquid": "https://github.com/ourointelligence/ouro/releases/download/v0.2.0/ourointelligence-source-hyperliquid-0.2.0.tgz",
      "@ourointelligence/executor-paper": "https://github.com/ourointelligence/ouro/releases/download/v0.2.0/ourointelligence-executor-paper-0.2.0.tgz"
    }
  }
}
```

With npm instead of pnpm use the same URLs in `dependencies` and an `overrides` block at the top level. Moving to the registry later is a one-line change per package: replace each URL with the version number and delete the overrides.

## Checklist

- Source: closed bars only, sorted, one yield per bar, release the socket in `return()`.
- Executor: read `x.meta.strategyId`, set `outcome.raw.asset`, report `closedTs`, implement `onBar` if fills depend on the next bar, `onOpen` to report fills, `stop` to flatten on shutdown.
- PrimitivePack: `null` not `NaN` during warm-up, unprefixed keys, docs with units, never look past `bars[i]`.
- LLM: temperature 0 (where accepted), JSON in the reply, usage in the return value, errors thrown not swallowed.
