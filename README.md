# OURO

**Superintelligence you can switch off.**

OURO is an open-source TypeScript SDK for recursive self-improvement (RSI): you give it a goal, a data source and a way to score results, and it invents its own population of strategies, runs them, critiques its own failures, rewrites and crossbreeds the survivors, and gets measurably better on data it has never seen, with no human in the loop. It is chain-agnostic, venue-agnostic, model-agnostic and domain-agnostic: trading is the reference example, but anything with a goal, an input stream and a score works. It runs on your machine with your own LLM key (BYOK): no server, no account, no token anywhere in the SDK.

MIT licensed. Node 20 or newer.

## Install

```bash
npm i @ourointelligence/sdk
export OURO_LLM=anthropic        # or openai, gemini, ollama
export ANTHROPIC_API_KEY=sk-...   # your own key, your own bill
```

- `OURO_LLM` picks the adapter (`anthropic` is the default). Each adapter reads its usual key: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`); Ollama needs none and reads `OLLAMA_URL` (default `http://localhost:11434`).
- `OURO_MODEL` overrides the adapter's default model (`claude-sonnet-5-5`, `gpt-4o`, `gemini-2.0-flash`, `llama3.1`). Temperature 0 is only sent to models that accept a temperature parameter; current Claude models run at their own setting.
- `OPENAI_BASE_URL` points the `openai` adapter at any OpenAI-compatible server (LM Studio, vLLM, OpenRouter); a key is optional in that case.
- A `.env` file in the working directory or at the repository root is read when the SDK is imported and when the CLI starts; variables already set in the shell win. Copy `.env.example` to start.

Everything the loop learns is stored in `./.ouro/` next to your project.

## Quick start (perp trading, no strategy supplied)

```ts
import { createLoop, primitives } from '@ourointelligence/sdk';
import { hyperliquid } from '@ourointelligence/source-hyperliquid';
import { paper } from '@ourointelligence/executor-paper';

const loop = createLoop({
  goal: 'Maximise realised PnL after fees on BTC and ETH 15m perps while keeping max drawdown under 8%',
  primitives: [primitives.ta, primitives.volume, primitives.time],
  source: hyperliquid(),
  executor: paper({ feeBps: 3.5, slippageBps: 2 }), // or the string 'paper'
  assets: ['BTC', 'ETH'],
  tf: '15m',
  score: (ep) => ep.outcome.pnl - ep.outcome.fees - 0.5 * ep.outcome.drawdown,
  population: 8,     // strategies alive at once
  cycleEvery: 40,    // episodes per strategy between cycles
  holdout: 0.3,      // newest share of episodes reserved for validation
  margin: 0.05,      // a candidate must beat the population median by this share
  guards: { maxDrawdownPct: 8, maxPositionPct: 10, requireApproval: false },
  warmupBars: 300,   // history pulled so indicators are warm
  backfill: 4000,    // trade through recent history on paper before going live
});

loop.events.on('log', (m) => console.log(m));
await loop.start();                  // seeds 8 strategies, trades them, cycles as episodes accumulate
```

That is the whole integration. You never write a strategy. On first start the Generator writes eight from the goal and the primitive docs, each passes the sandbox and the guards, they trade on paper, and every `cycleEvery` episodes per strategy the loop retires the weak, mutates and crossbreeds the strong, writes a fresh one from the Critic's diagnosis, and keeps only candidates that beat the population on train *and* on unseen holdout data.

## What a generated strategy looks like

Every strategy is a small TypeScript module with exactly four exports, saved as `.ouro/population/<id>.ts` next to its `<id>.json` record:

