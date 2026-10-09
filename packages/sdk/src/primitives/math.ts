/** Indicator math over plain number arrays. NaN marks "not enough data yet". */

export function sma(src: number[], n: number): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i]!;
    if (i >= n) sum -= src[i - n]!;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(src: number[], n: number): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  const k = 2 / (n + 1);
  let prev = NaN;
  let seedSum = 0;
  let seen = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i]!;
    if (Number.isNaN(v)) continue;
    seen++;
    if (seen < n) {
      seedSum += v;
      continue;
    }
    if (seen === n) {
      seedSum += v;
      prev = seedSum / n;
    } else {
      prev = v * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing (RMA). */
export function rma(src: number[], n: number): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  let prev = NaN;
  let seedSum = 0;
  let count = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i]!;
    if (Number.isNaN(v)) continue;
    count++;
    if (count < n) {
      seedSum += v;
      continue;
    }
    if (count === n) {
      seedSum += v;
      prev = seedSum / n;
    } else {
      prev = (prev * (n - 1) + v) / n;
    }
    out[i] = prev;
  }
  return out;
}

export function wma(src: number[], n: number): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  const denom = (n * (n + 1)) / 2;
  for (let i = n - 1; i < src.length; i++) {
    let acc = 0;
    let ok = true;
    for (let j = 0; j < n; j++) {
      const v = src[i - j]!;
      if (Number.isNaN(v)) {
        ok = false;
        break;
      }
      acc += v * (n - j);
    }
    if (ok) out[i] = acc / denom;
  }
  return out;
}

export function hull(src: number[], n: number): number[] {
  const half = Math.max(1, Math.round(n / 2));
  const root = Math.max(1, Math.round(Math.sqrt(n)));
  const a = wma(src, half);
  const b = wma(src, n);
  const diff = src.map((_, i) => (Number.isNaN(a[i]!) || Number.isNaN(b[i]!) ? NaN : 2 * a[i]! - b[i]!));
  return wma(diff, root);
}

export function rsi(close: number[], n: number): number[] {
  const gains = new Array<number>(close.length).fill(NaN);
  const losses = new Array<number>(close.length).fill(NaN);
  for (let i = 1; i < close.length; i++) {
    const d = close[i]! - close[i - 1]!;
    gains[i] = Math.max(d, 0);
    losses[i] = Math.max(-d, 0);
  }
  const ag = rma(gains, n);
  const al = rma(losses, n);
  return close.map((_, i) => {
    const g = ag[i]!;
    const l = al[i]!;
    if (Number.isNaN(g) || Number.isNaN(l)) return NaN;
    if (l === 0) return 100;
    return 100 - 100 / (1 + g / l);
  });
}

export function trueRange(h: number[], l: number[], c: number[]): number[] {
  return h.map((_, i) => {
    if (i === 0) return h[0]! - l[0]!;
    const pc = c[i - 1]!;
    return Math.max(h[i]! - l[i]!, Math.abs(h[i]! - pc), Math.abs(l[i]! - pc));
  });
}

export function atr(h: number[], l: number[], c: number[], n: number): number[] {
  return rma(trueRange(h, l, c), n);
}

export function adx(h: number[], l: number[], c: number[], n: number): number[] {
  const len = h.length;
  const plusDM = new Array<number>(len).fill(NaN);
  const minusDM = new Array<number>(len).fill(NaN);
  for (let i = 1; i < len; i++) {
    const up = h[i]! - h[i - 1]!;
    const down = l[i - 1]! - l[i]!;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const tr = trueRange(h, l, c);
  tr[0] = NaN;
  const atrS = rma(tr, n);
  const pS = rma(plusDM, n);
  const mS = rma(minusDM, n);
  const dx = new Array<number>(len).fill(NaN);
  for (let i = 0; i < len; i++) {
    const a = atrS[i]!;
    if (Number.isNaN(a) || a === 0) continue;
    const pdi = (100 * pS[i]!) / a;
    const mdi = (100 * mS[i]!) / a;
    const sum = pdi + mdi;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum;
  }
  return rma(dx, n);
}

export function stdev(src: number[], n: number): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  for (let i = n - 1; i < src.length; i++) {
    let mean = 0;
    for (let j = 0; j < n; j++) mean += src[i - j]!;
    mean /= n;
    let v = 0;
    for (let j = 0; j < n; j++) v += (src[i - j]! - mean) ** 2;
    out[i] = Math.sqrt(v / n);
  }
  return out;
}

