import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn } from "../src/agent/run.ts";
import type { Llm } from "../src/llm.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { finishTrace, newTrace, withTrace } from "../src/runtime/telemetry.ts";

test("invalid search arguments leave an enum-only trace without raw query or key data", async () => {
  const store = new MemoryStore(":memory:");
  const trace = newTrace("invalid-tool", "scripted", "live");
  let calls = 0;
  const llm: Llm = { json: async () => ({}), stream: async () => ++calls === 1
    ? { text: "", toolCalls: [{ id: "invalid", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: 42, urls: ["https://example.com/PRIVATE_QUERY"], apiKey: "PRIVATE_KEY" }) } }] }
    : { text: "The lookup arguments were invalid.", toolCalls: [] } };
  try {
    await withTrace(trace, async () => {
      await runTurn({ llm, store, clock: { simulated: false, now: () => new Date("2026-11-15T00:00:00Z") },
        search: { search: async () => assert.fail("Invalid tool arguments reached a provider") }, enricher: { schedule() {} } },
      { sessionId: "redacted-tool", message: "Help with this lookup.", tz: "UTC" }, () => {});
      finishTrace("completed");
    });
    assert.equal(store.count(), 1);
    assert.deepEqual(trace.stages.find(stage => stage.name === "tool_validation")!.data,
      { outcome: "rejected", code: "invalid_search_arguments" });
    assert.doesNotMatch(JSON.stringify(trace), /PRIVATE_QUERY|PRIVATE_KEY|example\.com|apiKey/);
  } finally { store.close(); }
});
