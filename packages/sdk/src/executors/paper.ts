import type { Bar, Decision, Outcome } from '../types.js';
import type { Executor } from '../plugins.js';

export type PaperConfig = {
  /** Taker fee per side in basis points of notional. Default 3.5. */
  feeBps?: number;
  /** Slippage per fill in basis points, applied against the trader. Default 2. */
  slippageBps?: number;
  /** Optional hard cap on bars a position may stay open. Off by default. */
  maxHoldBars?: number;
};

export type PaperPosition = {
  strategyId: string;
  asset: string;
  side: 'long' | 'short';
  size: number;
  entry: number;
  stop?: number;
  tp?: number;
  openedTs: number;
  bars: number;
  /** Worst adverse excursion as a fraction of entry price. */
  maxAdverse: number;
  lastPrice: number;
};

type PendingOrder = { strategyId: string; decision: NonNullable<Decision>; ts: number };

export type PaperCloseReason = 'stop' | 'tp' | 'flat' | 'flip' | 'maxHold' | 'shutdown';

export type PaperOutcomeRaw = {
  asset: string;
  side: 'long' | 'short';
  entry: number;
  exit: number;
  size: number;
  reason: PaperCloseReason;
  openedTs: number;
};

export interface PaperExecutor extends Executor {
  readonly name: 'paper';
  onBar(bar: Bar): void;
  stop(): void;
  positions(): PaperPosition[];
  /** Realised pnl after fees, in percent of equity, summed over every closed trade. */
  realised(): number;
  closed(): number;
}

function key(strategyId: string, asset: string): string {
  return `${strategyId}\u0000${asset}`;
}

/**
 * Paper executor. Fills at the next bar's open with fee and slippage, tracks one position per strategy per asset,
 * closes on stop, take-profit, a 'flat' decision, an opposite-side decision (flip) or shutdown, and emits one
 * Outcome per closed position. pnl, fees and drawdown are in percent of equity: a 10% position (size 0.1)
 * on a 2% move yields pnl 0.2.
 */
