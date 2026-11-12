/**
 * Web search: the agent's one tool.
 *
 * Exa is used because a single request returns the relevant passages of each
 * page (no second fetch-and-scrape step, which is where search agents lose
 * their seconds) and because it can filter by publication date, which is what
 * "has anything changed since Monday?" needs.
 */

export interface SearchQuery {
  query: string;
  /** YYYY-MM-DD. Only pages published after this day. */
  publishedAfter?: string;
  /** Restrict to these domains, e.g. an official pricing site. */
  domains?: string[];
  /** Set when the clock is simulated: search the web as it stood at this moment. */
  asOf?: Date;
}

export interface SearchHit {
  url: string;
  title: string;
  /** YYYY-MM-DD, when the page states or implies one. */
  publishedDate?: string;
  text: string;
}

export interface SearchProvider {
  search(query: SearchQuery, signal?: AbortSignal): Promise<SearchHit[]>;
}

const RESULTS_PER_QUERY = 5;
const EXCERPT_CHARS = 1500;
const TIMEOUT_MS = 12_000;
/** Pages cached longer ago than this are re-fetched, so a price read today is today's price. */
const MAX_PAGE_AGE_HOURS = 24;

interface ExaResult {
  url: string;
  title?: string;
  publishedDate?: string;
  highlights?: string[];
  text?: string;
}

export function createExaSearch(apiKey: string): SearchProvider {
  return {
    async search({ query, publishedAfter, domains, asOf }, signal) {
      const body = {
        query,
        type: "auto",
        numResults: RESULTS_PER_QUERY,
        startPublishedDate: publishedAfter ? `${publishedAfter}T00:00:00.000Z` : undefined,
        includeDomains: domains?.length ? domains : undefined,
        // A simulated clock should not see pages from its own future.
        endPublishedDate: asOf?.toISOString(),
        contents: {
          highlights: { maxCharacters: EXCERPT_CHARS },
          ...(asOf ? { snapshotAsOf: asOf.toISOString() } : { maxAgeHours: MAX_PAGE_AGE_HOURS }),
        },
      };

      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const response = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        throw new Error(`Exa responded ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }

      const data = (await response.json()) as { results?: ExaResult[] };
      return (data.results ?? []).map((r) => ({
        url: r.url,
        title: r.title || r.url,
        publishedDate: r.publishedDate?.slice(0, 10),
        text: r.highlights?.length ? r.highlights.join(" … ") : (r.text ?? "").slice(0, EXCERPT_CHARS),
      }));
    },
  };
}

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
