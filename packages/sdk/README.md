# @ourointelligence/sdk

The core of OURO: the recursive self-improvement loop, the sandbox, the trial harness, the guards, the SI metrics, the built-in primitive packs, the LLM adapters and the `ouro` CLI.

```bash
npm i @ourointelligence/sdk
export OURO_LLM=anthropic && export ANTHROPIC_API_KEY=sk-...
```

```ts
import { createLoop, primitives } from '@ourointelligence/sdk';

const loop = createLoop({
  goal: 'Maximise realised PnL after fees on BTC and ETH 15m perps while keeping max drawdown under 8%',
  primitives: [primitives.ta, primitives.volume, primitives.time],
  source: mySource,          // any Source plugin, e.g. @ourointelligence/source-hyperliquid
  executor: 'paper',         // built in; or any Executor plugin
  assets: ['BTC', 'ETH'],
  tf: '15m',
  score: (ep) => ep.outcome.pnl - ep.outcome.fees - 0.5 * ep.outcome.drawdown,
  guards: { maxDrawdownPct: 8, maxPositionPct: 10 },
});
await loop.start();
```

Since 0.2.0: typed events through `loop.on('cycle:end', handler)` (bars, trades, every cycle step, candidates, promotions, model usage), bar-level replay (candidates are re-run over the stored bars with the paper fill model), `cycleMaxWait`, `minTradesPerWindow`, `pause()`, `status()`, `export()` with `schemaVersion: 1`, `wrapLLM` for counting usage, and `Bar.ext` for funding and open interest. See CHANGELOG.md.

Full documentation, the CLI reference, the SI terms and the going-live guide: https://github.com/ourointelligence/ouro (README and `docs/`). Plugin interfaces: `docs/plugins.md`. Website: https://ourosi.xyz
