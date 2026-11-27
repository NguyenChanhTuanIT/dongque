// Token buckets keyed by an identity (account uid, IP…) rather than by
// connection, so closing and reopening a tab, or opening more tabs, does not
// hand out a fresh budget.

/**
 * @param {object} options
 * @param {number} options.burst     Tokens a full bucket holds.
 * @param {number} options.refillMs  One token comes back every refillMs.
 * @param {number} [options.idleMs]  Buckets unused this long are dropped by sweep() (default 10 min).
 */
export function createBuckets({ burst, refillMs, idleMs = 10 * 60_000 }) {
  /** @type {Map<string, { tokens: number, at: number, seen: number }>} */
  const buckets = new Map();

  /**
   * The bucket of `key`, refilled up to `now`. `scale` (≥ 1) grows the budget
   * for keys shared by several people (an IP): scale × burst, scale × faster.
   */
  function bucket(key, now, scale = 1) {
    const s = Math.max(1, scale);
    const cap = Math.round(burst * s);
    const every = refillMs / s;
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: cap, at: now, seen: now };
      buckets.set(key, b);
    }
    const refills = Math.floor((now - b.at) / every);
    if (refills > 0) {
      b.tokens = Math.min(cap, b.tokens + refills);
      b.at = b.tokens >= cap ? now : b.at + refills * every;
    }
    b.seen = now;
    return b;
  }

  return {
    /** Whether `key` has a token left (nothing is taken). */
    has(key, now = Date.now(), scale = 1) {
      return bucket(key, now, scale).tokens > 0;
    },
    /** Take one token; false when the bucket is empty. */
    take(key, now = Date.now(), scale = 1) {
      const b = bucket(key, now, scale);
      if (b.tokens <= 0) return false;
      b.tokens--;
      return true;
    },
    /** Forget buckets nobody used for idleMs (they would be full anyway). */
    sweep(now = Date.now()) {
      for (const [key, b] of buckets) if (now - b.seen > idleMs) buckets.delete(key);
    },
  };
}
