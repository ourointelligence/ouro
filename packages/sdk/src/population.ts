import fs from 'node:fs';
import path from 'node:path';
import type { CycleResult, Strategy } from './types.js';

export type PendingPromotion = { candidate: Strategy; retireId: string };
export type PendingCycle = { result: CycleResult; promotions: PendingPromotion[] };

export type HistoryFile = {
  version: 1;
  goal: string;
  createdAt: number;
  /** Every strategy ever generated, including rejected ones. */
  strategies: Strategy[];
  /** One record per completed cycle. */
  cycles: CycleResult[];
  /** Live ids at the end of each cycle, keyed by cycle number ("0" = after seeding). */
  liveByCycle: Record<string, string[]>;
  /** Ids of the seed generation (the live set after seeding). */
  seedIds: string[];
  /** Mean own-episode holdout score of the seed generation, stored once after cycle 1. The CI baseline. */
  baselineHoldout: number | null;
  /** Mean absolute own-episode holdout score of the seed generation; bounds the CI denominator. */
  baselineScale: number;
  pending: PendingCycle | null;
  /** Timestamp of the newest episode consumed by the last cycle. */
  lastCycleTs: number;
  /** Number of the last completed cycle. */
  cycle: number;
  nextId: number;
};

function emptyHistory(goal: string): HistoryFile {
  return {
    version: 1,
    goal,
    createdAt: Date.now(),
    strategies: [],
    cycles: [],
    liveByCycle: {},
    seedIds: [],
    baselineHoldout: null,
    baselineScale: 0,
    pending: null,
    lastCycleTs: 0,
    cycle: 0,
    nextId: 1,
  };
}

/**
 * The live set plus the full record of everything ever generated.
 * Persisted as `.ouro/history.json` and one `.ts` + `.json` pair per strategy under `.ouro/population/`.
 */
export class Population {
  readonly dir: string;
  readonly populationDir: string;
  readonly historyFile: string;
  private data: HistoryFile;
  private readonly index = new Map<string, Strategy>();

  constructor(
    dir: string,
    readonly K: number,
    goal: string,
    readonly retireShare = 0.25,
  ) {
    this.dir = dir;
    this.populationDir = path.join(dir, 'population');
    this.historyFile = path.join(dir, 'history.json');
    fs.mkdirSync(this.populationDir, { recursive: true });
    this.data = fs.existsSync(this.historyFile) ? (JSON.parse(fs.readFileSync(this.historyFile, 'utf8')) as HistoryFile) : emptyHistory(goal);
    if (!this.data.goal) this.data.goal = goal;
    this.data.seedIds ??= this.data.liveByCycle['0'] ?? [];
    this.data.baselineScale ??= 0;
    for (const s of this.data.strategies) this.index.set(s.id, s);
  }

  get goal(): string {
    return this.data.goal;
  }
  get cycle(): number {
    return this.data.cycle;
  }
  get lastCycleTs(): number {
    return this.data.lastCycleTs;
  }
  set lastCycleTs(ts: number) {
    this.data.lastCycleTs = ts;
  }
  get baselineHoldout(): number | null {
    return this.data.baselineHoldout;
  }
  set baselineHoldout(v: number | null) {
    this.data.baselineHoldout = v;
  }
  get baselineScale(): number {
    return this.data.baselineScale;
  }
  set baselineScale(v: number) {
    this.data.baselineScale = v;
  }
  get seedIds(): string[] {
    return [...this.data.seedIds];
  }
  get pending(): PendingCycle | null {
    return this.data.pending;
  }
  set pending(p: PendingCycle | null) {
    this.data.pending = p;
  }
  get createdAt(): number {
    return this.data.createdAt;
  }

  nextId(): string {
    const n = this.data.nextId++;
    return `s-${String(n).padStart(4, '0')}`;
  }

  live(): Strategy[] {
    return this.data.strategies.filter((s) => s.status === 'live');
  }
  all(): Strategy[] {
    return [...this.data.strategies];
  }
  cycles(): CycleResult[] {
    return [...this.data.cycles];
  }
  get(id: string): Strategy | undefined {
    return this.index.get(id);
  }
  liveIdsAt(cycle: number): string[] | undefined {
    return this.data.liveByCycle[String(cycle)];
  }

  /** Register a strategy record (any status) and write its files. */
  add(s: Strategy): Strategy {
    if (this.index.has(s.id)) return this.update(s);
    this.data.strategies.push(s);
    this.index.set(s.id, s);
    this.writeFiles(s);
    return s;
  }