```ts
export const params = { hullLen: 21, atrStop: 1.5, size: 0.05 };
export const bounds = {
  hullLen: { min: 9, max: 55, step: 1 },
  atrStop: { min: 0.5, max: 4, step: 0.5 },
  size: { min: 0.01, max: 0.1, step: 0.01 },
};
export function decide(x: Input, p: typeof params): Decision {
  const hour = x.features['time.hour'];
  const up = x.features['ta.hull21.crossUp'];
  const atr = x.features['ta.atr14'];
  if (typeof hour !== 'number' || typeof atr !== 'number') return null;
  if (hour >= 0 && hour < 4) return null;                 // learned: dead hours
  if (up === true) return { side: 'long', size: p.size, stop: p.atrStop * atr };
  return null;
}
export const describe = 'Hull 21 cross up with an ATR stop, skipping 00-04 UTC.';
```

No imports, pure function of `(x, p)`, numeric params only, every param in `bounds`. Features are flat keys prefixed with the pack name (`ta.hull21.crossUp`, `volume.volRatio`, `time.hour`); a feature is `null` until its indicator has data. `size` is a fraction of equity, `stop` and `tp` are distances from entry in price units. Generated code runs in a sandbox: isolated-vm with a 64 MB heap, 50 ms per `decide` call and 2 s to load, no network, no filesystem, no host objects in scope. isolated-vm is an optional dependency; where it cannot be installed the sandbox falls back to a worker thread running `node:vm` with the same limits.

`npx ouro explain s-0412` tells you in plain words what a strategy does, where it came from and why it is alive. Your own modules go in through `seed`; they are trialled and scored like any other.

## SI terms

| Term | Meaning in OURO |
| --- | --- |
| RSI | Recursive self-improvement: the loop that makes the agent better each cycle |
| Self-model | The live population plus every strategy ever generated, with parents and rationale; the Critic and the Generator both read it |
| Critic | The step where the agent judges its own failures: an LLM reads the worst episodes of the weak strategies and the best of the strong ones and writes a diagnosis |
| Capability Index (CI) | How much better a strategy scores than the seed generation on unseen data: `(holdoutScore - baseline) / max(abs(baseline), scale)`, which is `holdoutScore / baseline - 1` for a positive baseline |
| Takeoff curve | Population CI, best CI and velocity per cycle; `npx ouro takeoff` prints it and `.ouro/takeoff.json` holds it |
| Velocity | CI gain per cycle |
| Ceiling | Velocity below 0.01 for three cycles in a row: the population has exhausted its primitives; add packs or loosen `allow` / `bounds` / `freeze` |
| Corrigibility | Guards, holdout, the approval switch and one-call rollback: you can always bound it or stop it |

## Narrowing it (optional)

By default the Generator may read any feature from the packs you registered. Any of these narrows it; none is required:

```ts
seed: ['./my-hull-qqe.ts'],                         // start from your own strategy modules (origin 'user')
allow: { entry: ['ta.hull21.crossUp', 'ta.rsi14'] }, // only these feature keys may be read
bounds: { atrStop: { min: 1, max: 3, step: 0.5 } }, // cap a parameter range
freeze: ['size'],                                   // keys a child may never change from its parent
```

## CLI

`npx ouro` reads `ouro.config.ts` (or `.mts` / `.js` / `.mjs`) from the working directory; the file must `export default` a loop config. `-c, --config <file>` points elsewhere.

| Command | What it does |
| --- | --- |
| `ouro run [--paper] [--live] [--assets BTC,ETH] [--tf 15m] [--backfill N] [--every 1h] [--quiet]` | Seed if needed, warm up, trade through `backfill` history bars, subscribe to live bars, cycle as episodes accumulate. `--paper` (default) forces the built-in paper executor. `--live` uses the executor plugin from the config and refuses unless `guards.requireApproval` is `true`. `--every` adds a timer that also runs a cycle on an interval. `--quiet` hides per-episode lines. |
| `ouro start --every 1h [--paper] [--live] [--quiet]` | Same as `run` with the timer required. |
| `ouro cycle` | Run one improvement cycle on the recorded episodes. |
| `ouro population [--json]` | The live set: id, origin, cycle born, holdout score, CI, description. |
| `ouro history [--json]` | Every strategy ever generated (with status) and every cycle. |
| `ouro explain <id>` | Plain-language summary: what it does, parents, the diagnosis that produced it, trial scores, CI, rejections. |
| `ouro rollback <cycle>` | Restore the live set as it was at the end of that cycle; later strategies are marked `rolled_back`, nothing is deleted. |
| `ouro approve <cycle>` / `ouro reject <cycle>` | Apply or discard a cycle that is pending approval. |
| `ouro takeoff [--json]` | The takeoff curve, with a `ceiling` line when velocity has flattened. |
| `ouro export [-o ouro.json]` | Write `ouro.json` = `{ name, goal, createdAt, population, history, takeoff }` for any dashboard or registry. |

