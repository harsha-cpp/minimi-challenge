import { createHash } from "node:crypto";
import type { SearchHit, SearchProvider, SearchQuery } from "../search.ts";
import { canonicalUrl, matchesDomains, normalizeQuery } from "../search/validate.ts";
import { isHistoricalEvidenceEligible } from "./eligibility.ts";
import type { TemporalStore } from "./store.ts";
import type { TemporalPassage } from "./types.ts";

const RESULT_LIMIT = 5;
const PASSAGE_CHARS = 2000;
const STOP_WORDS = new Set("a an and are as at be been before by can did do does for from had has have how i in into is it of on or our that the their then there these they this to was were what when where which who why will with would you your".split(" "));

/** An exact contiguous excerpt, selected without model-generated summaries or new facts. */
export function corpusPassage(text: string, query: string): string {
  if (text.length <= PASSAGE_CHARS) return text;
  const lowered = text.toLowerCase();
  const tokens = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].filter(token => !STOP_WORDS.has(token)).slice(0, 32);
  const starts = new Set([0]);
  for (const token of tokens) {
    let cursor = 0;
    // A repeated boilerplate word must not make extraction unbounded.
    for (let count = 0; count < 24; count++) {
      const found = lowered.indexOf(token, cursor);
      if (found < 0) break;
      starts.add(Math.max(0, Math.min(text.length - PASSAGE_CHARS, found - Math.floor(PASSAGE_CHARS / 4))));
      cursor = found + token.length;
    }
  }
  let start = 0;
  let best = -1;
  for (const candidate of [...starts].sort((a, b) => a - b)) {
    const window = lowered.slice(candidate, candidate + PASSAGE_CHARS);
    const score = tokens.reduce((total, token) => total + Number(window.includes(token)), 0);
    if (score > best) { start = candidate; best = score; }
  }
  // Prefer readable word boundaries while preserving a literal substring.
  if (start > 0 && !/\s/.test(text[start - 1]!)) {
    const boundary = text.slice(start, start + 80).search(/\s/);
    if (boundary >= 0) start += boundary + 1;
  }
  let end = Math.min(text.length, start + PASSAGE_CHARS);
  if (end < text.length && !/\s/.test(text[end]!)) {
    const tail = text.slice(Math.max(start, end - 80), end);
    const boundary = [...tail.matchAll(/\s/g)].at(-1)?.index;
    if (boundary !== undefined) end = Math.max(start, end - 80) + boundary;
  }
  return text.slice(start, end).trim();
}

function fromCorpus(passage: TemporalPassage, query: string): SearchHit {
  const text = corpusPassage(passage.text, query);
  return {
    url: passage.url,
    title: passage.title,
    text,
    publishedDate: passage.publishedAt?.slice(0, 10),
    provider: "corpus",
    contentHash: createHash("sha256").update(text).digest("hex"),
    retrievedAt: new Date().toISOString(),
    temporal: {
      documentId: passage.id,
      availableAt: passage.availableAt,
      recordedAt: passage.recordedAt,
      provenanceKind: passage.provenanceKind,
      provenanceUrl: passage.provenanceUrl,
      reviewed: passage.reviewed,
      capturedAt: passage.capturedAt,
    },
  };
}

function respectsFilters(hit: SearchHit, query: SearchQuery): boolean {
  try {
    const url = canonicalUrl(hit.url);
    return Boolean(hit.text.trim()) && matchesDomains(url, query.domains)
      && (!query.urls?.length || query.urls.includes(url))
      && (!query.publishedAfter || Boolean(hit.publishedDate && hit.publishedDate >= query.publishedAfter))
      && (!query.publishedBefore || Boolean(hit.publishedDate && hit.publishedDate <= query.publishedBefore));
  } catch { return false; }
}

function unique(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const distinct = hits.filter(hit => {
    const key = JSON.stringify([canonicalUrl(hit.url), createHash("sha256").update(hit.text).digest("hex")]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const results: SearchHit[] = [];
  const visited = new Set<string>();
  const captureKey = (hit: SearchHit) => hit.archive && JSON.stringify([hit.url, hit.archive.captureUrl, hit.archive.rawHash]);
  for (const hit of distinct) {
    const key = captureKey(hit);
    if (key && visited.has(key)) continue;
    if (key) visited.add(key);
    const group = key ? distinct.filter(candidate => captureKey(candidate) === key) : [hit];
    // Merging with local evidence must not remove the final chunks of an archive table.
    if (results.length + group.length <= RESULT_LIMIT) results.push(...group);
  }
  return results;
}

/** Exa remains the only web provider. A local corpus adds reviewed historical evidence. */
export function withHistoricalCorpus(exa: SearchProvider, corpus: Pick<TemporalStore, "search">): SearchProvider {
  return {
    async search(input, signal) {
      signal?.throwIfAborted();
      // Preserve the current-date Exa path, including freshness and cache behavior.
      if (!input.asOf) return exa.search(input, signal);
      const query = normalizeQuery(input);
      const cutoff = query.asOf!;
      const eligible = (hit: SearchHit) => respectsFilters(hit, query) && isHistoricalEvidenceEligible(hit, cutoff);
      const passages = corpus.search({
        query: query.query, asOf: cutoff, limit: RESULT_LIMIT,
        urls: query.urls, domains: query.domains, publishedAfter: query.publishedAfter,
      });
      signal?.throwIfAborted();
      // Verify the preserved version before extracting a smaller display passage.
      const intact = passages.filter(passage => createHash("sha256").update(passage.text).digest("hex") === passage.contentHash);
      const local = unique(intact.map(passage => fromCorpus(passage, query.query)).filter(eligible));
      if (local.length === RESULT_LIMIT) return local;
      try {
        const snapshots = await exa.search(query, signal);
        signal?.throwIfAborted();
        return unique([...local, ...snapshots.filter(eligible)]);
      } catch (error) {
        signal?.throwIfAborted();
        // Partial reviewed evidence remains useful. Missing evidence never becomes a live lookup.
        if (local.length) return local;
        throw error;
      }
    },
  };
}
