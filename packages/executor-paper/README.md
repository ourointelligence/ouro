# @ourointelligence/executor-paper

OURO paper `Executor` plugin: fills at the next bar's open with fees and slippage, keeps one position per strategy per asset, and emits one `Outcome` per closed position with drawdown measured bar by bar.

```ts
import { paper } from '@ourointelligence/executor-paper';

createLoop({ executor: paper({ feeBps: 3.5, slippageBps: 2 }), ... });
```

Defaults: `feeBps: 3.5` per side, `slippageBps: 2` per fill, no `maxHoldBars`. The implementation lives in `@ourointelligence/sdk` (it is what `executor: 'paper'` uses, so paper mode needs no extra install); this package is the plugin-shaped entry point with the reference defaults.

**Fill model.** An order placed on bar N fills at bar N+1's open, moved `slippageBps` against the trader. `stop` and `tp` on the decision are distances from entry in price units and become levels at fill time. While open, each bar updates the hold count and the worst adverse excursion; a bar that touches the stop closes at the stop (or at the open if the bar gapped through it), a bar that reaches the target closes at the target, a bar touching both resolves as a stop. A `flat` decision closes, an opposite-side decision flips, a same-side decision holds and refreshes stop and tp, `loop.stop()` closes everything.

**Units.** `size` is a fraction of equity (0.1 = 10 %). `pnl = size * (exit / entry - 1) * direction * 100`, `fees = size * feeBps / 10000 * 2 * 100`, `drawdown = size * maxAdverseExcursion * 100`: all in percent of equity, so a 10 % position on a 2 % move is `pnl 0.2`, and `guards.maxDrawdownPct` compares directly. `outcome.raw` carries `{ asset, side, entry, exit, size, reason, openedTs }` where `reason` is `stop | tp | flat | flip | maxHold | shutdown`.
