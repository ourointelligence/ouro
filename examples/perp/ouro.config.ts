import { primitives } from '@ourointelligence/sdk';
import type { LoopConfig } from '@ourointelligence/sdk';
import { hyperliquid } from '@ourointelligence/source-hyperliquid';
import { paper } from '@ourointelligence/executor-paper';

/**
 * Reference example: BTC and ETH 15m perps on paper against live Hyperliquid candles.
 * No strategy is supplied. The Generator seeds eight from the TA, volume and time packs and the loop evolves them.
 *
 * Set OURO_LLM (anthropic | openai | gemini | ollama) and the matching API key, then:
 *   npx ouro run --paper
 */
const config: LoopConfig = {
  goal: 'Maximise realised PnL after fees on BTC and ETH 15m perps while keeping max drawdown under 8%',
  primitives: [primitives.ta, primitives.volume, primitives.time],
  source: hyperliquid(),
  executor: paper({ feeBps: 3.5, slippageBps: 2 }),
  assets: ['BTC', 'ETH'],
  tf: '15m',
  population: 8,
  cycleEvery: 40,
  holdout: 0.3,
  margin: 0.05,
  guards: { maxDrawdownPct: 8, maxPositionPct: 10, requireApproval: false },
  // pnl, fees and drawdown are in percent of equity (see @ourointelligence/executor-paper)
  score: (ep) => ep.outcome.pnl - ep.outcome.fees - 0.5 * ep.outcome.drawdown,
  // indicators need ~260 bars; the rest of the history is traded through on paper before going live so the
  // population reaches its first cycle in minutes instead of weeks of 15m bars
  warmupBars: 300,
  backfill: 4000,
};

export default config;
