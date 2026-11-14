import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { SearchHit, SearchProvider, SearchQuery } from "../src/search.ts";
import { corpusPassage, withHistoricalCorpus } from "../src/temporal/retrieve.ts";
import type { TemporalPassage } from "../src/temporal/types.ts";

const cutoff = new Date("2025-01-13T18:05:11.994Z");
const passage = (overrides: Partial<TemporalPassage> = {}): TemporalPassage => ({
  id: "version-1", sourceId: "atlas-pricing", url: "https://atlas.example.com/pricing", title: "Atlas pricing",
  text: "Atlas Pro costs $19 per month.", availableAt: "2024-01-01T00:00:00.000Z",
  publishedAt: "2024-01-01T00:00:00.000Z", capturedAt: "2024-01-02T00:00:00.000Z",
  provenanceKind: "archive", provenanceUrl: "https://archive.example.com/20240102/pricing", reviewed: true,
  recordedAt: "2026-11-13T00:00:00.000Z", contentHash: createHash("sha256").update(overrides.text ?? "Atlas Pro costs $19 per month.").digest("hex"),
  ...overrides,
});
const snapshot = (overrides: Partial<SearchHit> = {}): SearchHit => ({
  url: "https://other.example.com/atlas", title: "Atlas launch", text: "Atlas launched its Pro plan.",
  snapshotAsOf: cutoff.toISOString(), publishedDate: "2024-01-01", ...overrides,
});

test("current-date searches retain the original Exa request, signal and results", async () => {
  const query: SearchQuery = { query: " latest pricing ", freshness: "fresh" };
  const controller = new AbortController();
  const results = [snapshot({ snapshotAsOf: undefined })];
  const engine = withHistoricalCorpus({ search: async (input, signal) => {
    assert.equal(input, query); assert.equal(signal, controller.signal); return results;
  } }, { search: () => assert.fail("current search touched historical corpus") });
  assert.equal(await engine.search(query, controller.signal), results);
});

test("historical corpus sources keep real availability and version provenance without a synthetic Snapshot", async () => {
  let exaCalls = 0;
  const source = passage();
  const engine = withHistoricalCorpus({ search: async query => {
    exaCalls++; assert.equal(query.asOf?.toISOString(), cutoff.toISOString()); throw new Error("Exa responded 403.");
  } }, { search: input => {
    assert.equal(input.asOf.toISOString(), cutoff.toISOString()); return [source];
  } });
  const hits = await engine.search({ query: "Atlas pricing", asOf: cutoff });
  assert.equal(exaCalls, 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.text, source.text);
  assert.equal(hits[0]!.title, source.title);
  assert.equal(hits[0]!.provider, "corpus");
  assert.equal(hits[0]!.snapshotAsOf, undefined);
  assert.deepEqual(hits[0]!.temporal, {
    documentId: source.id, availableAt: source.availableAt, recordedAt: source.recordedAt,
    capturedAt: source.capturedAt, reviewed: true, provenanceKind: "archive", provenanceUrl: source.provenanceUrl,
  });
});

test("a full local evidence window avoids paid Snapshot calls and duplicate passages do not fill it", async () => {
  let exaCalls = 0;
  const docs = Array.from({ length: 5 }, (_, i) => passage({ id: `v${i}`, sourceId: `s${i}`, url: `https://atlas.example.com/${i}` }));
  const exa: SearchProvider = { search: async () => { exaCalls++; return []; } };
  assert.equal((await withHistoricalCorpus(exa, { search: () => docs }).search({ query: "Atlas", asOf: cutoff })).length, 5);
  assert.equal(exaCalls, 0);
  const duplicated = await withHistoricalCorpus(exa, { search: () => Array(5).fill(docs[0]!) }).search({ query: "Atlas", asOf: cutoff });
  assert.equal(duplicated.length, 1);
  assert.equal(exaCalls, 1);
});

