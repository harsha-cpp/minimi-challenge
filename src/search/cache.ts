import type { SearchHit, SearchProvider } from "./types.ts";
import { normalizeQuery } from "./validate.ts";

/** Bounded LRU + single-flight. Each subscriber owns its own cancellation. */
export function withCache(provider: SearchProvider, ttlMs = 300_000, maxEntries = 256): SearchProvider {
  const cache = new Map<string, { until: number; hits: SearchHit[] }>();
  const pending = new Map<string, { controller: AbortController; result: Promise<SearchHit[]>; users: number }>();
  return {
    async search(input, signal) {
      signal?.throwIfAborted();
      const query = normalizeQuery(input);
      const key = JSON.stringify([query.query, query.publishedAfter, query.publishedBefore, query.domains, query.urls, query.asOf?.toISOString(), query.freshness]);
      const cached = cache.get(key);
      if (cached) {
        cache.delete(key);
        if (cached.until > Date.now() && query.freshness !== "fresh") {
          cache.set(key, cached);
          return structuredClone(cached.hits);
        }
      }
      let flight = pending.get(key);
      if (!flight) {
        const controller = new AbortController();
        const entry = { controller, result: Promise.resolve([] as SearchHit[]), users: 0 };
        entry.result = Promise.resolve().then(() => provider.search(query, controller.signal)).then(hits => {
          if (!controller.signal.aborted && hits.length && query.freshness !== "fresh" && maxEntries > 0) {
            cache.set(key, { until: Date.now() + ttlMs, hits: structuredClone(hits) });
            while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
          }
          return hits;
        }).finally(() => { if (pending.get(key) === entry) pending.delete(key); });
        pending.set(key, entry);
        flight = entry;
      }
      const entry = flight;
      entry.users++;
      return new Promise<SearchHit[]>((resolve, reject) => {
        let settled = false;
        const finish = (error: unknown, hits?: SearchHit[]) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", abort);
          entry.users--;
          if (!entry.users && pending.get(key) === entry) {
            pending.delete(key);
            entry.controller.abort();
          }
          if (hits) resolve(structuredClone(hits));
          else reject(error);
        };
        const abort = () => finish(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
        entry.result.then(hits => finish(undefined, hits), error => finish(error));
      });
    },
  };
}
