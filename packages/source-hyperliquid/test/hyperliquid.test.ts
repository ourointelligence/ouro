import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { hyperliquid, INTERVALS, SNAPSHOT_LIMIT, toBar, type HyperliquidCandle } from '../src/index.js';

const T0 = 1_791_500_000_000;
const MIN15 = INTERVALS['15m']!;

function candle(coin: string, t: number, i = '15m'): HyperliquidCandle {
  return { t, T: t + INTERVALS[i]! - 1, s: coin, i, o: '100', c: '101', h: '102', l: '99', v: '5', n: 10 };
}

describe('history', () => {
  it('posts candleSnapshot per asset, drops the forming candle and returns the newest `bars` sorted by time', async () => {
    const calls: any[] = [];
    const nowTs = T0 + 10 * MIN15 + 5_000; // 5 s into candle 10
    const fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const { coin, startTime, endTime } = body.req;
      const out: HyperliquidCandle[] = [];
      for (let t = T0; t <= T0 + 10 * MIN15; t += MIN15) if (t >= startTime && t <= endTime) out.push(candle(coin, t));
      return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    const src = hyperliquid({ fetch, now: () => nowTs });
    const bars = await src.history({ assets: ['BTC', 'ETH'], tf: '15m', bars: 4 });
    expect(calls[0].type).toBe('candleSnapshot');
    expect(calls[0].req).toMatchObject({ coin: 'BTC', interval: '15m' });
    expect(bars).toHaveLength(8);
    const btc = bars.filter((b) => b.asset === 'BTC');
    expect(btc.map((b) => b.ts)).toEqual([6, 7, 8, 9].map((k) => T0 + k * MIN15)); // candle 10 is still forming
    expect(btc[0]).toMatchObject({ asset: 'BTC', tf: '15m', o: 100, h: 102, l: 99, c: 101, v: 5 });
    for (let i = 1; i < bars.length; i++) expect(bars[i]!.ts).toBeGreaterThanOrEqual(bars[i - 1]!.ts);
  });

  it('pages backwards when more than one snapshot is needed', async () => {
    const calls: any[] = [];
    const total = SNAPSHOT_LIMIT + 200;
    const first = T0 - total * MIN15;
    const nowTs = T0 + 1;
    const fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      calls.push(body.req);
      const out: HyperliquidCandle[] = [];
      let n = 0;
      for (let t = first; t < T0 && n < SNAPSHOT_LIMIT; t += MIN15) {
        if (t >= body.req.startTime && t <= body.req.endTime) {
          out.push(candle('BTC', t));
          n++;
        }
      }
      return new Response(JSON.stringify(out), { status: 200 });
    }) as typeof globalThis.fetch;
    const bars = await hyperliquid({ fetch, now: () => nowTs }).history({ assets: ['BTC'], tf: '15m', bars: SNAPSHOT_LIMIT + 100 });
    expect(bars).toHaveLength(SNAPSHOT_LIMIT + 100);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1].endTime).toBeLessThan(calls[0].endTime);
  });

  it('rejects unknown intervals and HTTP errors', async () => {
    await expect(hyperliquid().history({ assets: ['BTC'], tf: '7m', bars: 1 })).rejects.toThrow(/unsupported interval/);
    const fetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof globalThis.fetch;
    await expect(hyperliquid({ fetch }).history({ assets: ['BTC'], tf: '15m', bars: 1 })).rejects.toThrow(/HTTP 500/);
  });
});

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
    this.emit('close');
  }
  push(c: HyperliquidCandle) {
    this.emit('message', Buffer.from(JSON.stringify({ channel: 'candle', data: c })));
  }
}

describe('subscribe', () => {
  it('subscribes per coin, yields a candle once it closes, and stops on return()', async () => {
    FakeSocket.instances = [];
    let nowTs = T0 + 10_000;
    const src = hyperliquid({ WebSocket: FakeSocket as any, now: () => nowTs, pingMs: 10 });
    const it = src.subscribe({ assets: ['BTC'], tf: '15m' })[Symbol.asyncIterator]();
    const firstPromise = it.next();
    await new Promise((r) => setTimeout(r, 5));
    const sock = FakeSocket.instances[0]!;
    expect(sock.sent[0]).toBe(JSON.stringify({ method: 'subscribe', subscription: { type: 'candle', coin: 'BTC', interval: '15m' } }));

    // updates of the forming candle do not yield
    sock.push({ ...candle('BTC', T0), c: '100.5' });
    sock.push({ ...candle('BTC', T0), c: '100.8' });
    let settled = false;
    void firstPromise.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);

    // the next candle starting closes the previous one
    nowTs = T0 + MIN15 + 1_000;
    sock.push(candle('BTC', T0 + MIN15));
    const first = await firstPromise;
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ asset: 'BTC', ts: T0, c: 100.8 });

    // other coins and intervals are ignored
    sock.push(candle('ETH', T0 + MIN15));
    sock.push(candle('BTC', T0 + MIN15, '1h'));

    // a candle whose end time has passed closes immediately
    nowTs = T0 + 2 * MIN15 + 10;
    sock.push(candle('BTC', T0 + MIN15));
    const second = await it.next();
    expect(second.value).toMatchObject({ ts: T0 + MIN15 });

    await new Promise((r) => setTimeout(r, 25));
    expect(sock.sent.some((s) => s === JSON.stringify({ method: 'ping' }))).toBe(true);

    const pending = it.next();
    await it.return!(undefined);
    expect((await pending).done).toBe(true);
    expect((await it.next()).done).toBe(true);
    expect(sock.readyState).toBe(3);
  });

  it('reconnects after the socket drops', async () => {
    FakeSocket.instances = [];
    const src = hyperliquid({ WebSocket: FakeSocket as any, now: () => T0, reconnectMs: 5 });
    const it = src.subscribe({ assets: ['BTC'], tf: '15m' })[Symbol.asyncIterator]();
    const p = it.next();
    await new Promise((r) => setTimeout(r, 5));
    FakeSocket.instances[0]!.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeSocket.instances.length).toBe(2);
    await it.return!(undefined);
    expect((await p).done).toBe(true);
  });

  it('toBar converts strings to numbers', () => {
    expect(toBar(candle('BTC', T0))).toEqual({ ts: T0, asset: 'BTC', tf: '15m', o: 100, h: 102, l: 99, c: 101, v: 5 });
  });
});
