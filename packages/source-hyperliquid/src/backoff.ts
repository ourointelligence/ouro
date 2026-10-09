/** Exponential backoff with +-20% jitter: initial, 2x initial, 4x initial ... capped at max. `attempt` starts at 1. */
export function backoffDelay(attempt: number, initialMs: number, maxMs: number, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const base = Math.min(initialMs * 2 ** (n - 1), maxMs);
  const jitter = 1 + (random() * 0.4 - 0.2);
  return Math.max(0, Math.round(base * jitter));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}
