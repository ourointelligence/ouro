import fs from 'node:fs';
import path from 'node:path';
import type { Bar, Episode } from './types.js';

export type BarQuery = { from?: number; to?: number; limit?: number };

/** Append-only store of episodes and closed bars. SQLite when better-sqlite3 loads, JSONL otherwise. */
export interface EpisodeLog {
  readonly kind: 'sqlite' | 'jsonl';
  readonly file: string;
  append(ep: Episode): void;
  /** Newest n episodes for a strategy, returned oldest-first. */
  recent(strategyId: string, n: number): Episode[];
  /** Every episode for a strategy, oldest-first. */
  all(strategyId: string): Episode[];
  count(strategyId: string): number;
  /** Episodes with ts strictly after `ts`. */
  countSince(strategyId: string, ts: number): number;
  /** Newest n episodes with ts strictly after `ts`, oldest-first. */
  recentSince(strategyId: string, ts: number, n: number): Episode[];
  strategyIds(): string[];
  total(): number;
  /** Timestamp of the oldest episode in the store, or null when empty. */
  firstTs(): number | null;
  /** Store a closed bar (replaces an earlier bar with the same asset, tf and ts). */
  appendBar(bar: Bar): void;
  /** Closed bars for one asset and timeframe, oldest-first, optionally bounded by ts and count (newest `limit`). */
  bars(asset: string, tf: string, q?: BarQuery): Bar[];
  barCount(asset: string, tf: string): number;
  /** Flush buffered writes (no-op for the backends here, kept so stop() can call it). */
  flush(): void;
  close(): void;
}

type SqliteDb = {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): any;
    all(...args: unknown[]): any[];
  };
  exec(sql: string): unknown;
  pragma(s: string): unknown;
  close(): void;
};

