# examples/perp

The reference OURO app: BTC and ETH 15m perps on paper against live Hyperliquid candles. No strategy is supplied; the Generator seeds eight from the built-in TA, volume and time packs and the loop evolves them.

```bash
pnpm install && pnpm build          # from the repository root
cd examples/perp
export OURO_LLM=anthropic           # or openai, gemini, ollama
export ANTHROPIC_API_KEY=sk-...     # your key
npx ouro run --paper                # optionally --assets BTC,ETH --tf 15m --backfill 4000 --quiet
```

What happens: the loop pulls 4300 bars of history per asset, uses the oldest 300 to warm the indicators, trades the newest 4000 on paper (fills at next open, 3.5 bps fee, 2 bps slippage), records every closed position as an episode, and runs a cycle every 40 episodes per strategy: it ranks on holdout, asks the Critic for a diagnosis, mutates the weak, crossbreeds the strong, writes a fresh strategy, and promotes only candidates that beat the population on train and on unseen holdout data. Then it subscribes to live candles and keeps going. Every episode, cycle, population table and takeoff curve is printed as it goes.

Guards: max drawdown 8 % of equity, max position 10 % of equity, 30 % holdout, 5 % margin, no approval gate on paper. Scorer: `pnl - fees - 0.5 * drawdown`, all in percent of equity.

Outputs live in `examples/perp/.ouro/`: `episodes.db`, `history.json`, `population/<id>.ts` for every strategy ever generated, and `takeoff.json` (the committed sample is from a paper run). Other commands: `npx ouro population`, `npx ouro takeoff`, `npx ouro explain <id>`, `npx ouro history`, `npx ouro rollback <cycle>`, `npx ouro export`.

Nothing is live unless you pass `--live` with an executor plugin in the config and `guards.requireApproval: true`.
