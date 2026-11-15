import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelBudget, AdmissionPool, createModelGateway, runWithModelContext } from "../src/llm/gateway.ts";
import { createExaSearch, withCache } from "../src/search.ts";
import { newTrace, withTrace } from "../src/runtime/telemetry.ts";
import { loadConfig } from "../src/config.ts";
import type { Llm } from "../src/llm.ts";

const prices = { version: "test-external", inputPerMillionUsd: 1, outputPerMillionUsd: 2 };
const budget = (maxSpendUsd = 0.5) => new ModelBudget({ prices, maxSpendUsd });
const result = { url: "https://example.com/a", title: "a", highlights: ["One fact."] };
const response = (data: unknown, status = 200) => Response.json(data, { status });
const within = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const inBudget = <T>(budget: ModelBudget, fn: () => T) => runWithModelContext({ ownerId: "test", budget }, fn);

test("one request cost is settled once across all ranked hits and completed cache hits add no charge", async () => {
  let requests = 0;
  const http = (async () => { requests++; return response({ costDollars: { total: 0.012 }, results: [result, { ...result, url: "https://example.com/b" }] }); }) as typeof fetch;
  const cached = withCache(createExaSearch("mock", { spendPolicy: null, fetch: http, maxAttemptCostDollars: 0.04 }));
  const first = budget(), second = budget(), trace = newTrace("cost-trace", "mock", "live");
  const hits = await withTrace(trace, () => inBudget(first, () => cached.search({ query: "q" })));
  assert.equal(hits.length, 2); assert.equal(hits[0]!.retrieval!.providerCostScope, "request");
  within(first.snapshot.externalSpendUsd, 0.012); assert.equal(first.snapshot.externalCalls, 1);
  await withTrace(trace, () => inBudget(second, () => cached.search({ query: "q" })));
  assert.equal(requests, 1); assert.equal(second.snapshot.externalCalls, 0); within(second.snapshot.spendUsd, 0);
  const attempts = trace.stages.filter(stage => stage.name === "search_provider_attempt");
  assert.equal(attempts.length, 1); assert.equal(attempts[0]!.data!.costDollars, 0.012);
  assert.equal(trace.stages.some(stage => stage.name === "search_result" && stage.data?.costDollars !== undefined), false);
});

test("empty results and rejected malformed result payloads still count provider-reported billing", async () => {
  for (const results of [[], null]) {
    const costs = budget();
    const http = (async () => response({ results, costDollars: { total: 0.02 } })) as typeof fetch;
    const search = createExaSearch("mock", { spendPolicy: null, fetch: http, maxAttemptCostDollars: 0.04 });
    if (results === null) await assert.rejects(inBudget(costs, () => search.search({ query: "q" })), /invalid results/);
    else assert.deepEqual(await inBudget(costs, () => search.search({ query: "q" })), []);
    assert.equal(costs.snapshot.externalCalls, 1); within(costs.snapshot.externalSpendUsd, 0.02);
  }
});

test("retries separately reserve and settle error-response costs", async () => {
  const replies = [response({ costDollars: { total: 0.003 } }, 429), response({ results: [result], costDollars: { total: 0.01 } })];
  let requests = 0; const http = (async () => { requests++; return replies.shift()!; }) as typeof fetch;
  const costs = budget();
  await inBudget(costs, () => createExaSearch("mock", { spendPolicy: null, fetch: http, retryDelayMs: 0, maxAttemptCostDollars: 0.04 }).search({ query: "q" }));
  assert.equal(requests, 2); assert.equal(costs.snapshot.externalCalls, 2); assert.equal(costs.snapshot.unknownExternalUsage, 0);
  within(costs.snapshot.spendUsd, 0.013); within(costs.snapshot.externalSpendUsd, 0.013);
});

test("network failures retain a conservative attempt charge and flag unknown actual usage", async () => {
  let requests = 0; const http = (async () => { if (++requests === 1) throw new Error("private network payload"); return response({ results: [result], costDollars: { total: 0.01 } }); }) as typeof fetch;
  const costs = budget();
  await inBudget(costs, () => createExaSearch("mock", { spendPolicy: null, fetch: http, retryDelayMs: 0, maxAttemptCostDollars: 0.04 }).search({ query: "q" }));
  assert.equal(requests, 2); assert.equal(costs.snapshot.externalCalls, 2); assert.equal(costs.snapshot.unknownExternalUsage, 1);
  assert.equal(costs.snapshot.externalSpendUsd, null); within(costs.snapshot.externalSpendEstimateUsd, 0.05);
  assert.equal(costs.snapshot.spendIsEstimated, true); within(costs.snapshot.spendUsd, 0.05);
});

test("non-retryable error cost is counted and provider body details stay private", async () => {
  let requests = 0; const http = (async () => { requests++; return response({ error: "private provider details", costDollars: { total: 0.008 } }, 401); }) as typeof fetch;
  const costs = budget();
  await assert.rejects(inBudget(costs, () => createExaSearch("mock", { spendPolicy: null, fetch: http, maxAttemptCostDollars: 0.04 }).search({ query: "q" })), error => error instanceof Error && !error.message.includes("private"));
  assert.equal(requests, 1); within(costs.snapshot.externalSpendUsd, 0.008);
});

