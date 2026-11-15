import assert from "node:assert/strict";
import { test } from "node:test";
import { recall, renderMemory } from "../src/memory/recall.ts";
import { MemoryStore } from "../src/memory/store.ts";

const MAY = new Date("2026-05-15T12:00:00Z"), NOV = Date.parse("2026-11-15T12:00:00Z");
function save(store: MemoryStore, sessionId: string, askedAt: number, question: string, answer = "answer", ownerId = "alice") {
  return store.saveEpisode({ sessionId, ownerId, askedAt, tz: "UTC", question, answer, sources: [] });
}

test("the visible current conversation survives a backward viewpoint and stays pinned to its durable sequence", () => {
  const store = new MemoryStore(":memory:");
  try {
    const old = save(store, "cricket", Date.parse("2025-01-01T00:00:00Z"), "Verify these IPL claims now", "IPL winners to verify now.");
    const kimi = save(store, "models", NOV, "Compare Kimi and Claude model capabilities", "Kimi and Claude were compared.");
    const followup = save(store, "models", NOV + 1, "Which model did you recommend?", "The recommendation concerned Kimi and Claude.");
    assert.deepEqual(store.sessionHistory("models", 8, MAY.getTime(), "alice"), [], "legacy as-of reads keep their cutoff contract");
    assert.deepEqual(store.currentConversationHistory("models", 8, "alice").map(e => e.id), [kimi, followup]);
    const turn = store.beginTurn({ ownerId: "alice", sessionId: "models", idempotencyKey: "verify", requestHash: "verification", viewpointAt: MAY.getTime(), mode: "era" }).turn;
    store.saveEpisode({ sessionId: "models", ownerId: "alice", turnId: turn.id, askedAt: MAY.getTime(), question: "verify your claims now", answer: "A later persisted verification result.", tz: "UTC", sources: [] });
    save(store, "models", NOV + 2, "A still later same-session exchange");
    save(store, "models", NOV, "Private Bob model discussion", "Bob only", "bob");
    const pinned = store.currentConversationHistory("models", 8, "alice", turn.sequence);
    assert.deepEqual(pinned.map(e => e.id), [kimi, followup]);
    assert.ok(pinned.every(e => e.sessionId === "models" && e.ownerId === "alice" && e.id !== old));
    assert.equal(store.currentConversationHistory("models", 8).length, 0, "local context cannot read another authenticated owner's chat");
    assert.deepEqual(store.currentConversationHistory("models", 8, "alice", 1), []);
  } finally { store.close(); }
});

test("generic verification words cannot choose an unrelated remembered subject", () => {
  const store = new MemoryStore(":memory:");
  try {
    save(store, "cricket", Date.parse("2025-01-01T00:00:00Z"), "Verify these claims now", "IPL winners and claims to check now.");
    for (const message of ["verify your claims now", "confirm your claim", "recheck verified facts", "check your statements now", "confirm what you claimed"]) {
      const result = recall(store, message, MAY, "UTC", new Set(), "alice", { allowCrossSession: true });
      assert.deepEqual(result.related, [], message); assert.deepEqual(result.refs, [], message);
    }
  } finally { store.close(); }
});

test("disabled recall does not query any storage path", () => {
  const query = () => { throw new Error("disabled recall touched storage"); };
  const store = new Proxy({}, { get: () => query }) as MemoryStore;
  const result = recall(store, "verify your claims today", MAY, "UTC", new Set(), "alice", { sessionId: "models", disabled: true });
  assert.deepEqual(result.refs, []); assert.deepEqual(result.related, []);
});

test("omitting conversation scope fails closed before querying storage", () => {
  const query = () => { throw new Error("unscoped recall touched storage"); };
  const store = new Proxy({}, { get: () => query }) as MemoryStore;
  for (const scope of [undefined, {}, { allowCrossSession: false }, { sessionId: "" }]) {
    const result = recall(store, "What did I ask on 1 May about Postgres hosting?", MAY, "UTC", new Set(), "alice", scope);
    assert.deepEqual(result.refs, []); assert.deepEqual(result.related, []);
    assert.equal(renderMemory(result, "UTC"), "");
  }
});

