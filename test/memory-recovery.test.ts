import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { MemoryStore, StoreConflictError, type NewClaim } from "../src/memory/store.ts";
import { Enricher } from "../src/memory/enrich.ts";
import { recall } from "../src/memory/recall.ts";
import type { Llm } from "../src/llm.ts";
import { AdmissionPool, createModelGateway } from "../src/llm/gateway.ts";
import { recordStage, recordUsage } from "../src/runtime/telemetry.ts";

const exchange = { sessionId: "s", askedAt: 100, tz: "UTC", question: "Who was president?", answer: "Barack Obama.", sources: [] };
const claim: NewClaim = { entity: "Cloud", attribute: "price", value: "$10", kind: "price", sourceUrl: null, priorClaimId: null, verdict: "new" };
const begin = (store: MemoryStore, key: string, ownerId = "local", sessionId = "s") => store.beginTurn({ ownerId, sessionId, idempotencyKey: key, requestHash: `hash:${key}` });

test("durable turn idempotency conflicts, conversation serialization and commit recovery", () => {
  const store = new MemoryStore(":memory:");
  try {
    const first = begin(store, "first");
    assert.equal(first.created, true);
    assert.equal(begin(store, "first").turn.id, first.turn.id);
    assert.equal(begin(store, "first").created, false);
    assert.throws(() => store.beginTurn({ idempotencyKey: "first", requestHash: "changed", sessionId: "s" }), (e: unknown) => e instanceof StoreConflictError && e.code === "idempotency_conflict");
    assert.throws(() => begin(store, "second"), (e: unknown) => e instanceof StoreConflictError && e.code === "conversation_busy");
    const id = store.saveEpisode({ ...exchange, turnId: first.turn.id, quality: "supported" });
    const retry = begin(store, "first");
    assert.equal(retry.turn.episodeId, id); assert.equal(retry.turn.status, "completed");
    assert.equal(retry.turn.quality, "supported");
    assert.equal(store.count(), 1); assert.equal(store.memoryJobCounts().pending, 1);
    const next = begin(store, "second");
    assert.equal(next.turn.sequence, first.turn.sequence + 1);
    store.failTurn(next.turn.id, "cancelled");
    assert.equal(store.getTurn(next.turn.id)!.status, "failed");
  } finally { store.close(); }
});

test("an episode write failure cannot complete its turn or enqueue enrichment", () => {
  const store = new MemoryStore(":memory:");
  try {
    const { turn } = begin(store, "failure");
    const source = { n: 1, title: "source", url: "https://example.com" };
    assert.throws(() => store.saveEpisode({ ...exchange, turnId: turn.id, sources: [source, source] }));
    assert.equal(store.count(), 0); assert.equal(store.getTurn(turn.id)!.status, "running");
    assert.deepEqual(store.memoryJobCounts(), {});
  } finally { store.close(); }
});

test("owner scoping covers durable turns, episodes, recall, source/claim detail and ledger", () => {
  const store = new MemoryStore(":memory:");
  try {
    const a = begin(store, "same-key", "a"), b = begin(store, "same-key", "b");
    const id = store.saveEpisode({ ...exchange, ownerId: "a", turnId: a.turn.id,
      sources: [{ n: 1, title: "source", url: "https://example.com" }] });
    store.enrich(id, { summary: "Cloud pricing", topics: ["cloud"], claims: [claim] }, "a");
    assert.equal(store.getTurn(a.turn.id, "b"), null); assert.equal(store.episode(id, "b"), null);
    assert.equal(store.turnForKey("same-key", "a")!.id, a.turn.id);
    assert.equal(store.turnForKey("same-key", "b")!.id, b.turn.id);
    assert.equal(store.turnForKey("same-key"), null);
    assert.equal(store.turnForKey("missing", "a"), null);
    assert.deepEqual(store.sourcesFor(id, "b"), []); assert.deepEqual(store.claimsFor(id, "b"), []);
    assert.deepEqual(store.verifiedStatementsFor(id, "b"), []); assert.deepEqual(store.ledgerPage({ ownerId: "b" }).items, []);
    assert.equal(store.count(Number.MAX_SAFE_INTEGER, "b"), 0);
    assert.equal(recall(store, "Barack Obama", new Date(1000), "UTC", new Set(), "b", { allowCrossSession: true }).related.length, 0);
    assert.equal(recall(store, "Barack Obama", new Date(1000), "UTC", new Set(), "a", { allowCrossSession: true }).related[0]!.episode.id, id);
    assert.equal(store.getTurn(b.turn.id, "b")!.status, "running");
  } finally { store.close(); }
});

