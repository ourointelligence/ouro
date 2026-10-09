# OURO technical spec

Everything below describes the code in `packages/sdk/src` as built. File names in headings are relative to that directory.

## 1. Repository

pnpm monorepo, TypeScript 5 strict, ESM, tsup build, vitest, changesets, eslint, MIT, Node >= 20. All three packages share one version (0.2.0); the plugin packages depend on `@ourointelligence/sdk` with the range `^0.2.0`, which `link-workspace-packages=true` in `.npmrc` resolves to the workspace copy during development and which stays valid in the packed files.

```
packages/sdk                  @ourointelligence/sdk
packages/source-hyperliquid   @ourointelligence/source-hyperliquid
packages/executor-paper       @ourointelligence/executor-paper
examples/perp
examples/support-bot
docs/
```

Runtime dependencies of `@ourointelligence/sdk`: `better-sqlite3`, `zod`, `commander`, `@anthropic-ai/sdk`, `openai`, `@google/generative-ai`, `ws`, `typescript` (the compiler API transpiles generated modules and `ouro.config.ts`). `isolated-vm` is an optional dependency. The root `package.json` sets `pnpm.onlyBuiltDependencies: ["isolated-vm"]` so pnpm uses the prebuilt `better-sqlite3` binary instead of running node-gyp.

## 2. Core types (`types.ts`)

```ts
type Bar = {
  ts: number; asset: string; tf: string; o: number; h: number; l: number; c: number; v: number;
  ext?: Record<string, number>;   // extra numbers a Source attaches (funding rate, open interest ...), stored and replayed
  stale?: boolean;                // set by a Source on a bar more than two intervals late; recorded, never traded on
};
type FeatureValue = number | boolean | null;
type Input = { ts: number; asset: string; bar: Bar; features: Record<string, FeatureValue>; meta?: Record<string, unknown> };
type Side = 'long' | 'short' | 'flat';
type Decision = { side: Side; size: number; stop?: number; tp?: number; tag?: string } | null;
type Outcome = { pnl: number; fees: number; drawdown: number; holdBars: number; closedTs: number; funding?: number; raw?: unknown };  // funding is already inside pnl
type Episode = { id: string; ts: number; strategyId: string; input: Input; decision: Decision; outcome: Outcome; score?: number; tags?: string[] };
type StrategyStatus = 'live' | 'retired' | 'rejected' | 'rolled_back' | 'pending';
type Trial = {
  trainScore: number;      // mean score per episode on the pooled train slice
  holdoutScore: number;    // mean score per episode on the pooled holdout slice; what promotion compares
  trainN: number;
  holdoutN: number;
  maxDrawdown: number;
  ownHoldoutScore?: number; // mean score over the newest slice of the strategy's own episodes; what CI uses
  ownHoldoutN?: number;
};
type Origin = 'seed' | 'mutate' | 'crossbreed' | 'fresh' | 'user';
type Bounds = Record<string, { min: number; max: number; step: number }>;
type Strategy = {
  id: string; parentIds: string[]; origin: Origin; cycleBorn: number; code: string;
  params: Record<string, number>; rationale: string; status: StrategyStatus; trial?: Trial; ci?: number;
  bounds?: Bounds; describe?: string; cycleRetired?: number;
  retireReason?: string;          // 'replaced' | 'inactive' | 'rolled_back' | 'compile'
};
type Diagnosis = { patterns: string[]; summary: string; weakIds: string[]; strongIds: string[] };
type CycleResult = {
  cycle: number; status: 'promoted' | 'no_change' | 'pending' | 'error'; promoted: Strategy[]; retired: Strategy[];
  rejected: Array<{ strategy: Strategy; reason: string }>; diagnosis: Diagnosis; populationCI: number;
  bestCI?: number; baselineHoldout?: number; note?: string; ts?: number; startedAt?: number; usage?: LLMUsageTotal;
};
type LLMUsage = { inputTokens: number; outputTokens: number };
type LLMUsageTotal = LLMUsage & { calls: number; usd?: number };
type LLMPricing = { inputPerMTok: number; outputPerMTok: number };
type ReplayMode = 'bars' | 'outcome';
type Proposal = { origin: 'mutate' | 'crossbreed' | 'fresh'; parentIds: string[]; code: string; params: Record<string, number>; rationale: string };
type SeedProposal = Omit<Proposal, 'origin'> & { origin: 'seed' };
type Scorer = (ep: Episode) => number;
type ReplayResult = { score: number; maxDrawdown: number; n: number; maxSize: number; matched: number };
type TakeoffRow = { cycle: number; populationCI: number; bestCI: number; velocity: number };
type GuardConfig = {
  maxDrawdownPct: number; maxPositionPct: number; margin: number; holdout: number; requireApproval: boolean;
  allow?: Record<string, string[]>; bounds?: Bounds; freeze?: string[]; maxProposalsPerCycle: number;
};
type EnsembleMode = 'majority' | 'weighted' | 'none';
```

