import { EventEmitter } from 'node:events';
import type { Bar } from '@ourointelligence/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyFundingHistory,
  backoffDelay,
  hyperliquid,
  INTERVALS,
  RateBudget,
  withAssetCtx,
  type FundingEntry,
  type HyperliquidCandle,
  type HyperliquidEvent,
} from '../src/index.js';

const T0 = 1_791_500_000_000;
const MIN15 = INTERVALS['15m']!;

function candle(coin: string, t: number, i = '15m', c = '101'): HyperliquidCandle {
  return { t, T: t + INTERVALS[i]! - 1, s: coin, i, o: '100', c, h: '102', l: '99', v: '5', n: 10 };
}

class FakeSocket extends EventEmitter {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readonly sent: string[] = [];
  readyState = 0;
  constructor(readonly url: string) {
    super();
    FakeSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = FakeSocket.OPEN;
      this.emit('open');
    }, 0);
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.readyState = 3;
    this.emit('close', 1006);
  }
  push(c: HyperliquidCandle) {
    this.emit('message', Buffer.from(JSON.stringify({ channel: 'candle', data: c })));
  }
}

/** Snapshot server: every 15m candle from T0 to `until` (open time), closed or not. */
function snapshotFetch(until: () => number, calls: any[] = [], extra?: (body: any) => Response | undefined) {
  return (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const special = extra?.(body);
    if (special) return special;
    if (body.type !== 'candleSnapshot') return new Response('[]', { status: 200 });
    const { coin, startTime, endTime } = body.req;
    const out: HyperliquidCandle[] = [];
    for (let t = T0; t <= until(); t += MIN15) if (t >= startTime && t <= endTime) out.push(candle(coin, t));
    return new Response(JSON.stringify(out), { status: 200 });
  }) as typeof globalThis.fetch;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.useRealTimers();
  FakeSocket.instances = [];
});

describe('backoffDelay', () => {
  it('doubles from the initial delay, caps at max, and jitters within 20 percent', () => {
    expect(backoffDelay(1, 1000, 60000, () => 0.5)).toBe(1000);
    expect(backoffDelay(2, 1000, 60000, () => 0.5)).toBe(2000);
    expect(backoffDelay(3, 1000, 60000, () => 0.5)).toBe(4000);
    expect(backoffDelay(10, 1000, 60000, () => 0.5)).toBe(60000);
    expect(backoffDelay(1, 1000, 60000, () => 0)).toBe(800);
    expect(backoffDelay(1, 1000, 60000, () => 1)).toBe(1200);
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(3, 1000, 60000);
      expect(d).toBeGreaterThanOrEqual(3200);
      expect(d).toBeLessThanOrEqual(4800);
    }
  });
});

describe('reconnect', () => {
  it('backs off exponentially with jitter, reports each attempt, and resets after a stable connection', async () => {
    vi.useFakeTimers();
    const events: HyperliquidEvent[] = [];
    const src = hyperliquid({
      WebSocket: FakeSocket as any,
      now: () => T0,
      reconnectMs: 1000,
      maxReconnectMs: 60000,
      stableMs: 30000,
      random: () => 0.5,
      onEvent: (e) => events.push(e),
    });
    const it = src.subscribe({ assets: ['BTC'], tf: '15m' })[Symbol.asyncIterator]();
    const p = it.next();
    await vi.advanceTimersByTimeAsync(1);
    expect(src.stats().connected).toBe(true);
    FakeSocket.instances[0]!.close();
    expect(events.filter((e) => e.type === 'reconnect')).toEqual([{ type: 'reconnect', attempt: 1, delayMs: 1000 }]);
    expect(src.stats().connected).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.instances.length).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(FakeSocket.instances.length).toBe(2);
    // drop again before it is stable: attempt 2 waits 2 s
    FakeSocket.instances[1]!.close();
    expect(events.filter((e) => e.type === 'reconnect').at(-1)).toEqual({ type: 'reconnect', attempt: 2, delayMs: 2000 });
    await vi.advanceTimersByTimeAsync(2001);
    expect(FakeSocket.instances.length).toBe(3);
    FakeSocket.instances[2]!.close();
    expect(events.filter((e) => e.type === 'reconnect').at(-1)).toEqual({ type: 'reconnect', attempt: 3, delayMs: 4000 });
    await vi.advanceTimersByTimeAsync(4001);
    // stays open 30 s: the counter resets, so the next drop waits 1 s again
    await vi.advanceTimersByTimeAsync(30001);
    FakeSocket.instances[3]!.close();
    expect(events.filter((e) => e.type === 'reconnect').at(-1)).toEqual({ type: 'reconnect', attempt: 1, delayMs: 1000 });
    expect(src.stats().reconnects).toBe(4);
    await it.return!(undefined);
    expect((await p).done).toBe(true);
  });
});

