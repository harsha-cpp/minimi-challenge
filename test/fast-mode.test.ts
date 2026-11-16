import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn, type AgentEvent } from "../src/agent/run.ts";
import { FAST_LIMITS } from "../src/agent/response-mode.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { QuestionStore } from "../src/memory/questions.ts";
import { createApplication } from "../src/server.ts";
import type { Config } from "../src/config.ts";
import type { Llm } from "../src/llm.ts";

const now = new Date("2026-11-16T12:00:00Z");
const lookup = (id: number) => ({ id: `s${id}`, type: "function" as const, function: { name: "web_search", arguments: JSON.stringify({ query: `official price ${id}` }) } });
const hit = { url: "https://example.com/price", title: "Price", text: "Acme costs $25 monthly.", freshness: { requested: "fresh" as const, acquisition: "live" as const, ageStatus: "known" as const, contentFetchedAt: now.toISOString() } };
const answer = "Acme costs $25 monthly [1].";
const decode = async (response: Response) => (await response.text()).split("\n\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
const settings = (): Config => ({ port: 0, host: "127.0.0.1", dbPath: ":memory:", temporalDbPath: ":memory:", llm: null, exaApiKey: null,
  startAt: null, missing: [], retrievalProfiles: false, access: { mode: "local", allowedOrigins: [], ownerTokens: {} },
  limits: { activeTurns: 2, queuedTurns: 3, activeModels: 1, queuedModels: 4, modelRequestsPerMinute: 1000, modelTokensPerMinute: 1_000_000,
    turnTimeoutMs: 3000, turnTokens: 100_000, turnModelCalls: 10, maxOutputTokens: 4096, shutdownMs: 100, traceRetentionDays: 14,
    maxTurnDollars: 1, inputDollarsPerMillion: null, outputDollarsPerMillion: null } });

test("Fast bounds research to four lookups in one round and retains the full verification gate", async () => {
  const store = new MemoryStore(":memory:");
  let calls = 0, searches = 0, reviews = 0;
  const llm: Llm = { json: async () => { throw new Error("Fast generator must not replace the verifier"); }, stream: async request => {
    assert.equal(request.maxOutputTokens, FAST_LIMITS.outputTokens);
    assert.match(JSON.stringify(request.messages), /user selected Fast mode/);
    if (calls++ === 0) return { text: "", toolCalls: Array.from({ length: 6 }, (_, i) => lookup(i)) };
    assert.equal(request.toolChoice, "none"); assert.deepEqual(request.tools, []);
    return { text: answer, toolCalls: [] };
  } };
  try {
    const events: AgentEvent[] = [];
    await runTurn({ store, llm, clock: { now: () => now, simulated: false }, enricher: { schedule() {} },
      search: { search: async query => { searches++; assert.equal(query.freshness, "fresh"); return [hit]; } },
      verifier: { json: async () => { reviews++; return { status: "approved", issues: [], quality: "supported", claimChecks: [{ claim: "Acme price", sourceNumbers: [1], supported: true, applicable: true }] }; } } },
    { sessionId: "fast", message: "Verify Acme's current price", tz: "UTC", responseMode: "fast" }, event => events.push(event));
    const done = events.find(e => e.type === "done"); assert.ok(done && done.type === "done");
    assert.equal(searches, 4); assert.equal(calls, 2); assert.equal(reviews, 1);
    assert.equal(done.quality, "supported"); assert.equal(store.episode(done.episodeId)!.execution!.responseMode, "fast");
  } finally { store.close(); }
});

for (const approved of [true, false]) {
  test(`HTTP Fast escalates rejected drafts to the main model and requires approval=${approved}`, async () => {
    const store = new MemoryStore(":memory:");
    let fastCalls = 0, repairs = 0, reviews = 0;
    const rejected = { status: "needs_revision", issues: [{ code: "unsupported_claim", detail: "The price is incorrect." }] };
    const llm: Llm = {
      json: async () => ++reviews === 1 || !approved ? rejected : { status: "approved", issues: [], quality: "supported",
        claimChecks: [{ claim: "Acme costs $25 monthly", sourceNumbers: [1], supported: true, applicable: true }] },
      stream: async request => {
        repairs++;
        assert.equal(request.purpose, "repair");
        assert.equal(request.toolChoice, "none");
        assert.equal(request.maxOutputTokens, FAST_LIMITS.outputTokens);
        return { text: answer, toolCalls: [] };
      },
    };
    const fastLlm: Llm = { json: async () => { throw new Error("Fast must not review"); }, stream: async request => {
      assert.notEqual(request.purpose, "repair");
      return ++fastCalls === 1 ? { text: "", toolCalls: [lookup(1)] } : { text: "Acme costs $50 monthly [1].", toolCalls: [] };
    } };
    const app = createApplication({ config: settings(), store, deps: { llm, fastLlm, store, clock: { now: () => now, simulated: false },
      search: { search: async () => [hit] }, enricher: { schedule() {} } } });
    app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
    const address = app.server.address(); assert.ok(address && typeof address !== "string");
    try {
      const events = await decode(await fetch(`http://127.0.0.1:${address.port}/api/chat`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "repair", message: "Verify Acme's current price", tz: "UTC", mode: "live", responseMode: "fast" }) }));
      const done = events.find(e => e.type === "done"); assert.ok(done);
      assert.equal(fastCalls, 2); assert.equal(repairs, 1); assert.equal(reviews, 2);
      assert.equal(done.quality, approved ? "supported" : "explicitly_unverified");
      assert.equal(store.episode(done.episodeId)!.answer === answer, approved);
    } finally { await app.shutdown(); }
  });
}

