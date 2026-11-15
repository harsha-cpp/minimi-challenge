import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLlm, type LlmConfig, type ChatMessage } from "../src/llm.ts";
import { AdmissionPool, ModelBudget, ModelQuota, createModelGateway, runWithModelContext, type ModelCallTrace } from "../src/llm/gateway.ts";
import { createExaSearch, withCache } from "../src/search.ts";
import { ProviderSpendStore } from "../src/runtime/spend-store.ts";
import { defaultProviderSpending, type ProviderSpendingPolicy } from "../src/runtime/provider-spending.ts";

const config: LlmConfig = { apiKey: "mock-key", baseUrl: "https://azure.example.com/openai/v1", model: "sol", fastModel: "luna" };
const request = { messages: [{ role: "user", content: "hello" }] as ChatMessage[], tools: [], toolChoice: "none" as const, onText() {} };
const sse = (events: unknown[]) => new Response(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const chat = (finish = "stop", usage = true) => sse([
  { model: "wire-model", choices: [{ delta: { content: "Done." }, finish_reason: finish }] },
  ...(usage ? [{ model: "wire-model", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }] : []),
]);
function harness(caps: { azure?: number; exa?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "asof-adapter-spend-")), path = join(directory, "spend.db");
  const store = new ProviderSpendStore({ path, caps: { azure: caps.azure ?? 1, exa: caps.exa ?? 1 } });
  const policy: ProviderSpendingPolicy = { store, priceVersion: "mock-envelope-v1", exaAttemptMaxDollars: 0.02,
    modelPrices: { sol: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 }, luna: { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.2 } } };
  return { store, path, policy, close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("streaming and JSON requests use their own deployment envelopes and settle the shared durable allowance", async () => {
  const h = harness(); let requests = 0;
  const http = (async () => {
    requests++; const pending = h.store.getSummary().providers.azure;
    assert.equal(pending.pending, 1); assert.ok(pending.heldDollars > 0);
    return requests === 1 ? chat() : Response.json({ model: "wire-fast", choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  }) as typeof fetch;
  try {
    const llm = createLlm(config, { fetch: http, spendPolicy: h.policy });
    await llm.stream(request); await llm.json({ system: "json", user: "test", purpose: "enrichment" });
    const summary = h.store.getSummary().providers.azure;
    assert.equal(requests, 2); assert.equal(summary.pending, 0); assert.equal(summary.heldMicrousd, 0);
    assert.equal(summary.spentMicrousd, 154); assert.equal(summary.unknownSettlements, 0);
    const reopened = new ProviderSpendStore({ path: h.path });
    try { assert.equal(reopened.getSummary().providers.azure.spentMicrousd, 154); } finally { reopened.close(); }
  } finally { h.close(); }
});

test("global pre-HTTP refusal refunds turn tokens and account quota and never counts missing provider usage", async () => {
  const h = harness({ azure: 0.001 }); let requests = 0;
  const http = (async () => { requests++; return chat(); }) as typeof fetch;
  const budget = new ModelBudget(), traces: ModelCallTrace[] = [], quota = new ModelQuota({ requestsPerMinute: 10, tokensPerMinute: 100_000 });
  try {
    const model = createModelGateway(createLlm(config, { fetch: http, spendPolicy: h.policy }), { pool: new AdmissionPool({ maxActive: 1, maxQueued: 0 }), quota, onCall: value => traces.push(value) });
    await assert.rejects(runWithModelContext({ ownerId: "test", budget }, () => model.stream(request)), (error: any) => error.code === "budget" && error.providerStarted === false);
    assert.equal(requests, 0); assert.equal(budget.snapshot.calls, 0); assert.equal(budget.snapshot.tokens, 0); assert.equal(budget.snapshot.missingUsageCalls, 0);
    assert.equal(quota.stats.requests, 0); assert.equal(traces.length, 1); assert.equal(traces[0]!.providerStarted, false);
    assert.equal(h.store.getSummary().providers.azure.reservations, 0);
  } finally { h.close(); }
});

test("an unmapped deployment and unknown opaque history fail before HTTP, even when no model gateway is used", async () => {
  const h = harness(); let requests = 0;
  const http = (async () => { requests++; return chat(); }) as typeof fetch;
  try {
    await assert.rejects(createLlm({ ...config, model: "unpriced-deployment" }, { fetch: http, spendPolicy: h.policy }).stream(request), (error: any) => error.code === "budget" && error.providerStarted === false);
    const llm = createLlm(config, { fetch: http, spendPolicy: h.policy });
    await assert.rejects(llm.stream({ ...request, messages: [{ role: "assistant", content: null, responseOutput: [{ type: "reasoning", id: "unmetered", summary: [], encrypted_content: "compressed-opaque-history" }] }] }), (error: any) => error.code === "budget" && error.providerStarted === false);
    assert.equal(requests, 0); assert.equal(h.store.getSummary().providers.azure.reservations, 0);
  } finally { h.close(); }
});

test("encrypted reasoning reuses its recorded output-token ceiling rather than treating its small blob as plaintext", async () => {
  const h = harness(); let requests = 0, firstHold = 0, secondHold = 0;
  const reasoning = { type: "reasoning", id: "r", summary: [], encrypted_content: "tiny" };
  const message = { type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done.", annotations: [] }] };
  const http = (async () => {
    requests++; const held = h.store.getSummary().providers.azure.heldMicrousd;
    if (requests === 1) firstHold = held; else secondHold = held;
    return sse([{ type: "response.output_text.delta", delta: "Done." }, { type: "response.completed", response: { id: "response", status: "completed", model: "sol", output: [reasoning, message], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } }]);
  }) as typeof fetch;
  try {
    const llm = createLlm({ ...config, apiMode: "responses" }, { fetch: http, spendPolicy: h.policy });
    const first = await llm.stream(request);
    await llm.stream({ ...request, messages: [...request.messages, { role: "assistant", content: first.text, responseOutput: first.responseOutput }] });
    assert.ok(secondHold >= firstHold + 4096, "the previous 4096-token output ceiling must be added to the next input reservation");
    assert.equal(h.store.getSummary().providers.azure.spentMicrousd, 280);
  } finally { h.close(); }
});

test("concurrent raw model factories cannot oversubscribe a shared allowance", async () => {
  const h = harness({ azure: 0.02 }); let requests = 0, finish!: (response: Response) => void;
  const http = (async () => { requests++; return new Promise<Response>(resolve => { finish = resolve; }); }) as typeof fetch;
  try {
    const one = createLlm(config, { fetch: http, spendPolicy: h.policy }).stream(request);
    while (!finish) await Promise.resolve();
    await assert.rejects(createLlm(config, { fetch: http, spendPolicy: h.policy }).stream(request), (error: any) => error.code === "budget" && error.providerStarted === false);
    assert.equal(requests, 1); finish(chat()); await one;
    assert.equal(h.store.getSummary().providers.azure.spentMicrousd, 140);
    assert.equal(h.store.getSummary().providers.azure.pending, 0);
  } finally { h.close(); }
});

test("unknown and failed model attempts retain their conservative charge and SDK retries cannot bypass accounting", async () => {
  for (const failure of ["truncated", "network"] as const) {
    const h = harness({ azure: 0.015 }); let requests = 0;
    const http = (async () => { requests++; if (failure === "network") throw new Error("private transport payload"); return chat("length", false); }) as typeof fetch;
    try {
      const llm = createLlm(config, { fetch: http, spendPolicy: h.policy });
      await assert.rejects(llm.stream(request));
      const summary = h.store.getSummary().providers.azure;
      assert.equal(requests, 1); assert.equal(summary.unknownSettlements, 1); assert.ok(summary.spentMicrousd > 10_000); assert.equal(summary.heldMicrousd, 0);
      await assert.rejects(llm.stream(request), (error: any) => error.code === "budget" && error.providerStarted === false);
      assert.equal(requests, 1);
    } finally { h.close(); }
  }
});

test("cancellation after reserving but before HTTP releases the durable hold and does not count a provider call", async () => {
  const h = harness(); let requests = 0; const abort = new AbortController(), reserve = h.store.reserve.bind(h.store);
  h.store.reserve = input => { const hold = reserve(input); abort.abort(); return hold; };
  const http = (async () => { requests++; return chat(); }) as typeof fetch;
  try {
    await assert.rejects(createLlm(config, { fetch: http, spendPolicy: h.policy }).stream({ ...request, signal: abort.signal }), (error: any) => error.providerStarted === false);
    const summary = h.store.getSummary().providers.azure;
    assert.equal(requests, 0); assert.equal(summary.spentMicrousd, 0); assert.equal(summary.heldMicrousd, 0); assert.equal(summary.pending, 0); assert.equal(summary.unknownSettlements, 0);
  } finally { h.close(); }
});

test("Exa retries each consume the shared remaining allowance and cannot borrow Azure capacity", async () => {
  const h = harness({ exa: 0.03 }); let requests = 0;
  const http = (async () => { requests++; return Response.json({}, { status: 429 }); }) as typeof fetch;
  try {
    const search = createExaSearch("mock", { fetch: http, spendPolicy: h.policy, retryDelayMs: 0 });
    await assert.rejects(search.search({ query: "q" }), (error: any) => error.code === "budget_exhausted");
    const summary = h.store.getSummary();
    assert.equal(requests, 1); assert.equal(summary.providers.exa.spentMicrousd, 20_000); assert.equal(summary.providers.exa.remainingMicrousd, 10_000);
    assert.equal(summary.providers.azure.spentMicrousd, 0); assert.equal(summary.providers.exa.unknownSettlements, 1);
    await createLlm(config, { fetch: (async () => chat()) as typeof fetch, spendPolicy: h.policy }).stream(request);
    assert.equal(h.store.getSummary().providers.azure.spentMicrousd, 140);
  } finally { h.close(); }
});

test("cached Exa evidence does not re-charge its request total and empty results remain accounted", async () => {
  const h = harness(); let requests = 0;
  const http = (async () => { requests++; return Response.json({ costDollars: { total: 0.007 }, results: requests === 1 ? [{ url: "https://example.com", title: "Source", highlights: ["fact"] }] : [] }); }) as typeof fetch;
  try {
    const search = withCache(createExaSearch("mock", { fetch: http, spendPolicy: h.policy }));
    await search.search({ query: "first" }); await search.search({ query: "first" }); await search.search({ query: "empty" });
    assert.equal(requests, 2); assert.equal(h.store.getSummary().providers.exa.spentMicrousd, 14_000); assert.equal(h.store.getSummary().providers.exa.reservations, 2);
  } finally { h.close(); }
});

test("production accounting cannot be disabled without an injected test transport or reset through an alternate path", () => {
  assert.throws(() => createLlm(config, { spendPolicy: null }), /injected test transport/);
  assert.throws(() => createExaSearch("mock", { spendPolicy: null }), /injected test transport/);
  const previous = process.env.PROVIDER_SPEND_DB_PATH;
  try {
    process.env.PROVIDER_SPEND_DB_PATH = join(tmpdir(), "attempted-fresh-spend-ledger.db");
    assert.throws(() => defaultProviderSpending(), /canonical ledger path/);
  } finally { if (previous === undefined) delete process.env.PROVIDER_SPEND_DB_PATH; else process.env.PROVIDER_SPEND_DB_PATH = previous; }
});

test("Responses JSON and unsuccessful reported usage settle the fast deployment envelope", async () => {
  const h = harness(); let requests = 0;
  const output = [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }] }];
  const http = (async () => {
    requests++; return Response.json({ id: "r", model: "wire-model", status: requests === 1 ? "completed" : "incomplete", output,
      ...(requests === 1 ? {} : { incomplete_details: { reason: "max_output_tokens" } }), usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } });
  }) as typeof fetch;
  try {
    const llm = createLlm({ ...config, apiMode: "responses" }, { fetch: http, spendPolicy: h.policy });
    assert.deepEqual(await llm.json({ system: "json", user: "first", purpose: "review" }), { ok: true });
    await assert.rejects(llm.json({ system: "json", user: "truncated", purpose: "enrichment" }), (error: any) => error.code === "truncated" && error.providerStarted === true);
    const summary = h.store.getSummary().providers.azure;
    assert.equal(requests, 2); assert.equal(summary.spentMicrousd, 28); assert.equal(summary.unknownSettlements, 0); assert.equal(summary.heldMicrousd, 0);
  } finally { h.close(); }
});

