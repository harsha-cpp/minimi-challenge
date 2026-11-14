import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { TemporalStore, validateTemporalDocument, type TemporalDocumentInput } from "../src/temporal/store.ts";

const document = (overrides: Partial<TemporalDocumentInput> = {}): TemporalDocumentInput => ({
  sourceId: "official-leadership", url: "https://history.example.com/leadership", title: "Official leadership announcement",
  text: "The company announced that Mira Chen is its chief executive.", availableAt: "2020-01-01T00:00:00.000Z", publishedAt: "2020-01-01T00:00:00.000Z",
  provenanceKind: "primary-source", provenanceUrl: "https://archive.example.com/original-edition", reviewed: true, ...overrides,
});
const search = (store: TemporalStore, query = "chief executive", at = "2020-06-01T00:00:00Z") => store.search({ query, asOf: new Date(at) });

test("historical corpus returns only reviewed source versions available by the exact cutoff", () => {
  const store = new TemporalStore(":memory:");
  try {
    const past = store.importDocument(document());
    store.importDocument(document({ sourceId: "future-news", text: "The chief executive resigned. FUTURE_SENTINEL", availableAt: "2021-01-01T00:00:00Z", publishedAt: "2021-01-01T00:00:00Z" }));
    store.importDocument(document({ sourceId: "unreviewed", text: "The chief executive is UNKNOWN_SENTINEL", reviewed: false }));
    assert.deepEqual(search(store).map(item => item.id), [past.id]);
    assert.deepEqual(search(store, "FUTURE_SENTINEL"), []);
    assert.deepEqual(store.search({ query: "chief executive", asOf: new Date("2019-12-31T23:59:59.999Z") }), []);
    assert.equal(store.search({ query: "chief executive", asOf: new Date(past.availableAt) })[0]!.id, past.id);
    assert.equal(past.contentHash, createHash("sha256").update(past.text).digest("hex"));
    assert.ok(Date.parse(past.recordedAt) > Date.parse(past.availableAt));
  } finally { store.close(); }
});

test("archive and revision captures enforce version time while a reviewed primary edition permits later digitization", () => {
  const store = new TemporalStore(":memory:");
  try {
    for (const provenanceKind of ["archive", "revision"] as const) {
      store.importDocument(document({ sourceId: provenanceKind, provenanceKind, capturedAt: "2021-01-01T00:00:00Z" }));
    }
    const primary = store.importDocument(document({ capturedAt: "2025-01-01T00:00:00Z" }));
    assert.deepEqual(search(store).map(item => item.id), [primary.id]);
    assert.equal(search(store, "chief executive", "2021-01-01T00:00:00Z").length, 3);
  } finally { store.close(); }
});

test("source-version retrieval never resurfaces superseded text just because it matches a query", () => {
  const store = new TemporalStore(":memory:");
  try {
    const old = store.importDocument(document({ text: "Mira Chen is the chief executive. Original pricing costs $19." }));
    const newer = store.importDocument(document({ text: "Leadership now belongs to Dev Rao. Pricing costs $25.", availableAt: "2021-01-01T00:00:00Z", publishedAt: "2021-01-01T00:00:00Z" }));
    assert.equal(search(store, "Mira")[0]!.id, old.id);
    assert.deepEqual(search(store, "Mira", "2021-06-01T00:00:00Z"), []);
    assert.equal(search(store, "pricing", "2021-06-01T00:00:00Z")[0]!.id, newer.id);
    assert.equal(search(store, "pricing")[0]!.id, old.id);
  } finally { store.close(); }
});

test("historical ranking is unchanged when future documents are added", () => {
  const store = new TemporalStore(":memory:");
  try {
    store.importDocuments([document(), document({ sourceId: "second", title: "Additional chief executive details", text: "A chief executive announcement." })]);
    const before = search(store).map(item => item.id);
    store.importDocuments(Array.from({ length: 20 }, (_, i) => document({ sourceId: `future-${i}`, text: "chief executive ".repeat(i + 1), availableAt: "2025-01-01T00:00:00Z", publishedAt: "2025-01-01T00:00:00Z" })));
    assert.deepEqual(search(store).map(item => item.id), before);
  } finally { store.close(); }
});

test("source URL, subdomain and publication filters apply before the result limit", () => {
  const store = new TemporalStore(":memory:");
  try {
    const kept = store.importDocument(document());
    store.importDocument(document({ sourceId: "wrong-domain", title: "chief executive chief executive", url: "https://unrelated.com/leadership" }));
    const input = { query: "chief executive", asOf: new Date("2020-06-01T00:00:00Z"), limit: 1 };
    assert.equal(store.search({ ...input, domains: ["example.com"] })[0]!.id, kept.id);
    assert.equal(store.search({ ...input, urls: ["https://history.example.com/leadership?utm_source=test"] })[0]!.id, kept.id);
    assert.equal(store.search({ ...input, query: "unmatched words", urls: [kept.url] })[0]!.id, kept.id);
    assert.deepEqual(store.search({ ...input, publishedAfter: "2020-02-01" }), []);
    assert.deepEqual(store.search({ ...input, domains: ["ample.com"] }), []);
    assert.throws(() => store.search({ ...input, domains: ["example.com/unsafe"] }), /bare hostnames/);
  } finally { store.close(); }
});