for (const recovers of [true, false]) {
  test(`Fast corrects invalid tool arguments once, recovery=${recovers}`, async () => {
    const store = new MemoryStore(":memory:");
    let calls = 0, searches = 0;
    const llm: Llm = { json: async () => ({}), stream: async request => {
      calls++;
      if (calls <= 2) {
        assert.equal(request.toolChoice, "auto");
        assert.deepEqual(Object.keys((request.tools[0]!.function.parameters as any).properties), ["query", "urls"]);
        const call = lookup(1);
        if (calls === 1 || !recovers) call.function.arguments = '{"query":"price","urls":42}';
        return { text: "", toolCalls: [call] };
      }
      assert.equal(request.toolChoice, "none");
      return { text: recovers ? answer : "The price could not be checked.", toolCalls: [] };
    } };
    try {
      const events: AgentEvent[] = [];
      await runTurn({ store, llm, clock: { now: () => now, simulated: false }, search: { search: async () => { searches++; return [hit]; } }, enricher: { schedule() {} } },
        { sessionId: "retry", message: "What is the price?", tz: "UTC", responseMode: "fast" }, event => events.push(event));
      assert.equal(calls, 3); assert.equal(searches, recovers ? 1 : 0);
      assert.ok(events.some(e => e.type === "done"));
    } finally { store.close(); }
  });
}

test("HTTP Fast routing, replay and clarification resume preserve the selected mode", async () => {
  const store = new MemoryStore(":memory:"), questions = new QuestionStore(":memory:");
  let standardCalls = 0, fastCalls = 0, asked = false;
  const llm: Llm = { json: async () => ({}), stream: async request => { standardCalls++; request.onText("Standard answer"); return { text: "Standard answer", toolCalls: [] }; } };
  const fastLlm: Llm = { json: async () => ({}), stream: async request => {
    fastCalls++; assert.equal(request.maxOutputTokens, FAST_LIMITS.outputTokens);
    if (!asked && request.messages.some(m => "content" in m && m.content === "Compare hosting")) {
      asked = true;
      return { text: "", toolCalls: [{ id: "clarify", type: "function", function: { name: "ask_clarification", arguments: JSON.stringify({ question: "Which workload?", why: "This determines the hosting fit.", options: [{ label: "Small app", detail: "A small application" }, { label: "Large app", detail: "A larger application" }] }) } }] };
    }
    request.onText("Fast answer"); return { text: "Fast answer", toolCalls: [] };
  } };
  const app = createApplication({ config: settings(), store, questions, deps: { llm, fastLlm, store, clock: { now: () => now, simulated: false }, search: { search: async () => [] }, enricher: { schedule() {} } } });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening"); const address = app.server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (body: Record<string, unknown>, key: string) => fetch(base + "/api/chat", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ sessionId: "modes", tz: "UTC", mode: "live", ...body }) });
  try {
    assert.equal((await (await fetch(base + "/api/state")).json()).features.fastMode, true);
    assert.equal((await post({ message: "Hello", responseMode: "arbitrary-model" }, "invalid")).status, 400);
    await decode(await post({ message: "Hello" }, "standard"));
    const first = await decode(await post({ message: "Hello", responseMode: "fast" }, "fast"));
    const done = first.find(e => e.type === "done"); assert.ok(done);
    assert.equal(store.episode(done.episodeId)!.answer, "Fast answer");
    assert.equal(store.episode(done.episodeId)!.execution!.responseMode, "fast");
    assert.equal((await post({ message: "Hello" }, "fast")).status, 409);
    assert.ok((await decode(await post({ message: "Hello", responseMode: "fast" }, "fast"))).find(e => e.type === "done" && e.recovered));
    assert.equal(fastCalls, 1); assert.equal(standardCalls, 1);
    const clarification = (await decode(await post({ message: "Compare hosting", responseMode: "fast" }, "question"))).find(e => e.type === "clarification");
    assert.equal(clarification.card.responseMode, "fast");
    const resumed = await decode(await post({ clarification: { id: clarification.card.id, selection: { optionId: "a" } }, responseMode: "standard" }, "resume"));
    const completed = resumed.find(e => e.type === "done"); assert.ok(completed);
    assert.equal(store.episode(completed.episodeId)!.execution!.responseMode, "fast");
    assert.equal(standardCalls, 1); assert.equal(fastCalls, 3);
  } finally { await app.shutdown(); }
});

test("Fast mode is rejected before creating a turn when no fast deployment is configured", async () => {
  const store = new MemoryStore(":memory:"), questions = new QuestionStore(":memory:");
  const app = createApplication({ config: settings(), store, questions, deps: { store, llm: { json: async () => { throw new Error(); }, stream: async () => { throw new Error(); } },
    clock: { now: () => now, simulated: false }, search: { search: async () => [] }, enricher: { schedule() {} } } });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening"); const address = app.server.address(); assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "unavailable", message: "Hi", responseMode: "fast" }) });
    assert.equal(response.status, 400); assert.equal((await response.json()).code, "fast_mode_unavailable");
    assert.equal(store.count(), 0);
  } finally { await app.shutdown(); }
});

test("clarification mode survives reopening storage", () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-fast-")), path = join(dir, "questions.db");
  let questions = new QuestionStore(path);
  try {
    const card = questions.create({ sessionId: "persist", message: "Compare hosting", responseMode: "fast",
      time: { effectiveAt: now.toISOString(), receivedAt: now.toISOString(), tz: "UTC", simulated: false },
      question: { question: "Which workload?", why: "To choose the right host", options: [] } });
    questions.close(); questions = new QuestionStore(path);
    assert.equal(questions.pending("persist")!.responseMode, "fast");
    assert.equal(questions.begin(card.id, "persist", { skip: true }).card.responseMode, "fast");
  } finally { questions.close(); rmSync(dir, { recursive: true, force: true }); }
});
