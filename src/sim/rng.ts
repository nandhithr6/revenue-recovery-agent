/**
 * Deterministic RNG. Every result in this project must be reproducible from a
 * seed, otherwise strategy comparisons are noise and the numbers mean nothing.
 *
 * mulberry32: small, fast, good enough statistical quality for simulation.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Pick one element uniformly. Throws on an empty list, rather than returning undefined. */
  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error('Rng.pick called on an empty array');
    return item;
  }

  /**
   * Pick by weight. Weights need not sum to 1.
   * Throws on empty input or non-positive total weight.
   */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    if (entries.length === 0 || total <= 0) {
      throw new Error('Rng.weighted needs a non-empty list with positive total weight');
    }
    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll <= 0) return value;
    }
    // Floating point can leave a sliver; the last entry is the correct fallback.
    return entries[entries.length - 1]![0];
  }

  /**
   * Log-normal-ish positive value, for transaction amounts. Real payment
   * amounts are heavily right-skewed: many small, a few very large.
   */
  logNormal(medianValue: number, sigma: number): number {
    // Box-Muller for a standard normal.
    const u1 = Math.max(this.next(), Number.EPSILON);
    const u2 = this.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return medianValue * Math.exp(sigma * z);
  }
}