export function bbWidth(close: number[], n: number, mult = 2): number[] {
  const m = sma(close, n);
  const s = stdev(close, n);
  return close.map((_, i) => {
    if (Number.isNaN(m[i]!) || Number.isNaN(s[i]!) || m[i] === 0) return NaN;
    return (2 * mult * s[i]!) / m[i]!;
  });
}

/**
 * QQE (Quantitative Qualitative Estimation). Returns the smoothed RSI (centred on 0) and its trailing line.
 * crossUp happens when the smoothed RSI crosses above the trailing line.
 */
export function qqe(close: number[], n: number, smooth = 5, factor = 4.236): { value: number[]; trail: number[] } {
  const r = rsi(close, n);
  const rsiMa = ema(r, smooth);
  const wilders = 2 * n - 1;
  const absDiff = rsiMa.map((v, i) =>
    i === 0 || Number.isNaN(v) || Number.isNaN(rsiMa[i - 1]!) ? NaN : Math.abs(v - rsiMa[i - 1]!),
  );
  const dar = rma(rma(absDiff, wilders), wilders).map((v) => (Number.isNaN(v) ? NaN : v * factor));
  const trail = new Array<number>(close.length).fill(NaN);
  let longBand = NaN;
  let shortBand = NaN;
  let trend = 0;
  for (let i = 0; i < close.length; i++) {
    const v = rsiMa[i]!;
    const d = dar[i]!;
    if (Number.isNaN(v) || Number.isNaN(d)) continue;
    const newLong = v - d;
    const newShort = v + d;
    const prev = rsiMa[i - 1] ?? NaN;
    const pl = longBand;
    const ps = shortBand;
    longBand = !Number.isNaN(prev) && !Number.isNaN(pl) && prev > pl && v > pl ? Math.max(pl, newLong) : newLong;
    shortBand = !Number.isNaN(prev) && !Number.isNaN(ps) && prev < ps && v < ps ? Math.min(ps, newShort) : newShort;
    if (!Number.isNaN(ps) && v > ps) trend = 1;
    else if (!Number.isNaN(pl) && v < pl) trend = -1;
    trail[i] = trend === 1 ? longBand : shortBand;
  }
  return {
    value: rsiMa.map((v) => (Number.isNaN(v) ? NaN : v - 50)),
    trail: trail.map((v) => (Number.isNaN(v) ? NaN : v - 50)),
  };
}

export function crossUp(a: number[], b: number[], i: number): boolean | null {
  if (i < 1) return null;
  const a0 = a[i]!;
  const a1 = a[i - 1]!;
  const b0 = b[i]!;
  const b1 = b[i - 1]!;
  if ([a0, a1, b0, b1].some((v) => Number.isNaN(v))) return null;
  return a1 <= b1 && a0 > b0;
}

export function crossDown(a: number[], b: number[], i: number): boolean | null {
  if (i < 1) return null;
  const a0 = a[i]!;
  const a1 = a[i - 1]!;
  const b0 = b[i]!;
  const b1 = b[i - 1]!;
  if ([a0, a1, b0, b1].some((v) => Number.isNaN(v))) return null;
  return a1 >= b1 && a0 < b0;
}

export function nz(v: number | undefined): number | null {
  return v === undefined || Number.isNaN(v) || !Number.isFinite(v) ? null : v;
}
