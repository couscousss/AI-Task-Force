import { describe, expect, it } from 'vitest';
import { createRng } from '../src/grouping/prng';

function take(seed: number, n: number): number[] {
  const rng = createRng(seed);
  return Array.from({ length: n }, () => rng.next());
}

describe('createRng', () => {
  it('produces the same stream for the same seed', () => {
    expect(take(12345, 20)).toEqual(take(12345, 20));
  });

  it('produces a different stream for a different seed', () => {
    expect(take(1, 20)).not.toEqual(take(2, 20));
  });

  it('stays inside [0, 1)', () => {
    for (const v of take(99, 500)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('normalises seeds so a stored run id round-trips', () => {
    expect(take(7, 5)).toEqual(take(7.9, 5));
    expect(() => createRng(Number.NaN).next()).not.toThrow();
    expect(createRng(-1).next()).toBeGreaterThanOrEqual(0);
  });

  it('int() covers [0, max) and never returns the bound', () => {
    const rng = createRng(4);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = rng.int(5);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(5);
      seen.add(v);
    }
    expect(seen.size).toBe(5);
  });

  it('int() treats a non-positive bound as 0 rather than producing NaN', () => {
    const rng = createRng(4);
    expect(rng.int(0)).toBe(0);
    expect(rng.int(-3)).toBe(0);
    expect(rng.int(Number.NaN)).toBe(0);
  });

  it('shuffle() permutes without mutating and stays deterministic', () => {
    const input = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const once = createRng(2024).shuffle(input);
    const twice = createRng(2024).shuffle(input);
    expect(once).toEqual(twice);
    expect(input).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect([...once].sort()).toEqual([...input].sort());
  });

  it('shuffle() actually reorders a reasonable list', () => {
    const input = Array.from({ length: 30 }, (_, i) => i);
    expect(createRng(31).shuffle(input)).not.toEqual(input);
  });
});
