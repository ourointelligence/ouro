import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmDir, tmpDir } from '../helpers/tmp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..', '..');
const child = path.join(here, '..', 'helpers', 'crash-child.mjs');
const dirs: string[] = [];
afterAll(() => dirs.forEach(rmDir));

beforeAll(() => {
  // the child runs against dist, so build it from the current sources first
  execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['exec', 'tsup'], { cwd: pkg, stdio: 'ignore', shell: process.platform === 'win32' });
}, 180_000);

function run(dir: string, step: string) {
  const r = spawnSync(process.execPath, [child, dir, step], { encoding: 'utf8', timeout: 120_000 });
  const line = r.stdout.trim().split('\n').pop() ?? '';
  return { code: r.status, signal: r.signal, summary: line.startsWith('{') ? (JSON.parse(line) as { cycle: number; status: string; cycles: number[]; live: number; ids: string[]; episodes: number }) : null, stderr: r.stderr };
}

describe('crash during every cycle step', () => {
  const steps = ['collect', 'rank', 'diagnose', 'generate', 'trial', 'validate', 'promote'];
  for (const step of steps) {
    it(`SIGKILL at ${step}, then a clean resume with no duplicate or lost cycle`, () => {
      const dir = tmpDir(`ouro-crash-${step}-`);
      dirs.push(dir);
      const killed = run(dir, step);
      expect(killed.summary, `child should have died at ${step}: ${killed.stderr}`).toBeNull();
      expect(fs.existsSync(path.join(dir, 'history.json'))).toBe(true);
      const resumed = run(dir, 'none');
      expect(resumed.summary, resumed.stderr).not.toBeNull();
      const s = resumed.summary!;
      expect(s.cycle).toBe(1);
      expect(['promoted', 'no_change']).toContain(s.status);
      expect(s.cycles).toEqual([1]);
      expect(s.live).toBe(8);
      expect(new Set(s.ids).size).toBe(s.ids.length);
      expect(s.episodes).toBeGreaterThanOrEqual(150);
      const history = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8')) as { cycles: Array<{ cycle: number }>; strategies: Array<{ id: string }> };
      expect(history.cycles.map((c) => c.cycle)).toEqual([1]);
      expect(new Set(history.strategies.map((x) => x.id)).size).toBe(history.strategies.length);
      // a further run finds no new episodes: cycle 1 is not run twice and nothing new is recorded
      const again = run(dir, 'none');
      expect(again.summary!.cycles).toEqual([1]);
      expect(again.summary!.status).toBe('no_change');
      expect(again.summary!.ids).toEqual(s.ids);
    }, 300_000);
  }
});