Defaults (`guards.ts`): `maxDrawdownPct 8`, `maxPositionPct 10`, `margin 0.05`, `holdout 0.3`, `requireApproval false`, `maxProposalsPerCycle 6`. The loop copies its own `holdout`, `margin`, `allow`, `bounds` and `freeze` into the guard config unless `guards` sets them.

## 3. Plugin interfaces (`plugins.ts`)

```ts
interface Source {
  name: string;
  subscribe(opts: { assets: string[]; tf: string }): AsyncIterable<Bar>;
  history(opts: { assets: string[]; tf: string; bars: number }): Promise<Bar[]>;
}
interface Executor {
  name: string;
  place(d: NonNullable<Decision>, x: Input): Promise<{ orderId: string }>;
  onClose(cb: (strategyId: string, outcome: Outcome) => void): void;
  onOpen?(cb: (strategyId: string, info: { asset: string; side: 'long' | 'short'; size: number; price: number; ts: number }) => void): void;  // optional: report fills
  onBar?(bar: Bar): void;            // optional: called with every new bar before any decision on it
  stop?(): Promise<void> | void;     // optional: close everything and release resources
}
interface PrimitivePack {
  name: string;
  compute(bars: Bar[], i: number): Record<string, FeatureValue>;
  describe(): Array<{ key: string; doc: string }>;
}
type LLMResponse = { text: string; usage?: LLMUsage; model?: string };
interface LLM {
  name: string;
  complete(req: { system: string; user: string; json: true; maxTokens?: number }): Promise<string | LLMResponse>;
}
```

A plain string reply (0.1.0 adapters) is normalised to `{ text, usage: { 0, 0 }, model: <adapter name> }` by `normaliseResponse`; every model call goes through `completeText`, which reports `{ model, usage, ms, attempt }` to the loop.

Feature keys: a pack returns unprefixed keys (`hull21.crossUp`); `computeFeatures` and `primitiveDocs` prefix them as `${pack.name}.${key}` (`ta.hull21.crossUp`). The prefixed docs are what the Generator is shown and the only keys a strategy may read.

Built-in packs (`primitives/`): `ta` (hull 9/21/34/55 `.value` `.crossUp` `.crossDown` where cross means close crossing the Hull line, `qqe14.value/.crossUp/.crossDown` where cross means the smoothed RSI crossing its trailing line, `atr14`, `ema20/50/200`, `rsi14`, `adx14`, `bbWidth20`), `volume` (`vol`, `volSma20`, `volRatio`), `time` (`hour`, `dow`, `isWeekend`, `minutesToFundingHl` on an 8 h cadence), `orderbook` and `onchain` (documented keys, always `null`). Indicator series are memoised per bar-array identity and recomputed when the array grows. `INDICATOR_LOOKBACK = 260` bars.

## 4. Strategy module contract

```ts
export const params: Record<string, number>;
export const bounds: Record<string, { min: number; max: number; step: number }>;
export function decide(x: Input, p: typeof params): Decision;
export const describe: string;   // one sentence, plain English
```

No imports. Only `x.features['<prefixed key>']` plus `Math`, `Number` and `JSON`. `decide` must be pure: replay re-runs it on stored inputs, and module state that persists across calls makes replay wrong. Every key in `params` must appear in `bounds`. `size` is a fraction of equity (0.1 = 10 %), `stop` and `tp` are distances from entry in price units. `'flat'` closes an open position; `null` means no opinion (hold whatever is open). Saved as `.ouro/population/<id>.ts` plus `<id>.json` holding the `Strategy` record.

## 5. Sandbox (`sandbox.ts`)

`Sandbox.compile(code, id?)`:

1. Static scan of the comment-stripped source (string literals kept). Rejected tokens: `import`, `require`, `fetch`, `process`, `globalThis`, `eval`, `Function`, `while(true)`, `for(;;)`, `XMLHttpRequest`/`WebSocket`/`setTimeout`/`setInterval`/`queueMicrotask`, and `.constructor` / `constructor[` access. Missing `params`, `bounds`, `decide` or `describe` exports are contract errors.
2. `ts.transpileModule` to CommonJS, ES2022, comments removed; syntax errors throw `SandboxError('syntax: ...')`.
3. The JS is wrapped so it evaluates to a JSON string describing the exports and installs `__ouro.run(xs, ps)`; loaded under the load timeout.
4. The exports are validated with zod: params are finite numbers, bounds have finite `min`/`max` and a positive `step`, `describe` is 1..400 characters, `decide` is a function, every param has bounds.

`Sandbox.run(id, x, p)` calls `__ouro.run(JSON.stringify(x), JSON.stringify(p))` under the decide timeout and validates the result (`side` in long/short/flat, finite non-negative `size`, finite optional `stop`/`tp`, `tag` up to 64 chars, or `null`); anything else throws `SandboxError('runtime: ...')`. `Sandbox.runMany(id, xs, p)` runs `decide` over an array of inputs in one call through `__ouro.runMany`, under a timeout of the per-decision budget times the batch size (capped at one minute), and validates every decision the same way; bar replay uses it so one window costs one isolate call per asset.

Backends: `isolated-vm` when it loads (one `Isolate` per strategy id, `memoryLimit` 64 MB, `eval` with `timeout` 50 ms per decide and 2000 ms for load; a memory kill disposes the isolate), otherwise a worker thread per strategy running `node:vm` with a context of `{ Math, Number, JSON }` plus the SDK's own `__ouro` slot, `codeGeneration: { strings: false, wasm: false }`, `vm.runInContext` timeouts, and `resourceLimits.maxOldGenerationSizeMb` 64 (an out-of-memory worker exits and the call rejects). Error kinds: `forbidden`, `syntax`, `contract`, `timeout`, `memory`, `runtime`. Compiled isolates are cached per id and keyed by a hash of the code; `backend: 'auto' | 'isolated-vm' | 'worker'` forces one.

## 6. Store (`log.ts`)

SQLite at `.ouro/episodes.db`:

```sql
CREATE TABLE IF NOT EXISTS episodes (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, strategyId TEXT NOT NULL, score REAL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS episodes_strategy_ts ON episodes (strategyId, ts);
CREATE TABLE IF NOT EXISTS bars (asset TEXT NOT NULL, tf TEXT NOT NULL, ts INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (asset, tf, ts));
```

WAL journal mode, `busy_timeout` 5000, `INSERT OR REPLACE` on id and on `(asset, tf, ts)`. Episode methods: `append`, `recent(strategyId, n)` (newest n, returned oldest-first), `recentSince`, `all`, `count`, `countSince(strategyId, ts)`, `strategyIds`, `total`, `firstTs`. Bar methods: `appendBar(bar)` (the loop stores every warm-up, backfill and live bar, with `ext` and `stale`), `bars(asset, tf, { from?, to?, limit? })` (oldest-first; `limit` keeps the newest), `barCount`. `flush()` and `close()`. If `better-sqlite3` fails to load, `openLog` falls back to `.ouro/episodes.jsonl` plus `.ouro/bars.jsonl` (one JSON record per line, fully loaded into memory on open) and reports the reason through `onFallback`; `backend: 'sqlite' | 'jsonl'` forces one.

## 7. Trial harness (`trial.ts`, `replay.ts`)

`split(episodes, holdoutRatio)` sorts by `ts` and takes the newest `round(n * ratio)` as holdout (at least one when the ratio is above zero and there are at least two episodes; never everything). Never random.

**Bar-level replay** (`replayBars`, the default since 0.2.0 through `replay: 'bars'`). The loop turns a slice of episodes into a window: `from` is the earliest decision time (`input.ts`) in the slice, `to` is the time just before the next slice starts (train) or the newest bar seen (holdout). For every asset it loads the stored bars inside the window plus `INDICATOR_LOOKBACK` bars before it, computes features for each window bar with the registered packs from the series up to that bar, runs `decide` over all of them in one `runMany` call, then pushes the decisions through a fresh paper executor bar by bar: decide on the closed bar, fill at the next bar's open with fee and slippage, stop and take profit checked against each later bar's high and low, stop first when both are hit, open positions closed at the last window bar's price. Stale bars are skipped. Each close becomes an episode scored with the scorer; the result is the mean score, the max drawdown of the cumulative score curve, `n` closed trades, the largest `size` requested and `matched = n`. Fee, slippage and funding settings come from the paper executor in use, or from `replayPaper`. The same bars and params always give the same result; a look-ahead test (`test/unit/replay.test.ts`) changes every bar after the window and asserts that no feature or decision inside it moved, and that a pack or strategy that peeks at the next bar is caught.