test("insufficient total spend rejects paid attempts before HTTP and a failed retry leaves synthesis reserve", async () => {
  let requests = 0; const http = (async () => { requests++; return response({}, 429); }) as typeof fetch;
  const search = createExaSearch("mock", { spendPolicy: null, fetch: http, retryDelayMs: 0, maxAttemptCostDollars: 0.04 });
  await assert.rejects(inBudget(budget(0.05), () => search.search({ query: "q" })), (error: any) => error.code === "budget");
  assert.equal(requests, 0);
  const costs = budget(0.07);
  await assert.rejects(inBudget(costs, () => search.search({ query: "q" })), (error: any) => error.code === "budget");
  assert.equal(requests, 1); assert.equal(costs.snapshot.externalCalls, 1); assert.equal(costs.snapshot.unknownExternalUsage, 1);
  const llm: Llm = { async json() { return {}; }, async stream(request) { request.onUsage?.({ model: "mock", inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, reasoningTokens: 0 }); return { text: "A bounded partial answer.", toolCalls: [] }; } };
  const model = createModelGateway(llm, { pool: new AdmissionPool({ maxActive: 1, maxQueued: 0 }) });
  const answer = await inBudget(costs, () => model.stream({ messages: [{ role: "user", content: "q" }], tools: [], toolChoice: "none", purpose: "synthesis", onText() {} }));
  assert.match(answer.text, /partial/); assert.equal(costs.snapshot.calls, 1); assert.ok(costs.snapshot.spendUsd! < 0.07);
});

test("a configured spend cap refuses unspecified external bounds while uncapped local usage remains unknown", async () => {
  let requests = 0; const http = (async () => { requests++; return response({ results: [result] }); }) as typeof fetch;
  const search = createExaSearch("mock", { spendPolicy: null, fetch: http });
  await assert.rejects(inBudget(budget(), () => search.search({ query: "q" })), /explicit external-provider attempt bound/);
  assert.equal(requests, 0);
  const local = new ModelBudget(); await inBudget(local, () => search.search({ query: "q" }));
  assert.equal(requests, 1); assert.equal(local.snapshot.externalCalls, 1); assert.equal(local.snapshot.unknownExternalUsage, 1);
  assert.equal(local.snapshot.externalSpendUsd, null); assert.equal(local.snapshot.externalSpendEstimateUsd, null); assert.equal(local.snapshot.spendUsd, null);
  assert.equal(local.snapshot.spendCapEnforced, false); assert.equal(local.snapshot.spendIsEstimated, true);
});

test("an exceeded provider attempt bound is recorded and stops subsequent paid searches", async () => {
  let requests = 0; const http = (async () => { requests++; return response({ results: [result], costDollars: { total: 0.1 } }); }) as typeof fetch;
  const search = createExaSearch("mock", { spendPolicy: null, fetch: http, maxAttemptCostDollars: 0.04 }), costs = budget();
  await assert.rejects(inBudget(costs, () => search.search({ query: "one" })), /configured attempt bound/);
  assert.equal(costs.snapshot.externalBoundViolations, 1); within(costs.snapshot.externalSpendUsd, 0.1);
  await assert.rejects(inBudget(costs, () => search.search({ query: "two" })), (error: any) => error.code === "budget");
  assert.equal(requests, 1);
});

test("coalesced subscribers charge one physical attempt to its originating turn", async () => {
  let resolve!: (response: Response) => void, requests = 0;
  const http = (async () => { requests++; return new Promise<Response>(ready => { resolve = ready; }); }) as typeof fetch;
  const search = withCache(createExaSearch("mock", { spendPolicy: null, fetch: http, maxAttemptCostDollars: 0.04 }));
  const a = budget(), b = budget();
  const first = inBudget(a, () => search.search({ query: "shared" }));
  const second = inBudget(b, () => search.search({ query: "shared" }));
  await Promise.resolve(); resolve(response({ results: [result], costDollars: { total: 0.01 } }));
  await Promise.all([first, second]);
  assert.equal(requests, 1); assert.equal(a.snapshot.externalCalls, 1); assert.equal(b.snapshot.externalCalls, 0); within(a.snapshot.externalSpendUsd, 0.01);
});

test("hosted configuration requires an operator-supplied positive search attempt bound", () => {
  const directory = mkdtempSync(join(tmpdir(), "asof-cost-config-")), previousDirectory = process.cwd();
  const names = ["DEPLOYMENT_MODE", "ALLOWED_ORIGINS", "OWNER_TOKENS", "INPUT_DOLLARS_PER_MILLION", "OUTPUT_DOLLARS_PER_MILLION", "SEARCH_MAX_ATTEMPT_DOLLARS", "MAX_TURN_DOLLARS"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.chdir(directory);
    Object.assign(process.env, { DEPLOYMENT_MODE: "hosted", ALLOWED_ORIGINS: "https://example.com", OWNER_TOKENS: JSON.stringify({ alice: "a".repeat(40) }), INPUT_DOLLARS_PER_MILLION: "1", OUTPUT_DOLLARS_PER_MILLION: "2", MAX_TURN_DOLLARS: "1" });
    delete process.env.SEARCH_MAX_ATTEMPT_DOLLARS;
    assert.throws(() => loadConfig(), /SEARCH_MAX_ATTEMPT_DOLLARS/);
    process.env.SEARCH_MAX_ATTEMPT_DOLLARS = "0"; assert.throws(() => loadConfig(), /SEARCH_MAX_ATTEMPT_DOLLARS/);
    process.env.SEARCH_MAX_ATTEMPT_DOLLARS = "0.04"; assert.equal(loadConfig().limits.searchAttemptDollars, 0.04);
    process.env.SEARCH_MAX_ATTEMPT_DOLLARS = "-1"; assert.throws(() => loadConfig(), /SEARCH_MAX_ATTEMPT_DOLLARS/);
  } finally {
    process.chdir(previousDirectory);
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    rmSync(directory, { recursive: true, force: true });
  }
});
