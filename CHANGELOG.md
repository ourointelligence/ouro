# Changelog

All three packages share one version number.

## 0.2.0 (2026-10-10)

Everything Arena, the SDK's first real customer, found missing. Configs written for 0.1.0 keep working; the new options all have defaults.

### @ourointelligence/sdk

- Typed event API (F1): `loop.on(event, handler)` and `loop.off`, typed by the exported `EventMap`. Events: `bar`, `decision`, `trade:open`, `trade:close`, `cycle:start`, `cycle:step`, `critique`, `candidate`, `promote`, `retire`, `cycle:end`, `pending`, `approved`, `rejected`, `rollback`, `llm`, `error`, plus `log`, `seed`, `episode`, `cycle`, `pause`, `resume` and `stop`. A throwing handler never breaks the loop; it is reported as an `error` event with scope `handler:<event>`. `loop.events` (the 0.1.0 emitter) still fires.
- Bar-level replay (F2): `replay: 'bars'` (the new default) stores every closed bar in the episode store and scores strategies and candidates by running `decide` over the stored bars with the paper fill model (fill at the next open, fee and slippage, stop before target when both are hit in one bar). Features come from the registered packs and only from bars up to the decision bar. `replay: 'outcome'` restores the 0.1.0 behaviour. `replayBars()` is exported. The sandbox gained `runMany()` so a replay is one isolate call per asset.
- `cycleMaxWait` (F3): a cycle also fires when that much bar time has passed since the last cycle and at least one new episode exists, ranking strategies with what they have.
- `minTradesPerWindow` (F4, default 3): a strategy with fewer closed trades since the last cycle ranks weakest and, when replaced, is retired with `retireReason: 'inactive'`. Strategies now carry `retireReason` (`replaced`, `inactive`, `rolled_back`, `compile`).
- LLM usage (F5): adapters may return `{ text, usage: { inputTokens, outputTokens }, model }` and the four built-in ones do. The loop emits an `llm` event per call and sums usage into `cycle:end` and `CycleResult.usage`; `llmPricing: { inputPerMTok, outputPerMTok }` adds `usd`.
- `Bar.ext` (F6): optional numeric extras (funding rate, open interest, premium ...) that sources attach, packs read, the store keeps and replay uses. `Bar.stale` marks a late bar the loop records but does not trade on.
- Funding in paper (F7): `paperExecutor({ funding: true })` accrues `bar.ext['funding.rate']` hourly while a position is open (longs pay a positive rate), reports it in `outcome.funding` and includes it in `pnl`. Off by default. `stop(ts)` takes the timestamp to stamp forced closes with. The executor exposes its `config`.
- Export schema (F8): `loop.export()` and `ouro export` produce `schemaVersion: 1` in canonical key order, documented in `docs/export-schema.md`. `canonical()` and `canonicalJson()` are exported.
- Wrappable adapters (F9): `wrapLLM(inner, { before, after, onError })` and `withRetry()`. When an adapter throws, the loop retries twice with backoff (`llmRetry`), then ends the cycle with status `error` and note `llm_error`, keeps trading on the current population and never crashes. Seeding retries after `seedRetryMs` when the model is down.
- Lifecycle (F10): `pause()`, `resume()`, `setApproval(on)`, `export()`, `status()`. `stop()` now waits for a running cycle, closes the subscription, flushes the store, saves history and calls `executor.stop()`. Two loops with different `dir` values in one process share no state (tested), and a process killed during any cycle step resumes cleanly (tested).
- `Executor.onOpen` (optional) lets an executor report fills so `trade:open` carries the real price; the paper executor implements it.
- CLI: `ouro export` writes the versioned export; version 0.2.0.

### @ourointelligence/source-hyperliquid

- Reconnect with exponential backoff (1 s to 60 s, jitter, reset after 30 s stable), gap detection with refill from `candleSnapshot` before new bars are emitted, `stale` flag on bars older than two intervals, a per-source rate budget (`rateLimit: { weightPerMinute }`, 429 backoff), `stats()` for health reporting, and `onEvent` for gap, reconnect, stale and rate-limit notices.
- `withAssetCtx(source)` (or `assetCtx: true`) fills `bar.ext` with `funding.rate`, `oi`, `oi.change`, `premium`, `mark` and `oracle` from `metaAndAssetCtxs` once per bar close, and backfills `funding.rate` for history from `fundingHistory`.
- Depends on `@ourointelligence/sdk` with the range `^0.2.0` (was `workspace:^`).

### @ourointelligence/executor-paper

- Passes the new `funding` option through; depends on `@ourointelligence/sdk` `^0.2.0`.

## 0.1.0 (2026-10-09)

First release: the loop, sandbox, trial harness, guards, population store, SI metrics, built-in primitive packs, four LLM adapters, the `ouro` CLI, the Hyperliquid source and the paper executor.