**Outcome replay** (`replay`, `replay: 'outcome'`, the 0.1.0 behaviour, also the fallback when a window has no stored bars). Compiles (cached) and, in chronological order, re-runs `decide` on each episode's stored input with the given params. When the decision side matches the stored decision's side (and is not `flat`) the stored outcome is credited and the scorer is applied to the episode; otherwise the scorer is applied to a zero outcome (`pnl 0, fees 0, drawdown 0, holdBars 0`). A candidate is only ever credited with trades that some live strategy actually took. In both modes `decide` must be a pure function of `(input, params)`.

## 8. Guards (`guards.ts`)

`check(proposal, config, { sandbox, scorer, episodes, featureKeys?, parents?, id?, replayFn? })` rejects with a reason string, in this order. When `replayFn` is given (the loop passes its bar replay over the train window) it replaces the episode replay for the risk checks.

| Reason prefix | Condition |
| --- | --- |
| `sandbox: ...` | the code fails the static scan, transpile, load or contract, or a replay call throws |
| `bounds: ...` | a param is not a finite number, has no entry in the module's bounds, or (after snapping to the step grid) lies outside the module bounds or the user bounds |
| `freeze: ...` | a frozen key was removed or changed from the first parent that has it |
| `allow: ...` | the code reads a feature key not in the union of `allow` lists |
| `unknown feature: ...` | the code reads a key no registered pack produces (when `featureKeys` is given) |
| `drawdown: ...` | replay max drawdown exceeds `maxDrawdownPct` (only when episodes are given) |
| `size: ...` | any replayed decision's `size` exceeds `maxPositionPct / 100` |

On success it returns the compiled module, the merged and grid-snapped params (`proposal.params` override the module defaults), and the replay result. The cycle adds three more reasons: `train margin`, `holdout`, and `no slot`. `clampParams(params, bounds)` snaps to `[min, max]` and the step grid and is exported for callers.

## 9. Population (`population.ts`)

`.ouro/history.json`: `{ version, goal, createdAt, strategies[], cycles[], liveByCycle{cycle: ids}, seedIds, baselineHoldout, baselineScale, pending, lastCycleTs, cycle, nextId }`. Ids are `s-0001`, `s-0002`, ... in order of allocation (rejected candidates get ids too, so history shows everything ever generated). Every record is also written to `population/<id>.ts` and `population/<id>.json`.

- `rank(holdoutScores)` sorts live strategies descending; `weak(ranked)` is the bottom `floor(live * retireShare)` (live is the current population, K unless seeding filled fewer) (at least one when K > 1).
- `promote(candidate, retireId, cycle)` marks the target `retired` with `cycleRetired` and the candidate `live`. Size never changes.
- `recordCycle(result)` appends the cycle, snapshots the live ids, saves. `snapshot(0)` after seeding also stores `seedIds`.
- `rollback(cycle)` restores the live ids of that snapshot: later-born or currently-live strategies not in it become `rolled_back`, retired ones in it come back `live`, pending is cleared, and a `no_change` marker cycle with note `rollback:<cycle>` is appended. Nothing is deleted.

## 10. Generator (`generator.ts`) and Critic (`critic.ts`)

One system prompt for all four generator tasks states the module contract verbatim, the types, the rules (no imports / pure function / numeric params only / every param in bounds / null-guard features / size range / stop and tp semantics), the allowed feature keys with docs, and the output shape `{ code, params, bounds, rationale }`. User prompts start with `TASK: seed|mutate|crossbreed|fresh` and contain the goal, the diagnosis, parent code and params where relevant, the strongest live strategies (mutate, crossbreed), the live summaries (fresh), and the constraints section when `allow` / `bounds` / `freeze` are set.

- `seed(goal, primitiveDocs, k, deps)` asks for `{ strategies: [k objects] }`, origin `seed`.
- `mutate(strategy, diagnosis, deps)` asks for one strategy with changed params inside bounds or exactly one swapped feature, origin `mutate`, parent the strategy.
- `crossbreed(a, b, diagnosis, deps)` asks for entry logic from `a` and exit/filter logic from `b`, origin `crossbreed`, parents `[a, b]`.
- `fresh(goal, diagnosis, primitiveDocs, liveSummaries, deps)` asks for a strategy structurally different from every live one, origin `fresh`.

