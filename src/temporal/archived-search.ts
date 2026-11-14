import { createHash } from "node:crypto";
import type { SearchHit, SearchProvider, SearchQuery } from "../search.ts";
import { canonicalUrl, matchesDomains, normalizeQuery, validDay } from "../search/validate.ts";
import { parseInstant } from "../time/instant.ts";
import { captureArchive, type ArchiveCaptureResult } from "./archive.ts";

const PASSAGE_CHARS = 6000;
const TOTAL_CHARS = 20_000;
const RESULT_LIMIT = 5;
const MAX_SOURCE_CHARS = 200_000;
const CACHE_ENTRIES = 30;
const CACHE_MS = 5 * 60_000;
const STOP = new Set("a an and are as at be been before by can did do does each for from had has have how i in into is it list of on or that the their then there these they this to was were what when where which who why will with would year years you your".split(" "));

export interface ArchivedSearchOptions {
  capture?: typeof captureArchive;
  /** One to three candidates keep archive acquisition bounded. */
  maxCandidates?: number;
}

/** Exa discovers URLs; only preserved, pre-cutoff versions can become historical evidence. */
export function withArchivedSearch(exa: SearchProvider, options: ArchivedSearchOptions = {}): SearchProvider {
  const capture = options.capture ?? captureArchive;
  const maxCandidates = options.maxCandidates ?? 3;
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 3) throw new Error("Archive candidate limit must be 1 to 3.");
  const cache = new Map<string, { captured: ArchiveCaptureResult; expires: number }>();

  return {
    async search(input, signal) {
      signal?.throwIfAborted();
      if (!input.asOf) return exa.search(input, signal);
      const query = normalizeQuery(input);
      const cutoff = query.asOf!;
      const cutoffDay = cutoff.toISOString().slice(0, 10);
      const discoveryBefore = query.publishedBefore && query.publishedBefore < cutoffDay ? query.publishedBefore : cutoffDay;
      let snapshotFailure: unknown = new Error("No admissible historical evidence was available.");
      try {
        const hits = await abortable(exa.search(query, signal), signal);
        signal?.throwIfAborted();
        const snapshots = hits.filter(hit => !hit.temporal && !hit.archive && hit.snapshotAsOf === cutoff.toISOString() && respectsFilters(hit, query));
        if (snapshots.length) return snapshots.slice(0, RESULT_LIMIT);
      } catch (error) {
        signal?.throwIfAborted();
        if (!/^Exa responded 403\b/.test(message(error))) throw error;
        snapshotFailure = error;
      }

      let urls = query.urls;
      if (!urls) {
        const suffix = ` sources published before ${cutoff.toISOString().slice(0, 10)}`;
        try {
          // Publication text here is only a discovery hint. It cannot establish temporal eligibility.
          const discovery = await abortable(exa.search({ ...query, asOf: undefined, urls: undefined, publishedBefore: discoveryBefore,
            query: query.query.slice(0, 1000 - suffix.length) + suffix }, signal), signal);
          signal?.throwIfAborted();
          // Do not retain a live title, passage, publication date, or generated summary.
          urls = discovery.map(hit => hit.url);
        } catch {
          signal?.throwIfAborted();
          throw snapshotFailure;
        }
      }
      const candidates: string[] = [];
      for (const value of urls) {
        try {
          const url = canonicalUrl(value);
          if (!matchesDomains(url, query.domains) || candidates.includes(url)) continue;
          candidates.push(url);
          if (candidates.length === maxCandidates) break;
        } catch { /* Invalid discovery addresses never reach archive acquisition. */ }
      }
      if (!candidates.length) throw snapshotFailure;

      let next = 0;
      const captured: Array<ArchiveCaptureResult | undefined> = Array(candidates.length);
      await Promise.all(Array.from({ length: Math.min(2, candidates.length) }, async () => {
        while (next < candidates.length) {
          signal?.throwIfAborted();
          const index = next++;
          const url = candidates[index]!;
          const key = JSON.stringify([url, cutoff.toISOString()]);
          try {
            const saved = cache.get(key);
            if (saved && saved.expires > Date.now()) {
              cache.delete(key); cache.set(key, saved);
              captured[index] = structuredClone(saved.captured);
              continue;
            }
            cache.delete(key);
            const result = await abortable(capture({ url, asOf: cutoff, selector: "body", signal }), signal);
            signal?.throwIfAborted();
            if (!validCapture(result, url, cutoff)) continue;
            cache.set(key, { captured: structuredClone(result), expires: Date.now() + CACHE_MS });
            while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
            captured[index] = result;
          } catch {
            signal?.throwIfAborted();
            // Missing, denied and malformed archive captures are not live-page fallbacks.
          }
        }
      }));
      signal?.throwIfAborted();

      const results: SearchHit[] = [];
      let remaining = TOTAL_CHARS;
      for (let i = 0; i < captured.length; i++) {
        const result = captured[i];
        if (!result) continue;
        const { document } = result;
        const publishedDate = document.publishedAt?.slice(0, 10);
        if (query.publishedAfter && (!publishedDate || publishedDate < query.publishedAfter)) continue;
        if (query.publishedBefore && (!publishedDate || publishedDate > query.publishedBefore)) continue;
        const passages = archivePassages(document.text, query.query, result.tables);
        const chars = passages.reduce((total, text) => total + text.length, 0);
        // A complete table group is admitted together, including its final rows.
        if (!passages.length || chars > remaining || results.length + passages.length > RESULT_LIMIT) continue;
        const group = passages.map(text => ({ text, contentHash: createHash("sha256").update(text).digest("hex") }));
        for (const { text, contentHash } of group) {
          remaining -= text.length;
          results.push({
            url: candidates[i]!, title: document.title, text, provider: "wayback", publishedDate, contentHash,
            retrievedAt: new Date().toISOString(),
            archive: { provider: "wayback", capturedAt: document.capturedAt!, captureUrl: result.captureUrl,
              originalUrl: candidates[i]!, rawHash: result.rawHash },
          });
        }
      }
      if (!results.length) throw snapshotFailure;
      return results;
    },
  };
}

