#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import ts from 'typescript';
import type { CycleResult, Strategy, TakeoffRow } from './types.js';
import type { Loop, LoopConfig } from './loop.js';
import { createLoop } from './loop.js';
import { OURO_DIR, OURO_NAME, OURO_TAGLINE } from './constants.js';
import { formatTakeoff, readTakeoff, takeoff as takeoffOf } from './si.js';
import { loadEnv } from './env.js';

const CONFIG_NAMES = ['ouro.config.ts', 'ouro.config.mts', 'ouro.config.js', 'ouro.config.mjs'];

/** Load `ouro.config.ts` (or .js/.mjs) from cwd. TypeScript configs are transpiled next to the file so imports resolve. */
export async function loadConfig(explicit?: string, cwd = process.cwd()): Promise<LoopConfig> {
  const file = explicit ? path.resolve(cwd, explicit) : CONFIG_NAMES.map((n) => path.join(cwd, n)).find((f) => fs.existsSync(f));
  if (!file || !fs.existsSync(file)) {
    throw new Error(`no ouro.config.ts found in ${cwd}. Create one that does \`export default\` of a loop config object, or pass --config <file>.`);
  }
  let importPath = file;
  let temp: string | null = null;
  if (/\.m?ts$/.test(file)) {
    const src = fs.readFileSync(file, 'utf8');
    const out = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler },
      fileName: file,
    });
    temp = path.join(path.dirname(file), `.ouro.config.${process.pid}.${Date.now()}.mjs`);
    fs.writeFileSync(temp, out.outputText);
    importPath = temp;
  }
  try {
    const mod = (await import(pathToFileURL(importPath).href)) as { default?: LoopConfig; config?: LoopConfig };
    const cfg = mod.default ?? mod.config;
    if (!cfg || typeof cfg !== 'object') throw new Error(`${file} must \`export default\` a loop config object`);
    return cfg;
  } finally {
    if (temp) fs.rmSync(temp, { force: true });
  }
}

function signed(v: number | undefined, d = 2): string {
  if (v === undefined || !Number.isFinite(v)) return '   n/a';
  return (v >= 0 ? '+' : '') + v.toFixed(d);
}