test("review events are append-only, revocable and distinct from historical source availability", () => {
  const store = new TemporalStore(":memory:");
  try {
    const pending = store.importDocument(document({ reviewed: false }));
    assert.deepEqual(search(store), []);
    store.review(pending.id, true, "Checked original dated edition.");
    assert.equal(search(store)[0]!.id, pending.id);
    store.review(pending.id, false, "Original edition attribution could not be reproduced.");
    assert.deepEqual(search(store), []);
    assert.deepEqual(store.reviewHistory(pending.id).map(review => review.reviewed), [false, true, false]);
    assert.equal(store.reviewHistory(pending.id)[1]!.reason, "Checked original dated edition.");
    assert.throws(() => store.review("missing", true), /not found/);
    assert.equal(store.coverage().reviewedDocuments, 0);
  } finally { store.close(); }
});

test("imports are idempotent, preserve exact bytes and roll back metadata conflicts atomically", () => {
  const store = new TemporalStore(":memory:");
  try {
    const input = document({ text: "  Original chief executive statement.\n" });
    const initial = store.importDocument(input);
    assert.deepEqual(store.importDocument(input), initial);
    assert.equal(initial.text, input.text);
    assert.throws(() => store.importDocuments([document({ sourceId: "rolled-back" }), { ...input, provenanceUrl: "https://wrong.example.com/version" }]), /Conflicting metadata/);
    assert.equal(store.coverage().reviewedDocuments, 1);
    assert.deepEqual(search(store, "rolled-back"), []);
    assert.throws(() => store.importDocuments([document({ sourceId: "first" }), { ...input, availableAt: "2020-02-30T00:00:00Z" }]), /real ISO timestamp/);
    assert.equal(store.coverage().reviewedDocuments, 1);
  } finally { store.close(); }
});

test("source and review rows resist direct mutation and persist across reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-temporal-store-"));
  const path = join(dir, "corpus.db");
  let store = new TemporalStore(path);
  try {
    const saved = store.importDocument(document());
    const sql = new DatabaseSync(path);
    try {
      assert.throws(() => sql.prepare("UPDATE temporal_documents SET text = 'changed' WHERE id = ?").run(saved.id), /immutable/);
      assert.throws(() => sql.prepare("DELETE FROM temporal_documents WHERE id = ?").run(saved.id), /immutable/);
      assert.throws(() => sql.exec("UPDATE temporal_reviews SET reviewed = 0"), /append-only/);
      assert.throws(() => sql.exec("DELETE FROM temporal_reviews"), /append-only/);
    } finally { sql.close(); }
    store.close(); store = new TemporalStore(path);
    assert.equal(search(store)[0]!.id, saved.id);
    assert.equal(store.reviewHistory(saved.id).length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("conflicting exact version times cannot make historical retrieval depend on ingestion order", () => {
  const store = new TemporalStore(":memory:");
  try {
    const original = store.importDocument(document());
    assert.throws(() => store.importDocuments([document({ sourceId: "rolled-back-before-conflict" }), document({ text: "A different chief executive replaced Mira." })]), /Ambiguous version time/);
    assert.equal(store.coverage().reviewedDocuments, 1);
    assert.equal(search(store)[0]!.id, original.id);
    const corrected = store.importDocument(document({ text: "A different chief executive replaced Mira.", availableAt: "2020-02-01T00:00:00Z" }));
    assert.equal(search(store)[0]!.id, corrected.id);
    assert.equal(search(store, "chief executive", "2020-01-15T00:00:00Z")[0]!.id, original.id);
  } finally { store.close(); }
});

test("validation rejects missing attestations, contradictory dates and unsafe provenance", () => {
  for (const invalid of [null, [], { ...document(), reviewed: undefined }, { ...document(), availableAt: "2020-01-01" },
    { ...document(), provenanceKind: "generated" }, { ...document(), provenanceKind: "archive" },
    { ...document(), provenanceKind: "revision", capturedAt: "2019-01-01T00:00:00Z" },
    { ...document(), publishedAt: "2021-01-01T00:00:00Z" }, { ...document(), provenanceUrl: "file:///tmp/a" },
    { ...document(), url: "https://user:secret@example.com/source" }, { ...document(), text: " " }, { ...document(), text: "x".repeat(200_001) }]) {
    assert.throws(() => validateTemporalDocument(invalid));
  }
  assert.equal(validateTemporalDocument(document({ availableAt: "2020-01-01T01:00:00+01:00" })).availableAt, "2020-01-01T00:00:00.000Z");
});

test("coverage identifies eligible preserved documents without claiming gaps are covered", () => {
  const store = new TemporalStore(":memory:");
  try {
    assert.deepEqual(store.coverage(), { reviewedDocuments: 0, eligibleDocuments: 0, earliestAvailableAt: null, latestAvailableAt: null });
    store.importDocuments([document(), document({ sourceId: "future", availableAt: "2025-01-01T00:00:00Z", publishedAt: "2025-01-01T00:00:00Z" }), document({ sourceId: "unreviewed", reviewed: false })]);
    assert.deepEqual(store.coverage(new Date("2020-06-01T00:00:00Z")), { reviewedDocuments: 2, eligibleDocuments: 1, earliestAvailableAt: "2020-01-01T00:00:00.000Z", latestAvailableAt: "2020-01-01T00:00:00.000Z" });
    assert.throws(() => store.coverage(new Date("invalid")), /valid historical cutoff/);
    assert.throws(() => store.search({ query: "chief executive", asOf: new Date("invalid") }), /valid historical cutoff/);
    assert.throws(() => store.search({ query: "chief executive", asOf: new Date(), limit: 0 }), /1 to 50/);
    assert.deepEqual(search(store, '" OR * - : ( )'), []);
  } finally { store.close(); }
});
