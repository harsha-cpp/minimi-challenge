import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Llm, LlmUsage, StreamRequest } from "../src/llm.ts";
import { AdmissionPool, ModelBudget, ModelQuota, createModelGateway, runWithModelContext, type ModelCallTrace } from "../src/llm/gateway.ts";

const request: StreamRequest = { messages: [{ role: "user", content: "hello" }], tools: [], toolChoice: "none", onText() {} };
const usage: LlmUsage = { model: "mock", inputTokens: 100, outputTokens: 20, cachedInputTokens: 10, reasoningTokens: 5 };
const immediate: Llm = { async stream(request) { request.onText("ok"); request.onUsage?.(usage); return { text: "ok", toolCalls: [] }; }, async json(request) { request.onUsage?.(usage); return {}; } };

test("100-request burst bounds active and queued model work and rejects before providers", async () => {
  let active = 0, maximum = 0, calls = 0;
  const llm: Llm = { ...immediate, async stream(request) {
    calls++; maximum = Math.max(maximum, ++active);
    await delay(10); active--; request.onUsage?.(usage);
    return { text: "ok", toolCalls: [] };
  } };
  const pool = new AdmissionPool({ maxActive: 4, maxQueued: 8 });
  const gateway = createModelGateway(llm, { pool });
  const budgets = Array.from({ length: 100 }, () => new ModelBudget());
  const results = await Promise.allSettled(budgets.map((budget, index) => runWithModelContext({ ownerId: `owner-${index}`, budget }, () => gateway.stream(request))));
  assert.equal(maximum, 4); assert.equal(calls, 12);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 12);
  assert.equal(pool.stats.rejected, 88); assert.equal(pool.stats.active, 0); assert.equal(pool.stats.queued, 0);
  for (let index = 12; index < budgets.length; index++) assert.equal(budgets[index]!.snapshot.calls, 0);
});

test("cancelled queued work releases queue capacity and never calls a provider", async () => {
  const pool = new AdmissionPool({ maxActive: 1, maxQueued: 1 });
  const release = await pool.acquire({ ownerId: "busy" });
  const abort = new AbortController(), budget = new ModelBudget(), traces: ModelCallTrace[] = [];
  let calls = 0;
  const gateway = createModelGateway({ ...immediate, async stream(request) { calls++; return immediate.stream(request); } }, { pool, onCall: value => traces.push(value) });
  const promise = runWithModelContext({ ownerId: "queued", budget }, () => gateway.stream({ ...request, signal: abort.signal }));
  abort.abort();
  await assert.rejects(promise, { name: "AbortError" });
  assert.equal(pool.stats.queued, 0); assert.equal(calls, 0); assert.equal(budget.snapshot.calls, 0);
  release(); await gateway.stream(request);
  assert.equal(calls, 1); assert.equal(traces[0]!.outcome, "cancelled");
});

test("account fairness rotates owners and completion work precedes queued research", async () => {
  const pool = new AdmissionPool({ maxActive: 1, maxQueued: 8 });
  let release = await pool.acquire({ ownerId: "a" });
  const order: string[] = [];
  const queued = [
    pool.acquire({ ownerId: "a" }).then(unlock => { order.push("a1"); unlock(); }),
    pool.acquire({ ownerId: "a" }).then(unlock => { order.push("a2"); unlock(); }),
    pool.acquire({ ownerId: "b" }).then(unlock => { order.push("b"); unlock(); }),
  ];
  release(); await Promise.all(queued);
  assert.deepEqual(order, ["b", "a1", "a2"]);
  release = await pool.acquire({ ownerId: "first" });
  const research = pool.acquire({ ownerId: "research" }).then(unlock => { order.push("research"); unlock(); });
  const synthesis = pool.acquire({ ownerId: "final", completion: true }).then(unlock => { order.push("synthesis"); unlock(); });
  release(); await Promise.all([research, synthesis]);
  assert.deepEqual(order.slice(-2), ["synthesis", "research"]);
});