export function populationTable(strategies: Strategy[]): string {
  const rows = strategies.map((s) => [
    s.id,
    s.origin,
    String(s.cycleBorn),
    signed(s.trial?.holdoutScore, 4),
    signed(s.ci),
    (s.describe ?? '').slice(0, 90),
  ]);
  const header = ['id', 'origin', 'born', 'holdout', 'ci', 'describe'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  ');
  return [line(header), ...rows.map(line)].join('\n');
}

function cycleSummary(r: CycleResult): string {
  const lines = [`cycle ${r.cycle}: ${r.status}${r.note ? ` (${r.note})` : ''}; population CI ${signed(r.populationCI, 3)}`];
  if (r.diagnosis.summary) lines.push(`  diagnosis: ${r.diagnosis.summary}`);
  for (const s of r.promoted) lines.push(`  + ${s.id} (${s.origin}) holdout ${signed(s.trial?.holdoutScore, 4)}: ${s.describe ?? ''}`);
  for (const s of r.retired) lines.push(`  - ${s.id} retired`);
  for (const x of r.rejected) lines.push(`  x ${x.strategy.id} (${x.strategy.origin}): ${x.reason}`);
  return lines.join('\n');
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function attachLogging(loop: Loop, verbose = true) {
  loop.events.on('log', (m) => console.log(`[${stamp()}] ${m}`));
  loop.events.on('error', (e) => console.error(`[${stamp()}] error: ${e.message}`));
  if (verbose) {
    loop.events.on('episode', (ep) => {
      console.log(
        `[${stamp()}] episode ${ep.strategyId} ${ep.input.asset} ${ep.decision?.side ?? '-'} pnl ${signed(ep.outcome.pnl, 3)} fees ${ep.outcome.fees.toFixed(3)} dd ${ep.outcome.drawdown.toFixed(3)} hold ${ep.outcome.holdBars} score ${signed(ep.score, 3)}`,
      );
    });
  }
  loop.events.on('cycle', (r) => {
    console.log(cycleSummary(r));
    loop
      .population()
      .then((p) => console.log(populationTable(p)))
      .then(() => loop.takeoff())
      .then((t) => console.log(formatTakeoff(t)))
      .catch(() => undefined);
  });
}

async function withLoop(opts: { config?: string }, fn: (loop: Loop, cfg: LoopConfig) => Promise<void>): Promise<void> {
  const cfg = await loadConfig(opts.config);
  const loop = createLoop(cfg);
  try {
    await fn(loop, cfg);
  } finally {
    await loop.close();
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('ouro')
    .description(`${OURO_NAME}: recursive self-improvement for any goal. ${OURO_TAGLINE}`)
    .version('0.1.0')
    .option('-c, --config <file>', 'config file (default: ouro.config.ts in cwd)');

  program
    .command('run')
    .description('seed if needed, then trade the population on live data and cycle as episodes accumulate')
    .option('--paper', 'use the built-in paper executor (default)')
    .option('--live', 'use the executor plugin from the config; requires guards.requireApproval: true')
    .option('--assets <list>', 'comma-separated assets, overrides config')
    .option('--tf <tf>', 'timeframe, overrides config')
    .option('--backfill <n>', 'trade through the last n history bars before going live', (v) => Number(v))
    .option('--every <interval>', 'also run a cycle on a timer, e.g. 1h or 30m')
    .option('--quiet', 'do not print every episode')
    .action(async (o: { paper?: boolean; live?: boolean; assets?: string; tf?: string; backfill?: number; every?: string; quiet?: boolean }) => {
      const g = program.opts<{ config?: string }>();
      const cfg = await loadConfig(g.config);
      if (o.live) {
        if (cfg.executor === 'paper') throw new Error('--live needs an executor plugin in the config; executor is "paper"');
        if (!cfg.guards?.requireApproval) throw new Error('--live requires guards.requireApproval: true in the config');
      } else {
        cfg.executor = 'paper';
        cfg.guards = { ...(cfg.guards ?? {}), requireApproval: cfg.guards?.requireApproval ?? false };
      }
      if (o.assets) cfg.assets = o.assets.split(',').map((s) => s.trim()).filter(Boolean);
      if (o.tf) cfg.tf = o.tf;
      if (o.backfill !== undefined && Number.isFinite(o.backfill)) cfg.backfill = o.backfill;
      const loop = createLoop(cfg);
      attachLogging(loop, !o.quiet);
      console.log(`${OURO_NAME} ${o.live ? 'LIVE' : 'paper'} run: ${cfg.assets.join(', ')} ${cfg.tf}; goal: ${cfg.goal}`);
      const shutdown = () => {
        console.log(`\n[${stamp()}] stopping`);
        loop
          .stop()
          .then(() => loop.close())
          .finally(() => process.exit(0));
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      await loop.start(o.every ? { every: o.every } : {});
      await loop.close();
    });

  program
    .command('start')
    .description('same as run, with a timer that also cycles every interval')
    .requiredOption('--every <interval>', 'e.g. 1h, 30m')
    .option('--paper', 'use the built-in paper executor (default)')
    .option('--live', 'use the executor plugin from the config')
    .option('--quiet', 'do not print every episode')
    .action(async (o: { every: string; paper?: boolean; live?: boolean; quiet?: boolean }) => {
      const g = program.opts<{ config?: string }>();
      await program.parseAsync(
        [...(g.config ? ['--config', g.config] : []), 'run', '--every', o.every, ...(o.live ? ['--live'] : ['--paper']), ...(o.quiet ? ['--quiet'] : [])],
        { from: 'user' },
      );
    });

  program
    .command('cycle')
    .description('run one improvement cycle on the recorded episodes')
    .action(async () => {
      await withLoop(program.opts(), async (loop) => {
        attachLogging(loop, false);
        const r = await loop.cycle();
        console.log(cycleSummary(r));
        console.log(populationTable(await loop.population()));
      });
    });

  program
    .command('population')
    .description('print the live population')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }) => {
      await withLoop(program.opts(), async (loop) => {
        const p = await loop.population();
        console.log(o.json ? JSON.stringify(p, null, 2) : populationTable(p));
      });
    });

  program
    .command('history')
    .description('every strategy ever generated and every cycle')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }) => {
      await withLoop(program.opts(), async (loop) => {
        const h = await loop.history();
        if (o.json) {
          console.log(JSON.stringify(h, null, 2));
          return;
        }
        console.log(`${h.strategies.length} strategies, ${h.cycles.length} cycles\n`);
        const rows = h.strategies.map((s) => `${s.id.padEnd(8)} ${s.origin.padEnd(10)} born ${String(s.cycleBorn).padEnd(3)} ${s.status.padEnd(11)} holdout ${signed(s.trial?.holdoutScore, 4).padEnd(8)} ci ${signed(s.ci).padEnd(6)} ${(s.describe ?? '').slice(0, 70)}`);
        console.log(rows.join('\n'));
        console.log('');
        for (const c of h.cycles) console.log(cycleSummary(c));
      });
    });

  program
    .command('explain <id>')
    .description('plain-language summary of what a strategy does and why it exists')
    .action(async (id: string) => {
      await withLoop(program.opts(), async (loop) => console.log(await loop.explain(id)));
    });

  program
    .command('rollback <cycle>')
    .description('restore the population as it was at the end of a cycle')
    .action(async (cycle: string) => {
      await withLoop(program.opts(), async (loop) => {
        const r = await loop.rollback(Number(cycle));
        console.log(`restored: ${r.restored.join(', ') || 'none'}\nrolled back: ${r.rolledBack.join(', ') || 'none'}`);
        console.log(populationTable(await loop.population()));
      });
    });

  program
    .command('approve <cycle>')
    .description('apply a pending cycle')
    .action(async (cycle: string) => {
      await withLoop(program.opts(), async (loop) => {
        const r = await loop.approve(Number(cycle));
        console.log(cycleSummary(r));
      });
    });

  program
    .command('reject <cycle>')
    .description('discard a pending cycle')
    .action(async (cycle: string) => {
      await withLoop(program.opts(), async (loop) => {
        const r = await loop.reject(Number(cycle));
        console.log(cycleSummary(r));
      });
    });

  program
    .command('takeoff')
    .description('print the takeoff curve: population CI, best CI and velocity per cycle')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }) => {
      const g = program.opts<{ config?: string }>();
      let rows: TakeoffRow[];
      try {
        const cfg = await loadConfig(g.config);
        rows = readTakeoff(path.resolve(cfg.dir ?? OURO_DIR));
        if (!rows.length) {
          const loop = createLoop(cfg);
          rows = takeoffOf((await loop.history()).cycles);
          await loop.close();
        }
      } catch {
        rows = readTakeoff(path.resolve(OURO_DIR));
      }
      console.log(o.json ? JSON.stringify(rows, null, 2) : formatTakeoff(rows));
    });

  program
    .command('export')
    .description('write ouro.json = { population, history, takeoff, goal, createdAt }')
    .option('-o, --out <file>', 'output file', 'ouro.json')
    .action(async (o: { out: string }) => {
      await withLoop(program.opts(), async (loop, cfg) => {
        const population = await loop.population();
        const history = await loop.history();
        const takeoff = await loop.takeoff();
        const createdAt = history.cycles[0]?.ts ?? Date.now();
        const out = { name: OURO_NAME, goal: cfg.goal, createdAt, population, history, takeoff };
        fs.writeFileSync(o.out, JSON.stringify(out, null, 2));
        console.log(`wrote ${o.out}: ${population.length} live, ${history.strategies.length} total strategies, ${takeoff.length} cycles`);
      });
    });

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  loadEnv();
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

const invokedDirectly = (() => {
  try {
    const arg = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    return /cli\.(js|ts|mjs)$/.test(arg) || /[\\/]ouro(\.cmd|\.ps1)?$/.test(process.argv[1] ?? '');
  } catch {
    return false;
  }
})();

if (invokedDirectly) void main();