export function paperExecutor(cfg: PaperConfig = {}): PaperExecutor {
  const feeBps = cfg.feeBps ?? 3.5;
  const slippageBps = cfg.slippageBps ?? 2;
  const maxHoldBars = cfg.maxHoldBars;
  const open = new Map<string, PaperPosition>();
  const pending = new Map<string, PendingOrder>();
  const listeners: Array<(strategyId: string, outcome: Outcome) => void> = [];
  let realisedTotal = 0;
  let closedCount = 0;

  const slip = (price: number, side: 'buy' | 'sell') => price * (1 + (side === 'buy' ? 1 : -1) * (slippageBps / 10_000));

  function emitClose(pos: PaperPosition, exit: number, ts: number, reason: PaperCloseReason) {
    const dir = pos.side === 'long' ? 1 : -1;
    const move = (exit / pos.entry - 1) * dir;
    const pnl = pos.size * move * 100;
    const fees = pos.size * (feeBps / 10_000) * 2 * 100;
    const drawdown = pos.size * pos.maxAdverse * 100;
    const raw: PaperOutcomeRaw = { asset: pos.asset, side: pos.side, entry: pos.entry, exit, size: pos.size, reason, openedTs: pos.openedTs };
    const outcome: Outcome = { pnl, fees, drawdown, holdBars: pos.bars, closedTs: ts, raw };
    realisedTotal += pnl - fees;
    closedCount++;
    open.delete(key(pos.strategyId, pos.asset));
    for (const l of listeners) l(pos.strategyId, outcome);
  }

  function openPosition(strategyId: string, asset: string, d: NonNullable<Decision>, bar: Bar) {
    if (d.side === 'flat' || d.size <= 0) return;
    const entry = slip(bar.o, d.side === 'long' ? 'buy' : 'sell');
    const pos: PaperPosition = {
      strategyId,
      asset,
      side: d.side,
      size: d.size,
      entry,
      openedTs: bar.ts,
      bars: 0,
      maxAdverse: 0,
      lastPrice: entry,
    };
    if (d.stop && d.stop > 0) pos.stop = d.side === 'long' ? entry - d.stop : entry + d.stop;
    if (d.tp && d.tp > 0) pos.tp = d.side === 'long' ? entry + d.tp : entry - d.tp;
    open.set(key(strategyId, asset), pos);
  }

  function markAndCheck(pos: PaperPosition, bar: Bar): void {
    pos.bars++;
    pos.lastPrice = bar.c;
    const adverse = pos.side === 'long' ? (pos.entry - bar.l) / pos.entry : (bar.h - pos.entry) / pos.entry;
    if (adverse > pos.maxAdverse) pos.maxAdverse = adverse;
    // stop first: a bar that touches both stop and target is resolved conservatively
    if (pos.stop !== undefined) {
      const hit = pos.side === 'long' ? bar.l <= pos.stop : bar.h >= pos.stop;
      if (hit) {
        const fill = pos.side === 'long' ? Math.min(pos.stop, bar.o) : Math.max(pos.stop, bar.o);
        emitClose(pos, slip(fill, pos.side === 'long' ? 'sell' : 'buy'), bar.ts, 'stop');
        return;
      }
    }
    if (pos.tp !== undefined) {
      const hit = pos.side === 'long' ? bar.h >= pos.tp : bar.l <= pos.tp;
      if (hit) {
        const fill = pos.side === 'long' ? Math.max(pos.tp, bar.o) : Math.min(pos.tp, bar.o);
        emitClose(pos, slip(fill, pos.side === 'long' ? 'sell' : 'buy'), bar.ts, 'tp');
        return;
      }
    }
    if (maxHoldBars !== undefined && pos.bars >= maxHoldBars) {
      emitClose(pos, slip(bar.c, pos.side === 'long' ? 'sell' : 'buy'), bar.ts, 'maxHold');
    }
  }

  return {
    name: 'paper',
    async place(d, x) {
      const strategyId = String(x.meta?.['strategyId'] ?? d.tag ?? 'unknown');
      pending.set(key(strategyId, x.asset), { strategyId, decision: d, ts: x.ts });
      return { orderId: `paper:${strategyId}:${x.asset}:${x.ts}` };
    },
    onClose(cb) {
      listeners.push(cb);
    },
    onBar(bar) {
      // 1. fill orders placed on the previous bar at this bar's open
      for (const [k, order] of [...pending.entries()]) {
        const [strategyId, asset] = k.split('\u0000') as [string, string];
        if (asset !== bar.asset) continue;
        pending.delete(k);
        const pos = open.get(k);
        const d = order.decision;
        if (d.side === 'flat') {
          if (pos) emitClose(pos, slip(bar.o, pos.side === 'long' ? 'sell' : 'buy'), bar.ts, 'flat');
          continue;
        }
        if (pos && pos.side === d.side) {
          // holding: refresh protective levels if the strategy now asks for them
          if (d.stop && d.stop > 0) pos.stop = pos.side === 'long' ? pos.entry - d.stop : pos.entry + d.stop;
          if (d.tp && d.tp > 0) pos.tp = pos.side === 'long' ? pos.entry + d.tp : pos.entry - d.tp;
          continue;
        }
        if (pos && pos.side !== d.side) emitClose(pos, slip(bar.o, pos.side === 'long' ? 'sell' : 'buy'), bar.ts, 'flip');
        openPosition(strategyId, asset, d, bar);
      }
      // 2. mark open positions on this asset and resolve stops and targets
      for (const pos of [...open.values()]) if (pos.asset === bar.asset) markAndCheck(pos, bar);
    },
    stop() {
      pending.clear();
      for (const pos of [...open.values()]) emitClose(pos, slip(pos.lastPrice, pos.side === 'long' ? 'sell' : 'buy'), Date.now(), 'shutdown');
    },
    positions() {
      return [...open.values()].map((p) => ({ ...p }));
    },
    realised() {
      return realisedTotal;
    },
    closed() {
      return closedCount;
    },
  };
}

/** Narrow an Input to the asset an outcome refers to, used by the loop to attribute closes. */
export function outcomeAsset(outcome: Outcome): string | undefined {
  const raw = outcome.raw as { asset?: unknown } | undefined;
  return typeof raw?.asset === 'string' ? raw.asset : undefined;
}
