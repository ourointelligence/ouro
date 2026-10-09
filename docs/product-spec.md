# OURO product spec

OURO is an open-source TypeScript SDK for recursive self-improvement (RSI), the mechanism at the centre of every serious definition of superintelligence: a system that invents its own strategies, judges its own failures, rewrites itself, and gets measurably better with no human in the loop. OURO packages that mechanism so any developer can point it at any goal, on any chain or no chain, and let it run. The developer gives a goal, a data source and a scorer; OURO invents and evolves the strategies. "OURO" is a working name held in one constant (`OURO_NAME`) so it can be swapped before launch.

Positioning line: **Superintelligence you can switch off.**

## 1. Why this is SI tech, not an AI feature

A superintelligence is not a bigger model. It is a system whose capability rises on its own over time, and the engine of that rise is recursive self-improvement. Today's agents are frozen at deploy time and only change when a human edits them. OURO is RSI at the agent level, with the brakes built in.

| SI primitive | What it means in theory | What OURO ships |
| --- | --- | --- |
| Self-model | The system holds a readable description of itself | The live population plus every strategy ever generated, with parents and rationale, in `.ouro/history.json` and `.ouro/population/`; the Critic and the Generator read it |
| Self-critique | The system judges its own output | The Critic: an LLM step that reads the agent's own worst and best episodes and writes a diagnosis |
| Self-modification | The system rewrites itself | Seed, mutate, crossbreed and fresh-write: the population changes without human edits |
| Corrigibility | The system can be bounded and switched off | Sandbox, guards, holdout, approval switch, one-call rollback, `stop()` |

The number everyone watches is the **Capability Index (CI)**: a strategy's holdout score relative to the seed generation. Population CI plotted over cycles is the **takeoff curve**. CI gain per cycle is **velocity**; when velocity flattens the population has hit the **ceiling** of its current primitives and needs new packs, which is the only point a human steps in.

## 2. What it is and is not

- A library (`npm i @ourointelligence/sdk`), not a hosted service. It runs on the user's machine with the user's own LLM key and data (BYOK). No server, no credits, no account, no token.
- Model-agnostic: Anthropic, OpenAI, Gemini and Ollama adapters ship; any OpenAI-compatible server works through `OPENAI_BASE_URL`; a custom adapter is one object with a `complete` method.
- Chain-agnostic and venue-agnostic: sources and executors are plugins. The reference source is Hyperliquid public candles; the reference executor is paper.
- Domain-agnostic: trading is the reference example, but anything with a goal, an input stream and a score works (support bots, scrapers, pricing, routing, games). `examples/support-bot` runs the identical loop over tickets.
- It generates its own strategies. You can hand it some (`seed: [...]`), but the default is that it invents a population from your goal and primitive docs.
- It is not a trading bot, an exchange connector or an agent framework. It is the intelligence layer that sits on top of those.

## 3. Core concepts

| Concept | Plain meaning | Shape in code |
| --- | --- | --- |
| Goal | What "better" means, in one line, plus the primitives available and optional constraints | `goal`, `primitives`, `allow` / `bounds` / `freeze` |
| Primitive | A small building block the SDK may use: an indicator, a data field, a filter | A `PrimitivePack` that computes named features from bars and documents them |
| Strategy | A generated program made of primitives: when to act and how much | A TypeScript module (`params`, `bounds`, `decide`, `describe`) plus a `Strategy` record |
| Population | The set of strategies alive at once; the SDK keeps K, not one | Live `Strategy[]` with trial scores and CI |
| Episode | One unit of work with a result: one trade, one ticket, one scrape | `{ id, ts, strategyId, input, decision, outcome, score }` |
| Log | Append-only store of episodes | SQLite (`episodes.db`), JSONL fallback |
| Scorer | Turns an outcome into a number the loop can compare | `score(episode) => number` |
| Critic | LLM step that reads failures and explains why | `diagnose(weak, strong, live)` |
| Generator | LLM step that writes new strategies and mutations | `seed`, `mutate`, `crossbreed`, `fresh` |
| Trial | Strategies re-run over the same stored bars (or the same episodes), train and holdout | `split`, `replayBars` and `replay` in the trial harness |
| Promotion | A strategy enters the live population, or is retired | Versioned `history.json` |
| Guard | A rule the loop may never break | Sandbox, bounds, allow, freeze, drawdown and size caps, approval |
| Source | Where inputs come from | Plugin: `subscribe()` and `history()` |
| Executor | Where decisions go | Plugin: `place()` and `onClose()` |