test("conversation time is owner scoped and backward viewpoints preserve real sequence", () => {
  const store = new MemoryStore(":memory:");
  try {
    store.updateConversation({ sessionId: "s", mode: "era", viewpointAt: 1000 });
    store.updateConversation({ sessionId: "other", mode: "era", viewpointAt: 2000 });
    const first = store.saveEpisode({ ...exchange, askedAt: 1000 });
    const second = store.saveEpisode({ ...exchange, askedAt: 100 });
    assert.deepEqual(store.sessionHistory("s", 10).map(e => e.id), [first, second]);
    assert.equal(store.conversation("s")!.viewpointAt, 1000);
    assert.equal(store.conversation("other")!.viewpointAt, 2000);
    assert.equal(store.conversation("s", "other-owner"), null);
    assert.ok(store.episode(second)!.createdAt! >= store.episode(first)!.createdAt!);
  } finally { store.close(); }
});

test("enrichment retries keep claim IDs and foreign claim links stable", () => {
  const store = new MemoryStore(":memory:");
  try {
    const original = store.saveEpisode(exchange);
    store.enrich(original, { summary: "price", topics: [], claims: [claim] });
    const firstClaim = store.claimsFor(original)[0]!;
    const recheck = store.saveEpisode(exchange);
    store.enrich(recheck, { summary: "recheck", topics: [], claims: [{ ...claim, priorClaimId: firstClaim.id, verdict: "unverified" }] });
    store.enrich(original, { summary: "price repeated", topics: [], claims: [claim] });
    assert.equal(store.claimsFor(original)[0]!.id, firstClaim.id);
    store.enrich(original, { summary: "new extraction", topics: [], claims: [{ ...claim, value: "$20" }] });
    assert.equal(store.claimsFor(recheck)[0]!.priorClaimId, firstClaim.id);
    assert.equal(store.integrityCheck().ok, true);
  } finally { store.close(); }
});

