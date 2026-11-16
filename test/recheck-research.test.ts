import assert from "node:assert/strict";
import { test } from "node:test";
import { recheckSourceQuery, completionReserveMs, lookupAllowanceMs } from "../src/agent/recheck.ts";
import { runTurn, type AgentEvent } from "../src/agent/run.ts";
import { MemoryStore, type Source } from "../src/memory/store.ts";
import type { ConversationAnchor } from "../src/agent/context.ts";
import type { Llm } from "../src/llm.ts";
import type { SearchQuery } from "../src/search.ts";

const now = new Date("2026-11-17T00:00:00Z");
const oldSource: Source = { n: 1, url: "https://example.com/price", title: "Acme pricing", text: "OLD_SAVED_TEXT costs $10." };
const freshHit = { ...oldSource, text: "Acme costs $25 monthly.", freshness: { requested: "fresh" as const, acquisition: "live" as const,
  contentFetchedAt: now.toISOString(), ageStatus: "known" as const } };
const anchor: ConversationAnchor = { episodeId: 1, ownerId: "alice", sessionId: "pricing", sequence: 1, question: "What does Acme cost?",
  answer: "Acme costs $10 [1].", answerHash: "0".repeat(64), viewpointAt: now.getTime() - 1000, createdAt: now.getTime() - 1000, truncated: false };

test("source reuse selects only cited public URLs, deduplicates and bounds the batch", () => {
  const query = recheckSourceQuery({ ...anchor, answer: "Facts [1, 2, 3, 4, 5, 6, 7, 8]." }, [
    oldSource, { ...oldSource, n: 2, url: "https://example.com/price?utm_source=old#part" },
    { ...oldSource, n: 3, url: "http://127.0.0.1/secret" },
    ...[4, 5, 6, 7, 8, 9].map(n => ({ ...oldSource, n, url: `https://example.com/${n}` })),
  ]);
  assert.deepEqual(query?.urls, [oldSource.url, "https://example.com/4", "https://example.com/5", "https://example.com/6"].sort());
  assert.equal(query?.freshness, "fresh"); assert.equal(query?.content, "highlights");
  assert.equal(recheckSourceQuery(anchor, [oldSource])?.content, "full");
  assert.doesNotMatch(JSON.stringify(query), /OLD_SAVED_TEXT/);
  assert.equal(recheckSourceQuery({ ...anchor, answer: "No citations" }, [oldSource]), undefined);
});

for (const mode of ["standard", "fast"] as const) test(`${mode} reads the pinned answer's sources before asking the model, with no planning call`, async () => {
  const store = new MemoryStore(":memory:"); const queries: SearchQuery[] = [], events: AgentEvent[] = [];
  let generations = 0;
  const id = store.saveEpisode({ ownerId: "alice", sessionId: "pricing", askedAt: now.getTime() - 1000, tz: "UTC",
    question: anchor.question, answer: anchor.answer, sources: [oldSource] });
  store.saveEpisode({ ownerId: "bob", sessionId: "pricing", askedAt: now.getTime(), tz: "UTC",
    question: "Private topic", answer: "Private [1].", sources: [{ ...oldSource, url: "https://private.example.com" }] });
  const llm: Llm = { stream: async request => {
    generations++;
    assert.equal(queries.length, 1);
    assert.match(JSON.stringify(request.messages), /Acme costs \$25/);
    assert.doesNotMatch(JSON.stringify(request.messages), /OLD_SAVED_TEXT|private\.example/);
    assert.match(JSON.stringify(request.messages), /unchanged announcement page does not establish/);
    return { text: "Acme now costs $25 monthly [1].", toolCalls: [] };
  }, json: async request => {
    const reference = JSON.parse(request.user).reference;
    return { status: "approved", issues: [], quality: "supported", referenceCheck: { episodeId: id, answerHash: reference.answerHash,
      addressesTarget: true, coverage: "complete" }, claimChecks: [{ claim: "Acme now costs $25 monthly.", sourceNumbers: [1], supported: true, applicable: true }] };
  } };
  try {
    await runTurn({ llm, store, clock: { now: () => now, simulated: false }, enricher: { schedule() {} },
      search: { search: async query => { queries.push(query); return [freshHit]; } } },
    { ownerId: "alice", sessionId: "pricing", message: "Re-check now", recheckEpisodeId: id, tz: "UTC", responseMode: mode }, event => events.push(event));
    assert.equal(generations, 1); assert.equal(queries[0]?.freshness, "fresh"); assert.deepEqual(queries[0]?.urls, [oldSource.url]);
    const done = events.find(e => e.type === "done"); assert.ok(done && done.type === "done");
    assert.equal(done.quality, "supported"); assert.equal(done.timings.searches, 1); assert.equal(done.timings.modelCalls, 2);
    assert.equal(store.sourcesFor(done.episodeId, "alice")[0]?.text, freshHit.text);
  } finally { store.close(); }
});