The Critic summarises episodes before the prompt: per weak strategy the 10 worst, per strong strategy the 5 best, as rows `ts asset side pnl=.. hold=.. hour=.. volRatio=.. k1=v1 k2=v2 k3=v3` where the three features are the ones the strategy's code reads (numeric features fill in). The prompt is rebuilt with fewer rows until it fits about 4000 tokens (16000 characters). Output `{ patterns (max 5), summary (max 60 words, truncated), weakIds, strongIds }`; ids are filtered to known strategies and the weak/strong sets are always included.

## 11. LLM layer (`llm/`)

Adapters: `anthropic` (Messages API, default `claude-sonnet-5-5`, temperature 0 only on models that accept it), `openai` (Chat Completions, `gpt-4o`, `response_format: json_object`, temperature 0, honours `OPENAI_BASE_URL`), `gemini` (`gemini-2.0-flash`, `responseMimeType: application/json`, temperature 0), `ollama` (`llama3.1`, `format: 'json'`, temperature 0, `OLLAMA_URL`). Every adapter appends a one line "reply with a single JSON document (object, for openai) and nothing else" instruction to the system prompt, accepts an injected `fetch` for tests, and reads `OURO_MODEL`. `resolveLLM(choice)` takes an LLM object, an adapter name, or `OURO_LLM` (default `anthropic`).

`completeJson(llm, { system, user, schema, onCall? })` calls the model through `completeText`, extracts the first JSON object or array (code fences and prose tolerated), validates with zod, retries once with the error appended to the prompt, and throws `LLMOutputError` on the second failure. `onCall` receives `{ model, usage, ms, attempt }` after every call; the loop uses it to emit `llm` events and sum the cycle's usage. The loop catches `LLMOutputError` from the generator (that proposal is skipped) and from the critic (an empty diagnosis is used); invalid output therefore never reaches trial. Seeding retries up to four times on invalid output before failing.

Adapter failures are different from invalid output. Every model-backed step runs under `withRetry` (`llmRetry`, default 2 retries with 1 s, 2 s backoff; errors named `LLMOutputError` or `BudgetExceeded` are not retried). When the retries are exhausted inside a cycle, the cycle is recorded with status `error`, note `llm_error`, the usage so far, and the population unchanged; `cycle:end` carries `outcome: 'error', reason: 'llm_error'` and an `error` event with scope `llm` fires. When it happens during seeding, `start()` reports the error and tries again after `seedRetryMs` for as long as the loop is running.

`wrapLLM(inner, { before, after, onError, name })` wraps any adapter: `before` may replace the request or throw, `after` sees the normalised reply and the elapsed time and may replace it, `onError` may recover. Usage reported by the wrapper is what the loop counts, so an app can cap a daily budget by throwing an error named `BudgetExceeded` from `before`.

## 12. The cycle (`loop.ts`, `runCycle`)

