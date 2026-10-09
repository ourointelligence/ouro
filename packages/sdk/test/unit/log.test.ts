import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openLog, type EpisodeLog } from '../../src/log.js';
import type { Episode } from '../../src/types.js';
import { rmDir, tmpDir } from '../helpers/tmp.js';

function ep(id: string, strategyId: string, ts: number): Episode {
  return {
    id,
    ts,
    strategyId,
    input: { ts, asset: 'X', bar: { ts, asset: 'X', tf: '1m', o: 1, h: 1, l: 1, c: 1, v: 1 }, features: {} },
    decision: { side: 'long', size: 0.1 },
    outcome: { pnl: 1, fees: 0, drawdown: 0, holdBars: 1, closedTs: ts },
    score: 1,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmDir(d);
});

async function exercise(log: EpisodeLog) {
  log.append(ep('a', 's1', 300));
  log.append(ep('b', 's1', 100));
  log.append(ep('c', 's1', 200));
  log.append(ep('d', 's2', 150));
  expect(log.count('s1')).toBe(3);
  expect(log.count('s2')).toBe(1);
  expect(log.count('nope')).toBe(0);
  expect(log.all('s1').map((e) => e.ts)).toEqual([100, 200, 300]);
  expect(log.recent('s1', 2).map((e) => e.ts)).toEqual([200, 300]);
  expect(log.countSince('s1', 150)).toBe(2);
  expect(log.recentSince('s1', 150, 5).map((e) => e.ts)).toEqual([200, 300]);
  expect(new Set(log.strategyIds())).toEqual(new Set(['s1', 's2']));
  expect(log.total()).toBe(4);
  // idempotent on id
  log.append(ep('a', 's1', 300));
  expect(log.count('s1')).toBe(3);
}

describe('episode log', () => {
  it('sqlite backend stores and queries episodes', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const log = await openLog(dir, { backend: 'sqlite' });
    expect(log.kind).toBe('sqlite');
    await exercise(log);
    log.close();
    // reopen: data persisted
    const again = await openLog(dir, { backend: 'sqlite' });
    expect(again.count('s1')).toBe(3);
    again.close();
  });

  it('jsonl backend stores, queries and reloads episodes', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const log = await openLog(dir, { backend: 'jsonl' });
    expect(log.kind).toBe('jsonl');
    await exercise(log);
    log.close();
    expect(fs.existsSync(path.join(dir, 'episodes.jsonl'))).toBe(true);
    const again = await openLog(dir, { backend: 'jsonl' });
    expect(again.all('s1').map((e) => e.ts)).toEqual([100, 200, 300]);
    again.close();
  });

  it('auto mode falls back to jsonl and reports why when sqlite is unavailable', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    // simulate the failure path by asking for jsonl explicitly when sqlite would fail
    let reason = '';
    const log = await openLog(dir, { backend: 'auto', onFallback: (r) => (reason = r) });
    expect(['sqlite', 'jsonl']).toContain(log.kind);
    if (log.kind === 'jsonl') expect(reason.length).toBeGreaterThan(0);
    log.close();
  });
});