test("an unavailable original page leads to a targeted lookup instead of trusting its saved text", async () => {
  const store = new MemoryStore(":memory:"); const queries: SearchQuery[] = [], events: AgentEvent[] = [];
  const id = store.saveEpisode({ sessionId: "pricing", askedAt: now.getTime() - 1000, tz: "UTC", question: anchor.question,
    answer: anchor.answer, sources: [oldSource] });
  let generations = 0;
  const llm: Llm = { json: async () => { throw new Error("review offline"); }, stream: async request => {
    assert.doesNotMatch(JSON.stringify(request.messages), /OLD_SAVED_TEXT/);
    return ++generations === 1 ? { text: "", toolCalls: [{ id: "missing", type: "function", function: { name: "web_search",
      arguments: JSON.stringify({ query: "Acme current official pricing" }) } }] } : { text: "Acme costs $25 [1].", toolCalls: [] };
  } };
  try {
    await runTurn({ llm, store, clock: { now: () => now, simulated: false }, enricher: { schedule() {} }, search: { search: async query => {
      queries.push(query); return query.urls ? [] : [freshHit];
    } } }, { sessionId: "pricing", message: "Re-check now", recheckEpisodeId: id, tz: "UTC", responseMode: "fast" }, event => events.push(event));
    assert.equal(queries.length, 2); assert.equal(queries[0]?.urls?.length, 1); assert.equal(queries[1]?.urls, undefined);
    assert.equal(queries[1]?.freshness, "fresh"); assert.equal(events.at(-1)?.type, "done");
  } finally { store.close(); }
});

test("Fast source reuse counts toward the same four-lookup allowance", async () => {
  const store = new MemoryStore(":memory:"), events: AgentEvent[] = [];
  const id = store.saveEpisode({ sessionId: "pricing", askedAt: now.getTime() - 1000, tz: "UTC", question: anchor.question,
    answer: anchor.answer, sources: [oldSource] });
  let lookups = 0, generations = 0;
  const llm: Llm = { json: async () => { throw new Error("review offline"); }, stream: async request => {
    if (++generations === 1) return { text: "", toolCalls: Array.from({ length: 6 }, (_, i) => ({ id: `missing-${i}`, type: "function" as const,
      function: { name: "web_search", arguments: JSON.stringify({ query: `Missing facet ${i}` }) } })) };
    assert.equal(request.toolChoice, "none");
    assert.match(JSON.stringify(request.messages), /Search budget exhausted/);
    return { text: "Acme costs $25 [1]. Other facets remain unchecked.", toolCalls: [] };
  } };
  try {
    await runTurn({ llm, store, clock: { now: () => now, simulated: false }, enricher: { schedule() {} },
      search: { search: async () => { lookups++; return [freshHit]; } } },
    { sessionId: "pricing", message: "Re-check now", recheckEpisodeId: id, tz: "UTC", responseMode: "fast" }, event => events.push(event));
    const done = events.find(e => e.type === "done"); assert.ok(done && done.type === "done");
    assert.equal(lookups, 4); assert.equal(done.timings.searches, 4); assert.equal(generations, 2);
  } finally { store.close(); }
});

test("a lookup that ignores abort cannot consume the completion reserve or block another result", async () => {
  const store = new MemoryStore(":memory:"), events: AgentEvent[] = [];
  const keepAlive = setInterval(() => {}, 1000);
  let generations = 0, timedOut: AbortSignal | undefined;
  const llm: Llm = { json: async () => ({}), stream: async request => {
    if (++generations === 1) return { text: "", toolCalls: ["slow", "useful"].map(query => ({ id: query, type: "function" as const,
      function: { name: "web_search", arguments: JSON.stringify({ query }) } })) };
    assert.match(JSON.stringify(request.messages), /Acme costs \$25/);
    assert.match(JSON.stringify(request.messages), /could not be completed/);
    return { text: "Acme costs $25 [1]. The second detail remains unchecked.", toolCalls: [] };
  } };
  const began = performance.now();
  try {
    await runTurn({ llm, store, clock: { now: () => now, simulated: false }, enricher: { schedule() {} }, searchTimeoutMs: 25,
      search: { search: async (query, signal) => { if (query.query === "slow") { timedOut = signal; return new Promise(() => {}); } return [freshHit]; } } },
    { sessionId: "deadline", message: "Acme price and a second detail", tz: "UTC", deadlineAt: Date.now() + 1000 }, event => events.push(event));
    assert.ok(performance.now() - began < 800, "hung lookup must not consume the turn deadline");
    assert.equal(timedOut?.aborted, true); assert.ok(events.some(e => e.type === "search" && e.state === "failed"));
    assert.equal(events.at(-1)?.type, "done");
  } finally { clearInterval(keepAlive); store.close(); }
});

test("lookup budgets retain time for synthesis and required reviews", () => {
  assert.equal(completionReserveMs(120_000, true), 45_000);
  assert.equal(completionReserveMs(120_000, false), 15_000);
  assert.equal(lookupAllowanceMs({ remainingMs: 48_000, reserveMs: 45_000, fast: false, verification: true }), 3000);
  assert.equal(lookupAllowanceMs({ remainingMs: 44_000, reserveMs: 45_000, fast: false, verification: true }), 0);
  assert.equal(lookupAllowanceMs({ remainingMs: 120_000, reserveMs: 15_000, fast: false, verification: false }), 12_000);
});
