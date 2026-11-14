import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { SearchHit, SearchProvider } from "./types.ts";
import { canonicalUrl, matchesDomains, normalizeQuery, validDay } from "./validate.ts";

const RESULTS = 5;
const EXCERPT_CHARS = 2500;
const MAX_RESPONSE_BYTES = 2_000_000;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

export interface ExaOptions {

  fetch?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
}

export function createExaSearch(apiKey: string, options: ExaOptions = {}): SearchProvider {
  const http = options.fetch ?? fetch;
  return {
    async search(input, callerSignal) {
      callerSignal?.throwIfAborted();
      const query = normalizeQuery(input);
      const deadline = AbortSignal.timeout(options.timeoutMs ?? 20_000);
      const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
      const method = query.urls ? "contents" : "search";
      const freshness = query.asOf
        ? { snapshotAsOf: query.asOf.toISOString() }
        : { maxAgeHours: query.freshness === "fresh" ? 0 : 24 };
      const contents = {
        highlights: { maxCharacters: EXCERPT_CHARS, ...(query.urls ? { query: query.query } : {}) },
        ...freshness,
      };
      const body = query.urls ? { ids: query.urls, ...contents } : {
        query: query.query, type: "auto", numResults: RESULTS,
        startPublishedDate: query.publishedAfter ? `${query.publishedAfter}T00:00:00.000Z` : undefined,
        endPublishedDate: query.asOf?.toISOString() ?? (query.publishedBefore ? `${query.publishedBefore}T23:59:59.999Z` : undefined), includeDomains: query.domains, contents,
      };
      let response: Response | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted();
        try {
          response = await http(`https://api.exa.ai/${method}`, {
            method: "POST", headers: { "content-type": "application/json", "x-api-key": apiKey },
            body: JSON.stringify(body), signal,
          });
        } catch (error) {
          signal.throwIfAborted();
          if (attempt) throw new Error("Exa network request failed.", { cause: error });
          await delay(options.retryDelayMs ?? 200, undefined, { signal });
          continue;
        }
        if (response.ok) break;
        await response.body?.cancel();

        if (attempt || !RETRYABLE.has(response.status)) throw new Error(`Exa responded ${response.status}.`);
        const header = response.headers.get("retry-after");
        const retryMs = header === null ? options.retryDelayMs ?? 200 :
          /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Math.max(0, Date.parse(header) - Date.now());

        if (!Number.isFinite(retryMs) || retryMs > 2000) throw new Error(`Exa responded ${response.status}; retry later.`);
        await delay(retryMs, undefined, { signal });
      }
      if (!response?.ok) throw new Error("Exa request failed.");
      const data = object(await readJson(response));
      signal.throwIfAborted();
      if (!Array.isArray(data.results)) throw new Error("Exa returned an invalid results payload.");

      if ([...(Array.isArray(data.warnings) ? data.warnings : []), ...(Array.isArray(data.notices) ? data.notices : [])]
        .some(item => ["IGNORED_FIELD", "RESTRICTIONS_RELAXED"].includes(String(object(item).code)))) {
        throw new Error("Exa could not honor the requested retrieval policy.");
      }
      const failed = new Set((Array.isArray(data.statuses) ? data.statuses : [])
        .filter(item => object(item).status !== "success").map(item => object(item).id));
      const retrievedAt = new Date().toISOString();
      const hits: SearchHit[] = [];
      const seen = new Set<string>();
      for (const raw of data.results) {
        const result = object(raw);
        if (failed.has(result.id) || failed.has(result.url)) continue;
        let url: string;
        try { url = canonicalUrl(String(result.url)); } catch { continue; }
        if (seen.has(url) || !matchesDomains(url, query.domains)) continue;
        const published = string(result.publishedDate);
        const publishedDate = published && validDay(published.slice(0, 10)) ? published.slice(0, 10) : undefined;
        if (query.publishedAfter && (!publishedDate || publishedDate < query.publishedAfter)) continue;
        if (query.asOf && publishedDate && publishedDate > query.asOf.toISOString().slice(0, 10)) continue;
        if (query.asOf && published && published.length > 10 && Date.parse(published) > query.asOf.getTime()) continue;
        const highlights = Array.isArray(result.highlights) ? result.highlights.filter((x): x is string => typeof x === "string") : [];
        const text = (highlights.length ? highlights.join(" … ") : string(result.text) ?? "").replaceAll("\0", "").slice(0, EXCERPT_CHARS).trim();
        if (!text) continue;
        seen.add(url);
        hits.push({
          url, title: (string(result.title) || url).slice(0, 300), publishedDate, text,
          provider: "exa", method, retrievedAt, snapshotAsOf: query.asOf?.toISOString(),
          requestId: string(data.requestId) ?? response.headers.get("x-request-id") ?? undefined,
          contentHash: createHash("sha256").update(text).digest("hex"),
        });
        if (hits.length === RESULTS) break;
      }
      return hits;
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Exa returned an empty body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Exa response exceeded the size limit.");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new Error("Could not read Exa evidence.", { cause: error });
  } finally { reader.releaseLock(); }
}
