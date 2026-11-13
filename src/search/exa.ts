import type { SearchProvider } from "./types.ts";

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