```
cycleNo = pop.cycle + 1; forced = cycleMaxWait elapsed since the last cycle (bar time) and some strategy has a new episode
emit cycle:start
for s in live: perStrategy[s] = log.recent(s.id, cycleEvery)
episodes = dedupe(union(perStrategy)) sorted by ts; emit cycle:step collect
if (episodes.length < cycleEvery and not forced) or none newer than lastCycleTs:
  return no_change('not enough data')                       // not recorded, no cycle number consumed; cycle:end still fires
{ train, holdout } = split(episodes, holdoutRatio)           // holdout = newest slice
trainWindow = [earliest input.ts of train, first holdout input.ts); holdoutWindow = [earliest input.ts of holdout, newest bar]
for s in live:
  s.trial = { trainScore: score(s, train, trainWindow), holdoutScore: score(s, holdout, holdoutWindow), ... }   // bar replay, or outcome replay
  own = split(perStrategy[s], holdoutRatio).holdout
  if own.length >= 3: s.trial.ownHoldoutScore = mean(score(own))
  if log.countSince(s.id, lastCycleTs) < minTradesPerWindow: inactive.add(s); holdoutScore[s] = -Infinity
if baselineHoldout is null and some seed has ownHoldoutScore:
  baselineHoldout = mean(ownHoldoutScore of seedIds); baselineScale = mean(|ownHoldoutScore| of seedIds)   // stored once
ranked = rank by holdoutScore desc (inactive last); weak = bottom retireShare; strong = top 2 active; emit cycle:step rank
medianTrain = median(train scores of live); threshold = medianTrain + margin * |medianTrain|
diagnosis = critic.diagnose(worst of weak, best of strong, live)      // LLMOutputError -> empty diagnosis; emit cycle:step diagnose, critique
proposals = [mutate(w) for w in weak] + [crossbreed(strong[0], strong[1])] + [fresh()]  capped at maxProposalsPerCycle; emit cycle:step generate
replaceable = ranked reversed (weakest first)
for p in proposals:
  id = pop.nextId(); verdict = guards.check(p, { episodes: train, replayFn: score over trainWindow, parents, featureKeys, id })
  if not ok: reject(reason); emit candidate(stage sandbox | guards); continue
  if train score <= threshold: reject('train margin'); emit candidate(stage trial); continue
  target = replaceable[0]; if none: reject('no slot'); emit candidate(stage slot); continue
  holdout score = score(candidate, holdout, holdoutWindow)
  targetScore = -Infinity if target is inactive else target.trial.holdoutScore
  if holdout score <= targetScore: reject('holdout'); emit candidate(stage holdout); continue
  replaceable.shift(); promotions.push({ candidate, retireId: target.id })
emit cycle:step trial, validate
if no promotions: record no_change (with diagnosis and rejected list); emit cycle:step promote, cycle, cycle:end; return
if requireApproval: candidates stored as 'pending', pending = { result, promotions }, lastCycleTs = newest;
                    emit candidate(stage pending), pending, cycle:end; return status 'pending'
apply: for each promotion pop.promote(candidate, retireId, cycleNo); target.retireReason = 'inactive' | 'replaced';
       emit candidate(stage promoted), promote, retire
finish: for s in live: s.ci = capabilityIndex(s, baselineHoldout, baselineScale) if it has ownHoldoutScore else undefined
        result.populationCI = mean(defined ci); result.bestCI = max; result.usage = sum of this cycle's model calls (+ usd with llmPricing)
        lastCycleTs = newest; recordCycle; write takeoff.json; emit cycle, cycle:end
on an adapter failure that survived the retries anywhere above: record status 'error', note 'llm_error', population unchanged; emit error(scope llm), cycle:end(outcome error)
```

Every model call inside the cycle emits `llm { cycle, purpose: 'critic' | 'generator', model, inputTokens, outputTokens, ms }` (`purpose: 'seed'` with cycle 0 during seeding). Rejected candidates are stored in history with status `rejected` and the reason is kept on the cycle record. `approve(cycle)` recompiles the pending candidates, emits `approved` and applies them; `reject(cycle)` marks them `rejected` with reason `rejected by user`, emits `rejected` and records a `no_change` cycle. `setApproval(on)` flips `guards.requireApproval` at runtime. `cycle()` is re-entrancy safe (a running cycle is returned to concurrent callers) and throws while a cycle is pending. `ready()` is true when every live strategy has `cycleEvery` episodes since the last cycle, or when `cycleMaxWait` of bar time has passed since the last cycle (or since the first episode, before any cycle) and at least one new episode exists.

## 13. SI metrics (`si.ts`)

- `capabilityIndex(strategy, baseline, scale)` = `(score - baseline) / max(|baseline|, |scale|)` with `score = trial.ownHoldoutScore ?? trial.holdoutScore`; equals `score / baseline - 1` for a positive baseline, keeps "better is higher" for a negative one, and returns the raw gap when both baseline and scale are zero.
- `populationCI(live)` = mean of defined, finite CIs; `bestCI(live)` = max.
- `takeoff(cycles)` = one row per recorded cycle with `velocity = populationCI - previous populationCI` (0 for the first row).
- `ceilingDetected(rows, k = 3, threshold = 0.01)` is true when there are more than k rows and the last k velocities are all below the threshold.
- `.ouro/takeoff.json` is rewritten after every recorded cycle and after a rollback.

## 14. Ensemble (`ensembleDecision`)

Each non-null decision votes for its side with weight `max(0.05, ci + 1)` in `weighted` mode or `1` in `majority` mode. The top side wins if its weight exceeds 55 % (`weighted`) or 50 % (`majority`) of the total, else the ensemble is `{ side: 'flat', size: 0 }`. `size`, `stop` and `tp` are the means over the winning voters. `none` returns `null`; no votes return `null`.

## 15. Run flow (`start`)

