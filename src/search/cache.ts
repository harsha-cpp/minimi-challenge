import type { SearchHit, SearchProvider } from "./types.ts";

/**
 * Repeated and concurrent identical queries share one request. The window is
 * short because the point of this agent is noticing that things changed.
 */
export function withCache(provider: SearchProvider, ttlMs = 5 * 60_000): SearchProvider {
  const cache = new Map<string, { at: number; hits: Promise<SearchHit[]> }>();
  return {
    search(query, signal) {
      const key = JSON.stringify([query.query, query.publishedAfter, query.domains, query.asOf?.toISOString().slice(0, 10)]);
      const cached = cache.get(key);
      if (cached && Date.now() - cached.at < ttlMs) return cached.hits;
      const hits = provider.search(query, signal);
      cache.set(key, { at: Date.now(), hits });
      hits.catch(() => cache.delete(key));
      return hits;
    },
  };
}