test("outbox survives restart, expired leases reject stale commits, worker drains once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-outbox-")), path = join(dir, "memory.db");
  let store = new MemoryStore(path);
  try {
    const { turn } = begin(store, "interrupted");
    const id = store.saveEpisode({ ...exchange, answer: "x".repeat(600) });
    const abandoned = store.leaseMemoryJob(1000, 10)!;
    // The job is initially available at current wall time, not the synthetic lease clock.
    assert.equal(abandoned, null);
    const lease = store.leaseMemoryJob()!;
    store.close(); store = new MemoryStore(path);
    assert.equal(store.recoverInterruptedTurns(), 1);
    assert.equal(store.getTurn(turn.id)!.status, "interrupted");
    assert.equal(store.traceFor(turn.id)!.outcome, "interrupted");
    assert.equal(store.traceFor(turn.id)!.usageStatus, "unknown_after_restart");
    const replacement = store.leaseMemoryJob(Date.now() + 60_000)!;
    assert.equal(replacement.id, lease.id);
    assert.equal(store.completeMemoryJob(lease, { summary: "stale", topics: [], claims: [] }), false);
    store.releaseMemoryJob(replacement);
    let calls = 0;
    const llm: Llm = { stream: async () => ({ text: "", toolCalls: [] }), json: async () => { calls++; return { summary: "resumed", topics: [], claims: [] }; } };
    const worker = new Enricher(llm, store); await worker.idle(); await worker.stop();
    assert.equal(calls, 1); assert.equal(store.episode(id)!.summary, "resumed");
    assert.deepEqual(store.memoryJobCounts(), { completed: 1 });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("bounded answer-only indexing covers simulations and failed enrichment without verified claims", async () => {
  const store = new MemoryStore(":memory:");
  try {
    const id = store.saveEpisode({ ...exchange, execution: { simulation: { mode: "era" } } });
    assert.equal(recall(store, "Barack Obama", new Date(1000), "UTC", new Set(), "local", { allowCrossSession: true }).related[0]!.episode.id, id);
    assert.equal(store.termCoverage(["Obama"]).size, 0, "answer indexing is separate from audited metadata");
    assert.deepEqual(store.verifiedStatementsFor(id), []);
    const worker = new Enricher({ stream: async () => ({ text: "", toolCalls: [] }), json: async () => { throw new Error("must not extract simulation facts"); } }, store);
    await worker.idle(); await worker.stop(); assert.deepEqual(store.claimsFor(id), []);
    const long = store.saveEpisode({ ...exchange, answer: "x".repeat(12_100) + " ExcludedTailToken" });
    assert.equal(store.topicCoverage(["ExcludedTailToken"]).has(long), false);
  } finally { store.close(); }
});

test("backup restores migrations, exact cited hashes, scoped recall, pending jobs and traces", async () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-restore-")), path = join(dir, "memory.db"), dest = join(dir, "restored.db");
  const store = new MemoryStore(path);
  let restored: MemoryStore | undefined;
  try {
    const { turn } = begin(store, "restore");
    const text = "Exact cited passage.";
    const contentHash = createHash("sha256").update(text).digest("hex");
    const id = store.saveEpisode({ ...exchange, turnId: turn.id, sources: [{ n: 1, url: "https://example.com", title: "Source", text, contentHash }] });
    store.saveTrace(turn.id, "local", { status: "completed", spans: [] });
    assert.throws(() => store.saveTrace(turn.id, "local", { oversized: "x".repeat(64_001) }), /bound/);
    await store.backupTo(dest); restored = new MemoryStore(dest);
    assert.equal(restored.integrityCheck().ok, true); assert.equal(restored.getTurn(turn.id)!.episodeId, id);
    assert.equal(restored.traceFor(turn.id)!.status, "completed");
    assert.equal(restored.traceFor(turn.id, "another-owner"), null);
    assert.equal(restored.sourcesFor(id)[0]!.contentHash, contentHash);
    assert.equal(restored.integrityCheck().sources, 1);
    assert.equal(restored.memoryJobCounts().pending, 1);
    assert.equal(restored.topicCoverage(["Obama"]).size, 1);
    restored.purgeOperational(Date.now() + 1); assert.equal(restored.traceFor(turn.id), null);
    assert.equal(restored.count(), 1, "operational retention preserves immutable conversation/evidence");
  } finally { restored?.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("enrichment validates prior ownership and bounds extracted fields before storage", () => {
  const store = new MemoryStore(":memory:");
  try {
    const a = store.saveEpisode({ ...exchange, ownerId: "a" });
    store.enrich(a, { summary: "a", topics: [], claims: [claim] }, "a");
    const privateClaim = store.claimsFor(a, "a")[0]!;
    const b = store.saveEpisode({ ...exchange, ownerId: "b" });
    store.enrich(b, { summary: "x".repeat(2000), topics: ["x".repeat(200)],
      claims: [{ ...claim, entity: "e".repeat(1000), priorClaimId: privateClaim.id, verdict: "changed" }] }, "b");
    assert.equal(store.claimsFor(b, "b")[0]!.priorClaimId, null);
    assert.equal(store.claimsFor(b, "b")[0]!.verdict, "new");
    assert.equal(store.claimsFor(b, "b")[0]!.entity.length, 200);
    assert.equal(store.episode(b, "b")!.summary!.length, 1000);
  } finally { store.close(); }
});

test("worker shutdown releases unfinished leases and separately records background usage without private inputs", async () => {
  const store = new MemoryStore(":memory:");
  try {
    store.saveEpisode({ ...exchange, answer: "private-confidential-phrase ".repeat(30) });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const stalled: Llm = { stream: async () => ({ text: "", toolCalls: [] }), json: async () => {
      entered(); await new Promise<void>(() => {}); return {};
    } };
    const first = new Enricher(stalled, store); await started; await first.stop(0);
    assert.equal(store.memoryJobCounts().pending, 1);
    assert.equal(first.stats.cancellations, 1);
    assert.equal(store.traceFor("job-1-attempt-1")!.outcome, "cancelled");
    const pool = new AdmissionPool({ maxActive: 2, maxQueued: 2 });
    const gateway = createModelGateway({ stream: async () => ({ text: "", toolCalls: [] }), json: async request => {
      request.onUsage?.({ model: "test-fast", inputTokens: 12, outputTokens: 3, cachedInputTokens: 0, reasoningTokens: 0 });
      return { summary: "safe summary", topics: [], claims: [] };
    } }, { pool, onCall: call => { recordUsage(call.usage ?? undefined); recordStage("model_call", call.durationMs, { purpose: call.purpose }); } });
    const worker = new Enricher(gateway, store); await worker.idle(); await worker.stop();
    const trace = store.traceFor("job-1-attempt-2")!;
    assert.equal(trace.outcome, "completed"); assert.equal(trace.model, "test-fast");
    assert.equal((trace.usage as unknown[]).length, 1);
    assert.equal(JSON.stringify(trace).includes("private-confidential-phrase"), false);
    assert.equal(store.traceFor("job-1-attempt-2", "another-owner"), null);
    assert.deepEqual(store.memoryJobCounts(), { completed: 1 });
  } finally { store.close(); }
});

test("outbox retries are bounded and ready work alternates owners", () => {
  const store = new MemoryStore(":memory:");
  try {
    store.saveEpisode({ ...exchange, ownerId: "a" });
    store.saveEpisode({ ...exchange, ownerId: "a" });
    store.saveEpisode({ ...exchange, ownerId: "b" });
    const a = store.leaseMemoryJob()!, b = store.leaseMemoryJob()!;
    assert.equal(a.ownerId, "a"); assert.equal(b.ownerId, "b");
    store.completeMemoryJob(b, { summary: "b", topics: [], claims: [] });
    store.completeMemoryJob(a, { summary: "a", topics: [], claims: [] });
    const now = Date.now();
    for (let attempt=1;attempt<=5;attempt++) {
      const lease = store.leaseMemoryJob(now+attempt*65_000)!;
      assert.equal(lease.attempts, attempt);
      store.retryMemoryJob(lease, "enrichment_failed", now+attempt*65_000);
    }
    assert.equal(store.memoryJobCounts().dead, 1);
    assert.equal(store.leaseMemoryJob(now+1_000_000), null);
  } finally { store.close(); }
});

test("SQLite lock failures count bounded busy admission and leave transactions usable", t => {
  const dir = mkdtempSync(join(tmpdir(), "asof-busy-")), path = join(dir, "memory.db");
  const store = new MemoryStore(path), competing = new DatabaseSync(path);
  try {
    competing.exec("BEGIN IMMEDIATE");
    const start = performance.now();
    assert.throws(() => begin(store, "blocked"), /locked/);
    t.diagnostic(`SQLite busy admission elapsed=${(performance.now()-start).toFixed(1)}ms (configured busy_timeout=100ms)`);
    assert.equal(store.metrics.sqliteBusyEvents, 1);
    competing.exec("ROLLBACK");
    assert.equal(begin(store, "unblocked").created, true);
  } finally { competing.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("future schema versions fail before mutation and failed upgrades roll back all schema changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-migration-")), future = join(dir, "future.db"), failed = join(dir, "failed.db");
  try {
    const store = new MemoryStore(future); store.close();
    const db = new DatabaseSync(future); db.exec("INSERT INTO schema_migrations VALUES (999,0)"); db.close();
    const before = readFileSync(future);
    assert.throws(() => new MemoryStore(future), /newer application schema/);
    assert.deepEqual(readFileSync(future), before, "a rollback attempt must not mutate newer data");
    const legacy = new DatabaseSync(failed);
    legacy.exec(`CREATE TABLE episodes(id INTEGER PRIMARY KEY,session_id TEXT NOT NULL,asked_at INTEGER NOT NULL,tz TEXT NOT NULL,question TEXT NOT NULL,answer TEXT NOT NULL,summary TEXT,topics TEXT);
      INSERT INTO episodes VALUES (1,'s',0,'UTC','retained question','retained answer',NULL,NULL);
      CREATE TRIGGER reject_migration BEFORE UPDATE ON episodes BEGIN SELECT RAISE(ABORT,'forced migration failure'); END;`);
    const schema = legacy.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name").all(); legacy.close();
    assert.throws(() => new MemoryStore(failed), /forced migration failure/);
    const unchanged = new DatabaseSync(failed);
    try {
      assert.deepEqual(unchanged.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name").all(), schema);
      assert.equal(unchanged.prepare("SELECT answer FROM episodes").get()!.answer, "retained answer");
    } finally { unchanged.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("restart reconstructs only earlier owner-scoped prior claims and preserves completed manual enrichment", async () => {
  const store = new MemoryStore(":memory:");
  const save = (ownerId: string, askedAt: number, entity: string) => {
    const id = store.saveEpisode({ ...exchange, ownerId, askedAt });
    store.enrich(id, { summary: "manual enrichment", topics: [], claims: [{ ...claim, entity }] }, ownerId);
    return id;
  };
  try {
    const original = save("a", 100, "Cloud"); const prior = store.claimsFor(original, "a")[0]!;
    save("b", 100, "Foreign private entity"); const future = save("a", 400, "Future entity");
    const recheck = store.saveEpisode({ ...exchange, ownerId: "a", askedAt: 200, question: "Recheck Cloud pricing", answer: "Cloud still costs $10 [1].",
      sources: [{ n: 1, title: "Price", url: "https://example.com", text: "Cloud costs $10." }], execution: { intent: "verify" } });
    const later = save("a", 150, "Created after recheck");
    assert.deepEqual(store.priorClaimsForEpisode(recheck, "a").map(c => c.id), [prior.id]);
    assert.equal(store.memoryJobCounts().completed, 4);
    let called = 0;
    const worker = new Enricher({ stream: async () => ({ text: "", toolCalls: [] }), json: async request => {
      called++; assert.match(request.user, /id [0-9]+: Cloud/); assert.doesNotMatch(request.user, /Foreign private entity|Future entity|Created after recheck/);
      return { summary: "Rechecked Cloud pricing", topics: [], claims: [{ entity: "Cloud", attribute: "price", value: "$10", source: 1, prior_id: prior.id, verdict: "unchanged" }] };
    } }, store);
    await worker.idle(); await worker.stop();
    assert.equal(called, 1); assert.equal(store.claimsFor(recheck, "a")[0]!.priorClaimId, prior.id);
    assert.equal(store.claimsFor(original, "a")[0]!.id, prior.id);
    assert.equal(store.traceFor(`job-${recheck}-attempt-1`, "a")!.outcome, "completed");
    const ineligible = store.claimsFor(future, "a")[0]!.id;
    store.enrich(original, { summary: "bad prior", topics: [], claims: [{ ...claim, priorClaimId: ineligible, verdict: "changed" }] }, "a");
    assert.equal(store.claimsFor(original, "a")[0]!.priorClaimId, null);
    assert.ok(store.claimsFor(later, "a").length);
  } finally { store.close(); }
});

test("worker transient SQLite contention leaves jobs durable and recovers on the next wakeup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-worker-busy-")), path = join(dir, "memory.db");
  const store = new MemoryStore(path), competing = new DatabaseSync(path);
  let worker: Enricher | undefined;
  try {
    store.saveEpisode(exchange); competing.exec("BEGIN IMMEDIATE");
    worker = new Enricher({ stream: async () => ({ text: "", toolCalls: [] }), json: async () => ({}) }, store);
    await delay(0); assert.equal(worker.stats.leaseFailures, 1);
    assert.equal(store.memoryJobCounts().pending, 1); competing.exec("ROLLBACK");
    await worker.idle(); assert.equal(store.memoryJobCounts().completed, 1);
  } finally { await worker?.stop(); competing.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("scheduled enrichment reloads canonical owner-scoped context before sending model input", async () => {
  const store = new MemoryStore(":memory:");
  let worker: Enricher | undefined;
  try {
    const privateEpisode = store.saveEpisode({ ...exchange, ownerId: "a" });
    store.enrich(privateEpisode, { summary: "a", topics: [], claims: [{ ...claim, entity: "owner-a-secret-entity" }] }, "a");
    const foreignClaim = store.claimsFor(privateEpisode, "a")[0]!;
    const episodeId = store.saveEpisode({ ...exchange, ownerId: "b", question: "Canonical owner B question", answer: "Canonical owner B answer ".repeat(30),
      sources: [{ n: 1, title: "Canonical owner B source", url: "https://example.com/b", text: "Owner B source passage" }] });
    let calls = 0;
    worker = new Enricher({ stream: async () => ({ text: "", toolCalls: [] }), json: async request => {
      calls++; assert.match(request.user, /Canonical owner B question|Owner B source passage/);
      assert.doesNotMatch(request.user, /owner-a-secret-entity|spoofed payload/);
      return { summary: "B", topics: [], claims: [{ entity: "Cloud", attribute: "price", value: "$10", source: 1, prior_id: foreignClaim.id, verdict: "changed" }] };
    } }, store);
    worker.schedule(episodeId, { question: "spoofed payload", answer: "spoofed payload", sources: [], priorClaims: [foreignClaim] }, "b");
    await worker.idle(); assert.equal(calls, 1); assert.equal(store.claimsFor(episodeId, "b")[0]!.priorClaimId, null);
  } finally { await worker?.stop(); store.close(); }
});

test("multilingual enrichment context stays within its UTF-8 payload budget without broken surrogate pairs", async () => {
  const store = new MemoryStore(":memory:"); let worker: Enricher | undefined;
  try {
    const question = "漢".repeat(8000), answer = "🤖".repeat(10000);
    const sources = Array.from({ length: 20 }, (_, i) => ({ n: i+1, title: "漢".repeat(300), url: `https://example.com/${i}`, text: "漢".repeat(1000) }));
    const id = store.saveEpisode({ ...exchange, question, answer, sources }); let calls = 0;
    worker = new Enricher({ stream: async () => ({ text: "", toolCalls: [] }), json: async request => {
      calls++; assert.ok(Buffer.byteLength(request.user)<66_000); assert.equal(request.user.includes("�"), false);
      return { summary: "summary", topics: [], claims: [] };
    } }, store);
    worker.schedule(id, { question, answer, sources, priorClaims: [] });
    const inspection = store.leaseMemoryJob()!;
    assert.ok(Buffer.byteLength(JSON.stringify(inspection.payload)) <= 64_000);
    store.releaseMemoryJob(inspection); await worker.idle(); assert.equal(calls, 1); assert.equal(store.memoryJobCounts().completed, 1);
  } finally { await worker?.stop(); store.close(); }
});

test("bounded recall retains exact coverage ranking ahead of recency", () => {
  const store = new MemoryStore(":memory:");
  try {
    const specific = store.saveEpisode({ ...exchange, askedAt: 100, question: "alpha beta gamma", answer: "same" });
    for (let i=0;i<300;i++) store.saveEpisode({ ...exchange, askedAt: 200+i, question: "alpha beta", answer: "same" });
    const result = recall(store, "alpha beta gamma", new Date(1000), "UTC", new Set(), "local", { allowCrossSession: true });
    assert.equal(result.related[0]!.episode.id, specific); assert.equal(store.topicCoverage(["alpha", "beta", "gamma"],1000).get(specific), 3);
  } finally { store.close(); }
});

test("100k disk-backed broad-term/date recall stays SQL bounded before cutoff selection", async t => {
  const dir = mkdtempSync(join(tmpdir(), "asof-scale-")), path = join(dir, "memory.db");
  let store = new MemoryStore(path); store.close();
  const db = new DatabaseSync(path);
  db.exec(`BEGIN;
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100000)
    INSERT INTO episodes(id,session_id,asked_at,tz,question,answer,owner_id,sequence)
    SELECT i,'bulk',CASE WHEN i<=1000 THEN 100 ELSE 2000 END,'UTC','common broad topic','a','local',i FROM n;
    INSERT INTO episodes_fts(rowid,question) SELECT id,question FROM episodes;
    INSERT INTO conversation_fts(rowid,answer) SELECT id,answer FROM episodes;
    COMMIT;`); db.close(); store = new MemoryStore(path);
  try {
    const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable(); await delay(20);
    const timings: number[] = [];
    for (let i=0;i<5;i++) {
      const start = performance.now();
      const result = recall(store, "common broad topic", new Date(1000), "UTC", new Set(), "local", { allowCrossSession: true });
      timings.push(performance.now()-start);
      assert.equal(result.related.length, 3); assert.ok(result.related.every(e => e.episode.askedAt === 100));
      await delay(1);
    }
    loop.disable();
    assert.equal(store.topicCoverage(["common", "broad"], 1000).size, 256);
    assert.equal(store.episodesBetween(0, 3000, 1000).length, 100);
    const page = store.ledgerPage({ limit: 50, knownAt: 1000 });
    assert.equal(page.items.length, 50); assert.ok(page.nextCursor);
    const next = store.ledgerPage({ limit: 50, beforeId: page.nextCursor!, knownAt: 1000 });
    assert.ok(next.items.every(e => e.episode.id < page.nextCursor!));
    t.diagnostic(`100k disk-backed samples=${timings.length}; recall p95=${Math.max(...timings).toFixed(1)}ms; event-loop p95=${(loop.percentile(95)/1e6).toFixed(1)}ms; candidates<=256 date<=100`);
    const allEligible: number[] = [];
    const broadLoop = monitorEventLoopDelay({ resolution: 10 }); broadLoop.enable(); await delay(20);
    for (let i=0;i<5;i++) {
      const start = performance.now();
      const result = recall(store, "common broad topic", new Date(3000), "UTC", new Set(), "local", { allowCrossSession: true });
      allEligible.push(performance.now()-start); assert.equal(result.related.length, 3); await delay(1);
    }
    broadLoop.disable();
    t.diagnostic(`100k all-eligible broad matches samples=${allEligible.length}; recall p95=${Math.max(...allEligible).toFixed(1)}ms; event-loop p95=${(broadLoop.percentile(95)/1e6).toFixed(1)}ms; bounded returned candidates<=256`);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
