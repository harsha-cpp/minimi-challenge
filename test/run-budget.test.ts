import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn, type AgentEvent } from "../src/agent/run.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { AdmissionPool, ModelBudget, ModelQuota, createModelGateway, runWithModelContext, type ModelCallTrace } from "../src/llm/gateway.ts";
import type { Llm, ModelPurpose } from "../src/llm.ts";

function harness(options: { budget: ModelBudget; quota?: ModelQuota; pool?: AdmissionPool; deadlineReserveMs?: number; contextDeadlineMs?: number }) {
  const store = new MemoryStore(":memory:"), events: AgentEvent[] = [], started: ModelPurpose[] = [], traces: ModelCallTrace[] = [];
  let searches = 0;
  const draft = "The plan costs $25 monthly [1]. Availability remains unverified.";
  const raw: Llm = {
    async stream(request) {
      started.push(request.purpose!);
      request.onUsage?.({ model: "mock", inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0, reasoningTokens: 0 });
      if (request.purpose === "research") return { text: "", toolCalls: [{ id: "lookup", type: "function", function: { name: "web_search", arguments: '{"query":"Acme current price"}' } }] };
      assert.equal(request.purpose, "synthesis"); assert.equal(request.toolChoice, "none"); assert.deepEqual(request.tools, []);
      request.onText(draft); return { text: draft, toolCalls: [] };
    },
    async json(request) {
      started.push(request.purpose!);
      request.onUsage?.({ model: "mock", inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0, reasoningTokens: 0 });
      return { status: "approved", issues: [], quality: "supported_partial", claimChecks: [
        { claim: "The plan costs $25 monthly.", sourceNumbers: [1], supported: true, applicable: true },
      ] };
    },
  };
  const llm = createModelGateway(raw, { pool: options.pool ?? new AdmissionPool({ maxActive: 1, maxQueued: 0 }), quota: options.quota, onCall: trace => traces.push(trace) });
  const run = () => runWithModelContext({ ownerId: "local", budget: options.budget,
    deadlineAt: Date.now() + (options.contextDeadlineMs ?? 20_000), deadlineReserveMs: options.deadlineReserveMs ?? 1000 }, () => runTurn({
      llm, verifier: llm, store, clock: { now: () => new Date(), simulated: false }, enricher: { schedule() {} },
      search: { async search() { searches++; return [{ url: "https://example.com/price", title: "Official price", text: "The plan costs $25 monthly.",
        freshness: { requested: "fresh", acquisition: "live", contentFetchedAt: new Date().toISOString(), ageStatus: "known" } }]; } },
    }, { sessionId: "budget", message: "Verify the current Acme price and availability.", tz: "UTC", deadlineAt: Date.now() + 20_000 }, event => {
      if (event.type === "text") assert.equal(store.count(), 1, "buffered synthesis must be committed first");
      events.push(event);
    }));
  return { store, events, started, traces, run, get searches() { return searches; } };
}

test("exhausted research call allowance uses reserved synthesis and review for a supported partial completion", async () => {
  const budget = new ModelBudget({ maxCalls: 3, maxTokens: 100_000, reserveCalls: 2 });
  const h = harness({ budget });
  try {
    await h.run();
    assert.deepEqual(h.started, ["research", "synthesis", "review"]); assert.equal(h.searches, 1);
    assert.equal(h.events.some(event => event.type === "error"), false);
    const done = h.events.find(event => event.type === "done"); assert.ok(done && done.type === "done");
    assert.equal(done.quality, "supported_partial"); assert.equal(h.store.count(), 1);
    assert.equal(h.events.filter(event => event.type === "text").length, 1);
    assert.match(h.store.episode(done.episodeId)!.answer, /Availability remains unverified/);
    assert.equal(h.traces.filter(trace => trace.providerStarted).length, 3);
    assert.equal(h.traces.filter(trace => !trace.providerStarted && trace.purpose === "research").length, 1);
    assert.equal(budget.snapshot.calls, 3); assert.equal(budget.snapshot.missingUsageCalls, 0);
  } finally { h.store.close(); }
});

test("account research headroom preserves synthesis and review instead of starving a researched answer", async () => {
  const quota = new ModelQuota({ requestsPerMinute: 3, tokensPerMinute: 100_000, completionRequests: 2, completionTokens: 40_000 });
  const h = harness({ budget: new ModelBudget(), quota });
  try {
    await h.run();
    assert.deepEqual(h.started, ["research", "synthesis", "review"]); assert.equal(quota.stats.requests, 3);
    assert.equal(h.events.at(-1)?.type, "done");
    const done = h.events.find(event => event.type === "done"); assert.ok(done && done.type === "done"); assert.equal(done.quality, "supported_partial");
    const blocked = h.traces.find(trace => trace.outcome === "budget"); assert.ok(blocked); assert.equal(blocked.providerStarted, false);
  } finally { h.store.close(); }
});

test("research deadline reserve can finish as explicitly unverified without another lookup", async () => {
  const h = harness({ budget: new ModelBudget(), contextDeadlineMs: 5000, deadlineReserveMs: 10_000 });
  try {
    await h.run();
    assert.deepEqual(h.started, ["synthesis"]); assert.equal(h.searches, 0);
    assert.equal(h.events.at(-1)?.type, "done");
    assert.match(h.store.episode(1)!.answer, /couldn't verify/); assert.doesNotMatch(h.store.episode(1)!.answer, /\$25/);
    assert.equal(h.store.episode(1)!.quality, "explicitly_unverified");
    assert.equal(h.traces[0]!.providerStarted, false); assert.equal(h.traces[0]!.outcome, "deadline");
  } finally { h.store.close(); }
});

test("a global busy queue is not retried as synthesis and an impossible final budget does not loop", async () => {
  const pool = new AdmissionPool({ maxActive: 1, maxQueued: 0 }), release = await pool.acquire({ ownerId: "occupied" });
  const busy = harness({ budget: new ModelBudget(), pool });
  try {
    await busy.run(); assert.deepEqual(busy.started, []); assert.equal(busy.traces.length, 1); assert.equal(busy.store.count(), 0);
    const error = busy.events.find(event => event.type === "error"); assert.ok(error && error.type === "error"); assert.equal(error.code, "admission_busy");
  } finally { release(); busy.store.close(); }
  const exhausted = harness({ budget: new ModelBudget({ maxCalls: 1, reserveCalls: 0 }) });
  try {
    await exhausted.run(); assert.deepEqual(exhausted.started, ["research"]); assert.equal(exhausted.traces.length, 3);
    assert.deepEqual(exhausted.traces.map(trace => trace.purpose), ["research", "research", "synthesis"]);
    assert.equal(exhausted.store.count(), 0); assert.equal(exhausted.events.at(-1)?.type, "error");
  } finally { exhausted.store.close(); }
});
