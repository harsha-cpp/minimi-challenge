import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchCheckpoints, RESEARCH_CHECKPOINT_TTL_MS, type ResearchCheckpoint } from "../src/runtime/research-checkpoints.ts";

const now = Date.parse("2026-11-17T12:00:00Z");
const example = (): ResearchCheckpoint => ({ version: 1, ownerId: "owner-a", turnId: "turn-a", sessionId: "session-a",
  requestHash: "a".repeat(64), contextHash: "b".repeat(64), policyHash: "c".repeat(64),
  createdAt: now, expiresAt: now + RESEARCH_CHECKPOINT_TTL_MS, effectiveAt: new Date(now).toISOString(),
  request: { sessionId: "session-a", message: "Verify the Acme price", mode: "live", asOf: null, tz: "UTC", responseMode: "fast" },
  progress: { stage: "researched", messages: [{ role: "system", content: "Private instructions" }], sources: [{ n: 1, url: "https://example.com/pricing", title: "Price", text: "$25 monthly" }], searches: 1, modelCalls: 1 },
  usage: { calls: 1, tokens: 500, spendUsd: 0.01 },
});

test("research checkpoint survives reopening and remains owner and conversation scoped", () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-checkpoint-")), path = join(dir, "app.db");
  let store = new ResearchCheckpoints(path, () => now);
  try {
    store.save(example()); store.close(); store = new ResearchCheckpoints(path, () => now + 1000);
    assert.deepEqual(store.get("turn-a", "owner-a"), example());
    assert.equal(store.get("turn-a", "owner-b"), null);
    assert.equal(store.get("unknown", "owner-a"), null);
    assert.throws(() => store.save({ ...example(), sessionId: "other", request: { ...example().request, sessionId: "other" } }), /conversation changed/);
    assert.deepEqual(store.get("turn-a", "owner-a"), example());
    store.remove("turn-a", "owner-b"); assert.ok(store.get("turn-a", "owner-a"));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("research expiration cannot be extended by repeated updates", () => {
  let clock = now;
  const store = new ResearchCheckpoints(":memory:", () => clock);
  try {
    store.save(example()); clock += 60_000;
    store.save({ ...example(), createdAt: clock, expiresAt: clock + RESEARCH_CHECKPOINT_TTL_MS });
    assert.equal(store.get("turn-a", "owner-a")!.expiresAt, now + RESEARCH_CHECKPOINT_TTL_MS);
    clock = now + RESEARCH_CHECKPOINT_TTL_MS;
    assert.equal(store.get("turn-a", "owner-a"), null);
    store.purge(); assert.equal(store.get("turn-a", "owner-a"), null);
  } finally { store.close(); }
});

test("checkpoint rejects oversized, incomplete or inconsistent persisted state", () => {
  const store = new ResearchCheckpoints(":memory:", () => now);
  try {
    for (const invalid of [
      { ...example(), policyHash: "not-a-hash" },
      { ...example(), expiresAt: now + RESEARCH_CHECKPOINT_TTL_MS + 1 },
      { ...example(), progress: { ...example().progress, stage: "reviewed" } },
      { ...example(), progress: { ...example().progress, messages: [{ role: "system", content: "x".repeat(300_000) }] } },
      { ...example(), progress: { ...example().progress, sources: [example().progress.sources[0]!, example().progress.sources[0]!] } },
      { ...example(), usage: { calls: -1, tokens: 100, spendUsd: 0 } },
    ]) assert.throws(() => store.save(invalid as ResearchCheckpoint), /Invalid research checkpoint/);
    assert.equal(store.get("turn-a", "owner-a"), null);
  } finally { store.close(); }
});

test("idempotent resumption identity survives evidence expiration without retaining raw research", () => {
  let clock = now;
  const store = new ResearchCheckpoints(":memory:", () => clock);
  try {
    store.save(example());
    store.recordResumption({ ownerId: "owner-a", idempotencyKey: "resume-key", turnId: "turn-b", fromTurnId: "turn-a", request: example().request });
    clock += RESEARCH_CHECKPOINT_TTL_MS + 1; store.purge();
    assert.equal(store.get("turn-a", "owner-a"), null);
    const saved = store.resumption("resume-key", "owner-a")!;
    assert.equal(saved.turnId, "turn-b");
    assert.deepEqual(saved.request, example().request);
    assert.equal(store.resumption("resume-key", "owner-b"), null);
    assert.doesNotMatch(JSON.stringify(saved), /Private instructions|\$25/);
  } finally { store.close(); }
});