test("partial local evidence combines with eligible Exa snapshots in deterministic order", async () => {
  const engine = withHistoricalCorpus({ search: async () => [
    snapshot(), snapshot({ url: passage().url, title: "Duplicate", text: passage().text }),
    snapshot({ url: "https://other.example.com/live", snapshotAsOf: undefined }),
    snapshot({ url: "https://other.example.com/later", snapshotAsOf: "2025-01-13T18:05:11.995Z" }),
  ] }, { search: () => [passage()] });
  const hits = await engine.search({ query: "Atlas", asOf: cutoff });
  assert.deepEqual(hits.map(hit => hit.url), [passage().url, snapshot().url]);
  assert.equal(hits[0]!.provider, "corpus");
});

test("merging local evidence cannot cut an acquired table's final chunks", async () => {
  const url = "https://other.example.com/history";
  const archive = { provider: "wayback" as const, capturedAt: "2024-01-02T00:00:00.000Z",
    captureUrl: `https://web.archive.org/web/20240102000000id_/${url}`, originalUrl: url, rawHash: "a".repeat(64) };
  const table = Array.from({ length: 5 }, (_, i) => ({ url, title: "History", text: `Row group ${i}`, archive }));
  const engine = withHistoricalCorpus({ search: async () => table }, { search: () => [passage()] });
  const hits = await engine.search({ query: "Atlas history", asOf: cutoff });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.provider, "corpus");
  const empty = withHistoricalCorpus({ search: async () => table }, { search: () => [] });
  assert.deepEqual((await empty.search({ query: "history", asOf: cutoff })).map(hit => hit.text), table.map(hit => hit.text));
});

test("missing historical evidence preserves the Exa access error and never retries live", async () => {
  const denied = new Error("Exa responded 403.");
  let requests = 0;
  const engine = withHistoricalCorpus({ search: async query => {
    requests++; assert.equal(query.asOf?.toISOString(), cutoff.toISOString()); throw denied;
  } }, { search: () => [] });
  await assert.rejects(engine.search({ query: "unknown", asOf: cutoff }), error => error === denied);
  assert.equal(requests, 1);
});

test("defensive eligibility excludes unreviewed, retrospective and later-captured archive records", async () => {
  const engine = withHistoricalCorpus({ search: async () => [] }, { search: () => [
    passage({ id: "unreviewed", reviewed: false }),
    passage({ id: "retrospective", availableAt: "2026-01-01T00:00:00.000Z" }),
    passage({ id: "later-capture", capturedAt: "2026-01-01T00:00:00.000Z" }),
    passage({ id: "later-publication", publishedAt: "2026-01-01T00:00:00.000Z", availableAt: "2026-01-01T00:00:00.000Z" }),
    passage({ id: "same-instant", availableAt: cutoff.toISOString(), capturedAt: cutoff.toISOString() }),
  ] });
  const hits = await engine.search({ query: "Atlas", asOf: cutoff });
  assert.deepEqual(hits.map(hit => hit.temporal!.documentId), ["same-instant"]);
});

test("a reviewed original edition can be digitized later without becoming a modern retrospective", async () => {
  const source = passage({ id: "edition", provenanceKind: "primary-source", availableAt: "1863-01-01T00:00:00.000Z", publishedAt: "1863-01-01T00:00:00.000Z", capturedAt: "2026-11-13T00:00:00.000Z" });
  const engine = withHistoricalCorpus({ search: async () => [] }, { search: () => [source] });
  const hits = await engine.search({ query: "Atlas", asOf: new Date("1863-09-01T00:00:00.000Z") });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.temporal!.documentId, "edition");
});

test("changed source bytes cannot pass under a previously reviewed content hash", async () => {
  const changed = { ...passage(), text: "Tampered evidence claims a later outcome." };
  const engine = withHistoricalCorpus({ search: async () => [] }, { search: () => [changed] });
  assert.deepEqual(await engine.search({ query: "outcome", asOf: cutoff }), []);
});

