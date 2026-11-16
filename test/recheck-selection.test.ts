import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn, type AgentEvent } from "../src/agent/run.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { recall } from "../src/memory/recall.ts";
import type { Llm } from "../src/llm.ts";

const now = new Date("2026-11-15T12:00:00Z");
const message = "What did we discuss earlier, and is it still correct?";

test("ordinary weekly news keeps its sourced answer without a verification-only reviewer", async () => {
  const store = new MemoryStore(":memory:");
  let calls = 0;
  const answer = "Acme announced a new AI model this week [1].";
  const llm: Llm = {
    stream: async request => {
      if (calls++ === 0) return { text: "", toolCalls: [{ id: "search", type: "function", function: { name: "web_search", arguments: '{"query":"AI news this week"}' } }] };
      request.onText(answer);
      return { text: answer, toolCalls: [] };
    },
    json: async () => { throw new Error("Ordinary news does not need the verification-only reviewer"); },
  };
  try {
    const events: AgentEvent[] = [];
    await runTurn({ store, llm, clock: { now: () => now, simulated: false }, enricher: { schedule() {} },
      search: { search: async () => [{ url: "https://example.com/news", title: "Acme announcement", text: "Acme announced a new AI model this week." }] } },
    { sessionId: "news", message: "What changed in AI this week?", tz: "UTC" }, event => events.push(event));
    const done = events.find(event => event.type === "done"); assert.ok(done && done.type === "done");
    assert.equal(store.episode(done.episodeId)!.answer, answer);
    assert.equal(done.timings.modelCalls, 2); assert.equal(done.cited.length, 1);
    assert.ok(events.some(event => event.type === "text" && event.delta === answer));
    assert.ok(!events.some(event => event.type === "verification"));
  } finally { store.close(); }
});

test("empty personal history and repeated attempts explain the gap without paid research", async () => {
  const store = new MemoryStore(":memory:");
  store.saveEpisode({ ownerId: "someone-else", sessionId: "private", askedAt: now.getTime(), tz: "UTC", question: "Private subject", answer: "Private facts", sources: [] });
  const forbidden = async (): Promise<never> => { throw new Error("Empty history must not call a provider"); };
  try {
    for (let i = 0; i < 2; i++) {
      const events: AgentEvent[] = [];
      await runTurn({ store, llm: { json: forbidden, stream: forbidden }, search: { search: forbidden },
        clock: { now: () => now, simulated: false }, enricher: { schedule() {} } },
      { ownerId: "visitor", sessionId: "fresh", message, tz: "UTC" }, event => events.push(event));
      const done = events.find(event => event.type === "done"); assert.ok(done && done.type === "done");
      assert.equal(done.quality, "non_factual"); assert.equal(done.timings.modelCalls, 0);
      const answer = store.episode(done.episodeId, "visitor")!.answer;
      assert.match(answer, /matching earlier discussion/); assert.doesNotMatch(answer, /check remains unresolved|Private facts/);
    }
  } finally { store.close(); }
});

test("generic personal recall can find this owner's recent chat without guessing a topic", () => {
  const store = new MemoryStore(":memory:");
  try {
    const id = store.saveEpisode({ ownerId: "visitor", sessionId: "old", askedAt: now.getTime() - 1000, tz: "UTC", question: "Compare CRM tools", answer: "We shortlisted CRM tools.", sources: [] });
    store.saveEpisode({ ownerId: "someone-else", sessionId: "old", askedAt: now.getTime(), tz: "UTC", question: "Private", answer: "Secret", sources: [] });
    const result = recall(store, message, now, "UTC", new Set(), "visitor", { sessionId: "fresh", allowCrossSession: true, allowRecent: true });
    assert.deepEqual(result.related.map(item => item.episode.id), [id]);
  } finally { store.close(); }
});

