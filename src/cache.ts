import { glob, type Path } from "glob"
import NodeCache from "node-cache"

// ---- Path Cache ----
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

// ---- Glob Cache ----

/**
 * Cache for glob pattern matching results
 * Maps glob patterns to their matched file paths
 */
export const globPatternCache = new NodeCache({
  stdTTL: 300, // 5 minutes default TTL
  checkperiod: 120, // Check for expired items every 2 minutes
  useClones: false, // We want to share references, not clone values
})

/**
 * Cached version of the glob function that stores and reuses results
 *
 * The most significant performance improvements will be in watch mode with large directories, where the same glob patterns are evaluated repeatedly
 *
 * @param pattern - The glob pattern to match
 * @param options - Options for the glob matching
 * @param maxAge - Maximum age of cache entry in milliseconds (0 = no caching)
 * @returns Promise resolving to matched paths
 */
export async function cachedGlob(
  pattern: string,
  options: Parameters<typeof glob>[1] = {}
): Promise<string[] | Path[]> {
  const cacheKey = `glob:${pattern}:${JSON.stringify(options)}`

  // Check if we have a cached result
  const cached = globPatternCache.get<string[]>(cacheKey)
  if (cached) {
    return cached
  }

  // If not cached, perform the glob operation
  const results = await glob(pattern, options)

  // Cache the results with the specified TTL
  globPatternCache.set(cacheKey, results)

  return results
}

/**
 * Clear the glob pattern cache
 */
export function clearGlobCache(): void {
  globPatternCache.flushAll()
}

/**
 * Invalidate specific glob pattern cache entries
 *
 * @param pattern Optional pattern to match against cache keys, if omitted, all entries are removed
 */
export function invalidateGlobCache(pattern?: string): void {
  if (!pattern) {
    globPatternCache.flushAll()
    return
  }
  // Remove only entries matching the pattern
  const keys = globPatternCache.keys().filter((key) => key.includes(pattern))
  keys.forEach((key) => globPatternCache.del(key))
}