test("an uncooperative aborted transport keeps a durable hold until its attempt settles", async () => {
  const h = harness({ azure: 0.02 }); let requests = 0, finish!: (response: Response) => void;
  const http = (async () => { requests++; return new Promise<Response>(resolve => { finish = resolve; }); }) as typeof fetch;
  const abort = new AbortController(), pool = new AdmissionPool({ maxActive: 1, maxQueued: 0 }), text: string[] = [];
  const raw = createLlm(config, { fetch: http, spendPolicy: h.policy }), model = createModelGateway(raw, { pool });
  try {
    const running = model.stream({ ...request, signal: abort.signal, onText: value => text.push(value) });
    while (!finish) await Promise.resolve();
    abort.abort(); await assert.rejects(running);
    const pending = h.store.getSummary().providers.azure;
    assert.equal(pending.pending, 1); assert.ok(pending.heldMicrousd > 10_000); assert.equal(pending.spentMicrousd, 0);
    const secondConnection = new ProviderSpendStore({ path: h.path });
    try { assert.equal(secondConnection.getSummary().providers.azure.heldMicrousd, pending.heldMicrousd); } finally { secondConnection.close(); }
    await assert.rejects(raw.stream(request), (error: any) => error.code === "budget" && error.providerStarted === false);
    assert.equal(requests, 1);
    finish(chat());
    const deadline = performance.now() + 1000;
    while (h.store.getSummary().providers.azure.pending && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
    const final = h.store.getSummary().providers.azure;
    assert.equal(final.pending, 0); assert.ok(final.spentMicrousd > 0); assert.equal(final.heldMicrousd, 0); assert.equal(pool.stats.active, 0);
    assert.deepEqual(text, []);
  } finally { h.close(); }
});
