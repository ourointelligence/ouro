import type { Bar, Decision, Executor, Input, LoopConfig, Outcome, PrimitivePack, Source } from '@ourointelligence/sdk';

/**
 * Non-trading example: a synthetic support-ticket stream. Each "bar" is one ticket, the 'text' pack turns it into
 * features, and a Decision of 'long' means resolve it yourself while 'short' means escalate to a human.
 * It proves the SDK is not trading-specific: same loop, same guards, same takeoff curve.
 *
 * Set OURO_LLM and a key, then: npx ouro run --paper --quiet
 */

// ----- a deterministic ticket generator; the bar fields carry the ticket's measurements -----
let seed = 7;
const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
const CATEGORIES = ['billing', 'bug', 'howto', 'refund', 'outage'];

function ticket(ts: number): Bar {
  const length = Math.round(20 + rand() * 500); // characters
  const sentiment = Math.round((rand() * 2 - 1) * 100) / 100; // -1 angry .. +1 happy
  const category = Math.floor(rand() * CATEGORIES.length);
  const urgency = Math.round(rand() * 3); // 0..3
  const prior = Math.floor(rand() * 4); // previous contacts
  return { ts, asset: 'tickets', tf: '1t', o: length, h: sentiment, l: category, c: urgency, v: prior };
}

/** Hidden ground truth: how hard the ticket really is. Strategies must discover the pattern from the features. */
function difficulty(b: Bar): number {
  const cat = CATEGORIES[b.l] ?? 'howto';
  let d = cat === 'outage' ? 0.9 : cat === 'refund' ? 0.6 : cat === 'bug' ? 0.5 : cat === 'billing' ? 0.3 : 0.1;
  if (b.h < -0.5) d += 0.2; // angry customers are harder
  if (b.v >= 2) d += 0.2; // repeat contacts are harder
  if (b.o > 400) d += 0.1; // long tickets are harder
  return Math.min(1, d);
}

// ----- the 'text' primitive pack: length, sentiment stub, category, urgency, prior contacts -----
const text: PrimitivePack = {
  name: 'text',
  compute(bars, i) {
    const b = bars[i];
    if (!b) return { length: null, sentiment: null, category: null, urgency: null, priorContacts: null };
    return { length: b.o, sentiment: b.h, category: b.l, urgency: b.c, priorContacts: b.v };
  },
  describe() {
    return [
      { key: 'length', doc: 'Ticket length in characters.' },
      { key: 'sentiment', doc: 'Sentiment stub, -1 (angry) to +1 (happy).' },
      { key: 'category', doc: `Category code: ${CATEGORIES.map((c, i) => `${i}=${c}`).join(', ')}.` },
      { key: 'urgency', doc: 'Urgency 0 (low) to 3 (critical).' },
      { key: 'priorContacts', doc: 'How many times this customer already wrote in about this issue.' },
    ];
  },
};

// ----- source: a backlog of tickets, then a slow live trickle -----
const source: Source = {
  name: 'tickets',
  async history({ bars }) {
    const start = Date.now() - bars * 60_000;
    return Array.from({ length: bars }, (_, i) => ticket(start + i * 60_000));
  },
  async *subscribe() {
    for (;;) {
      await new Promise((r) => setTimeout(r, 500));
      yield ticket(Date.now());
    }
  },
};

// ----- executor: resolving a ticket is the "trade"; the outcome arrives on the next ticket -----
const resolver: Executor = {
  name: 'ticket-resolver',
  listeners: [] as Array<(strategyId: string, outcome: Outcome) => void>,
  pending: [] as Array<{ strategyId: string; d: NonNullable<Decision>; x: Input }>,
  async place(d: NonNullable<Decision>, x: Input) {
    this.pending.push({ strategyId: String(x.meta?.['strategyId']), d, x });
    return { orderId: `${x.meta?.['strategyId']}:${x.ts}` };
  },
  onClose(cb: (strategyId: string, outcome: Outcome) => void) {
    this.listeners.push(cb);
  },
  onBar(bar: Bar) {
    for (const p of this.pending.splice(0)) {
      const hard = difficulty(p.x.bar);
      const resolved = p.d.side === 'long' && hard < 0.5; // resolved without escalation
      const bounced = p.d.side === 'long' && hard >= 0.5; // tried, failed, customer came back
      const pnl = resolved ? 1 : bounced ? -1 : hard >= 0.5 ? 0.4 : -0.3; // escalating an easy ticket wastes a human
      const holdBars = 1 + (p.d.side === 'long' ? Math.round(hard * 3) : 2);
      const outcome: Outcome = { pnl, fees: 0, drawdown: bounced ? 1 : 0, holdBars, closedTs: bar.ts, raw: { asset: 'tickets' } };
      for (const l of this.listeners) l(p.strategyId, outcome);
    }
  },
} as Executor & { listeners: Array<(strategyId: string, outcome: Outcome) => void>; pending: Array<{ strategyId: string; d: NonNullable<Decision>; x: Input }> };

const config: LoopConfig = {
  goal: 'Resolve support tickets without escalation and without bouncing; escalate only tickets that really need a human. Fewer turns is better.',
  primitives: [text],
  source,
  executor: resolver,
  assets: ['tickets'],
  tf: '1t',
  population: 6,
  cycleEvery: 30,
  holdout: 0.3,
  margin: 0.05,
  guards: { maxDrawdownPct: 1000, maxPositionPct: 100, requireApproval: false },
  score: (ep) => ep.outcome.pnl - 0.1 * ep.outcome.holdBars,
  warmupBars: 5,
  backfill: 600,
};

export default config;