test("URL, domain and publication restrictions remain in force on both evidence paths", async () => {
  let captured: SearchQuery | undefined;
  const engine = withHistoricalCorpus({ search: async query => {
    captured = query;
    return [snapshot(), snapshot({ url: "https://atlas.example.com/pricing", publishedDate: "2023-12-31" })];
  } }, { search: input => {
    assert.deepEqual(input.urls, ["https://atlas.example.com/pricing"]);
    assert.deepEqual(input.domains, ["atlas.example.com"]);
    assert.equal(input.publishedAfter, "2024-01-01");
    return [passage(), passage({ url: "https://atlas.example.com/other" }), passage({ url: "https://evil.example.com/pricing" }), passage({ publishedAt: undefined })];
  } });
  const hits = await engine.search({ query: "Atlas", asOf: cutoff, urls: ["https://atlas.example.com/pricing?utm_source=ignored#x"], domains: ["atlas.example.com"], publishedAfter: "2024-01-01" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.provider, "corpus");
  assert.equal(captured!.asOf?.toISOString(), cutoff.toISOString());
});

test("cancellation is never swallowed when local evidence is available", async () => {
  const controller = new AbortController();
  const engine = withHistoricalCorpus({ search: async (_query, signal) => {
    controller.abort(); signal!.throwIfAborted(); return [];
  } }, { search: () => [passage()] });
  await assert.rejects(engine.search({ query: "Atlas", asOf: cutoff }, controller.signal), { name: "AbortError" });
  const already = new AbortController(); already.abort();
  await assert.rejects(engine.search({ query: "Atlas", asOf: cutoff }, already.signal), { name: "AbortError" });
});

test("publication upper bounds also constrain reviewed local versions", async () => {
  const engine = withHistoricalCorpus({ search: async () => [] }, { search: () => [
    passage({ id: "at-bound" }),
    passage({ id: "after-bound", publishedAt: "2024-01-02T00:00:00.000Z" }),
    passage({ id: "unknown-publication", publishedAt: undefined }),
  ] });
  const hits = await engine.search({ query: "Atlas", asOf: cutoff, publishedBefore: "2024-01-01" });
  assert.deepEqual(hits.map(hit => hit.temporal!.documentId), ["at-bound"]);
});

test("invalid cutoffs and corpus errors do not reach Exa", async () => {
  const exa: SearchProvider = { search: async () => assert.fail("unexpected Exa call") };
  const engine = withHistoricalCorpus(exa, { search: () => { throw new Error("corpus unavailable"); } });
  await assert.rejects(engine.search({ query: "Atlas", asOf: new Date("bad") }), /cutoff/);
  await assert.rejects(engine.search({ query: "Atlas", asOf: cutoff }), /corpus unavailable/);
});

test("long corpus documents yield a bounded, exact passage around relevant late text", async () => {
  const text = "Preface about unrelated administrative details. ".repeat(250)
    + "\nAtlas Pro pricing is $19 monthly. The launch was announced in March.\n"
    + "Appendix with other material. ".repeat(250);
  const excerpt = corpusPassage(text, "What was Atlas Pro pricing at launch?");
  assert.ok(excerpt.length <= 2000);
  assert.ok(text.includes(excerpt), "passage must be an unchanged contiguous source substring");
  assert.match(excerpt, /Atlas Pro pricing is \$19 monthly/);
  const engine = withHistoricalCorpus({ search: async () => [] }, { search: () => [passage({ text })] });
  const hit = (await engine.search({ query: "Atlas Pro pricing", asOf: cutoff }))[0]!;
  assert.ok(text.includes(hit.text));
  assert.match(hit.text, /Atlas Pro pricing/);
  assert.equal(hit.contentHash, createHash("sha256").update(hit.text).digest("hex"));
  assert.equal(corpusPassage("Short exact source.", "source"), "Short exact source.");
});
