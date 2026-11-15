import assert from "node:assert/strict";
import { test } from "node:test";
import { createExaSearch, withCache } from "../src/search.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { finishTrace, newTrace, recordStage, recordUsage, withTrace, type TurnTrace } from "../src/runtime/telemetry.ts";

test("a shared physical search retains its final cost after its original turn cancels", async () => {
  const store = new MemoryStore(":memory:");
  let providerStarted!: () => void, finishProvider!: (value: Response) => void;
  const entered = new Promise<void>(resolve => { providerStarted = resolve; });
  const response = new Promise<Response>(resolve => { finishProvider = resolve; });
  const search = withCache(createExaSearch("not-a-real-key", { spendPolicy: null, maxAttemptCostDollars: 0.02, fetch: async () => { providerStarted(); return response; } }));
  const trace = newTrace("cancelled-shared-turn", "model", "live");
  const persist = (updated: TurnTrace) => store.saveTrace(updated.turnId, "local", { ...updated });
  const abort = new AbortController();
  let first!: Promise<unknown>;
  const original = withTrace(trace, async () => {
    first = search.search({ query: "public fact" }, abort.signal);
    const rejected = assert.rejects(first, { name: "AbortError" });
    await entered; await new Promise<void>(resolve => { queueMicrotask(resolve); });
    abort.abort(); await rejected; persist(finishTrace("cancelled")!);
  }, persist);
  await entered;
  const subscriber = search.search({ query: "public fact" });
  await original;
  assert.ok((store.traceFor(trace.turnId)!.stages as any[]).some(stage => stage.name === "search_provider_started"));
  finishProvider(Response.json({ costDollars: { total: 0.01 }, results: [{ url: "https://example.com/fact", highlights: ["The public fact."] }] }));
  try {
    await subscriber;
    const saved = store.traceFor(trace.turnId)!;
    assert.equal(saved.outcome, "cancelled");
    const attempts = (saved.stages as any[]).filter(stage => stage.name === "search_provider_attempt");
    assert.equal(attempts.length, 1); assert.equal(attempts[0].data.costDollars, 0.01);
    assert.doesNotMatch(JSON.stringify(saved), /public fact|not-a-real-key/);
  } finally { store.close(); }
});

test("bounded telemetry projects usage fields and cannot retain extra prompt/key payloads", async () => {
  const trace = newTrace("redacted", "m", "live");
  await withTrace(trace, async () => {
    recordUsage({ model: "m", inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, reasoningTokens: 0, prompt: "PRIVATE_PROMPT", apiKey: "PRIVATE_KEY" } as any);
    recordStage("safe", 1, { prompt: "PRIVATE_PROMPT", query: "PRIVATE_QUERY", results: 2 });
    for (let i = 0; i < 150; i++) recordStage("bounded", 1);
    finishTrace("completed");
  });
  assert.equal(trace.usage.length, 1); assert.equal(trace.stages.length, 128); assert.ok(trace.droppedStages > 0);
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE_/);
});
