import type { AnyProposal, Bounds, Episode, GuardConfig, ReplayResult, Scorer, Strategy } from './types.js';
import { SandboxError, type CompiledModule, type Sandbox } from './sandbox.js';
import { replay } from './trial.js';

export const DEFAULT_GUARDS: GuardConfig = {
  maxDrawdownPct: 8,
  maxPositionPct: 10,
  margin: 0.05,
  holdout: 0.3,
  requireApproval: false,
  maxProposalsPerCycle: 6,
};

/** Snap every param to [min, max] and to the step grid of its bounds. Keys without bounds pass through. */
export function clampParams(params: Record<string, number>, bounds: Bounds): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(params)) {
    const b = bounds[k];
    if (!b) {
      out[k] = v;
      continue;
    }
    let x = Math.min(Math.max(v, b.min), b.max);
    if (b.step > 0) {
      const steps = Math.round((x - b.min) / b.step);
      x = b.min + steps * b.step;
      x = Math.min(Math.max(x, b.min), b.max);
      // kill floating noise such as 0.30000000000000004
      const decimals = Math.min(12, Math.max(0, -Math.floor(Math.log10(b.step)) + 2));
      x = Number(x.toFixed(decimals));
    }
    out[k] = x;
  }
  return out;
}

/** Snap to the step grid only, leaving out-of-range values alone so they can be rejected. */
function snapToGrid(params: Record<string, number>, bounds: Bounds): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(params)) {
    const b = bounds[k];
    if (!b || !(b.step > 0)) {
      out[k] = v;
      continue;
    }
    const steps = Math.round((v - b.min) / b.step);
    const decimals = Math.min(12, Math.max(0, -Math.floor(Math.log10(b.step)) + 2));
    out[k] = Number((b.min + steps * b.step).toFixed(decimals));
  }
  return out;
}

export type GuardContext = {
  sandbox: Sandbox;
  scorer: Scorer;
  /** Episodes to replay for the risk checks. Empty skips the replay checks (seed time). */
  episodes: Episode[];
  /** Every feature key the registered packs can produce; unknown keys are rejected when given. */
  featureKeys?: string[];
  /** Parents of the proposal, used for the freeze check. */
  parents?: Strategy[];
  /** Isolate id to compile under; defaults to a temporary id. */
  id?: string;
  /** Replaces the episode replay for the risk checks (bar-level replay in 0.2.0). Runs when given, even with no episodes. */
  replayFn?: (strategy: { id: string; code: string; params: Record<string, number> }) => Promise<ReplayResult>;
};

export type GuardVerdict =
  | { ok: true; module: CompiledModule; params: Record<string, number>; replay: ReplayResult | null }
  | { ok: false; reason: string };

export function allowedFeatureKeys(allow: GuardConfig['allow']): Set<string> | null {
  if (!allow) return null;
  const set = new Set<string>();
  for (const keys of Object.values(allow)) for (const k of keys) set.add(k);
  return set;
}

/**
 * Check one proposal against every guard. Rejects with a reason string when:
 * the code fails the sandbox; a param is outside its own bounds or the user bounds; a frozen key changed;
 * a feature key is outside `allow`; replay drawdown exceeds maxDrawdownPct; any size exceeds maxPositionPct / 100.
 */
export async function check(proposal: AnyProposal, config: GuardConfig, ctx: GuardContext): Promise<GuardVerdict> {
  let module: CompiledModule;
  try {
    module = await ctx.sandbox.compile(proposal.code, ctx.id);
  } catch (err) {
    const msg = err instanceof SandboxError ? err.message : (err as Error).message;
    return { ok: false, reason: `sandbox: ${msg}` };
  }
  const cleanup = () => {
    if (!ctx.id) ctx.sandbox.dispose(module.id);
  };

  // params: the proposal's params override the module defaults; every key needs bounds
  const merged = { ...module.params, ...proposal.params };
  for (const [k, v] of Object.entries(merged)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      cleanup();
      return { ok: false, reason: `bounds: param "${k}" is not a finite number` };
    }
    const b = module.bounds[k];
    if (!b) {
      cleanup();
      return { ok: false, reason: `bounds: param "${k}" has no entry in bounds` };
    }
  }
  const params = snapToGrid(merged, module.bounds);
  for (const [k, v] of Object.entries(params)) {
    const b = module.bounds[k]!;
    if (v < b.min || v > b.max) {
      cleanup();
      return { ok: false, reason: `bounds: ${k}=${v} outside module bounds [${b.min}, ${b.max}]` };
    }
    const ub = config.bounds?.[k];
    if (ub && (v < ub.min || v > ub.max)) {
      cleanup();
      return { ok: false, reason: `bounds: ${k}=${v} outside user bounds [${ub.min}, ${ub.max}]` };
    }
  }

  // freeze: frozen keys must keep the value of the parent that has them
  if (config.freeze?.length && ctx.parents?.length) {
    for (const key of config.freeze) {
      const parent = ctx.parents.find((p) => key in p.params);
      if (!parent) continue;
      if (!(key in params)) {
        cleanup();
        return { ok: false, reason: `freeze: "${key}" was removed` };
      }
      if (params[key] !== parent.params[key]) {
        cleanup();
        return { ok: false, reason: `freeze: "${key}" changed from ${parent.params[key]} to ${params[key]}` };
      }
    }
  }

  // allow: every feature the code reads must be in the allow list
  const allowed = allowedFeatureKeys(config.allow);
  if (allowed) {
    for (const key of module.featureKeys) {
      if (!allowed.has(key)) {
        cleanup();
        return { ok: false, reason: `allow: feature "${key}" is not in the allow list` };
      }
    }
  }
  if (ctx.featureKeys) {
    const known = new Set(ctx.featureKeys);
    for (const key of module.featureKeys) {
      if (!known.has(key)) {
        cleanup();
        return { ok: false, reason: `unknown feature: "${key}" is not produced by any registered primitive pack` };
      }
    }
  }

  // risk: replay on the provided episodes
  let result: ReplayResult | null = null;
  if (ctx.replayFn || ctx.episodes.length) {
    try {
      const target = { id: module.id, code: proposal.code, params };
      result = ctx.replayFn ? await ctx.replayFn(target) : await replay(ctx.episodes, target, ctx.scorer, ctx.sandbox);
    } catch (err) {
      cleanup();
      return { ok: false, reason: `sandbox: ${(err as Error).message}` };
    }
    if (result.maxDrawdown > config.maxDrawdownPct) {
      cleanup();
      return { ok: false, reason: `drawdown: replay max drawdown ${result.maxDrawdown.toFixed(3)} exceeds ${config.maxDrawdownPct}` };
    }
    if (result.maxSize > config.maxPositionPct / 100) {
      cleanup();
      return { ok: false, reason: `size: position size ${result.maxSize} exceeds ${config.maxPositionPct}% cap` };
    }
  }
  return { ok: true, module, params, replay: result };
}

export function resolveGuards(partial?: Partial<GuardConfig>): GuardConfig {
  return { ...DEFAULT_GUARDS, ...(partial ?? {}) };
}
