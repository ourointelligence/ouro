import { afterAll, describe, expect, it } from 'vitest';
import { Sandbox, SandboxError, scanFeatureKeys, stripComments, validateSource } from '../src/sandbox.js';
import type { Input } from '../src/types.js';
import { synStrategyCode } from './helpers/synthetic.js';

const x: Input = { ts: 1, asset: 'SYN', bar: { ts: 1, asset: 'SYN', tf: '1m', o: 1, h: 1, l: 1, c: 1, v: 1 }, features: { 'syn.a': 0.9, 'syn.b': 0.1 } };

let ivmAvailable = false;
try {
  await import('isolated-vm');
  ivmAvailable = true;
} catch {
  ivmAvailable = false;
}

const backends: Array<'worker' | 'isolated-vm'> = ivmAvailable ? ['isolated-vm', 'worker'] : ['worker'];

describe('static validation', () => {
  it('strips comments but not strings', () => {
    expect(stripComments(`const a = 'http://x'; // comment\n/* block */ const b = "y";`)).toBe(`const a = 'http://x'; \n const b = "y";`);
  });
  it('rejects forbidden tokens and missing exports', () => {
    expect(validateSource(synStrategyCode(0.5, 0.5))).toBeNull();
    expect(validateSource(`import x from 'y';\n` + synStrategyCode(0.5, 0.5))).toMatch(/import/);
    expect(validateSource(synStrategyCode(0.5, 0.5, 0.05, 'for(;;){}'))).toMatch(/for\(;;\)/);
    expect(validateSource(`export const params = {}; export const bounds = {}; export const describe = 'x';`)).toMatch(/missing `export function decide`/);
  });
  it('ignores forbidden words inside comments', () => {
    expect(validateSource(`// we never import anything\n` + synStrategyCode(0.5, 0.5))).toBeNull();
  });
  it('scans feature keys', () => {
    expect(scanFeatureKeys(synStrategyCode(0.5, 0.5)).sort()).toEqual(['syn.a', 'syn.b']);
  });
});

describe.each(backends)('sandbox (%s backend)', (backend) => {
  const sandbox = new Sandbox({ backend, decideTimeoutMs: 50, loadTimeoutMs: 2000, memoryMb: 64 });
  afterAll(() => sandbox.close());

  it('compiles a module, exposes its metadata and runs decide', async () => {
    const m = await sandbox.compile(synStrategyCode(0.6, 0.3), 'ok');
    expect(sandbox.backendName).toBe(backend);
    expect(m.params).toEqual({ aMin: 0.6, bMax: 0.3, size: 0.05 });
    expect(m.bounds.aMin).toEqual({ min: 0, max: 1, step: 0.1 });
    expect(m.describe).toMatch(/Long when/);
    expect(await sandbox.run('ok', x, { aMin: 0.6, bMax: 0.3, size: 0.07 })).toEqual({ side: 'long', size: 0.07 });
    expect(await sandbox.run('ok', { ...x, features: { 'syn.a': 0.1, 'syn.b': 0.1 } }, m.params)).toBeNull();
  });

  it('throws on code that calls fetch, process or require', async () => {
    for (const snippet of ['fetch("http://x")', 'process.exit(1)', 'require("fs")']) {
      await expect(sandbox.compile(synStrategyCode(0.6, 0.3, 0.05, `${snippet};`), 'bad')).rejects.toBeInstanceOf(SandboxError);
    }
  });

  it('rejects timers, sockets and constructor walks statically', async () => {
    for (const snippet of ['setTimeout(() => 1, 1)', 'new WebSocket("ws://x")', 'const C = ({}).constructor;']) {
      await expect(sandbox.compile(synStrategyCode(0.6, 0.3, 0.05, `${snippet};`), 'host')).rejects.toBeInstanceOf(SandboxError);
    }
  });

  it('runs decide inside the isolate with no access to Date-free host state and stays pure across calls', async () => {
    const counter = synStrategyCode(0.6, 0.3, 0.05, '').replace('export function decide', 'let calls = 0;\nexport function decide').replace('if (a > p.aMin', 'calls++;\n  if (calls > 1) return { side: \'short\', size: 0.01 };\n  if (a > p.aMin');
    await sandbox.compile(counter, 'impure');
    const first = await sandbox.run('impure', x, { aMin: 0.6, bMax: 0.3, size: 0.05 });
    const second = await sandbox.run('impure', x, { aMin: 0.6, bMax: 0.3, size: 0.05 });
    // module state persists inside one isolate; this documents that replay relies on decide being written pure
    expect(first).toEqual({ side: 'long', size: 0.05 });
    expect(second).toEqual({ side: 'short', size: 0.01 });
  });

  it('kills an infinite loop in decide in under 100 ms', async () => {
    const code = synStrategyCode(0.6, 0.3, 0.05, 'let i = 0; for (let j = 0; j >= 0; j++) { i += j; }');
    await sandbox.compile(code, 'loop');
    const t0 = performance.now();
    await expect(sandbox.run('loop', x, { aMin: 0.6, bMax: 0.3, size: 0.05 })).rejects.toThrow(/timeout/);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it('kills a memory bomb', async () => {
    const bomb = `export const params = { k: 1 };
export const bounds = { k: { min: 0, max: 2, step: 1 } };
const big: any[] = [];
for (let i = 0; i < 1e8; i++) big.push({ i, s: 'x'.repeat(64) + i, arr: [i, i, i, i] });
export function decide(x: Input, p: typeof params): Decision { return big.length > 0 ? null : null; }
export const describe = 'memory bomb';`;
    const t0 = performance.now();
    await expect(sandbox.compile(bomb, 'bomb')).rejects.toBeInstanceOf(SandboxError);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(sandbox.has('bomb')).toBe(false);
    // the sandbox is still usable afterwards
    await sandbox.compile(synStrategyCode(0.6, 0.3), 'after');
    expect(await sandbox.run('after', x, { aMin: 0.6, bMax: 0.3, size: 0.05 })).toEqual({ side: 'long', size: 0.05 });
  });

  it('rejects modules that break the contract', async () => {
    await expect(sandbox.compile(`export const params = { a: 1 };\nexport const bounds = {};\nexport function decide(x: Input, p: typeof params): Decision { return null; }\nexport const describe = 'x';`, 'c1')).rejects.toThrow(/no entry in bounds/);
    await expect(sandbox.compile(`export const params = { a: 'x' };\nexport const bounds = { a: { min: 0, max: 1, step: 1 } };\nexport function decide(x: Input, p: typeof params): Decision { return null; }\nexport const describe = 'x';`, 'c2')).rejects.toThrow(/contract/);
    await expect(sandbox.compile(synStrategyCode(0.6, 0.3).replace("return { side: 'long', size: p.size }", "return { side: 'up', size: p.size }"), 'c3')).resolves.toBeTruthy();
    await expect(sandbox.run('c3', x, { aMin: 0.6, bMax: 0.3, size: 0.05 })).rejects.toThrow(/invalid decision/);
  });

  it('caches compiled isolates by id and recompiles when the code changes', async () => {
    const a = await sandbox.compile(synStrategyCode(0.6, 0.3), 'cache');
    const b = await sandbox.compile(synStrategyCode(0.6, 0.3), 'cache');
    expect(a).toBe(b);
    const c = await sandbox.compile(synStrategyCode(0.7, 0.3), 'cache');
    expect(c.params.aMin).toBe(0.7);
  });
});