test("background work leaves reserved foreground capacity and shutdown rejects waiting work", async () => {
  const pool = new AdmissionPool({ maxActive: 3, maxQueued: 4, foregroundReserve: 1 });
  const one = await pool.acquire({ ownerId: "bg1", priority: "background" });
  const two = await pool.acquire({ ownerId: "bg2", priority: "background" });
  const waiting = pool.acquire({ ownerId: "bg3", priority: "background" });
  const front = await pool.acquire({ ownerId: "interactive" });
  assert.equal(pool.stats.active, 3); assert.equal(pool.stats.queued, 1);
  pool.close(); await assert.rejects(waiting, (error: any) => error.code === "closed");
  await assert.rejects(pool.acquire({ ownerId: "new" }), (error: any) => error.code === "closed");
  one(); two(); front(); assert.equal(pool.stats.active, 0);
});

test("turn budget reserves synthesis and charges missing usage conservatively", async () => {
  let calls = 0;
  const gateway = createModelGateway({ ...immediate, async stream(request) { calls++; return { text: "ok", toolCalls: [] }; } }, { pool: new AdmissionPool({ maxActive: 1, maxQueued: 2 }), outputTokens: 200 });
  const budget = new ModelBudget({ maxCalls: 3, maxTokens: 10_000, reserveCalls: 1, reserveTokens: 1000 });
  await runWithModelContext({ ownerId: "a", budget }, async () => {
    await gateway.stream({ ...request, toolChoice: "auto" });
    await gateway.stream({ ...request, toolChoice: "auto" });
    await assert.rejects(gateway.stream({ ...request, toolChoice: "auto" }), (error: any) => error.code === "budget");
    await gateway.stream({ ...request, purpose: "synthesis" });
    await assert.rejects(gateway.stream(request), (error: any) => error.code === "budget");
  });
  assert.equal(calls, 3); assert.equal(budget.snapshot.calls, 3); assert.equal(budget.snapshot.missingUsageCalls, 3);
  assert.ok(budget.snapshot.tokens >= 600); assert.equal(budget.snapshot.spendUsd, null);
});

test("versioned spend cap rejects before the provider and does not double-count reasoning", async () => {
  const prices = { version: "test-prices", inputPerMillionUsd: 1, outputPerMillionUsd: 2, cachedInputPerMillionUsd: 0.5 };
  const budget = new ModelBudget({ maxSpendUsd: 0.1, prices });
  const gateway = createModelGateway(immediate, { pool: new AdmissionPool({ maxActive: 1, maxQueued: 2 }) });
  await runWithModelContext({ ownerId: "a", budget }, () => gateway.stream(request));
  assert.equal(budget.snapshot.tokens, 120);
  assert.ok(Math.abs(budget.snapshot.spendUsd! - 0.000135) < 1e-10);
  assert.equal(budget.snapshot.priceVersion, "test-prices"); assert.equal(budget.snapshot.knownUsageCalls, 1);
  assert.throws(() => new ModelBudget({ maxSpendUsd: 1 }), /price table/);
  const tiny = new ModelBudget({ maxSpendUsd: 0.000001, prices });
  let calls = 0;
  const capped = createModelGateway({ ...immediate, async stream(request) { calls++; return immediate.stream(request); } }, { pool: new AdmissionPool({ maxActive: 1, maxQueued: 2 }) });
  await assert.rejects(runWithModelContext({ ownerId: "a", budget: tiny }, () => capped.stream(request)), (error: any) => error.code === "budget");
  assert.equal(calls, 0);
});

test("failed provider usage is charged and appears in bounded call telemetry", async () => {
  const budget = new ModelBudget(), traces: ModelCallTrace[] = [];
  const gateway = createModelGateway({ ...immediate, async stream(request) { request.onUsage?.(usage); throw Object.assign(new Error("private payload"), { code: "truncated" }); } }, { pool: new AdmissionPool({ maxActive: 1, maxQueued: 2 }) });
  await assert.rejects(runWithModelContext({ ownerId: "a", turnId: "turn-a", budget, onCall: value => traces.push(value) }, () => gateway.stream(request)));
  assert.equal(budget.snapshot.tokens, 120); assert.equal(budget.snapshot.calls, 1);
  assert.equal(traces[0]!.outcome, "truncated"); assert.equal(traces[0]!.turnId, "turn-a");
  assert.ok(!JSON.stringify(traces).includes("private payload"));
});