## 4. The loop

One cycle runs automatically once every live strategy has `cycleEvery` new episodes, or once `cycleMaxWait` of bar time has passed since the last cycle with at least one new episode (so one quiet strategy cannot freeze the loop), on a timer (`start({ every })`), or on demand (`cycle()`). The SDK runs a population at once, so every cycle is both an edit to the survivors and a search for new ones. Every step is reported through typed events (`cycle:start`, `cycle:step`, `critique`, `candidate`, `promote`, `retire`, `cycle:end`), so a dashboard can show the loop thinking.

1. **Seed** (first run only): the Generator reads the goal and the primitive docs and writes K strategies. Each passes the sandbox and the guards before it may run. User-supplied modules (`seed: [...]`) come first, origin `user`.
2. **Collect**: the last `cycleEvery` episodes of every live strategy, pooled, split chronologically into train (older) and holdout (newest, untouched).
3. **Rank**: every live strategy is re-run over the holdout window. A strategy with fewer than `minTradesPerWindow` closed trades since the last cycle (default 3) ranks weakest regardless of score, so strategies that never trade are retired first (reason `inactive`). The bottom share (`retireShare`, default a quarter, at least one) is marked weak; the top two active strategies are strong.
4. **Diagnose**: the Critic reads the worst episodes of the weak strategies and the best of the strong ones and writes a short diagnosis: patterns, a summary, weak and strong ids.
5. **Generate**: one mutation per weak strategy, one crossbreed of the two strong ones, one fresh strategy written from the diagnosis, capped at `maxProposalsPerCycle`. Every candidate must pass the sandbox and the guards.
6. **Trial**: candidates are re-run over the stored bars of the train window with the paper fill model (`replay: 'bars'`, the default), so a new idea is scored on what it would have done; those that do not beat the population median by the margin are rejected (`train margin`).
7. **Validate**: survivors are re-run over the holdout window; each must beat the weakest live strategy not yet replaced, else it is rejected (`holdout`). Winners on train that lose on holdout are curve-fit and never enter.
8. **Promote**: each winner replaces its target. Population size stays at K. Everything is written to history with scores and rationale, CI is recomputed, `takeoff.json` is rewritten.

If no candidate survives, the cycle records `no_change`. That is a valid and common result. If there is not enough data, the cycle returns `no_change` with the note `not enough data` and is not recorded. If the model cannot be reached after the retries, the cycle is recorded with status `error` and the note `llm_error`, the population stays as it was, and trading continues; the loop never crashes because a provider is down. Every model call reports its token usage, summed per cycle and priced in dollars when `llmPricing` is set.

## 5. Strategy modes

- **Generate mode** (default): the SDK invents strategies from the goal and primitives, keeps a population and evolves it. Nothing is fixed except the guards.
- **Seeded mode**: `seed: ['./my-strategy.ts']` makes your modules the first generation (origin `user`); the Generator fills the rest of K.
- **Constrained mode**: `allow` (feature keys the Generator may read), `bounds` (parameter ranges), `freeze` (keys a child may never change from its parent). Any combination, per key, never forced. They appear in every Generator prompt and are enforced by the guards.

## 6. Guards (always on)

- **Sandbox**: every generated module runs in an isolated VM with memory, CPU and time limits, no network, no filesystem, no imports. Code containing `import`, `require`, `fetch`, `process`, `globalThis`, `eval`, `Function`, `while(true)`, `for(;;)`, timers, sockets or constructor walks is rejected before it runs.
- **Holdout**: the newest slice of episodes is never used for diagnosing or generating, only for validating.
- **Margin**: a candidate must beat the population median on train by `margin`, and beat the strategy it would replace on holdout.
- **Risk ceiling**: a candidate whose replay drawdown exceeds `maxDrawdownPct` or whose sizing exceeds `maxPositionPct / 100` is rejected before trial.
- **Optional narrowing**: `allow`, `bounds`, `freeze`. Off by default.
- **Rollback**: `rollback(cycle)` restores the population as it was at the end of that cycle; history is never deleted.
- **Human switch**: `requireApproval: true` makes a cycle return `pending` until `approve(cycle)` or `reject(cycle)`. Default off for paper; `--live` refuses to start without it.

