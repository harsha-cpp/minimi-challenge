import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore } from "../src/memory/store.ts";
import { recall, renderMemory } from "../src/memory/recall.ts";
import { conceptMatches, memoryConcepts, MEMORY_RETRIEVAL_LIMITS } from "../src/memory/concepts.ts";

const now = new Date("2026-11-16T12:00:00Z");
const save = (store: MemoryStore, question: string, patch = {}) => store.saveEpisode({ sessionId: "current", ownerId: "alice", askedAt: Date.parse("2026-11-09T10:00:00Z"), tz: "UTC", question, answer: "A historical conversation record, not current evidence.", sources: [], ...patch });
const retrieve = (store: MemoryStore, message: string, cross = false) => recall(store, message, now, "UTC", new Set(), "alice", { sessionId: "current", allowCrossSession: cross });

test("bounded aliases retrieve CRM and Postgres paraphrases without embedding calls", () => {
  const store = new MemoryStore(":memory:");
  try {
    const crm = save(store, "Compare CRM options for a team.");
    const pg = save(store, "Which PostgreSQL provider did we choose?");
    save(store, "Explain customer service etiquette.");
    assert.deepEqual(retrieve(store, "What did we discuss about customer relationship management?").related.map(row => row.episode.id), [crm]);
    assert.deepEqual(retrieve(store, "Recall our hosted database discussion.").related.map(row => row.episode.id), [pg]);
    assert.equal(retrieve(store, "Recall our hosted database discussion.").retrieval?.method, "lexical-concepts");
    assert.equal(conceptMatches("CRM CRMs customer relationship management customer management sales tools", memoryConcepts("CRM")), 1);
  } finally { store.close(); }
});

test("near-tied conversations remain explicit alternatives rather than a recency-selected subject", () => {
  const store = new MemoryStore(":memory:");
  try {
    const earlier = save(store, "CRM selection for a tiny team", { sessionId: "first" });
    const later = save(store, "CRM selection for a large team", { sessionId: "second", askedAt: Date.parse("2026-11-12T10:00:00Z") });
    const result = retrieve(store, "Which customer management tool did we discuss?", true);
    assert.deepEqual(new Set(result.ambiguity?.episodeIds), new Set([earlier, later]));
    assert.match(renderMemory(result, "UTC"), /Present these as alternatives and ask which conversation the user means/);
    assert.match(renderMemory(result, "UTC"), /Recency or a small ranking difference is not permission/);
  } finally { store.close(); }
});

test("alias expansion cannot bypass owner, session, requested date or viewpoint boundaries", () => {
  const store = new MemoryStore(":memory:");
  try {
    const current = save(store, "CRM comparison");
    const other = save(store, "CRM shortlist", { sessionId: "other" });
    save(store, "CRM private record", { ownerId: "bob" });
    save(store, "CRM future record", { askedAt: Date.parse("2026-11-20T10:00:00Z") });
    const message = "Recall the customer management discussion";
    assert.deepEqual(retrieve(store, message).related.map(row => row.episode.id), [current]);
    assert.deepEqual(new Set(retrieve(store, message, true).related.map(row => row.episode.id)), new Set([current, other]));
    assert.deepEqual(recall(store, message, now, "UTC", new Set(), "alice").related, []);
    assert.deepEqual(recall(store, message, now, "UTC", new Set(), "alice", { allowCrossSession: true, disabled: true }).related, []);
    const dated = retrieve(store, "What customer management question did I ask on 3 November?", true);
    assert.deepEqual(dated.related, []); assert.equal(dated.refs.flatMap(ref => ref.hits).length, 0);
    assert.doesNotMatch(renderMemory(dated, "UTC"), /CRM comparison|CRM shortlist|private record|future record/);
  } finally { store.close(); }
});

test("expansion is bounded and reports omitted near-ties instead of hiding ambiguity", () => {
  const store = new MemoryStore(":memory:");
  try {
    for (let index = 0; index < 230; index++) save(store, "CRM option " + index);
    const result = retrieve(store, "Recall the customer management tools");
    assert.ok(result.retrieval!.candidates <= MEMORY_RETRIEVAL_LIMITS.candidateIds);
    assert.equal(result.related.length, 3); assert.ok(result.ambiguity!.additionalCandidates > 0);
    assert.match(renderMemory(result, "UTC"), /additional matching records are omitted/);
  } finally { store.close(); }
});
