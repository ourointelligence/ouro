import { afterAll, describe, expect, it } from 'vitest';
import { openLog } from '../../src/log.js';
import { Sandbox } from '../../src/sandbox.js';
import { canonical, canonicalJson } from '../../src/export.js';
import type { Bar } from '../../src/types.js';
import { rmDir, tmpDir } from '../helpers/tmp.js';
import { synStrategyCode } from '../helpers/synthetic.js';

const dirs: string[] = [];
afterAll(() => dirs.forEach(rmDir));

const bar = (asset: string, i: number, ext?: Record<string, number>): Bar => ({ ts: 1_700_000_000_000 + i * 60_000, asset, tf: '1m', o: i, h: i + 1, l: i - 1, c: i, v: 1, ext });

describe('bar store', () => {
  for (const backend of ['sqlite', 'jsonl'] as const) {
    it(`${backend}: stores closed bars with ext, replaces duplicates, queries by range and limit, survives reopen`, async () => {
      const dir = tmpDir(`ouro-bars-${backend}-`);
      dirs.push(dir);
      let log = await openLog(dir, { backend });
      for (let i = 0; i < 10; i++) log.appendBar(bar('BTC', i, { 'funding.rate': i / 1000 }));
      log.appendBar(bar('ETH', 0));
      log.appendBar({ ...bar('BTC', 3), c: 99 }); // replaces bar 3
      expect(log.barCount('BTC', '1m')).toBe(10);
      expect(log.barCount('ETH', '1m')).toBe(1);
      expect(log.bars('BTC', '1m').map((b) => b.ts)).toEqual(Array.from({ length: 10 }, (_, i) => bar('BTC', i).ts));
      expect(log.bars('BTC', '1m')[3]!.c).toBe(99);
      expect(log.bars('BTC', '1m', { from: bar('BTC', 4).ts, to: bar('BTC', 6).ts }).map((b) => b.c)).toEqual([4, 5, 6]);
      expect(log.bars('BTC', '1m', { to: bar('BTC', 5).ts, limit: 2 }).map((b) => b.c)).toEqual([4, 5]);
      expect(log.bars('BTC', '1m')[7]!.ext).toEqual({ 'funding.rate': 0.007 });
      expect(log.firstTs()).toBeNull();
      log.close();
      log = await openLog(dir, { backend });
      expect(log.barCount('BTC', '1m')).toBe(10);
      expect(log.bars('BTC', '1m')[3]!.c).toBe(99);
      log.close();
    });
  }
});

describe('sandbox runMany', () => {
  it('returns one validated decision per input in order, in a single call', async () => {
    const sandbox = new Sandbox({ backend: 'worker' });
    await sandbox.compile(synStrategyCode(0.5, 0.5), 'm');
    const xs = [0.2, 0.7, 0.9].map((a, i) => ({ ts: i, asset: 'SYN', bar: bar('SYN', i), features: { 'syn.a': a, 'syn.b': 0.1 } }));
    const ds = await sandbox.runMany('m', xs, { aMin: 0.5, bMax: 0.5, size: 0.05 });
    expect(ds.map((d) => d?.side ?? null)).toEqual([null, 'long', 'long']);
    expect(await sandbox.runMany('m', [], {})).toEqual([]);
    sandbox.close();
  });
});

describe('canonical export form', () => {
  it('sorts keys at every level, drops undefined and keeps array order', () => {
    const v = canonical({ b: [{ z: 1, a: undefined, m: 2 }], a: { y: 1, x: 2 } });
    expect(JSON.stringify(v)).toBe('{"a":{"x":2,"y":1},"b":[{"m":2,"z":1}]}');
    expect(canonicalJson({ k: 1 })).toBe('{"k":1}');
  });
});
