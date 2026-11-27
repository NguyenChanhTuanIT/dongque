// Interest management for crowded rooms: each player only receives the
// states of the `k` players nearest to them (the game draws at most 128
// characters, src/engine/characters.ts MAX_CHARS). Everyone still shares one
// world; far players simply are not sent.
//
// Brute force with a selection instead of a full sort: O(n) per receiver, so
// O(n²) per refresh. For a thousand or two players refreshed twice a second
// that is a few million cheap operations per second.

/** Players already in view count this much closer (squared): no flicker at the edge. */
const KEEP_BONUS = 0.8;

/**
 * The `k` players nearest to `me` among `players` (with a state, not `me`).
 * `wasVisible` (the previous result) keeps players at the edge in view.
 * @template {{ x: number, z: number, state: unknown }} P
 * @param {P} me
 * @param {Iterable<P>} players
 * @param {number} k
 * @param {Set<P> | null} [wasVisible]
 * @param {number} [maxDistance]  0 = any distance
 * @returns {Set<P>}
 */
export function nearest(me, players, k, wasVisible = null, maxDistance = 0) {
  const others = [];
  const dist = [];
  const max2 = maxDistance ? maxDistance * maxDistance : Infinity;
  for (const p of players) {
    if (p === me || !p.state) continue;
    const dx = p.x - me.x;
    const dz = p.z - me.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > max2) continue;
    others.push(p);
    dist.push(wasVisible?.has(p) ? d2 * KEEP_BONUS : d2);
  }
  if (others.length <= k) return new Set(others);
  const limit = kthSmallest(Float64Array.from(dist), k - 1);
  const out = new Set();
  // Strictly closer first, then ties up to k.
  for (let i = 0; i < others.length; i++) if (dist[i] < limit) out.add(others[i]);
  for (let i = 0; i < others.length && out.size < k; i++) if (dist[i] === limit) out.add(others[i]);
  return out;
}

/** Value of rank `n` (0-based) in `a` (reordered in place): quickselect. */
function kthSmallest(a, n) {
  let lo = 0;
  let hi = a.length - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i++;
        j--;
      }
    }
    if (n <= j) hi = j;
    else if (n >= i) lo = i;
    else return a[n];
  }
  return a[n];
}