test("explicit re-check selects the clicked answer beyond the recent history window", async () => {
  const store = new MemoryStore(":memory:");
  const original = store.saveEpisode({ sessionId: "prices", askedAt: now.getTime() - 1000, tz: "UTC", question: "What is Acme's price?", answer: "Acme costs $25 monthly.", sources: [] });
  for (let i = 0; i < 10; i++) store.saveEpisode({ sessionId: "prices", askedAt: now.getTime(), tz: "UTC", question: "Unrelated Zeta news", answer: "Zeta costs $99.", sources: [] });
  let calls = 0;
  const llm: Llm = {
    stream: async request => {
      const text = JSON.stringify(request.messages);
      assert.match(text, /Acme/); assert.doesNotMatch(text, /Zeta/);
      return calls++ === 0 ? { text: "", toolCalls: [{ id: "search", type: "function", function: { name: "web_search", arguments: '{"query":"Acme official current price"}' } }] }
        : { text: "Acme costs $25 monthly [1].", toolCalls: [] };
    },
    json: async request => {
      const reference = JSON.parse(request.user).reference;
      assert.equal(reference.episodeId, original);
      return { status: "approved", issues: [], quality: "supported", referenceCheck: { episodeId: original, answerHash: reference.answerHash, addressesTarget: true, coverage: "complete" },
        claimChecks: [{ claim: "Acme costs $25 monthly.", sourceNumbers: [1], supported: true, applicable: true }] };
    },
  };
  try {
    const events: AgentEvent[] = [];
    await runTurn({ store, llm, clock: { now: () => now, simulated: false }, enricher: { schedule() {} },
      search: { search: async () => [{ url: "https://example.com/pricing", title: "Acme pricing", text: "Acme costs $25 monthly." }] } },
    { sessionId: "prices", message: 'Re-check your answer to “What is Acme\'s price?” using current sources. What has changed?', recheckEpisodeId: original, tz: "UTC" }, event => events.push(event));
    const done = events.find(event => event.type === "done"); assert.ok(done && done.type === "done");
    assert.equal(done.quality, "supported"); assert.match(store.episode(done.episodeId)!.answer, /Acme costs/);
    assert.equal((store.episode(done.episodeId)!.execution!.requestContext as { anchorEpisodeId: number }).anchorEpisodeId, original);
  } finally { store.close(); }
});

test("explicit historical selection verifies only that record inside the current chat", async () => {
  const store = new MemoryStore(":memory:");
  const original = store.saveEpisode({ ownerId: "alice", sessionId: "old", askedAt: now.getTime() - 1000, tz: "UTC",
    question: "What is Acme's price?", answer: "Acme costs $25 monthly [1].", sources: [{ n: 1, url: "https://example.com/pricing", title: "Acme pricing", text: "STALE SOURCE MUST NOT BECOME FRESH EVIDENCE" }] });
  for (const sessionId of ["old", "current"]) store.saveEpisode({ ownerId: "alice", sessionId, askedAt: now.getTime(), tz: "UTC", question: "UNRELATED PRIVATE SUBJECT", answer: "UNRELATED PRIVATE ANSWER", sources: [] });
  let searches = 0;
  const llm: Llm = {
    stream: async request => {
      assert.ok(!request.tools?.some(tool => tool.function.name === "ask_clarification"));
      const text = JSON.stringify(request.messages);
      assert.match(text, /Acme costs \$25 monthly/); assert.doesNotMatch(text, /UNRELATED PRIVATE|STALE SOURCE/);
      return { text: "Acme costs $25 monthly [1].", toolCalls: [] };
    },
    json: async request => {
      const { reference } = JSON.parse(request.user);
      assert.equal(reference.episodeId, original); assert.equal(reference.sessionId, "old");
      return { status: "approved", issues: [], quality: "supported", referenceCheck: { episodeId: original, answerHash: reference.answerHash, addressesTarget: true, coverage: "complete" },
        claimChecks: [{ claim: "Acme costs $25 monthly.", sourceNumbers: [1], supported: true, applicable: true }] };
    },
  };
  try {
    const events: AgentEvent[] = [];
    await runTurn({ store, llm, clock: { now: () => now, simulated: false }, enricher: { schedule() {} }, questions: { create() { throw new Error("Selected topic must remain pinned rather than start unbound clarification"); } },
      search: { search: async () => { searches++; return [{ url: "https://example.com/pricing", title: "Acme pricing", text: "Acme costs $25 monthly." }]; } } },
    { ownerId: "alice", sessionId: "current", message: "Verify your earlier pricing recommendations.", memoryReferenceEpisodeId: original, tz: "UTC" }, event => events.push(event));
    const done = events.find(event => event.type === "done"); assert.ok(done && done.type === "done", JSON.stringify(events));
    const saved = store.episode(done.episodeId, "alice")!;
    assert.equal(done.quality, "supported"); assert.ok(searches > 0);
    assert.equal(saved.sessionId, "current"); assert.equal(saved.question, "Verify your earlier pricing recommendations."); assert.equal(saved.askedAt, now.getTime());
    assert.equal(saved.execution!.memoryReferenceEpisodeId, original);
    assert.equal((saved.execution!.requestContext as { referenceScope: string }).referenceScope, "selected_memory");
    assert.equal(store.currentConversationHistory("old", 20, "alice").length, 2);
  } finally { store.close(); }
});