## 7. Public API (v1)

| Call | What it does |
| --- | --- |
| `createLoop(config)` | Builds a loop from a goal, primitives, a scorer, a source, an executor and an LLM adapter |
| `loop.init()` | Opens the log and the population store (every other method calls it) |
| `loop.seed(k?)` | Generates the first population (runs automatically on first `start`) |
| `loop.decide(input)` | Runs every live strategy on one input; returns `{ perStrategy, ensemble }` |
| `loop.record(episode)` | Scores (if unscored) and appends one episode |
| `loop.cycle()` | Runs one improvement cycle; returns `{ cycle, status, promoted, retired, rejected, diagnosis, populationCI }` |
| `loop.start({ every? })` | Seeds if needed, warms up, trades through backfill, subscribes to live bars, cycles automatically; `every` adds a timer |
| `loop.stop()` | Waits for a running cycle, ends the subscription, clears the timer, closes open paper positions, flushes the store |
| `loop.pause(reason?)` / `loop.resume()` | Keep receiving bars but make no decisions and run no cycles until resumed |
| `loop.setApproval(on)` | Turn the approval switch on or off at runtime |
| `loop.export()` | The versioned export (`schemaVersion: 1`) in canonical key order |
| `loop.status()` | Running, paused, cycle count, live and total strategies, episodes, pending cycle, approval, last bar and cycle times |
| `loop.on(event, handler)` / `loop.off(event, handler)` | Typed events: bars, decisions, trades, every cycle step, the critique, every candidate with its fate, promotions, retirements, cycle ends with usage, pending, approved, rejected, rollback, model calls, errors |
| `loop.approve(cycle)` / `loop.reject(cycle)` | Apply or discard a pending cycle |
| `loop.population()` | Live strategies with trial scores and CI |
| `loop.history()` | Every strategy ever generated and every cycle |
| `loop.rollback(cycle)` | Restores the population as it was after that cycle |
| `loop.explain(id)` | Plain-language summary of what a strategy does and why it exists |
| `loop.takeoff()` | `[{ cycle, populationCI, bestCI, velocity }]` |
| `loop.use(plugin)` | Registers a source, executor, primitive pack or LLM adapter |
| `loop.ready()` / `loop.cycleCount()` / `loop.close()` | Whether a cycle is due; completed cycles; release everything |
| `loop.events` | The 0.1.0 emitter: `log`, `seed`, `bar`, `decision`, `episode`, `cycle`, `error` |

Config: `{ goal, primitives, source, executor | 'paper', score, llm?, population? (8), cycleEvery? (50), cycleMaxWait? (off), minTradesPerWindow? (3), holdout? (0.3), margin? (0.05), guards?, seed?, allow?, bounds?, freeze?, ensemble? ('weighted'), dir? ('.ouro'), assets, tf, warmupBars? (300), backfill? (0), dispatch? ('per-strategy'), retireShare? (0.25), autoCycle? (true), replay? ('bars'), replayPaper?, llmPricing?, llmRetry? ({ retries: 2, baseMs: 1000 }), seedRetryMs? (60000), sandbox?, log? }`.

## 8. Outputs people can show

- A population table: every live strategy with origin (`seed`, `mutate`, `crossbreed`, `fresh`, `user`), the cycle it was born, holdout score, CI and a one-sentence description.
- A takeoff curve: population CI, best CI and velocity per cycle, with a ceiling flag when velocity flattens.
- Readable code for every strategy ever generated, with parents and rationale, so a non-coder can see what changed and why.
- A standard `ouro.json` export with `schemaVersion: 1` (`goal`, `createdAt`, `cycle`, `population`, `history`, `takeoff`) in canonical key order, documented in `docs/export-schema.md`, so any dashboard, bot, hash chain or on-chain registry can display and verify the track record.

## 9. SI terms

| Term | Meaning in OURO |
| --- | --- |
| RSI | Recursive self-improvement: the loop that makes the agent better each cycle |
| Self-model | The live population plus the history of every strategy generated; the Generator reads both |
| Critic | The step where the agent judges its own failures |
| Capability Index (CI) | How much better a strategy is than the seed generation, measured on unseen data |
| Takeoff curve | Population CI over cycles; `npx ouro takeoff` prints it |
| Velocity | CI gain per cycle |
| Ceiling | When velocity flattens; add primitive packs or loosen narrowing |
| Corrigibility | Guards, approval and rollback: you can always bound it or stop it |

