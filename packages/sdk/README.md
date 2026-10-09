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

Full documentation, the CLI reference, the SI terms and the going-live guide are in the repository README and `docs/`. Plugin interfaces are documented in `docs/plugins.md`.