The same operations exist on the `Loop` object: `seed`, `decide`, `record`, `cycle`, `start`, `stop`, `approve`, `reject`, `population`, `history`, `rollback`, `explain`, `takeoff`, `use`, `ready`, `cycleCount`, `close`, plus an `events` emitter (`log`, `seed`, `bar`, `decision`, `episode`, `cycle`, `error`).

## Going live safely

1. Start on paper. Let the population CI rise over at least three cycles and hold on holdout before anything touches money.
2. Set `guards.maxDrawdownPct` and `guards.maxPositionPct`. Any candidate whose replay breaches them is rejected before trial; the reasons show up in `ouro history`.
3. Turn on `guards.requireApproval`. Each cycle then returns `pending`; read the diagnosis and rationales, then `ouro approve <cycle>` or `ouro reject <cycle>`. `ouro run --live` refuses to start unless the config has an executor plugin (not `'paper'`) and `requireApproval: true`.
4. Decide what gets sent. By default every strategy's decision goes to the executor tagged with its id (`x.meta.strategyId`), so each strategy earns its own episodes. Set `dispatch: 'ensemble'` to send only the ensemble decision (one order, tagged `ensemble`); the outcome is then credited to every strategy that voted with it.
5. Keep `ouro rollback <cycle>` one command away. It restores the population from that cycle; a running loop picks it up on its next start.

## State directory

```
.ouro/
  episodes.db          SQLite log of every episode (episodes.jsonl when better-sqlite3 cannot load)
  history.json         every strategy ever generated, every cycle, live ids per cycle, CI baseline, pending cycle
  population/<id>.ts   the strategy module, readable and editable
  population/<id>.json the Strategy record (parents, origin, params, trial scores, CI, status)
  takeoff.json         [{ cycle, populationCI, bestCI, velocity }]
```

## Beyond trading

Same four things: a goal, a source, a scorer and primitive packs that expose the features of your domain. `examples/support-bot` runs the identical loop over a synthetic support-ticket stream, where a decision of `long` means resolve and `short` means escalate. See [docs/plugins.md](docs/plugins.md) for writing a Source, Executor, PrimitivePack or LLM adapter in about 60 lines each.

## Repository

```
packages/sdk                 @ourointelligence/sdk: the loop, sandbox, trial harness, guards, SI metrics, CLI, built-in packs and LLM adapters
packages/source-hyperliquid  @ourointelligence/source-hyperliquid: Hyperliquid public candles (websocket + candleSnapshot), no API key
packages/executor-paper      @ourointelligence/executor-paper: paper executor with fees and slippage
examples/perp                the reference perp example (BTC and ETH 15m on paper)
examples/support-bot         a non-trading example
docs/                        product-spec.md, tech-spec.md, plugins.md, publishing.md
```

```bash
pnpm install     # Node >= 20, pnpm 9
pnpm build       # tsup, every package
pnpm test        # vitest: unit, sandbox, LLM adapters and fixtures, integration, curve-fit
pnpm lint        # eslint
cd examples/perp && npx ouro run --paper
```

Further reading: [docs/product-spec.md](docs/product-spec.md), [docs/tech-spec.md](docs/tech-spec.md), [docs/plugins.md](docs/plugins.md).
