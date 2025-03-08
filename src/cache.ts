import NodeCache from "node-cache"

// Create a cache for processed paths
// stdTTL: null means items won't expire based on time
// maxKeys: 10000 limits the cache size to prevent memory issues
/**
 * A cache for processed paths
 *
 * - stdTTL: '0' means items won't expire based on time
 * - maxKeys: 10000 limits the cache size to prevent memory issues
 */
export const pathCache = new NodeCache({
  stdTTL: 0,
  maxKeys: 10000,
  useClones: false,
})

/**
 * Clear the path processing cache
 * This can be useful in tests or when memory needs to be freed
 */
export function clearPathCache(): void {
  pathCache.flushAll()
}

/**
 * Get statistics about the path cache
 * This can be useful for debugging or monitoring
 */
export function getPathCacheStats() {
  return {
    keys: pathCache.keys().length,
    hits: pathCache.getStats().hits,
    misses: pathCache.getStats().misses,
    vsize: pathCache.getStats().vsize,
  }
}
