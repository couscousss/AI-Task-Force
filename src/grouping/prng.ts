/**
 * mulberry32, written out rather than pulled in as a dependency so the exact bit
 * sequence is pinned to this file. A seed stored on a run has to reproduce that run
 * byte-for-byte weeks later, which is only true if the generator never changes.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). Returns 0 for a non-positive bound. */
  int(maxExclusive: number): number;
  /** Fisher-Yates into a new array. The input is left untouched. */
  shuffle<T>(items: readonly T[]): T[];
}

export function createRng(seed: number): Rng {
  // Any finite number is accepted so a run seed can be stored as a plain INTEGER.
  let state = (Number.isFinite(seed) ? Math.trunc(seed) : 0) >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (maxExclusive: number): number => {
    if (!Number.isFinite(maxExclusive) || maxExclusive <= 0) return 0;
    return Math.floor(next() * maxExclusive) % Math.floor(maxExclusive);
  };

  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(i + 1);
      const a = out[i]!;
      const b = out[j]!;
      out[i] = b;
      out[j] = a;
    }
    return out;
  };

  return { next, int, shuffle };
}
