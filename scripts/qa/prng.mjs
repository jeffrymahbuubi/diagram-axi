// Seeded PRNG for the fuzzer. mulberry32 over a 32-bit seed; hash32 mixes (runSeed, index, ...) into a case seed.
// Pure and deterministic: the same seed always yields the same stream on every platform (integer math only).

/** FNV-1a over the string form of every part (separated by `|`), finished with the murmur3 avalanche. Unsigned 32-bit. */
export function hash32(...parts) {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const s = `${part}|`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32: returns a function giving floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rng helper over a seed: next, int(a, b) inclusive, pick, chance, shuffle (new array), weighted([[value, weight], ...]), range. */
export function makeRng(seed) {
  const next = mulberry32(seed);
  const rng = {
    next,
    int: (a, b) => a + Math.floor(next() * (b - a + 1)),
    range: ([a, b]) => a + Math.floor(next() * (b - a + 1)),
    float: (a, b) => a + next() * (b - a),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    shuffle: (arr) => {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    weighted: (pairs) => {
      const total = pairs.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [v, w] of pairs) {
        r -= w;
        if (r < 0) return v;
      }
      return pairs[pairs.length - 1][0];
    },
  };
  return rng;
}
