import { Worker } from 'node:worker_threads';
import ts from 'typescript';
import { z } from 'zod';
import type { Bounds, Decision, Input } from './types.js';

export type SandboxOptions = {
  /** Heap limit per strategy isolate, MB. Default 64. */
  memoryMb?: number;
  /** Wall-clock budget for one decide call, ms. Default 50. */
  decideTimeoutMs?: number;
  /** Wall-clock budget for loading a module, ms. Default 2000. */
  loadTimeoutMs?: number;
  /** Force a backend. Default: isolated-vm when it loads, otherwise a worker thread running node:vm. */
  backend?: 'auto' | 'isolated-vm' | 'worker';
};

export type CompiledModule = {
  id: string;
  params: Record<string, number>;
  bounds: Bounds;
  describe: string;
  /** Feature keys the module reads from x.features (static scan of string literals). */
  featureKeys: string[];
};

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly kind: 'forbidden' | 'syntax' | 'contract' | 'timeout' | 'memory' | 'runtime',
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

const FORBIDDEN: Array<{ re: RegExp; label: string }> = [
  { re: /\bimport\b/, label: 'import' },
  { re: /\brequire\b/, label: 'require' },
  { re: /\bfetch\b/, label: 'fetch' },
  { re: /\bprocess\b/, label: 'process' },
  { re: /\bglobalThis\b/, label: 'globalThis' },
  { re: /\beval\b/, label: 'eval' },
  { re: /\bFunction\b/, label: 'Function' },
  { re: /\bwhile\s*\(\s*true\s*\)/, label: 'while(true)' },
  { re: /\bfor\s*\(\s*;\s*;\s*\)/, label: 'for(;;)' },
  { re: /\bXMLHttpRequest\b|\bWebSocket\b|\bsetTimeout\b|\bsetInterval\b|\bqueueMicrotask\b/, label: 'host API' },
  { re: /\bconstructor\s*\[|\.constructor\b/, label: 'constructor access' },
];

const DecisionSchema = z
  .object({
    side: z.enum(['long', 'short', 'flat']),
    size: z.number().finite().nonnegative(),
    stop: z.number().finite().optional(),
    tp: z.number().finite().optional(),
    tag: z.string().max(64).optional(),
  })
  .nullable();

const BoundsSchema = z.record(
  z.string(),
  z.object({ min: z.number().finite(), max: z.number().finite(), step: z.number().finite().positive() }),
);

const ModuleMetaSchema = z.object({
  params: z.record(z.string(), z.number().finite()),
  bounds: BoundsSchema,
  describe: z.string().min(1).max(400),
  hasDecide: z.literal(true),
});

/** Strip // and block comments without touching string literals. */
export function stripComments(code: string): string {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i]!;
    const next = code[i + 1];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      out += ch;
      i++;
      while (i < n && code[i] !== q) {
        if (code[i] === '\\') {
          out += code[i]! + (code[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += code[i]!;
        i++;
      }
      out += code[i] ?? '';
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Returns a rejection reason when the source contains a forbidden construct, else null. */
export function validateSource(code: string): string | null {
  const stripped = stripComments(code);
  for (const f of FORBIDDEN) if (f.re.test(stripped)) return `forbidden token: ${f.label}`;
  if (!/export\s+(const|let|var)\s+params\b/.test(stripped)) return 'contract: missing `export const params`';
  if (!/export\s+(const|let|var)\s+bounds\b/.test(stripped)) return 'contract: missing `export const bounds`';
  if (!/export\s+function\s+decide\b/.test(stripped) && !/export\s+const\s+decide\b/.test(stripped)) return 'contract: missing `export function decide`';
  if (!/export\s+(const|let|var)\s+describe\b/.test(stripped)) return 'contract: missing `export const describe`';
  return null;
}

/** Extract feature keys read from x.features via string literals. */
export function scanFeatureKeys(code: string): string[] {
  const keys = new Set<string>();
  const re = /features\s*\[\s*['"`]([^'"`]+)['"`]\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) keys.add(m[1]!);
  const re2 = /features\s*\.\s*([A-Za-z_$][\w$]*)/g;
  while ((m = re2.exec(code))) keys.add(m[1]!);
  return [...keys];
}

/** Transpile the TypeScript module to CommonJS-shaped JavaScript. Throws SandboxError on syntax errors. */
export function transpile(code: string): string {
  const result = ts.transpileModule(code, {
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      removeComments: true,
      strict: false,
      esModuleInterop: false,
    },
  });
  const errors = (result.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    const msg = errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ');
    throw new SandboxError(`syntax: ${msg}`, 'syntax');
  }
  return result.outputText;
}

/** Wrap transpiled CJS so it evaluates to a JSON string describing the exports and installs __ouro.run. */
function wrapModule(js: string): string {
  return `(function(){
  var exports = {}; var module = { exports: exports };
  (function(exports, module){ ${js}\n })(exports, module);
  var m = module.exports;
  var decide = m.decide;
  __ouro = {
    run: function(xs, ps) { var d = decide(JSON.parse(xs), JSON.parse(ps)); return JSON.stringify(d === undefined ? null : d); },
    runMany: function(xss, ps) {
      var inputs = JSON.parse(xss); var p = JSON.parse(ps); var out = new Array(inputs.length);
      for (var i = 0; i < inputs.length; i++) { var d = decide(inputs[i], p); out[i] = d === undefined ? null : d; }
      return JSON.stringify(out);
    }
  };
  return JSON.stringify({ params: m.params, bounds: m.bounds, describe: m.describe, hasDecide: typeof decide === 'function' });
})()`;
}

interface Backend {
  readonly name: 'isolated-vm' | 'worker';
  load(id: string, js: string): Promise<string>;
  run(id: string, xs: string, ps: string): Promise<string>;
  /** Run decide over a JSON array of inputs in one call; the timeout scales with the batch size. */
  runMany(id: string, xss: string, ps: string, n: number): Promise<string>;
  dispose(id: string): void;
  disposeAll(): void;
}

type Limits = { memoryMb: number; decideTimeoutMs: number; loadTimeoutMs: number };

/** A batch may take the per-decision budget times its size, capped at one minute. */
function batchTimeout(limits: Limits, n: number): number {
  return Math.min(60_000, Math.max(limits.decideTimeoutMs, limits.decideTimeoutMs * Math.max(1, n)));
}

function classify(err: unknown): SandboxError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/timed out|timeout/i.test(msg)) return new SandboxError(`timeout: ${msg}`, 'timeout');
  if (/memory|disposed|heap|allocation failed|ERR_WORKER_OUT_OF_MEMORY/i.test(msg)) return new SandboxError(`memory: ${msg}`, 'memory');
  return new SandboxError(`runtime: ${msg}`, 'runtime');
}

/* ---------------------------------- isolated-vm backend ---------------------------------- */

class IsolatedVmBackend implements Backend {
  readonly name = 'isolated-vm' as const;
  private readonly isolates = new Map<string, { isolate: any; context: any }>();
  constructor(
    private readonly ivm: any,
    private readonly limits: Limits,
  ) {}
  async load(id: string, js: string): Promise<string> {
    this.dispose(id);
    const isolate = new this.ivm.Isolate({ memoryLimit: this.limits.memoryMb });
    const context = await isolate.createContext();
    try {
      const meta: string = await context.eval(wrapModule(js), { timeout: this.limits.loadTimeoutMs });
      this.isolates.set(id, { isolate, context });
      return meta;
    } catch (err) {
      try {
        if (!isolate.isDisposed) isolate.dispose();
      } catch {
        // the memory limit already disposed it
      }
      throw classify(err);
    }
  }
  async run(id: string, xs: string, ps: string): Promise<string> {
    const h = this.isolates.get(id);
    if (!h) throw new SandboxError(`runtime: strategy ${id} is not compiled`, 'runtime');
    try {
      return await h.context.eval(`__ouro.run(${JSON.stringify(xs)}, ${JSON.stringify(ps)})`, { timeout: this.limits.decideTimeoutMs });
    } catch (err) {
      const e = classify(err);
      if (e.kind === 'memory' || h.isolate.isDisposed) this.dispose(id);
      throw e;
    }
  }
  async runMany(id: string, xss: string, ps: string, n: number): Promise<string> {
    const h = this.isolates.get(id);
    if (!h) throw new SandboxError(`runtime: strategy ${id} is not compiled`, 'runtime');
    try {
      return await h.context.eval(`__ouro.runMany(${JSON.stringify(xss)}, ${JSON.stringify(ps)})`, { timeout: batchTimeout(this.limits, n) });
    } catch (err) {
      const e = classify(err);
      if (e.kind === 'memory' || h.isolate.isDisposed) this.dispose(id);
      throw e;
    }
  }
  dispose(id: string): void {
    const h = this.isolates.get(id);
    if (!h) return;
    this.isolates.delete(id);
    try {
      if (!h.isolate.isDisposed) h.isolate.dispose();
    } catch {
      // already gone
    }
  }
  disposeAll(): void {
    for (const id of [...this.isolates.keys()]) this.dispose(id);
  }
}

/* ------------------------------------ worker backend ------------------------------------- */

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const limits = workerData.limits;
let context = null;
parentPort.on('message', (msg) => {
  try {
    if (msg.type === 'load') {
      context = vm.createContext({ Math, Number, JSON, __ouro: null }, { codeGeneration: { strings: false, wasm: false } });
      const meta = vm.runInContext(msg.js, context, { timeout: limits.loadTimeoutMs, filename: msg.id + '.js' });
      parentPort.postMessage({ seq: msg.seq, ok: true, value: meta });
    } else if (msg.type === 'run') {
      if (!context) throw new Error('not loaded');
      context.__xs = msg.xs; context.__ps = msg.ps;
      const out = vm.runInContext('__ouro.run(__xs, __ps)', context, { timeout: limits.decideTimeoutMs });
      parentPort.postMessage({ seq: msg.seq, ok: true, value: out });
    } else if (msg.type === 'runMany') {
      if (!context) throw new Error('not loaded');
      context.__xs = msg.xs; context.__ps = msg.ps;
      const out = vm.runInContext('__ouro.runMany(__xs, __ps)', context, { timeout: msg.timeoutMs });
      parentPort.postMessage({ seq: msg.seq, ok: true, value: out });
    }
  } catch (err) {
    parentPort.postMessage({ seq: msg.seq, ok: false, error: String(err && err.message || err) });
  }
});
`;

type Pending = { resolve: (v: string) => void; reject: (e: Error) => void };

class WorkerHandle {
  readonly worker: Worker;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  dead = false;
  constructor(limits: Limits) {
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { limits },
      resourceLimits: { maxOldGenerationSizeMb: limits.memoryMb, maxYoungGenerationSizeMb: Math.max(4, Math.floor(limits.memoryMb / 4)) },
      stdout: false,
      stderr: false,
    });
    this.worker.unref();
    this.worker.on('message', (m: { seq: number; ok: boolean; value?: string; error?: string }) => {
      const p = this.pending.get(m.seq);
      if (!p) return;
      this.pending.delete(m.seq);
      if (m.ok) p.resolve(m.value ?? 'null');
      else p.reject(new Error(m.error ?? 'unknown'));
    });
    const fail = (err: Error) => {
      this.dead = true;
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    this.worker.on('error', (err) => fail(err));
    this.worker.on('exit', (code) => fail(new Error(`worker exited (${code}); memory limit exceeded`)));
  }
  call(msg: Record<string, unknown>, timeoutMs: number): Promise<string> {
    if (this.dead) return Promise.reject(new Error('worker is dead'));
    const seq = ++this.seq;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`timed out after ${timeoutMs} ms (hard kill)`));
        void this.worker.terminate();
      }, timeoutMs);
      this.pending.set(seq, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.worker.postMessage({ ...msg, seq });
    });
  }
  terminate(): void {
    this.dead = true;
    void this.worker.terminate();
  }
}

class WorkerBackend implements Backend {
  readonly name = 'worker' as const;
  private readonly workers = new Map<string, WorkerHandle>();
  constructor(private readonly limits: Limits) {}
  async load(id: string, js: string): Promise<string> {
    this.dispose(id);
    const w = new WorkerHandle(this.limits);
    try {
      // the hard-kill timer is generous: vm's own timeout fires first for CPU loops, this catches allocation storms
      const meta = await w.call({ type: 'load', id, js: wrapModule(js) }, this.limits.loadTimeoutMs + 500);
      this.workers.set(id, w);
      return meta;
    } catch (err) {
      w.terminate();
      throw classify(err);
    }
  }
  async run(id: string, xs: string, ps: string): Promise<string> {
    const w = this.workers.get(id);
    if (!w) throw new SandboxError(`runtime: strategy ${id} is not compiled`, 'runtime');
    try {
      return await w.call({ type: 'run', xs, ps }, this.limits.decideTimeoutMs + 100);
    } catch (err) {
      const e = classify(err);
      if (w.dead) this.dispose(id);
      throw e;
    }
  }
  async runMany(id: string, xss: string, ps: string, n: number): Promise<string> {
    const w = this.workers.get(id);
    if (!w) throw new SandboxError(`runtime: strategy ${id} is not compiled`, 'runtime');
    const timeoutMs = batchTimeout(this.limits, n);
    try {
      return await w.call({ type: 'runMany', xs: xss, ps, timeoutMs }, timeoutMs + 100);
    } catch (err) {
      const e = classify(err);
      if (w.dead) this.dispose(id);
      throw e;
    }
  }
  dispose(id: string): void {
    const w = this.workers.get(id);
    if (!w) return;
    this.workers.delete(id);
    w.terminate();
  }
  disposeAll(): void {
    for (const id of [...this.workers.keys()]) this.dispose(id);
  }
}

/* --------------------------------------- Sandbox ---------------------------------------- */

let ivmModule: any | null | undefined;
async function loadIvm(): Promise<any | null> {
  if (ivmModule !== undefined) return ivmModule;
  try {
    const mod = await import('isolated-vm');
    ivmModule = (mod as any).default ?? mod;
  } catch {
    ivmModule = null;
  }
  return ivmModule;
}

/**
 * Runs generated strategy modules in isolation: no network, no filesystem, no imports, bounded CPU and memory.
 * One isolate per strategy id, cached across calls so replay stays fast.
 */
export class Sandbox {
  private backend: Backend | null = null;
  private backendReady: Promise<Backend> | null = null;
  private readonly compiled = new Map<string, CompiledModule & { hash: string }>();
  private readonly limits: Limits;
  private readonly preferred: NonNullable<SandboxOptions['backend']>;
  private counter = 0;

  constructor(opts: SandboxOptions = {}) {
    this.limits = { memoryMb: opts.memoryMb ?? 64, decideTimeoutMs: opts.decideTimeoutMs ?? 50, loadTimeoutMs: opts.loadTimeoutMs ?? 2000 };
    this.preferred = opts.backend ?? 'auto';
  }

  /** Name of the active backend, once something has been compiled. */
  get backendName(): 'isolated-vm' | 'worker' | null {
    return this.backend?.name ?? null;
  }

  private getBackend(): Promise<Backend> {
    if (this.backend) return Promise.resolve(this.backend);
    if (!this.backendReady) {
      this.backendReady = (async () => {
        if (this.preferred !== 'worker') {
          const ivm = await loadIvm();
          if (ivm) return (this.backend = new IsolatedVmBackend(ivm, this.limits));
          if (this.preferred === 'isolated-vm') throw new SandboxError('runtime: isolated-vm is not installed', 'runtime');
        }
        return (this.backend = new WorkerBackend(this.limits));
      })();
    }
    return this.backendReady;
  }

  /**
   * Validate, transpile and load a strategy module. Returns the module's declared params, bounds and description.
   * The compiled isolate is cached under `id` (generated when omitted).
   */
  async compile(code: string, id?: string): Promise<CompiledModule> {
    const sid = id ?? `tmp-${++this.counter}`;
    const hash = fnv(code);
    const hit = this.compiled.get(sid);
    if (hit && hit.hash === hash) return hit;
    const reason = validateSource(code);
    if (reason) throw new SandboxError(reason, reason.startsWith('contract') ? 'contract' : 'forbidden');
    const js = transpile(code);
    const backend = await this.getBackend();
    const metaJson = await backend.load(sid, js);
    let meta: unknown;
    try {
      meta = JSON.parse(metaJson);
    } catch {
      throw new SandboxError('contract: module exports are not serialisable', 'contract');
    }
    const parsed = ModuleMetaSchema.safeParse(meta);
    if (!parsed.success) {
      backend.dispose(sid);
      throw new SandboxError(`contract: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`, 'contract');
    }
    for (const k of Object.keys(parsed.data.params)) {
      if (!parsed.data.bounds[k]) {
        backend.dispose(sid);
        throw new SandboxError(`contract: param "${k}" has no entry in bounds`, 'contract');
      }
    }
    const mod: CompiledModule & { hash: string } = {
      id: sid,
      params: parsed.data.params,
      bounds: parsed.data.bounds,
      describe: parsed.data.describe,
      featureKeys: scanFeatureKeys(code),
      hash,
    };
    this.compiled.set(sid, mod);
    return mod;
  }

  /** Run a compiled strategy's decide on one input with the given params. */
  async run(strategyId: string, x: Input, p: Record<string, number>): Promise<Decision> {
    const backend = await this.getBackend();
    if (!this.compiled.has(strategyId)) throw new SandboxError(`runtime: strategy ${strategyId} is not compiled`, 'runtime');
    const out = await backend.run(strategyId, JSON.stringify(x), JSON.stringify(p));
    let raw: unknown;
    try {
      raw = JSON.parse(out);
    } catch {
      throw new SandboxError('runtime: decide returned a non-serialisable value', 'runtime');
    }
    const parsed = DecisionSchema.safeParse(raw);
    if (!parsed.success) throw new SandboxError(`runtime: decide returned an invalid decision: ${JSON.stringify(raw)}`, 'runtime');
    return parsed.data;
  }

  /** Run decide over many inputs in one sandbox call (replay). Each decision is validated like run(). */
  async runMany(strategyId: string, xs: Input[], p: Record<string, number>): Promise<Decision[]> {
    const backend = await this.getBackend();
    if (!this.compiled.has(strategyId)) throw new SandboxError(`runtime: strategy ${strategyId} is not compiled`, 'runtime');
    if (xs.length === 0) return [];
    const out = await backend.runMany(strategyId, JSON.stringify(xs), JSON.stringify(p), xs.length);
    let raw: unknown;
    try {
      raw = JSON.parse(out);
    } catch {
      throw new SandboxError('runtime: decide returned a non-serialisable value', 'runtime');
    }
    if (!Array.isArray(raw) || raw.length !== xs.length) throw new SandboxError('runtime: batch decide returned the wrong shape', 'runtime');
    return raw.map((r) => {
      const parsed = DecisionSchema.safeParse(r);
      if (!parsed.success) throw new SandboxError(`runtime: decide returned an invalid decision: ${JSON.stringify(r)}`, 'runtime');
      return parsed.data;
    });
  }

  has(strategyId: string): boolean {
    return this.compiled.has(strategyId);
  }

  get(strategyId: string): CompiledModule | undefined {
    return this.compiled.get(strategyId);
  }

  dispose(strategyId: string): void {
    this.compiled.delete(strategyId);
    this.backend?.dispose(strategyId);
  }

  close(): void {
    this.compiled.clear();
    this.backend?.disposeAll();
  }
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** Convenience: a process-wide sandbox for callers that do not manage their own. */
let shared: Sandbox | null = null;
export function sharedSandbox(): Sandbox {
  return (shared ??= new Sandbox());
}

/** Compile with the shared sandbox. */
export function compile(code: string, id?: string): Promise<CompiledModule> {
  return sharedSandbox().compile(code, id);
}

/** Run with the shared sandbox. */
export function run(strategyId: string, x: Input, p: Record<string, number>): Promise<Decision> {
  return sharedSandbox().run(strategyId, x, p);
}