test("active-session recall is isolated by default and cross-session recall requires explicit opt in", () => {
  const store = new MemoryStore(":memory:");
  try {
    const other = save(store, "other", Date.parse("2026-05-01T00:00:00Z"), "Postgres hosting pricing", "Other conversation about Postgres hosting pricing.");
    const scoped = recall(store, "postgres hosting pricing", MAY, "UTC", new Set(), "alice", { sessionId: "models" });
    assert.deepEqual(scoped.related, []);
    const enabled = recall(store, "postgres hosting pricing", MAY, "UTC", new Set(), "alice", { sessionId: "models", allowCrossSession: true });
    assert.deepEqual(enabled.related.map(item => item.episode.id), [other]);
    assert.equal(enabled.related[0]!.conversation, "other");
    assert.match(renderMemory(enabled, "UTC"), /OTHER CONVERSATION \(only for the explicit memory request\)/);
    const blockedWithoutIdentity = recall(store, "postgres hosting pricing", MAY, "UTC", new Set(), "alice", { allowCrossSession: false });
    assert.deepEqual(blockedWithoutIdentity.related, []);
    assert.deepEqual(recall(store, "postgres hosting pricing", MAY, "UTC", new Set(), "alice").related, []);
    const explicitWithoutActiveSession = recall(store, "postgres hosting pricing", MAY, "UTC", new Set(), "alice", { allowCrossSession: true });
    assert.deepEqual(explicitWithoutActiveSession.related.map(item => item.episode.id), [other]);
    assert.deepEqual(recall(store, "postgres hosting pricing", MAY, "UTC", new Set(), "bob", { sessionId: "models", allowCrossSession: true }).related, []);
  } finally { store.close(); }
});

test("session filtering precedes bounded topic/date selection and nearest suggestions", () => {
  const store = new MemoryStore(":memory:");
  try {
    for (let i = 0; i < 300; i++) save(store, "other", Date.parse("2026-05-14T01:00:00Z") + i, "orion hosting pricing");
    const current = save(store, "models", Date.parse("2026-05-14T12:00:00Z"), "orion hosting pricing");
    save(store, "other", Date.parse("2026-05-14T23:00:00Z"), "orion hosting pricing newest");
    save(store, "models", Date.parse("2026-05-16T00:00:00Z"), "orion hosting pricing future");
    assert.deepEqual([...store.topicCoverage(["orion", "hosting", "pricing"], MAY.getTime(), "alice", "models").keys()], [current]);
    const topic = recall(store, "orion hosting pricing", MAY, "UTC", new Set(), "alice", { sessionId: "models" });
    assert.deepEqual(topic.related.map(e => e.episode.id), [current]); assert.equal(topic.related[0]!.conversation, "current");
    assert.match(renderMemory(topic, "UTC"), /current conversation record/);
    const date = recall(store, "What did I ask yesterday?", MAY, "UTC", new Set(), "alice", { sessionId: "models" });
    assert.deepEqual(date.refs[0]!.hits[0]!.episodes.map(e => e.episode.id), [current]);
    const before = Date.parse("2026-05-14T00:00:00Z"), after = Date.parse("2026-05-15T00:00:00Z");
    assert.deepEqual(store.episodesBetween(before, after, MAY.getTime(), "alice", 1, "models").map(e => e.id), [current]);
    assert.deepEqual(store.neighbours(Date.parse("2026-05-13T00:00:00Z"), Date.parse("2026-05-14T00:00:00Z"), MAY.getTime(), "alice", "models").map(e => e.id), [current]);
    assert.ok(date.refs.flatMap(r => r.hits.flatMap(h => h.episodes)).every(e => e.episode.sessionId === "models"));
  } finally { store.close(); }
});