class SqliteLog implements EpisodeLog {
  readonly kind = 'sqlite' as const;
  private readonly stmts;
  constructor(
    private readonly db: SqliteDb,
    readonly file: string,
  ) {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec(
      'CREATE TABLE IF NOT EXISTS episodes (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, strategyId TEXT NOT NULL, score REAL, json TEXT NOT NULL)',
    );
    db.exec('CREATE INDEX IF NOT EXISTS episodes_strategy_ts ON episodes (strategyId, ts)');
    db.exec('CREATE TABLE IF NOT EXISTS bars (asset TEXT NOT NULL, tf TEXT NOT NULL, ts INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (asset, tf, ts))');
    this.stmts = {
      insert: db.prepare('INSERT OR REPLACE INTO episodes (id, ts, strategyId, score, json) VALUES (?, ?, ?, ?, ?)'),
      recent: db.prepare('SELECT json FROM episodes WHERE strategyId = ? ORDER BY ts DESC, rowid DESC LIMIT ?'),
      recentSince: db.prepare('SELECT json FROM episodes WHERE strategyId = ? AND ts > ? ORDER BY ts DESC, rowid DESC LIMIT ?'),
      all: db.prepare('SELECT json FROM episodes WHERE strategyId = ? ORDER BY ts ASC, rowid ASC'),
      count: db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE strategyId = ?'),
      countSince: db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE strategyId = ? AND ts > ?'),
      ids: db.prepare('SELECT DISTINCT strategyId AS id FROM episodes'),
      total: db.prepare('SELECT COUNT(*) AS n FROM episodes'),
      firstTs: db.prepare('SELECT MIN(ts) AS ts FROM episodes'),
      insertBar: db.prepare('INSERT OR REPLACE INTO bars (asset, tf, ts, json) VALUES (?, ?, ?, ?)'),
      bars: db.prepare('SELECT json FROM bars WHERE asset = ? AND tf = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC'),
      barsLimit: db.prepare('SELECT json FROM bars WHERE asset = ? AND tf = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?'),
      barCount: db.prepare('SELECT COUNT(*) AS n FROM bars WHERE asset = ? AND tf = ?'),
    };
  }
  append(ep: Episode): void {
    this.stmts.insert.run(ep.id, ep.ts, ep.strategyId, ep.score ?? null, JSON.stringify(ep));
  }
  recent(strategyId: string, n: number): Episode[] {
    return (this.stmts.recent.all(strategyId, n) as Array<{ json: string }>).map((r) => JSON.parse(r.json) as Episode).reverse();
  }
  recentSince(strategyId: string, ts: number, n: number): Episode[] {
    return (this.stmts.recentSince.all(strategyId, ts, n) as Array<{ json: string }>)
      .map((r) => JSON.parse(r.json) as Episode)
      .reverse();
  }
  all(strategyId: string): Episode[] {
    return (this.stmts.all.all(strategyId) as Array<{ json: string }>).map((r) => JSON.parse(r.json) as Episode);
  }
  count(strategyId: string): number {
    return Number((this.stmts.count.get(strategyId) as { n: number }).n);
  }
  countSince(strategyId: string, ts: number): number {
    return Number((this.stmts.countSince.get(strategyId, ts) as { n: number }).n);
  }
  strategyIds(): string[] {
    return (this.stmts.ids.all() as Array<{ id: string }>).map((r) => r.id);
  }
  total(): number {
    return Number((this.stmts.total.get() as { n: number }).n);
  }
  firstTs(): number | null {
    const v = (this.stmts.firstTs.get() as { ts: number | null }).ts;
    return v === null || v === undefined ? null : Number(v);
  }
  appendBar(bar: Bar): void {
    this.stmts.insertBar.run(bar.asset, bar.tf, bar.ts, JSON.stringify(bar));
  }
  bars(asset: string, tf: string, q: BarQuery = {}): Bar[] {
    const from = q.from ?? 0;
    const to = q.to ?? Number.MAX_SAFE_INTEGER;
    if (q.limit !== undefined) {
      return (this.stmts.barsLimit.all(asset, tf, from, to, q.limit) as Array<{ json: string }>).map((r) => JSON.parse(r.json) as Bar).reverse();
    }
    return (this.stmts.bars.all(asset, tf, from, to) as Array<{ json: string }>).map((r) => JSON.parse(r.json) as Bar);
  }
  barCount(asset: string, tf: string): number {
    return Number((this.stmts.barCount.get(asset, tf) as { n: number }).n);
  }
  flush(): void {
    // better-sqlite3 writes synchronously
  }
  close(): void {
    this.db.close();
  }
}

