/**
 * Canonical form for exports and hashing: object keys sorted at every level, arrays kept in order,
 * undefined values dropped, numbers as JSON gives them. Two equal exports produce byte-equal JSON.
 */
export function canonical<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => canonical(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = canonical(v);
    }
    return out as T;
  }
  return value;
}

/** Canonical JSON text: sorted keys, no whitespace. The ledger hashes this. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/** The export schema version this SDK writes. Bump when the shape changes in a way readers must know about. */
export const EXPORT_SCHEMA_VERSION = 1 as const;
