import fs from 'node:fs';
import path from 'node:path';
import type { Episode } from './types.js';

/** Append-only store of episodes. SQLite when better-sqlite3 loads, JSONL otherwise. */
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
    db.exec(
      'CREATE TABLE IF NOT EXISTS episodes (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, strategyId TEXT NOT NULL, score REAL, json TEXT NOT NULL)',
    );
    db.exec('CREATE INDEX IF NOT EXISTS episodes_strategy_ts ON episodes (strategyId, ts)');
    this.stmts = {
      insert: db.prepare('INSERT OR REPLACE INTO episodes (id, ts, strategyId, score, json) VALUES (?, ?, ?, ?, ?)'),
      recent: db.prepare('SELECT json FROM episodes WHERE strategyId = ? ORDER BY ts DESC, rowid DESC LIMIT ?'),
      recentSince: db.prepare('SELECT json FROM episodes WHERE strategyId = ? AND ts > ? ORDER BY ts DESC, rowid DESC LIMIT ?'),
      all: db.prepare('SELECT json FROM episodes WHERE strategyId = ? ORDER BY ts ASC, rowid ASC'),
      count: db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE strategyId = ?'),
      countSince: db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE strategyId = ? AND ts > ?'),
      ids: db.prepare('SELECT DISTINCT strategyId AS id FROM episodes'),
      total: db.prepare('SELECT COUNT(*) AS n FROM episodes'),
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
  close(): void {
    this.db.close();
  }
}

class JsonlLog implements EpisodeLog {
  readonly kind = 'jsonl' as const;
  private readonly byStrategy = new Map<string, Episode[]>();
  private readonly seen = new Set<string>();
  constructor(readonly file: string) {
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
  const tmp = path.join(process.env['TMPDIR'] ?? process.env['TEMP'] ?? '.', `ouro-mem-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  const log = new JsonlLog(tmp);
  const origClose = log.close.bind(log);
  log.close = () => {
    origClose();
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  };
  return log;
}
