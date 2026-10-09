import { paperExecutor } from '@ourointelligence/sdk';
import type { Executor, PaperConfig, PaperExecutor } from '@ourointelligence/sdk';

export type { PaperConfig, PaperExecutor, PaperPosition, PaperCloseReason, PaperOutcomeRaw } from '@ourointelligence/sdk';

/** Defaults the reference example uses: 3.5 bps taker fee per side, 2 bps slippage per fill. */
export const PAPER_DEFAULTS: Required<Pick<PaperConfig, 'feeBps' | 'slippageBps'>> = { feeBps: 3.5, slippageBps: 2 };

/**
 * Paper executor plugin. Fills at the next bar's open with fee and slippage, keeps one position per strategy
 * per asset, closes on stop, take-profit, a 'flat' decision, an opposite-side decision or shutdown, and emits one
 * Outcome per closed position with drawdown measured bar by bar while the position is open.
 *
 * The implementation lives in @ourointelligence/sdk (it is what `executor: 'paper'` uses, so paper mode works with no extra
 * install); this package is the plugin-shaped entry point with the reference defaults.
 */
export function paper(config: PaperConfig = {}): PaperExecutor {
  return paperExecutor({ ...PAPER_DEFAULTS, ...config });
}

/** Type-level proof that the plugin satisfies the Executor contract. */
export const asExecutor = (e: PaperExecutor): Executor => e;

export default paper;
