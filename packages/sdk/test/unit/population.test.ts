import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Population } from '../../src/population.js';
import type { Strategy } from '../../src/types.js';
import { rmDir, tmpDir } from '../helpers/tmp.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmDir(d);
});

function strat(id: string, origin: Strategy['origin'] = 'seed', cycleBorn = 0): Strategy {
  return { id, parentIds: [], origin, cycleBorn, code: `// ${id}`, params: { a: 1 }, rationale: 'r', status: 'live', describe: `strategy ${id}` };
}

describe('Population', () => {
  it('adds, ranks, marks the bottom quarter weak and persists files', () => {
    const dir = tmpDir();
    dirs.push(dir);
    const pop = new Population(dir, 8, 'goal');
    for (let i = 1; i <= 8; i++) pop.add(strat(`s-000${i}`));
    pop.snapshot(0);
    const ranked = pop.rank({ 's-0001': 0.1, 's-0002': 0.9, 's-0003': 0.5, 's-0004': -1, 's-0005': 0.2, 's-0006': 0.3, 's-0007': 0.4, 's-0008': 0.0 });
    expect(ranked.map((s) => s.id)).toEqual(['s-0002', 's-0003', 's-0007', 's-0006', 's-0005', 's-0001', 's-0008', 's-0004']);
    expect(pop.weak(ranked).map((s) => s.id)).toEqual(['s-0008', 's-0004']);
    expect(fs.existsSync(path.join(dir, 'population', 's-0001.ts'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'population', 's-0001.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'history.json'))).toBe(true);
    expect(pop.nextId()).toBe('s-0001');
  });

  it('promotes without shrinking, records cycles and rolls back by snapshot', () => {
    const dir = tmpDir();
    dirs.push(dir);
    const pop = new Population(dir, 2, 'goal');
    pop.add(strat('s-0001'));
    pop.add(strat('s-0002'));
    pop.snapshot(0);
    const child = strat('s-0003', 'mutate', 1);
    pop.promote(child, 's-0001', 1);
    expect(pop.live().map((s) => s.id).sort()).toEqual(['s-0002', 's-0003']);
    expect(pop.get('s-0001')!.status).toBe('retired');
    pop.recordCycle({ cycle: 1, status: 'promoted', promoted: [child], retired: [pop.get('s-0001')!], rejected: [], diagnosis: { patterns: [], summary: '', weakIds: [], strongIds: [] }, populationCI: 0.1 });
    expect(pop.cycle).toBe(1);
    expect(pop.liveIdsAt(1)).toEqual(['s-0002', 's-0003']);

    // reload from disk and roll back
    const reloaded = new Population(dir, 2, 'goal');
    expect(reloaded.live().map((s) => s.id).sort()).toEqual(['s-0002', 's-0003']);
    const r = reloaded.rollback(0);
    expect(r.restored).toEqual(['s-0001']);
    expect(r.rolledBack).toEqual(['s-0003']);
    expect(reloaded.live().map((s) => s.id).sort()).toEqual(['s-0001', 's-0002']);
    expect(reloaded.get('s-0003')!.status).toBe('rolled_back');
    expect(reloaded.cycles().at(-1)!.note).toBe('rollback:0');
    expect(() => reloaded.rollback(99)).toThrow(/no snapshot/);
  });
});