  /** Replace an existing record in place. */
  update(s: Strategy): Strategy {
    const idx = this.data.strategies.findIndex((x) => x.id === s.id);
    if (idx >= 0) this.data.strategies[idx] = s;
    else this.data.strategies.push(s);
    this.index.set(s.id, s);
    this.writeFiles(s);
    return s;
  }

  /** Sort ids by score descending. Ids missing a score sort last. */
  rank(holdoutScores: Record<string, number>): Strategy[] {
    const live = this.live();
    return live.sort((a, b) => {
      const sa = holdoutScores[a.id];
      const sb = holdoutScores[b.id];
      if (sa === undefined && sb === undefined) return 0;
      if (sa === undefined) return 1;
      if (sb === undefined) return -1;
      return sb - sa;
    });
  }

  /** Bottom share of a ranked list, marked for retirement. At least one when K > 1. */
  weak(ranked: Strategy[]): Strategy[] {
    if (ranked.length < 2) return [];
    const n = Math.max(1, Math.floor(ranked.length * this.retireShare));
    return ranked.slice(ranked.length - n);
  }

  /** Promote a candidate into the live set in place of a retired strategy. Population size never changes. */
  promote(candidate: Strategy, retireId: string, cycle: number): void {
    const target = this.index.get(retireId);
    if (target && target.status === 'live') {
      target.status = 'retired';
      target.cycleRetired = cycle;
      this.update(target);
    }
    candidate.status = 'live';
    this.add(candidate);
  }

  /** Append a cycle record and snapshot the live ids. */
  recordCycle(result: CycleResult): void {
    this.data.cycles.push(result);
    this.data.cycle = result.cycle;
    this.data.liveByCycle[String(result.cycle)] = this.live().map((s) => s.id);
    this.save();
  }

  /** Snapshot live ids for cycle 0 (after seeding); that set is the seed generation the CI baseline refers to. */
  snapshot(cycle: number): void {
    this.data.liveByCycle[String(cycle)] = this.live().map((s) => s.id);
    if (cycle === 0) this.data.seedIds = this.live().map((s) => s.id);
    this.save();
  }

  /**
   * Restore the live set recorded at the end of `cycle`. Strategies born later are marked rolled_back,
   * strategies retired later come back as live. History is never deleted.
   */
  rollback(cycle: number): { restored: string[]; rolledBack: string[] } {
    const ids = this.data.liveByCycle[String(cycle)];
    if (!ids) throw new Error(`no snapshot for cycle ${cycle}`);
    const keep = new Set(ids);
    const restored: string[] = [];
    const rolledBack: string[] = [];
    for (const s of this.data.strategies) {
      if (keep.has(s.id)) {
        if (s.status !== 'live') restored.push(s.id);
        s.status = 'live';
        delete s.cycleRetired;
      } else if (s.status === 'live' || (s.cycleBorn > cycle && s.status !== 'rejected')) {
        if (s.status === 'live') rolledBack.push(s.id);
        s.status = 'rolled_back';
      }
      this.writeFiles(s);
    }
    this.data.pending = null;
    const marker: CycleResult = {
      cycle: this.data.cycle + 1,
      status: 'no_change',
      promoted: [],
      retired: [],
      rejected: [],
      diagnosis: { patterns: [], summary: `rolled back to cycle ${cycle}`, weakIds: [], strongIds: [] },
      populationCI: this.data.cycles.find((c) => c.cycle === cycle)?.populationCI ?? 0,
      note: `rollback:${cycle}`,
      ts: Date.now(),
    };
    this.recordCycle(marker);
    return { restored, rolledBack };
  }

  history(): { strategies: Strategy[]; cycles: CycleResult[]; liveByCycle: Record<string, string[]>; seedIds: string[]; baselineHoldout: number | null } {
    return {
      strategies: this.all(),
      cycles: this.cycles(),
      liveByCycle: { ...this.data.liveByCycle },
      seedIds: [...this.data.seedIds],
      baselineHoldout: this.data.baselineHoldout,
    };
  }

  save(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.historyFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.historyFile);
  }

  private writeFiles(s: Strategy): void {
    fs.writeFileSync(path.join(this.populationDir, `${s.id}.ts`), s.code);
    fs.writeFileSync(path.join(this.populationDir, `${s.id}.json`), JSON.stringify(s, null, 2));
  }
}
