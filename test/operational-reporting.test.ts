import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { MemoryStore } from "../src/memory/store.ts";
import { QuestionStore } from "../src/memory/questions.ts";
import { createApplication } from "../src/server.ts";
import { summarizeTraces } from "../src/runtime/latency-report.ts";
import type { Config } from "../src/config.ts";

const config: Config = { port: 0, host: "127.0.0.1", dbPath: ":memory:", temporalDbPath: ":memory:", llm: null, exaApiKey: null,
  startAt: null, missing: [], retrievalProfiles: false, access: { mode: "local", allowedOrigins: [], ownerTokens: {} },
  limits: { activeTurns: 2, queuedTurns: 3, activeModels: 2, queuedModels: 4, modelRequestsPerMinute: 1000, modelTokensPerMinute: 1000000,
    turnTimeoutMs: 3000, turnTokens: 100000, turnModelCalls: 10, maxOutputTokens: 4096, shutdownMs: 100, traceRetentionDays: 14,
    maxTurnDollars: 1, inputDollarsPerMillion: null, outputDollarsPerMillion: null } };
const decode = async (response: Response) => (await response.text()).split("\n\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));

test("clarification is durable waiting input and idempotent retries replay the exact card", async () => {
  const store = new MemoryStore(":memory:"), questions = new QuestionStore(":memory:"); let calls = 0;
  const app = createApplication({ config, store, questions, deps: { store, clock: { now: () => new Date(), simulated: false },
    search: { search: async () => [] }, enricher: { schedule() {} }, llm: { json: async () => ({}), stream: async () => {
      calls++; return { text: "", toolCalls: [{ id: "clarify", type: "function", function: { name: "ask_clarification", arguments: JSON.stringify({ question: "Which workload?", why: "Usage determines fit.", options: [{ label: "Small", detail: "Small application" }, { label: "Large", detail: "Large application" }] }) } }] };
    } } } });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const address = app.server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
  const post = () => fetch(base + "/api/chat", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "waiting" }, body: JSON.stringify({ sessionId: "s", message: "Compare hosting", mode: "live", tz: "UTC" }) });
  try {
    const events = await decode(await post()); const card = events.find(event => event.type === "clarification").card;
    const turnId = events.find(event => event.type === "turn").turnId;
    const saved = await (await fetch(base + "/api/turns/" + turnId)).json();
    assert.equal(saved.turn.status, "waiting_input"); assert.equal(saved.turn.errorCode, null); assert.equal(saved.clarification.id, card.id);
    // A later clarification cannot replace the exact question bound to this attempt.
    questions.create({ sessionId: "s", message: "Another question", time: card.time, question: { question: "Unrelated", why: "Different task", options: [] } });
    const replay = await decode(await post()); assert.equal(replay.find(event => event.type === "clarification").card.id, card.id); assert.equal(calls, 1);
    const metrics = await (await fetch(base + "/api/metrics")).json(); assert.equal(metrics.latency.overall.outcomes.waiting_input, 1);
    assert.equal(metrics.latency.overall.completedMs.samples, 0); assert.doesNotMatch(JSON.stringify(metrics.latency), /Compare hosting|Which workload|Unrelated/);
    assert.equal(questions.pendingById(card.id, "other-owner"), null);
  } finally { await app.shutdown(); }
});

test("latency summaries retain failures and missing browser measurements without inventing p95", () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ outcome: "completed", totalMs: (index + 1) * 100,
    serverFirstEmissionMs: index * 10, clientFirstRenderMs: null, stages: [{ name: "response_mode", data: { mode: "fast" } }, { name: "request_policy", data: { intent: "lookup" } }], privatePrompt: "PRIVATE_TEXT" }));
  const result = summarizeTraces([...rows, { outcome: "model_provider_error", totalMs: 5000 }, { outcome: "cancelled", totalMs: 400 }, { outcome: "clarification_required", totalMs: 200 }, { outcome: "turn_timeout", totalMs: 3000 }]);
  assert.equal(result.overall.attempts, 24); assert.equal(result.overall.outcomes.provider_failure, 1); assert.equal(result.overall.outcomes.waiting_input, 1);
  assert.equal(result.overall.completedMs.p95Ms, 1900); assert.equal(result.overall.failedMs.samples, 3);
  assert.equal(result.overall.firstBrowserRenderMs.samples, 0); assert.equal(result.overall.firstBrowserRenderMs.p50Ms, null);
  assert.equal(result.byModeAndIntent["fast/lookup"]!.completedMs.samples, 20);
  assert.equal(summarizeTraces(rows.slice(0, 19)).overall.completedMs.p95Ms, null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TEXT|privatePrompt/);
});
