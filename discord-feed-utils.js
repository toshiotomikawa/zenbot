/**
 * Helpers shared by surfaces that are not a feed publisher.
 * GitHub events use the rate limiter. This module does not publish.
 */

export function createRateLimiter({
  windowMs = 60_000,
  maxPerIp = 60,
  maxGlobal = 120,
} = {}) {
  /** @type {Map<string, number[]>} */
  const buckets = new Map();
  /** @type {number[]} */
  let globalHits = [];

  function prune(arr, now) {
    const cutoff = now - windowMs;
    let i = 0;
    while (i < arr.length && arr[i] < cutoff) i += 1;
    return i > 0 ? arr.slice(i) : arr;
  }

  return {
    /**
     * @param {string} ip
     * @returns {{ allowed: boolean, retryAfterMs?: number }}
     */
    check(ip) {
      const now = Date.now();
      globalHits = prune(globalHits, now);
      if (globalHits.length >= maxGlobal) {
        return { allowed: false, retryAfterMs: windowMs - (now - globalHits[0]) };
      }
      const key = ip || 'unknown';
      let hits = prune(buckets.get(key) ?? [], now);
      if (hits.length >= maxPerIp) {
        buckets.set(key, hits);
        return { allowed: false, retryAfterMs: windowMs - (now - hits[0]) };
      }
      hits = [...hits, now];
      buckets.set(key, hits);
      globalHits = [...globalHits, now];
      return { allowed: true };
    },
    /** Test helper */
    reset() {
      buckets.clear();
      globalHits = [];
    },
  };
}

/**
 * AbortSignal that fires after `ms`. Uses AbortSignal.timeout when available.
 * @returns {AbortSignal}
 */
export function createTimeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
  return controller.signal;
}