class JsonlLog implements EpisodeLog {
  readonly kind = 'jsonl' as const;
  private readonly byStrategy = new Map<string, Episode[]>();
  private readonly seen = new Set<string>();
  private readonly barSeries = new Map<string, Bar[]>();
  readonly barsFile: string;
  constructor(readonly file: string) {
    this.barsFile = file.replace(/episodes\.jsonl$/, 'bars.jsonl');
    if (this.barsFile === file) this.barsFile = `${file}.bars`;
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          this.insert(JSON.parse(line) as Episode);
        } catch {
          // skip corrupt line
        }
      }
    }
    if (fs.existsSync(this.barsFile)) {
      for (const line of fs.readFileSync(this.barsFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          this.insertBar(JSON.parse(line) as Bar);
        } catch {
          // skip corrupt line
        }
      }
    }
  }
  private insert(ep: Episode) {
    if (this.seen.has(ep.id)) {
      const arr = this.byStrategy.get(ep.strategyId) ?? [];
      const idx = arr.findIndex((e) => e.id === ep.id);
      if (idx >= 0) arr[idx] = ep;
      return;
    }
    this.seen.add(ep.id);
    const arr = this.byStrategy.get(ep.strategyId) ?? [];
    // keep chronological order; appends are almost always in order so scan from the end
    let i = arr.length;
    while (i > 0 && arr[i - 1]!.ts > ep.ts) i--;
    arr.splice(i, 0, ep);
    this.byStrategy.set(ep.strategyId, arr);
  }
  private insertBar(bar: Bar) {
    const k = `${bar.asset}\u0000${bar.tf}`;
    const arr = this.barSeries.get(k) ?? [];
    let i = arr.length;
    while (i > 0 && arr[i - 1]!.ts > bar.ts) i--;
    if (i > 0 && arr[i - 1]!.ts === bar.ts) arr[i - 1] = bar;
    else arr.splice(i, 0, bar);
    this.barSeries.set(k, arr);
  }
  append(ep: Episode): void {
    this.insert(ep);
    fs.appendFileSync(this.file, JSON.stringify(ep) + '\n');
  }
  recent(strategyId: string, n: number): Episode[] {
    const arr = this.byStrategy.get(strategyId) ?? [];
    return arr.slice(Math.max(0, arr.length - n));
  }
  recentSince(strategyId: string, ts: number, n: number): Episode[] {
    const arr = (this.byStrategy.get(strategyId) ?? []).filter((e) => e.ts > ts);
    return arr.slice(Math.max(0, arr.length - n));
  }
  all(strategyId: string): Episode[] {
    return [...(this.byStrategy.get(strategyId) ?? [])];
  }
  count(strategyId: string): number {
    return (this.byStrategy.get(strategyId) ?? []).length;
  }
  countSince(strategyId: string, ts: number): number {
    return (this.byStrategy.get(strategyId) ?? []).filter((e) => e.ts > ts).length;
  }
  strategyIds(): string[] {
    return [...this.byStrategy.keys()];
  }
  total(): number {
    return this.seen.size;
  }
  firstTs(): number | null {
    let min: number | null = null;
    for (const arr of this.byStrategy.values()) {
      const first = arr[0];
      if (first && (min === null || first.ts < min)) min = first.ts;
    }
    return min;
  }
  appendBar(bar: Bar): void {
    this.insertBar(bar);
    fs.appendFileSync(this.barsFile, JSON.stringify(bar) + '\n');
  }
  bars(asset: string, tf: string, q: BarQuery = {}): Bar[] {
    const from = q.from ?? 0;
    const to = q.to ?? Number.MAX_SAFE_INTEGER;
    const arr = (this.barSeries.get(`${asset}\u0000${tf}`) ?? []).filter((b) => b.ts >= from && b.ts <= to);
    return q.limit !== undefined ? arr.slice(Math.max(0, arr.length - q.limit)) : arr;
  }
  barCount(asset: string, tf: string): number {
    return (this.barSeries.get(`${asset}\u0000${tf}`) ?? []).length;
  }
  flush(): void {
    // appendFileSync already flushed
  }
  close(): void {
    // nothing to release
  }
}

export type LogOptions = { backend?: 'auto' | 'sqlite' | 'jsonl'; onFallback?: (reason: string) => void };

/** Open the episode log in `dir`. Tries SQLite first; falls back to JSONL when better-sqlite3 cannot load. */
export async function openLog(dir: string, opts: LogOptions = {}): Promise<EpisodeLog> {
  fs.mkdirSync(dir, { recursive: true });
  const backend = opts.backend ?? 'auto';
  if (backend !== 'jsonl') {
    try {
      const mod = (await import('better-sqlite3')) as unknown as { default: new (file: string) => SqliteDb };
      const Database = mod.default;
      const file = path.join(dir, 'episodes.db');
      return new SqliteLog(new Database(file), file);
    } catch (err) {
      if (backend === 'sqlite') throw err;
      opts.onFallback?.((err as Error).message);
    }
  }
  return new JsonlLog(path.join(dir, 'episodes.jsonl'));
}

/** In-memory log for tests and ephemeral runs. */
export function memoryLog(): EpisodeLog {
  const tmp = path.join(process.env['TMPDIR'] ?? process.env['TEMP'] ?? '.', `ouro-mem-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.episodes.jsonl`);
  const log = new JsonlLog(tmp);
  const origClose = log.close.bind(log);
  log.close = () => {
    origClose();
    try {
      fs.rmSync(tmp, { force: true });
      fs.rmSync(log.barsFile, { force: true });
    } catch {
      // ignore
    }
  };
  return log;
}
