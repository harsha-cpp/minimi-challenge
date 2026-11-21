import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EvidenceWindow } from "../src/agent/evidence.ts";
import { PROMPT_LIMITS } from "../src/agent/prepare.ts";
import type { SearchHit } from "../src/search.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MemoryStore } from "../src/memory/store.ts";
import { recall } from "../src/memory/recall.ts";

const episode = { sessionId: "s", askedAt: 0, tz: "UTC", question: "pricing", answer: "$25 [1]" };

test("legacy databases migrate additively and evidence survives a reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-evidence-"));
  const path = join(dir, "old.db");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE episodes (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, asked_at INTEGER NOT NULL,
      tz TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, summary TEXT, topics TEXT);
      CREATE TABLE sources (episode_id INTEGER NOT NULL, n INTEGER NOT NULL, url TEXT NOT NULL,
      title TEXT NOT NULL, published_date TEXT, PRIMARY KEY (episode_id, n));
      INSERT INTO episodes VALUES (99, 'legacy', 0, 'UTC', 'Old question', 'Old answer', NULL, NULL);
      INSERT INTO sources VALUES (99, 1, 'https://example.com/old', 'Old source', NULL);`);
    legacy.close();
    const store = new MemoryStore(path);
    assert.equal(store.sourcesFor(99)[0]!.text, undefined);
    assert.equal(store.termCoverage(["Old"]).has(99), true, "legacy question indexing is backfilled");
    assert.equal(store.episode(99)!.createdAt, null, "migration must preserve unknown real creation time");
    assert.equal(store.episode(99)!.sequence, 99, "legacy ID is the documented ordering fallback");
    const source = { n: 1, url: "https://example.com/pricing", title: "Pricing", text: "$25/month", retrievedAt: "2026-11-12T10:00:00Z", snapshotAsOf: "2026-11-03T10:00:00Z", contentHash: "hash", requestId: "r1", provider: "exa" };
    const id = store.saveEpisode({ ...episode, execution: { time: { effectiveAt: "2020-11-03T10:00:00Z", simulated: true } }, sources: [source] });
    store.close();
    const reopened = new MemoryStore(path);
    assert.deepEqual(reopened.sourcesFor(id), [{ ...source, publishedDate: undefined }]);
    assert.equal((reopened.episode(id)!.execution!.time as { simulated: boolean }).simulated, true);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a source write failure rolls back the entire episode and FTS update", () => {
  const store = new MemoryStore(":memory:");
  const source = { n: 1, url: "https://example.com", title: "Example" };
  assert.throws(() => store.saveEpisode({ ...episode, sources: [source, source] }));
  assert.equal(store.count(), 0);
  assert.equal(store.termCoverage(["pricing"]).size, 0);
  assert.equal(store.saveEpisode({ ...episode, sources: [source] }), 1);
  store.close();
});

test("verified statements preserve source links, viewpoint and real verification time across reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-verified-ledger-"));
  const path = join(dir, "memory.db");
  let store = new MemoryStore(path);
  try {
    const before = Date.now();
    const id = store.saveEpisode({ ...episode, askedAt: Date.parse("2020-01-01T00:00:00Z"), sources: [
      { n: 1, url: "https://example.com/pricing", title: "Pricing", text: "$25/month" },
      { n: 2, url: "https://example.com/terms", title: "Terms", text: "$25 paid monthly" },
    ], verifiedStatements: [
      { text: "The price is $25 monthly [1, 2].", sourceNumbers: [2, 1, 2] },
      { text: "Payments are monthly [2].", sourceNumbers: [2] },
    ] });
    const statements = store.verifiedStatementsFor(id);
    assert.equal(statements.length, 2);
    assert.deepEqual(statements.map(statement => statement.sourceNumbers), [[1, 2], [2]]);
    assert.equal(statements[0]!.text, "The price is $25 monthly [1, 2].");
    for (const statement of statements) {
      assert.equal(statement.viewpointAt, Date.parse("2020-01-01T00:00:00Z"));
      assert.ok(statement.verifiedAt >= before && statement.verifiedAt <= Date.now());
      assert.deepEqual(Object.keys(statement).sort(), ["id", "sourceNumbers", "text", "verifiedAt", "viewpointAt"]);
    }
    store.close(); store = new MemoryStore(path);
    assert.deepEqual(store.verifiedStatementsFor(id), statements);
    assert.equal(store.sourcesFor(id)[1]!.text, "$25 paid monthly");
    assert.deepEqual(store.claimsFor(id), [], "independent enrichment cannot invent a verified claim");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("verified statement validation binds every citation to the same new episode", () => {
  const store = new MemoryStore(":memory:");
  const source = { n: 1, url: "https://example.com", title: "Example", text: "A claim." };
  try {
    store.saveEpisode({ ...episode, sources: [{ ...source, n: 2 }] });
    for (const invalid of [
      { text: " ", sourceNumbers: [1] },
      { text: "x".repeat(20_001), sourceNumbers: [1] },
      { text: "Claim", sourceNumbers: [] },
      { text: "Claim", sourceNumbers: [0] },
      { text: "Claim", sourceNumbers: [2] },
      { text: "Claim", sourceNumbers: [1.5] },
    ]) assert.throws(() => store.saveEpisode({ ...episode, sources: [source], verifiedStatements: [invalid] }));
    assert.equal(store.count(), 1);
    assert.deepEqual(store.verifiedStatementsFor(1), []);
    const abstained = store.saveEpisode({ ...episode, answer: "I could not verify this.", sources: [], verifiedStatements: [] });
    assert.deepEqual(store.verifiedStatementsFor(abstained), []);
    const current = store.saveEpisode({ ...episode, sources: [source] });
    assert.deepEqual(store.verifiedStatementsFor(current), []);
  } finally { store.close(); }
});

test("verified statements and their evidence sets are immutable and foreign keys reject orphan links", () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-verified-immutable-"));
  const path = join(dir, "memory.db");
  const store = new MemoryStore(path);
  try {
    const source = { url: "https://example.com", title: "Example", text: "A claim." };
    const id = store.saveEpisode({ ...episode, sources: [{ ...source, n: 1 }, { ...source, n: 2 }], verifiedStatements: [{ text: "A claim [1].", sourceNumbers: [1] }] });
    const statement = store.verifiedStatementsFor(id)[0]!;
    const sql = new DatabaseSync(path);
    try {
      sql.exec("PRAGMA foreign_keys = ON");
      assert.throws(() => sql.prepare("UPDATE verified_statements SET text = 'changed' WHERE id = ?").run(statement.id), /immutable/);
      assert.throws(() => sql.prepare("DELETE FROM verified_statements WHERE id = ?").run(statement.id), /immutable/);
      assert.throws(() => sql.prepare("UPDATE verified_statement_sources SET source_n = 2 WHERE statement_id = ?").run(statement.id), /immutable/);
      assert.throws(() => sql.prepare("DELETE FROM verified_statement_sources WHERE statement_id = ?").run(statement.id), /immutable/);
      assert.throws(() => sql.prepare("INSERT INTO verified_statement_sources VALUES (?, ?, 2)").run(statement.id, id), /immutable/);
      assert.throws(() => sql.prepare("UPDATE sources SET evidence_json = '{}' WHERE episode_id = ? AND n = 1").run(id), /immutable/);
      assert.throws(() => sql.prepare("DELETE FROM sources WHERE episode_id = ? AND n = 1").run(id), /immutable/);
      assert.throws(() => sql.prepare("INSERT INTO verified_statement_sources VALUES (999, ?, 1)").run(id), /FOREIGN KEY/);
      assert.throws(() => sql.prepare("INSERT INTO verified_statements VALUES (999, ?, 'No evidence', 0, 0)").run(id), /requires evidence/);
    } finally { sql.close(); }
    assert.deepEqual(store.verifiedStatementsFor(id), [statement]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a late verified statement failure rolls back episode, sources, prior statements and FTS together", () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-verified-rollback-"));
  const path = join(dir, "memory.db");
  const store = new MemoryStore(path);
  try {
    const sql = new DatabaseSync(path);
    sql.exec("CREATE TRIGGER reject_test_statement BEFORE INSERT ON verified_statements WHEN new.text = 'FORCED_FAILURE' BEGIN SELECT RAISE(ABORT, 'forced statement failure'); END;");
    sql.close();
    const source = { n: 1, url: "https://example.com", title: "Example", text: "A claim." };
    assert.throws(() => store.saveEpisode({ ...episode, sources: [source], verifiedStatements: [
      { text: "First successfully inserted statement", sourceNumbers: [1] },
      { text: "FORCED_FAILURE", sourceNumbers: [1] },
    ] }), /forced statement failure/);
    assert.equal(store.count(), 0);
    assert.deepEqual(store.sourcesFor(1), []);
    assert.deepEqual(store.verifiedStatementsFor(1), []);
    assert.equal(store.termCoverage(["pricing"]).size, 0);
    assert.equal(store.termCoverage(["successfully", "FORCED_FAILURE"]).size, 0);
    const id = store.saveEpisode({ ...episode, sources: [source], verifiedStatements: [{ text: "A claim [1].", sourceNumbers: [1] }] });
    assert.equal(id, 1);
    assert.equal(store.verifiedStatementsFor(id)[0]!.id, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("recall indexes only approved statement terms and preserves them through later enrichment", () => {
  const store = new MemoryStore(":memory:");
  try {
    const source = { n: 1, url: "https://example.com/leadership", title: "Leadership", text: "Mira Chen is chief executive." };
    const id = store.saveEpisode({ ...episode, question: "Leadership research", answer: "Mira Chen is chief executive [1]. Unapproved Sentinel is a draft detail.",
      sources: [source], verifiedStatements: [{ text: "Mira Chen is chief executive [1].", sourceNumbers: [1] }] });
    assert.equal(store.termCoverage(["Sentinel"]).size, 0, "the whole draft must never become audited search metadata");
    assert.equal(recall(store, "Mira Chen", new Date("2020-01-01T00:00:00Z"), "UTC", new Set(), "local", { allowCrossSession: true }).related[0]!.episode.id, id);
    store.enrich(id, { summary: "Leadership research", topics: ["leadership"], claims: [] });
    assert.equal(recall(store, "Mira Chen", new Date("2020-01-01T00:00:00Z"), "UTC", new Set(), "local", { allowCrossSession: true }).related[0]!.episode.id, id);
    assert.equal(store.termCoverage(["Sentinel"]).size, 0);
    assert.equal(store.verifiedStatementsFor(id)[0]!.text, "Mira Chen is chief executive [1].");
    assert.throws(() => store.saveEpisode({ ...episode, sources: [source], verifiedStatements: [
      { text: "x".repeat(10_000), sourceNumbers: [1] }, { text: "y".repeat(10_001), sourceNumbers: [1] },
    ] }), /episode budget/);
    assert.equal(store.count(), 1);
  } finally { store.close(); }
});

test("a budget-truncated observation later admits its decisive continuation without duplicating the prefix", () => {
  const window = new EvidenceWindow();
  const allowed = ("UNIQUE_PREFIX_ONLY\n" + "x".repeat(11_000) + "\nDECISIVE_TAIL price is $25.").padEnd(12_000, "y");
  const raw = allowed + "OUTSIDE_FULL_TEXT_LIMIT";
  const hit = { url: "https://example.com/table", title: "Complete table", text: raw, contentHash: "provider-hash-for-untruncated-text" };
  const admitted: SearchHit[] = [];
  const numberFor = (source: SearchHit) => { admitted.push(source); return admitted.length; };
  const first = window.renderRound([{ query: { query: "complete table", content: "full" }, hits: [hit] }, "Another lookup returned no evidence", "A third lookup returned no evidence"], numberFor);
  assert.equal(admitted.length, 1); assert.ok(admitted[0]!.text.length < 12_000);
  assert.doesNotMatch(first[0]!, /DECISIVE_TAIL/);
  const second = window.render({ query: "remaining table", content: "full" }, [hit], numberFor);
  assert.equal(admitted.length, 2); assert.match(second, /DECISIVE_TAIL/);
  assert.match(second, /\[2\][\s\S]*CONTINUATION/); assert.match(second, /earlier passages \[1\]/);
  assert.equal(admitted[0]!.text + admitted[1]!.text, allowed);
  assert.doesNotMatch(admitted[1]!.text, /UNIQUE_PREFIX_ONLY/);
  assert.doesNotMatch(second, /OUTSIDE_FULL_TEXT_LIMIT/);
  for (const source of admitted) assert.equal(source.contentHash, createHash("sha256").update(source.text).digest("hex"));
  assert.notEqual(admitted[0]!.contentHash, admitted[1]!.contentHash);
  const third = window.render({ query: "same table again", content: "full" }, [hit], numberFor);
  assert.equal(admitted.length, 2); assert.match(third, /\[1, 2\] Same observation/); assert.doesNotMatch(third, /PASSAGE/);
  assert.equal(window.stats.toolChars, first.join("").length + second.length + third.length);
  assert.equal(window.stats.admittedPassages, 2); assert.equal(window.stats.duplicatePassages, 2);
  assert.equal(window.stats.duplicateCharsAvoided, admitted[0]!.text.length + allowed.length);
  assert.ok(window.stats.toolChars <= PROMPT_LIMITS.toolChars);
});

test("continuations honor excerpt limits and only an explicit full-text expansion extends that limit", () => {
  const window = new EvidenceWindow(), admitted: SearchHit[] = [];
  const text = "PREFIX_ONLY " + "x".repeat(7000) + "EXPLICIT_EXPANSION_TAIL";
  const hit = { url: "https://example.com/source", title: "Source", text };
  const numberFor = (source: SearchHit) => { admitted.push(source); return admitted.length; };
  const first = window.renderRound([{ query: { query: "fact" }, hits: [hit] }, "second", "third", "fourth", "fifth"], numberFor);
  const second = window.render({ query: "fact follow-up" }, [hit], numberFor);
  assert.equal(admitted.length, 2); assert.equal(admitted.map(source => source.text).join(""), text.slice(0, PROMPT_LIMITS.passageChars));
  assert.doesNotMatch(second, /EXPLICIT_EXPANSION_TAIL/);
  const repeated = window.render({ query: "fact again" }, [hit], numberFor);
  assert.equal(admitted.length, 2); assert.match(repeated, /Same observation/); assert.doesNotMatch(repeated, /PASSAGE/);
  const expanded = window.render({ query: "read full source", content: "full" }, [hit], numberFor);
  assert.equal(admitted.length, 3); assert.match(expanded, /EXPLICIT_EXPANSION_TAIL/);
  assert.equal(admitted.map(source => source.text).join(""), text);
  assert.equal(window.stats.toolChars, first.join("").length + second.length + repeated.length + expanded.length);
  assert.ok(window.stats.toolChars <= PROMPT_LIMITS.toolChars);
});

test("comparison and research packing retain decisive candidates ranked sixth through eighth", () => {
  for (const [profile, count] of [["comparison", 6], ["research", 8]] as const) {
    const window = new EvidenceWindow(), admitted: SearchHit[] = [];
    const hits = Array.from({ length: count }, (_, index) => ({ url: `https://example.com/${profile}/${index + 1}`, title: `Source ${index + 1}`,
      text: index >= 5 ? `DECISIVE_FACET_${index + 1}: the complementary answer is supported here.` : `Background fact ${index + 1}.` }));
    const numberFor = (hit: SearchHit) => { admitted.push(hit); return admitted.length; };
    const first = window.render({ query: "compare complementary facts", profile }, hits, numberFor);
    assert.equal(admitted.length, count);
    for (let rank = 6; rank <= count; rank++) assert.match(first, new RegExp(`\\[${rank}\\][\\s\\S]*DECISIVE_FACET_${rank}`));
    const repeated = window.render({ query: "same comparison again", profile }, hits, numberFor);
    assert.equal(admitted.length, count, "repeat observations retain source identity without a new passage");
    assert.match(repeated, /Same observation/);
    assert.doesNotMatch(repeated, /PASSAGE/);
    const final = window.render({ query: "a later missing fact" }, [{ url: "https://example.com/follow-up", title: "Follow-up", text: "FOLLOW_UP_DECISIVE_FACT" }], numberFor);
    assert.match(final, /FOLLOW_UP_DECISIVE_FACT/);
    assert.equal(window.stats.toolChars, first.length + repeated.length + final.length);
    assert.ok(window.stats.toolChars <= PROMPT_LIMITS.toolChars);
  }
});

test("deep-profile rounds interleave ranks across queries and remain bounded at eight candidates each", () => {
  const window = new EvidenceWindow(), admitted: SearchHit[] = [];
  const batches = ["left", "right"].map(query => ({ query: { query, profile: "research" as const },
    hits: Array.from({ length: 100 }, (_, index) => ({ url: `https://example.com/${query}/${index + 1}`, title: `${query} ${index + 1}`, text: `${query} fact ${index + 1}.` })) }));
  const output = window.renderRound(batches, hit => { admitted.push(hit); return admitted.length; });
  assert.equal(admitted.length, 16);
  assert.deepEqual(admitted.map(hit => hit.title), Array.from({ length: 8 }, (_, index) => [`left ${index + 1}`, `right ${index + 1}`]).flat());
  assert.ok(output[0]!.includes("left fact 8."));
  assert.ok(output[1]!.includes("right fact 8."));
  assert.doesNotMatch(output.join(""), /fact 9\./);
  assert.ok(window.stats.toolChars <= PROMPT_LIMITS.toolChars * 0.75, "the first round retains follow-up capacity");
});