1. `init()`; seed K if there is no live population, retrying after `seedRetryMs` while the model is down; compile every live module (a module that no longer compiles is retired with reason `compile`).
2. `source.history({ assets, tf, bars: warmupBars + backfill })`, grouped per asset and sorted. The oldest `warmupBars` of each asset become the warm window and are stored in the bars table.
3. The newest `backfill` bars of every asset are merged by time and fed through `processBar` one by one.
4. `source.subscribe({ assets, tf })` is iterated until `stop()`.
5. `processBar(bar)`: append to the asset's window (replace on equal `ts`, ignore older), trim the window, store the bar, emit `bar`, call `executor.onBar?.(bar)`. A bar with `stale` set, or any bar while the loop is paused, stops here. Otherwise skip decisions until the window reaches `min(INDICATOR_LOOKBACK, warmupBars)` bars, compute features, `decide(x)` (which emits `decision` per non-null result), then dispatch: per strategy, `executor.place(d, { ...x, meta: { strategyId } })` for every non-null decision, remembering the input that opened the position; or with `dispatch: 'ensemble'`, one `place` tagged `ensemble` with the voters remembered. `trade:open` fires from the executor's `onOpen` hook with the fill price, or at placement with the decision price for executors without one. Afterwards, if `autoCycle`, the loop is not paused and `ready()` is true, `cycle()` runs.
6. `executor.onClose((strategyId, outcome))` builds an Episode: the asset comes from `outcome.raw.asset` when present (else the most recent entry), the input and decision are the ones that opened the position, `ts = outcome.closedTs`, `tags = [side, 'win' | 'loss']`; it is scored, appended, and `episode` then `trade:close` fire. An `ensemble` close is credited to every strategy that voted with the ensemble side.
7. A timer from `start({ every })` also calls `cycle()` (not while paused). `pause(reason)` and `resume()` toggle decisions and automatic cycles without touching the subscription. `stop()` clears the timer, waits for a running cycle to finish, ends the subscription, calls `executor.stop?.()`, waits for the data loop to return, flushes the store and saves `history.json`, then emits `stop`; `close()` also releases the sandbox and the store. `status()` reports the flags, counts and timestamps.

**Crash safety.** A cycle writes `history.json` only when it finishes (`recordCycle`, atomic rename), so a process killed at any step restarts with the previous cycle intact; the next run re-reads the same episodes and runs the cycle once. Strategy files written for rejected candidates before the kill are overwritten when their ids are reused. `test/integration/crash.test.ts` kills a child process with SIGKILL at each of the seven steps and checks that the resumed run records exactly one cycle with no duplicate ids. Two loops with different `dir` values in one process keep separate stores, sandboxes, id counters and files (`test/integration/v020.test.ts`).

## 16. Paper executor units (`executors/paper.ts`)

Orders placed on bar N fill at bar N+1's open with `slippageBps` against the trader. `pnl = size * (exit / entry - 1) * direction * 100 + funding`, `fees = size * feeBps / 10000 * 2 * 100`, `drawdown = size * maxAdverseExcursion * 100`, all in percent of equity. With `funding: true` (default false), each bar whose timestamp crosses one or more hour boundaries since the last settlement accrues `rate * hours * size * 100` from `bar.ext['funding.rate']` (the hourly rate): longs pay a positive rate, shorts receive it; the total is `outcome.funding`. `stop(ts?)` closes everything at the last price and stamps the outcomes with `ts` (replay passes the last window bar). The executor exposes `config` (`feeBps`, `slippageBps`, `funding`, `maxHoldBars`) and `onOpen(cb)`, called with `{ asset, side, size, price, ts }` at every fill. `size` is the fraction of equity, `stop` and `tp` are price distances turned into levels at fill time; a bar touching both resolves as a stop. Closes happen on stop, tp, a `flat` decision, an opposite-side decision (flip), optional `maxHoldBars`, or shutdown; `outcome.raw = { asset, side, entry, exit, size, reason, openedTs }`. One position per strategy per asset; a same-side decision while open is a hold that refreshes stop and tp.

## 17. CLI (`cli.ts`)

`ouro.config.ts` is transpiled next to itself (so relative imports resolve) into a temporary `.mjs`, imported, and deleted. Commands: `run`, `start`, `cycle`, `population`, `history`, `explain`, `rollback`, `approve`, `reject`, `takeoff`, `export`. `run --live` throws unless the config's executor is a plugin and `guards.requireApproval` is true; `--paper` forces `executor: 'paper'`. `export` writes `loop.export()`: `{ schemaVersion: 1, name, goal, createdAt, cycle, population, history, takeoff }` in canonical key order (`canonical()` sorts keys at every level and drops `undefined`; `canonicalJson()` is the whitespace-free text a hash chain should sign). The shape is documented in [export-schema.md](export-schema.md).

