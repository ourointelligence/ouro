import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, parseEnv, findRepoRoot } from '../../src/env.js';
import { tmpDir } from '../helpers/tmp.js';

const KEYS = ['OURO_T_A', 'OURO_T_B', 'OURO_T_C', 'OURO_T_D', 'OURO_T_Q'];
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe('parseEnv', () => {
  it('handles comments, export, quotes and escapes', () => {
    const env = parseEnv(
      [
        '# comment',
        '',
        'OURO_T_A=plain # trailing',
        'export OURO_T_B="two\\nlines"',
        "OURO_T_C='single # not a comment'",
        'OURO_T_D=',
        'not a pair',
      ].join('\n'),
    );
    expect(env).toEqual({ OURO_T_A: 'plain', OURO_T_B: 'two\nlines', OURO_T_C: 'single # not a comment', OURO_T_D: '' });
  });
});

describe('loadEnv', () => {
  it('reads cwd then repo root, never overriding shell variables', () => {
    const root = tmpDir('env-');
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n');
    const cwd = path.join(root, 'examples', 'x');
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(root, '.env'), 'OURO_T_A=root\nOURO_T_B=root\nOURO_T_Q=root\n');
    fs.writeFileSync(path.join(cwd, '.env'), 'OURO_T_A=cwd\nOURO_T_C=cwd\n');
    process.env['OURO_T_Q'] = 'shell';
    expect(findRepoRoot(cwd)).toBe(root);
    const loaded = loadEnv({ cwd });
    expect(loaded).toEqual([path.join(cwd, '.env'), path.join(root, '.env')]);
    expect(process.env['OURO_T_A']).toBe('cwd');
    expect(process.env['OURO_T_B']).toBe('root');
    expect(process.env['OURO_T_C']).toBe('cwd');
    expect(process.env['OURO_T_Q']).toBe('shell');
    expect(loadEnv({ cwd, override: true })).toHaveLength(2);
    expect(process.env['OURO_T_Q']).toBe('root');
  });
  it('is a no-op without files', () => {
    expect(loadEnv({ cwd: tmpDir('env-empty-') })).toEqual([]);
  });
});