/** Complete relevant tables take priority over fragments of surrounding navigation. */
export function archivePassages(text: string, query: string, tables: string[] = []): string[] {
  const tokens = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].filter(token => !STOP.has(token))
    .map(token => token.length > 4 && token.endsWith("s") && !/(ss|us|is)$/.test(token) ? token.slice(0, -1) : token).slice(0, 32);
  const score = (value: string) => tokens.reduce((sum, token) => sum + Number(value.toLowerCase().includes(token)), 0);
  const eligibleTables = [...new Set(tables)].filter(table => table.trim() && text.includes(table) && score(table) > 0)
    .sort((a, b) => score(b) - score(a) || text.indexOf(a) - text.indexOf(b));
  if (eligibleTables.length) {
    const passages: string[] = [];
    for (const table of eligibleTables.slice(0, 2)) {
      const chunks = tablePassages(table);
      if (!chunks) return [];
      passages.push(...chunks);
    }
    // Never replace an oversized relevant table with a partial body excerpt.
    return passages.length <= RESULT_LIMIT && passages.reduce((sum, chunk) => sum + chunk.length, 0) <= TOTAL_CHARS ? passages : [];
  }
  return [contiguousPassage(text, tokens)];
}

function tablePassages(table: string): string[] | null {
  if (table.length > TOTAL_CHARS) return null;
  const passages: string[] = [];
  let start = 0;
  while (table.length - start > PASSAGE_CHARS) {
    const newline = table.lastIndexOf("\n", start + PASSAGE_CHARS - 1);
    if (newline < start) return null; // One indivisible row exceeds the passage budget.
    passages.push(table.slice(start, newline + 1));
    if (passages.length >= RESULT_LIMIT) return null;
    start = newline + 1;
  }
  if (start < table.length) passages.push(table.slice(start));
  return passages;
}

function contiguousPassage(text: string, tokens: string[]): string {
  if (text.length <= PASSAGE_CHARS) return text;
  const lower = text.toLowerCase();
  const starts = new Set([0]);
  for (const token of tokens) {
    let at = 0;
    for (let count = 0; count < 24; count++) {
      const found = lower.indexOf(token, at);
      if (found < 0) break;
      starts.add(Math.max(0, Math.min(text.length - PASSAGE_CHARS, found - 1000)));
      at = found + token.length;
    }
  }
  let best = 0, bestScore = -1;
  for (const start of [...starts].sort((a, b) => a - b)) {
    const window = lower.slice(start, start + PASSAGE_CHARS);
    const coverage = tokens.reduce((sum, token) => sum + Number(window.includes(token)), 0);
    if (coverage > bestScore) { best = start; bestScore = coverage; }
  }
  // Keep an exact contiguous slice; never splice a synthesized table or summary into evidence.
  return text.slice(best, best + PASSAGE_CHARS);
}

function validCapture(result: ArchiveCaptureResult, original: string, cutoff: Date): boolean {
  const doc = result?.document;
  if (!doc || doc.provenanceKind !== "archive" || typeof doc.text !== "string" || !doc.text.trim()
    || doc.text.length > MAX_SOURCE_CHARS || typeof doc.title !== "string" || !doc.title.trim() || doc.title.length > 500
    || !/^[a-f0-9]{64}$/.test(result.rawHash)) return false;
  const captured = doc.capturedAt && parseInstant(doc.capturedAt);
  const available = parseInstant(doc.availableAt);
  if (!captured || !available || captured.getTime() !== available.getTime() || captured.getTime() > cutoff.getTime()) return false;
  if (doc.publishedAt && (!parseInstant(doc.publishedAt) || Date.parse(doc.publishedAt) > captured.getTime())) return false;
  try {
    if (canonicalUrl(doc.url) !== original || doc.provenanceUrl !== result.captureUrl) return false;
    const url = new URL(result.captureUrl);
    if (url.origin !== "https://web.archive.org" || url.username || url.password || url.port || url.hash) return false;
    const match = /^\/web\/(\d{14})id_\/(https?:\/\/.+)$/.exec(url.pathname + url.search);
    return Boolean(match && match[1] === captured.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14) && canonicalUrl(match[2]!) === original);
  } catch { return false; }
}

function respectsFilters(hit: SearchHit, query: SearchQuery): boolean {
  try {
    return Boolean(hit.text.trim()) && matchesDomains(canonicalUrl(hit.url), query.domains)
      && (!query.urls || query.urls.includes(canonicalUrl(hit.url)))
      && (!hit.publishedDate || (validDay(hit.publishedDate) && hit.publishedDate <= query.asOf!.toISOString().slice(0, 10)))
      && (!query.publishedBefore || Boolean(hit.publishedDate && hit.publishedDate <= query.publishedBefore))
      && (!query.publishedAfter || Boolean(hit.publishedDate && hit.publishedDate >= query.publishedAfter));
  } catch { return false; }
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}