test("research respects deadline reserve and expired queued deadlines never call providers", async () => {
  const pool = new AdmissionPool({ maxActive: 1, maxQueued: 2 });
  let calls = 0;
  const gateway = createModelGateway({ ...immediate, async stream(request) { calls++; return immediate.stream(request); } }, { pool });
  await runWithModelContext({ ownerId: "a", deadlineAt: Date.now() + 1000, deadlineReserveMs: 5000 }, async () => {
    await assert.rejects(gateway.stream({ ...request, toolChoice: "auto" }), (error: any) => error.code === "deadline");
    await gateway.stream({ ...request, purpose: "synthesis" });
  });
  assert.equal(calls, 1);
  const release = await pool.acquire({ ownerId: "busy" });
  await assert.rejects(pool.acquire({ ownerId: "queued", deadlineAt: Date.now() + 15 }), (error: any) => error.code === "deadline");
  release(); assert.equal(pool.stats.queued, 0);
});

test("shared provider quota covers multiple gateways and resets only after its window", async () => {
  let clock = 0, calls = 0;
  const quota = new ModelQuota({ requestsPerMinute: 2, tokensPerMinute: 20_000 }, () => clock);
  const llm: Llm = { ...immediate, async stream(request) { calls++; return immediate.stream(request); } };
  const pool = new AdmissionPool({ maxActive: 2, maxQueued: 2 });
  const main = createModelGateway(llm, { pool, quota }), review = createModelGateway(llm, { pool, quota });
  await main.stream(request); await review.stream(request);
  await assert.rejects(main.stream(request), (error: any) => error.code === "busy");
  assert.equal(calls, 2); assert.equal(quota.stats.requests, 2); assert.equal(quota.stats.tokens, 240);
  clock = 60_001; await main.stream(request); assert.equal(calls, 3); assert.equal(quota.stats.requests, 1);
  const tokenQuota = new ModelQuota({ requestsPerMinute: 100, tokensPerMinute: 500 });
  await assert.rejects(createModelGateway(llm, { pool, quota: tokenQuota }).stream(request), (error: any) => error.code === "busy");
  assert.equal(calls, 3);
});

test("uncooperative provider abort returns promptly, suppresses late text, and retains capacity until settlement", async () => {
  const pool = new AdmissionPool({ maxActive: 1, maxQueued: 0 });
  let resolveProvider!: () => void;
  const gate = new Promise<void>(resolve => { resolveProvider = resolve; });
  const llm: Llm = { ...immediate, async stream(request) { await gate; request.onText("late text"); request.onUsage?.(usage); return { text: "late text", toolCalls: [] }; } };
  const gateway = createModelGateway(llm, { pool });
  const abort = new AbortController(), text: string[] = [], budget = new ModelBudget();
  const result = runWithModelContext({ ownerId: "a", budget }, () => gateway.stream({ ...request, signal: abort.signal, onText: value => text.push(value) }));
  await delay(1); abort.abort(new Error("cancelled"));
  await assert.rejects(result, /cancelled/);
  assert.equal(pool.stats.active, 1);
  await assert.rejects(gateway.stream(request), (error: any) => error.code === "busy");
  resolveProvider(); await delay(1);
  assert.deepEqual(text, []); assert.equal(pool.stats.active, 0); assert.equal(budget.snapshot.missingUsageCalls, 1);
});

test("gateway enforces context deadline when provider ignores its request signal", async () => {
  const pool = new AdmissionPool({ maxActive: 1, maxQueued: 0 });
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const traces: ModelCallTrace[] = [];
  const gateway = createModelGateway({ ...immediate, async stream() { await gate; return { text: "late", toolCalls: [] }; } }, { pool, onCall: trace => traces.push(trace) });
  const running = runWithModelContext({ ownerId: "a", deadlineAt: Date.now() + 15 }, () => gateway.stream(request));
  // Node's AbortSignal.timeout is unref'ed; keep the test event loop alive while it expires.
  const timer = setTimeout(() => {}, 1000);
  try { await assert.rejects(running, (error: any) => error.name === "TimeoutError"); }
  finally { clearTimeout(timer); finish(); }
  await delay(1); assert.equal(pool.stats.active, 0);
  assert.equal(traces.length, 1); assert.equal(traces[0]!.outcome, "timeout");
  assert.equal(traces[0]!.providerStarted, true);
});