## 10. Going live safely

- Start on paper until population CI has risen over at least three cycles and held on holdout.
- Set `maxDrawdownPct` and `maxPositionPct`; the loop rejects any candidate that breaches them before trial.
- Turn on `requireApproval` and read each cycle's diagnosis and rationales before approving.
- Use a live executor plugin only with `--live`. Choose `dispatch: 'ensemble'` to send one ensemble order instead of one order per strategy.
- Keep `rollback <cycle>` one command away.

## 11. Token model (optional, separate package)

The token is separate from the SDK. The SDK is free, MIT licensed and works with no token on any chain. The token is the community asset of the SI thesis, not a key to the product. Possible later uses, all optional and chain-agnostic: a Capability Registry on any EVM or SVM chain where agents publish their takeoff curves; fees in the token for hosted loops once those exist; votes on which primitive packs enter the public library. None of this is in v1.

## 12. Non-goals for v1

No hosted runs, no dashboard web app, no exchange connectors beyond the Hyperliquid candle source, no Python port. Each is a later package. (Full re-simulation replay was a v1 non-goal and shipped in 0.2.0 as bar-level replay.)

## 13. Decisions where the build deliberately differs from the original spec text

- **Paper executor placement.** The paper executor implementation lives inside `@ourointelligence/sdk` (`paperExecutor`) so `executor: 'paper'` works with no extra install. `@ourointelligence/executor-paper` is the plugin-shaped entry point that wraps it with the reference defaults (3.5 bps fee, 2 bps slippage). This avoids a circular workspace dependency.
- **Capability Index baseline.** CI uses each strategy's **own-episode** holdout score (`trial.ownHoldoutScore`: mean score over the newest `holdout` share of its own last `cycleEvery` episodes), and the baseline is the seed generation's mean own-episode holdout score, stored once at the first cycle that has it. `trial.holdoutScore` is the pooled-replay score the promotion decision compares. Pooled scores move with what the live population happens to trade, so a ratio against them wobbles even when nothing changed; own-episode scores do not. A strategy gets a CI once it has traded on its own for at least three holdout episodes; until then it does not count toward the population CI.
- **Pooled replay for ranking.** Live strategies and candidates are all replayed on the same pooled episode set (the union of every live strategy's recent episodes), so "beats the median" and "beats the strategy it would replace" compare like with like.
- **Extra config.** `backfill` trades through recent history on paper before subscribing so the first cycles happen in minutes; `dispatch: 'ensemble'` sends one order; `autoCycle: false` disables the episode-count trigger; `retireShare` sets the weak share; `sandbox` and `log` pass backend options.
- **`Executor.onBar` and `stop`.** Optional hooks on the Executor interface. The loop calls `onBar(bar)` with every new bar before any decision on it, which is how the paper executor fills at the next open and tracks stops; `stop()` closes positions on shutdown.
- **Anthropic default model.** `claude-sonnet-5-5` instead of the `claude-sonnet-4-5` the original spec named, because that model is deprecated with an end of life on 2026-11-30. `OURO_MODEL` overrides it. Temperature 0 is only sent to models that accept a temperature parameter; Claude 4.6 and later reject it.
- **Not-enough-data cycles are not recorded**, so they do not consume a cycle number or add a flat takeoff row.
- **Bar replay by default (0.2.0).** Trial and validation re-run a candidate's `decide` over the stored bars of the window with the paper fill model instead of crediting stored outcomes, because outcome replay scored a genuinely new idea at zero whenever its trades differed from the live population's and pushed the population toward copies of itself. `replay: 'outcome'` keeps the 0.1.0 behaviour; it is also the fallback when no bars are stored.
- **Max wait (0.2.0).** `cycleMaxWait` fires a cycle on bar time even when a strategy is short of `cycleEvery` episodes, because one rarely-trading strategy otherwise stalls the whole loop for days. Such a cycle ranks strategies with what they have.
- **Minimum activity (0.2.0).** `minTradesPerWindow` ranks a strategy with too few closed trades as the weakest, so a strategy that never trades (score zero, never loses) cannot squat a slot forever; it retires with reason `inactive`.
- **Usage events (0.2.0).** Adapters return token usage, every call is an `llm` event and each cycle carries its usage and cost, because a self-improving loop that spends money needs a per-cycle bill. Plain-string adapters still work and report zero.