describe('gap refill', () => {
  it('fetches the missing closed candles after a drop and emits them in order, once', async () => {
    let nowTs = T0 + 10;
    const calls: any[] = [];
    const events: HyperliquidEvent[] = [];
    const src = hyperliquid({
      WebSocket: FakeSocket as any,
      fetch: snapshotFetch(() => nowTs, calls),
      now: () => nowTs,
      reconnectMs: 1,
      maxReconnectMs: 1,
      onEvent: (e) => events.push(e),
    });
    const it = src.subscribe({ assets: ['BTC'], tf: '15m' })[Symbol.asyncIterator]();
    const first = it.next();
    await tick(2);
    const sock = FakeSocket.instances[0]!;
    nowTs = T0 + MIN15 + 10;
    sock.push(candle('BTC', T0 + MIN15)); // closes candle 0? no: nothing was forming. candle 1 is forming now
    sock.push(candle('BTC', T0 + MIN15, '15m', '101.5'));
    nowTs = T0 + 2 * MIN15 + 10;
    sock.push(candle('BTC', T0 + 2 * MIN15)); // closes candle 1
    expect((await first).value).toMatchObject({ ts: T0 + MIN15, c: 101.5 });

    // socket drops; candles 2, 3 and 4 close while we are away; candle 5 arrives after the reconnect
    sock.close();
    await tick(5);
    const sock2 = FakeSocket.instances[1]!;
    nowTs = T0 + 6 * MIN15 + 10;
    sock2.push(candle('BTC', T0 + 5 * MIN15)); // closed already (its end time has passed)
    const got: number[] = [];
    for (let i = 0; i < 4; i++) got.push((await it.next()).value!.ts);
    expect(got).toEqual([2, 3, 4, 5].map((k) => T0 + k * MIN15));
    const gap = events.find((e) => e.type === 'gap');
    expect(gap).toEqual({ type: 'gap', asset: 'BTC', from: T0 + 2 * MIN15, to: T0 + 4 * MIN15, filled: 3 });
    expect(src.stats().gapsFilled).toBe(3);
    expect(src.stats().lastBarTs['BTC']).toBe(T0 + 5 * MIN15);
    const snap = calls.find((c) => c.type === 'candleSnapshot');
    expect(snap.req).toMatchObject({ coin: 'BTC', interval: '15m', startTime: T0 + 2 * MIN15 });

    // a replay of an older candle is ignored
    sock2.push(candle('BTC', T0 + 4 * MIN15));
    nowTs = T0 + 7 * MIN15 + 10;
    sock2.push(candle('BTC', T0 + 6 * MIN15));
    expect((await it.next()).value!.ts).toBe(T0 + 6 * MIN15);
    await it.return!(undefined);
  });
});

describe('stale bars', () => {
  it('flags a closed candle emitted more than two intervals late, but not a prompt one or a refilled one', async () => {
    let nowTs = T0 + 10;
    const events: HyperliquidEvent[] = [];
    const src = hyperliquid({ WebSocket: FakeSocket as any, fetch: snapshotFetch(() => nowTs), now: () => nowTs, onEvent: (e) => events.push(e) });
    const it = src.subscribe({ assets: ['ETH'], tf: '15m' })[Symbol.asyncIterator]();
    const first = it.next();
    await tick(2);
    const sock = FakeSocket.instances[0]!;
    nowTs = T0 + MIN15 + 10;
    sock.push(candle('ETH', T0)); // end time passed: closed, prompt
    const a = await first;
    expect(a.value!.stale).toBeUndefined();
    // the next candle shows up three intervals after its end
    nowTs = T0 + 5 * MIN15;
    sock.push(candle('ETH', T0 + MIN15));
    // gap refill for candles 2 and 3? no: candle 1 follows candle 0 directly, so there is no gap
    const b = await it.next();
    expect(b.value!.ts).toBe(T0 + MIN15);
    expect(b.value!.stale).toBe(true);
    expect(events.some((e) => e.type === 'stale' && e.asset === 'ETH')).toBe(true);
    // candle 4 arrives on time while 2 and 3 are refilled: refilled bars are not stale
    nowTs = T0 + 5 * MIN15 + 10;
    sock.push(candle('ETH', T0 + 4 * MIN15));
    const c2 = await it.next();
    const c3 = await it.next();
    const c4 = await it.next();
    expect([c2.value!.ts, c3.value!.ts, c4.value!.ts]).toEqual([2, 3, 4].map((k) => T0 + k * MIN15));
    expect(c2.value!.stale).toBeUndefined();
    expect(c3.value!.stale).toBeUndefined();
    expect(c4.value!.stale).toBeUndefined();
    await it.return!(undefined);
  });
});