## 18. Test matrix (`packages/sdk/test`)

| Area | What is asserted |
| --- | --- |
| unit/trial | split is chronological and holdout is newest; replay credits only matching sides, mean and drawdown on a fixed fixture, chronological replay |
| unit/guards | `clampParams` snaps to the grid; rejections for import and each forbidden token, frozen key, module and user bounds, allow list, unknown feature, oversize, drawdown |
| unit/si | CI for positive, negative and zero baselines; population and best CI; takeoff velocities and ceiling on a fixed history |
| unit/primitives, log, population, paper | indicator math, prefixed keys and warm-up nulls; SQLite and JSONL backends; promote, snapshot, rollback; fills, fees, stops, tp, flat, flip, shutdown |
| sandbox (both backends) | contract metadata and decide; fetch/process/require throw; timers and sockets rejected; an infinite loop is killed under 100 ms; a memory bomb is killed and the sandbox stays usable; invalid decisions rejected; cache by id |
| llm/adapters | all four adapters against a mocked fetch: URL, temperature 0, JSON mode, response parsing; `resolveLLM` |
| llm/generator | prompts state the contract, keys and constraints; seed, mutate, crossbreed, fresh and diagnose against recorded fixtures compile in the sandbox; malformed JSON is retried once then thrown and never yields a proposal |
| integration/convergence | synthetic world where the optimal rule is "long when a > 0.6 and b < 0.3" with noise; 8 strategies, 10 cycles, a fake LLM that moves mutations toward the best parent; population CI rises over at least 3 consecutive cycles and the best strategy is within one step of the optimum |
| integration/curvefit | a candidate that beats train by more than 20 % but loses on holdout is rejected with reason `holdout` |
| integration/loop | full run flow with a synthetic candle source and the paper executor (seed, warm-up, backfill, episodes, cycles, files); approval, approve from a fresh process, rollback, reject; ensemble arithmetic; `parseEvery` |
| unit/replay | bar replay matches a real paper executor fed the same decisions; determinism across bar order; look-ahead (later bars changed, window unchanged; a cheating pack is caught); stop-first when a bar hits both levels; funding accrual on and off |
| unit/events, unit/store | typed emitter semantics and a throwing handler; bars table and bars.jsonl with ext, ranges and reopen; `runMany`; canonical export form |
| integration/v020 | a paper run emits every event with the documented payload, a throwing handler does not stop the run, usage and dollars add up; `cycleMaxWait` fires early; an inactive strategy ranks last and retires with reason `inactive`; `export()` has `schemaVersion` 1 and stable key order, `status()`, `setApproval`, `pause`; `wrapLLM` hooks, retries on 503, an `llm_error` cycle that leaves the population intact; two loops side by side |
| integration/crash | a child process is killed with SIGKILL at each of the seven cycle steps and resumes with exactly one recorded cycle |

`packages/source-hyperliquid/test` covers history paging and forming-candle exclusion with a mocked fetch, subscription, candle close detection, pings, `return()`, reconnect backoff and its reset, gap refill order, the stale flag, the rate budget and 429 backoff, `withAssetCtx` ext fields and the funding backfill. `packages/executor-paper/test` checks the plugin satisfies `Executor` with the reference defaults.

## 19. Events (`events.ts`)

`TypedEmitter` backs `loop.on` and `loop.off`. `emit` copies the handler set before calling, wraps every handler in try/catch, and reports a throwing handler as `error { scope: 'handler:<event>', message }`; a throwing `error` handler is swallowed so the emitter never recurses. The `EventMap` type is the contract: `bar`, `decision`, `trade:open`, `trade:close`, `cycle:start`, `cycle:step` (`collect`, `rank`, `diagnose`, `generate`, `trial`, `validate`, `promote`), `critique`, `candidate` (stages `sandbox`, `guards`, `trial`, `holdout`, `slot`, `promoted`, `pending`), `promote`, `retire`, `cycle:end` (outcomes `promoted`, `no_change`, `pending`, `error`), `pending`, `approved`, `rejected`, `rollback`, `llm`, `error`, `log`, `seed`, `episode`, `cycle`, `pause`, `resume`, `stop`. Payloads are listed in the README. The 0.1.0 `loop.events` emitter keeps firing its seven events; a legacy `error` listener receives an `Error` object only when one is registered.
