import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MemoryStore } from "../src/memory/store.ts";
import { backupDatabase, restoreDatabase, inspectDatabase, pruneDatabase } from "../scripts/ops.ts";

const exchange = { sessionId: "conversation", askedAt: 100, tz: "UTC", question: "Who was president?", answer: "Barack Obama.", sources: [] };

test("backup and clean-instance restore retain exact evidence, FTS, jobs, turns and original snapshot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "asof-ops-"));
  const path = join(directory, "source.db"), backup = join(directory, "backup.db"), destination = join(directory, "restored.db");
  const store = new MemoryStore(path);
  let restored: MemoryStore | undefined;
  try {
    const accepted = store.beginTurn({ sessionId: "conversation", idempotencyKey: "completed", requestHash: "one" }).turn;
    const text = "Barack Obama was president.", contentHash = createHash("sha256").update(text).digest("hex");
    const id = store.saveEpisode({ ...exchange, turnId: accepted.id, quality: "supported", sources: [{ n: 1, title: "Evidence", url: "https://example.com/president", text, contentHash }] });
    const pendingTurn = store.beginTurn({ sessionId: "other", idempotencyKey: "interrupted", requestHash: "two" }).turn;
    const lease = store.leaseMemoryJob(); assert.ok(lease);
    store.saveTrace(accepted.id, "local", { status: "completed", spans: [] });
    const snapshot = await backupDatabase(path, backup);
    assert.equal(snapshot.integrity.ok, true); assert.equal(snapshot.integrity.episodes, 1); assert.equal(snapshot.integrity.pendingJobs, 1);
    assert.equal(snapshot.sha256.length, 64); assert.equal(existsSync(`${backup}-wal`), false);
    assert.equal(store.getTurn(pendingTurn.id)!.status, "running", "snapshot does not recover active source turns");
    const report = await restoreDatabase(backup, destination, snapshot.sha256);
    assert.equal(report.interruptedTurns, 1);
    restored = new MemoryStore(destination);
    assert.equal(restored.getTurn(pendingTurn.id)!.status, "interrupted");
    assert.equal(restored.getTurn(accepted.id)!.episodeId, id);
    assert.equal(restored.sourcesFor(id)[0]!.contentHash, contentHash);
    assert.equal(restored.topicCoverage(["Obama"]).has(id), true);
    assert.equal(restored.memoryJobCounts().pending, 1);
    assert.equal(restored.traceFor(accepted.id)!.status, "completed");
    assert.equal(inspectDatabase(destination).ok, true);
    assert.equal(createHash("sha256").update(readFileSync(backup)).digest("hex"), snapshot.sha256, "restore never mutates its backup");
    await assert.rejects(backupDatabase(path, backup), /already exists/);
    await assert.rejects(restoreDatabase(backup, destination), /already exists/);
    const badHashTarget = join(directory, "bad-hash.db");
    await assert.rejects(restoreDatabase(backup, badHashTarget, "0".repeat(64)), /hash/);
    assert.equal(existsSync(badHashTarget), false);
  } finally { restored?.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("legacy upgrade backfills searchable conversation content without inventing creation times", async () => {
  const directory = mkdtempSync(join(tmpdir(), "asof-legacy-ops-"));
  const legacy = join(directory, "legacy.db"), backup = join(directory, "legacy-backup.db"), destination = join(directory, "upgraded.db");
  const db = new DatabaseSync(legacy);
  db.exec(`CREATE TABLE episodes(id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, asked_at INTEGER NOT NULL, tz TEXT NOT NULL,
    question TEXT NOT NULL, answer TEXT NOT NULL, summary TEXT, topics TEXT, execution_json TEXT);
    INSERT INTO episodes VALUES(1,'old',100,'UTC','Original topic','Asterism migration answer.',NULL,NULL,NULL);`); db.close();
  try {
    await backupDatabase(legacy, backup);
    const unchanged = new DatabaseSync(legacy);
    try { assert.equal(unchanged.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get(), undefined); }
    finally { unchanged.close(); }
    const originalBackup = new DatabaseSync(backup, { readOnly: true });
    try { assert.equal(originalBackup.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get(), undefined); }
    finally { originalBackup.close(); }
    await restoreDatabase(backup, destination);
    const store = new MemoryStore(destination);
    try { assert.equal(store.count(), 1); assert.equal(store.topicCoverage(["Asterism"]).has(1), true); assert.equal(store.episode(1)!.createdAt, null); assert.equal(store.integrityCheck().ok, true); }
    finally { store.close(); }
    const upgraded = new DatabaseSync(destination);
    try { assert.ok(upgraded.prepare("SELECT version FROM schema_migrations WHERE version=1").get()); }
    finally { upgraded.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("retention deletes operational records and completed jobs while preserving pending work and immutable answers", () => {
  const directory = mkdtempSync(join(tmpdir(), "asof-prune-ops-")), path = join(directory, "memory.db");
  const store = new MemoryStore(path);
  try {
    const turn = store.beginTurn({ sessionId: "conversation", idempotencyKey: "first", requestHash: "hash" }).turn;
    const id = store.saveEpisode({ ...exchange, turnId: turn.id });
    const job = store.leaseMemoryJob()!; store.completeMemoryJob(job, { summary: "summary", topics: [], claims: [] });
    store.saveTrace(turn.id, "local", { status: "completed" }); store.saveEpisode(exchange);
    const db = new DatabaseSync(path);
    db.exec("UPDATE turn_traces SET updated_at=0; UPDATE memory_jobs SET updated_at=0 WHERE state='completed'"); db.close();
    const result = pruneDatabase(path, 14);
    assert.deepEqual(result, { traces: 1, jobs: 1 }); assert.equal(store.count(), 2); assert.equal(store.episode(id)!.answer, exchange.answer); assert.equal(store.memoryJobCounts().pending, 1);
    assert.throws(() => pruneDatabase(path, 0), /days/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("operations CLI rejects missing databases and damaged evidence without publishing a restore", async () => {
  const directory = mkdtempSync(join(tmpdir(), "asof-invalid-ops-")), source = join(directory, "bad.db"), destination = join(directory, "restored.db");
  try {
    const absent = join(directory, "absent.db");
    assert.throws(() => inspectDatabase(absent), /does not exist/); assert.equal(existsSync(absent), false);
    const store = new MemoryStore(source);
    store.saveEpisode({ ...exchange, sources: [{ n: 1, title: "bad hash", url: "https://example.com", text: "passage", contentHash: "invalid" }] }); store.close();
    await assert.rejects(restoreDatabase(source, destination), /integrity/); assert.equal(existsSync(destination), false);
    const run = spawnSync(process.execPath, ["--import", "tsx", "--disable-warning=ExperimentalWarning", "scripts/ops.ts", "check", source], { encoding: "utf8" });
    assert.notEqual(run.status, 0); assert.match(run.stderr, /integrity/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