describe('rate budget', () => {
  it('blocks a request until enough weight has refilled and charges the per-item surcharge afterwards', async () => {
    vi.useFakeTimers();
    let nowTs = T0;
    const budget = new RateBudget({ weightPerMinute: 60, now: () => nowTs });
    expect(budget.waitFor(20)).toBe(0);
    await budget.acquire(20);
    await budget.acquire(20);
    await budget.acquire(20);
    expect(budget.usedLastMinute()).toBe(60);
    expect(budget.waitFor(20)).toBe(20000);
    let done = false;
    const waits: number[] = [];
    void budget.acquire(20, (ms) => waits.push(ms)).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(10000);
    nowTs += 10000;
    expect(done).toBe(false);
    nowTs += 10000;
    await vi.advanceTimersByTimeAsync(10001);
    expect(done).toBe(true);
    expect(waits).toEqual([20000]);
    budget.charge(5);
    expect(budget.waitFor(1)).toBeGreaterThan(0);
    nowTs += 60001;
    expect(budget.usedLastMinute()).toBe(0);
  });

  it('makes history respect the budget and backs off on HTTP 429', async () => {
    vi.useFakeTimers();
    const nowTs = T0 + 4 * MIN15 + 10;
    const calls: any[] = [];
    let rateLimited = 2;
    const events: HyperliquidEvent[] = [];
    const fetch = snapshotFetch(
      () => nowTs,
      calls,
      () => (rateLimited-- > 0 ? new Response('slow down', { status: 429 }) : undefined),
    );
    const src = hyperliquid({ fetch, now: () => nowTs, rateLimit: { weightPerMinute: 1200 }, reconnectMs: 1000, random: () => 0.5, onEvent: (e) => events.push(e) });
    const p = src.history({ assets: ['BTC'], tf: '15m', bars: 3 });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(1);
    expect(events).toEqual([{ type: 'rateLimit', waitMs: 1000, reason: '429' }]);
    await vi.advanceTimersByTimeAsync(1001);
    expect(calls.length).toBe(2);
    expect(events.at(-1)).toEqual({ type: 'rateLimit', waitMs: 2000, reason: '429' });
    await vi.advanceTimersByTimeAsync(2001);
    const bars = await p;
    expect(bars).toHaveLength(3);
    expect(calls.length).toBe(3);
    expect(src.stats().requests).toBe(3);
    // the budget only counts the request that went through: base weight 20, no surcharge for 4 items
    expect(src.stats().weightUsedLastMinute).toBe(20);
  });

  it('gives up after five retries on 429', async () => {
    vi.useFakeTimers();
    const fetch = (async () => new Response('', { status: 429 })) as unknown as typeof globalThis.fetch;
    const src = hyperliquid({ fetch, now: () => T0, reconnectMs: 1, maxReconnectMs: 1, random: () => 0.5 });
    const p = src.history({ assets: ['BTC'], tf: '15m', bars: 1 });
    const settled = p.catch((e: Error) => e);
    for (let i = 0; i < 7; i++) await vi.advanceTimersByTimeAsync(2);
    const err = (await settled) as Error;
    expect(err.message).toMatch(/429/);
  });
});