test("search attempts and model work share a spend allowance with unknown external costs charged conservatively", async () => {
  const prices = { version: "combined-test", inputPerMillionUsd: 1, outputPerMillionUsd: 2 };
  const budget = new ModelBudget({ maxSpendUsd: 0.1, prices });
  const first = budget.reserveExternal(0.04); first.settle(0.01);
  assert.equal(budget.snapshot.externalCalls, 1); assert.ok(Math.abs(budget.snapshot.externalSpendUsd! - 0.01) < 1e-10);
  const failedAttempt = budget.reserveExternal(0.04); failedAttempt.settle(null);
  assert.equal(budget.snapshot.unknownExternalUsage, 1); assert.equal(budget.snapshot.spendIsEstimated, true);
  assert.ok(Math.abs(budget.snapshot.spendUsd! - 0.05) < 1e-10);
  assert.throws(() => budget.reserveExternal(0.04), (error: any) => error.code === "budget");
  const cancelled = budget.reserveExternal(0.02); cancelled.cancel(); cancelled.cancel();
  assert.equal(budget.snapshot.externalCalls, 2);
  const gateway = createModelGateway(immediate, { pool: new AdmissionPool({ maxActive: 1, maxQueued: 1 }) });
  await runWithModelContext({ ownerId: "a", budget }, () => gateway.stream({ ...request, purpose: "synthesis" }));
  assert.ok(budget.snapshot.spendUsd! > 0.05); assert.equal(budget.snapshot.calls, 1);
  assert.throws(() => budget.reserveExternal(-1), (error: any) => error.code === "budget");
});

test("provider-reported external overspend is recorded and prevents more paid work", () => {
  const budget = new ModelBudget({ maxSpendUsd: 0.1, prices: { version: "test", inputPerMillionUsd: 1, outputPerMillionUsd: 2 } });
  const attempt = budget.reserveExternal(0.02);
  assert.throws(() => attempt.settle(0.2), (error: any) => error.code === "budget");
  assert.equal(budget.snapshot.externalSpendUsd, 0.2); assert.equal(budget.snapshot.spendUsd, 0.2);
  assert.throws(() => budget.reserveExternal(0.01), (error: any) => error.code === "budget");
});

test("account completion headroom is unavailable to background and research stages", async () => {
  const quota = new ModelQuota({ requestsPerMinute: 4, tokensPerMinute: 100_000, completionRequests: 2, completionTokens: 40_000 });
  const traces: ModelCallTrace[] = [];
  const model = createModelGateway(immediate, { pool: new AdmissionPool({ maxActive: 1, maxQueued: 0 }), quota, onCall: trace => traces.push(trace) });
  await model.json({ system: "extract", user: "one", purpose: "enrichment" });
  await model.json({ system: "extract", user: "two", purpose: "enrichment" });
  await assert.rejects(model.json({ system: "extract", user: "blocked", purpose: "enrichment" }), (error: any) => error.code === "budget");
  await assert.rejects(model.stream({ ...request, toolChoice: "auto", purpose: "research" }), (error: any) => error.code === "budget");
  await model.stream({ ...request, purpose: "synthesis" });
  await model.json({ system: "review", user: "answer", purpose: "review" });
  await assert.rejects(model.stream(request), (error: any) => error.code === "busy");
  assert.equal(quota.stats.requests, 4); assert.equal(traces.filter(trace => trace.providerStarted).length, 4);
  assert.equal(traces.filter(trace => !trace.providerStarted).length, 3);
});

test("account token headroom protects final work independently of request count", () => {
  const quota = new ModelQuota({ requestsPerMinute: 100, tokensPerMinute: 10_000, completionRequests: 2, completionTokens: 6000 });
  for (let i = 0; i < 4; i++) quota.reserve(1000);
  assert.throws(() => quota.reserve(1), (error: any) => error.code === "budget");
  quota.reserve(6000, { completion: true });
  assert.equal(quota.stats.tokens, 10_000);
  assert.throws(() => quota.reserve(1, { completion: true }), (error: any) => error.code === "busy");
});