describe('withAssetCtx', () => {
  function ctxFetch(state: { oi: number; funding: number; polls: number; calls: any[]; nowTs: number }) {
    return (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      state.calls.push(body);
      if (body.type === 'metaAndAssetCtxs') {
        state.polls++;
        const ctx = (oi: number) => ({
          funding: String(state.funding),
          openInterest: String(oi),
          premium: '0.0002',
          oraclePx: '100.5',
          markPx: '100.6',
          prevDayPx: '99',
          dayNtlVlm: '1',
        });
        return new Response(JSON.stringify([{ universe: [{ name: 'ETH' }, { name: 'BTC' }] }, [ctx(state.oi * 2), ctx(state.oi)]]), { status: 200 });
      }
      if (body.type === 'fundingHistory') {
        const entries: FundingEntry[] = [];
        for (let t = T0 - 3_600_000; t <= body.endTime; t += 3_600_000) {
          if (t >= body.startTime) entries.push({ coin: body.coin, fundingRate: String(0.0001 * ((t - T0) / 3_600_000 + 1)), premium: '0', time: t });
        }
        return new Response(JSON.stringify(entries), { status: 200 });
      }
      if (body.type === 'candleSnapshot') {
        const { coin, startTime, endTime } = body.req;
        const out: HyperliquidCandle[] = [];
        for (let t = T0; t <= state.nowTs; t += MIN15) if (t >= startTime && t <= endTime) out.push(candle(coin, t));
        return new Response(JSON.stringify(out), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    }) as typeof globalThis.fetch;
  }

  it('fills ext on live bars with one poll per bar close and oi.change across polls', async () => {
    const state = { oi: 1000, funding: 0.0001, polls: 0, calls: [] as any[], nowTs: T0 + 10 };
    const src = hyperliquid({ WebSocket: FakeSocket as any, fetch: ctxFetch(state), now: () => state.nowTs, assetCtx: true });
    const it = src.subscribe({ assets: ['BTC', 'ETH'], tf: '15m' })[Symbol.asyncIterator]();
    const first = it.next();
    await tick(2);
    const sock = FakeSocket.instances[0]!;
    state.nowTs = T0 + MIN15 + 10;
    sock.push(candle('BTC', T0));
    sock.push(candle('ETH', T0));
    const a = (await first).value!;
    const b = (await it.next()).value!;
    expect(state.polls).toBe(1);
    expect(a.ext).toEqual({ 'funding.rate': 0.0001, oi: a.asset === 'BTC' ? 1000 : 2000, 'oi.change': 0, premium: 0.0002, mark: 100.6, oracle: 100.5 });
    expect(b.ext!['oi']).toBe(b.asset === 'BTC' ? 1000 : 2000);
    state.oi = 1100;
    state.funding = -0.00005;
    state.nowTs = T0 + 2 * MIN15 + 10;
    sock.push(candle('BTC', T0 + MIN15));
    sock.push(candle('ETH', T0 + MIN15));
    const c = (await it.next()).value!;
    const d = (await it.next()).value!;
    expect(state.polls).toBe(2);
    const btc = [c, d].find((x) => x.asset === 'BTC')!;
    const eth = [c, d].find((x) => x.asset === 'ETH')!;
    expect(btc.ext).toMatchObject({ 'funding.rate': -0.00005, oi: 1100, 'oi.change': 100 });
    expect(eth.ext).toMatchObject({ oi: 2200, 'oi.change': 200 });
    expect(src.stats().requests).toBe(2);
    await it.return!(undefined);
    expect(sock.readyState).toBe(3);
  });

  it('backfills funding.rate on history bars from fundingHistory', async () => {
    const state = { oi: 1, funding: 0, polls: 0, calls: [] as any[], nowTs: T0 + 8 * MIN15 + 10 };
    const src = withAssetCtx(hyperliquid({ fetch: ctxFetch(state), now: () => state.nowTs }));
    const bars = await src.history({ assets: ['BTC'], tf: '15m', bars: 8 });
    expect(bars).toHaveLength(8);
    const fh = state.calls.find((c) => c.type === 'fundingHistory');
    expect(fh).toMatchObject({ coin: 'BTC', startTime: T0, endTime: T0 + 8 * MIN15 - 1 });
    // entries at T0 (rate 0.0001), T0+1h (0.0002): bars 0-3 end before T0+1h, bars 4-7 after
    expect(bars.slice(0, 4).map((b) => b.ext?.['funding.rate'])).toEqual([0.0001, 0.0001, 0.0001, 0.0001]);
    expect(bars.slice(4).map((b) => b.ext?.['funding.rate'])).toEqual([0.0002, 0.0002, 0.0002, 0.0002]);
    expect(bars[0]!.ext).toEqual({ 'funding.rate': 0.0001 });
  });

  it('applyFundingHistory leaves bars before the first entry without a key and picks the latest entry at a boundary', () => {
    const bars: Bar[] = [0, 1, 2, 3].map((k) => ({ ts: T0 + k * MIN15, asset: 'BTC', tf: '15m', o: 1, h: 1, l: 1, c: 1, v: 1 }));
    const entries: FundingEntry[] = [
      { coin: 'BTC', fundingRate: '0.5', premium: '0', time: T0 + 2 * MIN15 - 1 }, // exactly at the end of bar 1
      { coin: 'BTC', fundingRate: '0.7', premium: '0', time: T0 + 3 * MIN15 },
    ];
    applyFundingHistory(bars, entries, MIN15);
    expect(bars.map((b) => b.ext?.['funding.rate'])).toEqual([undefined, 0.5, 0.5, 0.7]);
  });

  it('refuses a source that was not created by hyperliquid()', () => {
    expect(() => withAssetCtx({ name: 'x', subscribe: () => ({}) as any, history: async () => [] })).toThrow(/hyperliquid\(\)/);
  });
});
