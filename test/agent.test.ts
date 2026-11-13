import assert from "node:assert/strict";
import { test } from "node:test";
import { type AgentEvent, runTurn } from "../src/agent/run.ts";
import type { Clock } from "../src/clock.ts";
import type { ChatMessage, Llm, StreamRequest, ToolCall } from "../src/llm.ts";
import { Enricher } from "../src/memory/enrich.ts";
import { MemoryStore } from "../src/memory/store.ts";
import type { SearchProvider, SearchQuery } from "../src/search.ts";

const TZ = "Asia/Kolkata";

const fixedClock = (iso: string): Clock => ({ now: () => new Date(iso), simulated: false });

const searchCall = (id: string, args: Record<string, unknown>): ToolCall => ({
  id,
  type: "function",
  function: { name: "web_search", arguments: JSON.stringify(args) },
});

type Step = { text?: string; toolCalls?: ToolCall[] };

/** A model that replays scripted turns and records what it was sent. */
function scriptedLlm(steps: Step[], enrichment: unknown = { summary: "s", topics: [], claims: [] }) {
  const requests: StreamRequest[] = [];
  const jsonPrompts: string[] = [];
  const llm: Llm = {
    async stream(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      const step = steps.shift();
      if (!step) throw new Error("script ran out");
      if (step.text) request.onText(step.text);
      return { text: step.text ?? "", toolCalls: step.toolCalls ?? [] };
    },
    async json({ user }) {
      jsonPrompts.push(user);
      return enrichment;
    },
  };
  return { llm, requests, jsonPrompts };
}

function harness(llm: Llm, search: SearchProvider, clock: Clock, store = new MemoryStore(":memory:")) {
  const enricher = new Enricher(llm, store);
  const events: AgentEvent[] = [];
  const ask = async (message: string, sessionId = "s1") => {
    events.length = 0;
    await runTurn({ llm, search, store, clock, enricher }, { sessionId, message, tz: TZ }, (e) => events.push(e));
    await enricher.idle();
    return events;
  };
  return { store, ask, events };
}

const lastUserMessage = (messages: ChatMessage[]) => messages.findLast((m) => m.role === "user")!.content as string;

test("a message that needs no search is one model call and no searches", async () => {
  const { llm, requests } = scriptedLlm([{ text: "Hello!" }]);
  const search: SearchProvider = { search: async () => assert.fail("should not search") };
  const { ask, store } = harness(llm, search, fixedClock("2026-11-11T10:00:00+05:30"));

  const events = await ask("hi");
  const done = events.find((e) => e.type === "done")!;
  assert.equal(done.type === "done" && done.timings.modelCalls, 1);
  assert.equal(done.type === "done" && done.timings.searches, 0);
  assert.equal(store.count(), 1);
  assert.equal(lastUserMessage(requests[0]!.messages), "hi");
  assert.match(requests[0]!.messages[1]!.content as string, /2026-11-11T04:30:00.000Z/);
});

test("searches in one round run in parallel and share one numbering", async () => {
  const { llm, requests } = scriptedLlm([
    { toolCalls: [searchCall("a", { query: "neon pricing" }), searchCall("b", { query: "supabase pricing", published_after: "2026-11-03" })] },
    { text: "Neon is $19 [1]. Supabase is $25 [2]." },
  ]);

  const started: SearchQuery[] = [];
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => (release = resolve));
  const search: SearchProvider = {
    async search(query) {
      started.push(query);
      if (started.length === 2) release();
      await bothStarted; // would hang here if the searches ran one after another
      const host = query.query.split(" ")[0];
      return [{ url: `https://${host}.com/pricing`, title: `${host} pricing`, text: "plans", publishedDate: "2026-11-05" }];
    },
  };

  const { ask, store } = harness(llm, search, fixedClock("2026-11-11T10:00:00+05:30"));
  const events = await ask("compare neon and supabase pricing");

  assert.equal(started[1]!.publishedAfter, "2026-11-03");
  const toolResults = requests[1]!.messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.match(toolResults[0]!, /\[1\] neon pricing\nhttps:\/\/neon\.com\/pricing · published 2026-11-05/);
  assert.match(toolResults[1]!, /\[2\] supabase pricing/);

  const done = events.find((e) => e.type === "done")!;
  assert.deepEqual(done.type === "done" && done.cited, [1, 2]);
  assert.deepEqual(store.sourcesFor(1).map((s) => s.url), ["https://neon.com/pricing", "https://supabase.com/pricing"]);
});

test("text streamed before a tool call is retracted, and only the final answer is stored", async () => {
  const { llm } = scriptedLlm([
    { text: "Let me check.", toolCalls: [searchCall("a", { query: "x" })] },
    { text: "Final answer." },
  ]);
  const search: SearchProvider = { search: async () => [] };
  const { ask, store } = harness(llm, search, fixedClock("2026-11-11T10:00:00+05:30"));

  const events = await ask("q");
  assert.deepEqual(events.filter((e) => e.type === "text" || e.type === "retract").map((e) => e.type), ["text", "retract", "text"]);
  assert.equal(store.episode(1)!.answer, "Final answer.");
});

test("a failed search is reported to the model instead of failing the turn", async () => {
  const { llm, requests } = scriptedLlm([{ toolCalls: [searchCall("a", { query: "x" })] }, { text: "I could not verify that." }]);
  const search: SearchProvider = { search: async () => Promise.reject(new Error("timeout")) };
  const { ask } = harness(llm, search, fixedClock("2026-11-11T10:00:00+05:30"));

  const events = await ask("q");
  assert.ok(events.some((e) => e.type === "search" && e.state === "failed"));
  assert.ok(events.some((e) => e.type === "done"));
  assert.match(requests[1]!.messages.at(-1)!.content as string, /Search failed \(timeout\)/);
});

test("after the allowed search rounds the model is made to answer", async () => {
  const again = { toolCalls: [searchCall("a", { query: "x" })] };
  const { llm, requests } = scriptedLlm([again, again, again, { text: "Answer." }]);
  const search: SearchProvider = { search: async () => [] };
  const { ask } = harness(llm, search, fixedClock("2026-11-11T10:00:00+05:30"));

  await ask("q");
  assert.deepEqual(requests.map((r) => r.toolChoice), ["auto", "auto", "auto", "none"]);
});

test("a model error surfaces as an error event and nothing is stored", async () => {
  const llm: Llm = { stream: async () => Promise.reject(new Error("401 bad key")), json: async () => ({}) };
  const { ask, store } = harness(llm, { search: async () => [] }, fixedClock("2026-11-11T10:00:00+05:30"));
  const events = await ask("q");
  assert.deepEqual(events.at(-1), { type: "error", message: "401 bad key" });
  assert.equal(store.count(), 0);
});

test("a week later: the old claim is recalled, re-checked, and the new claim links back to it", async () => {
  const store = new MemoryStore(":memory:");
  const search: SearchProvider = {
    search: async () => [{ url: "https://neon.com/pricing", title: "Neon pricing", text: "Launch $25/month" }],
  };

  // Tuesday 3 November: the original answer, whose claim the memory step records.
  const first = scriptedLlm(
    [{ toolCalls: [searchCall("a", { query: "neon pricing" })] }, { text: "Neon Launch is $19/month [1]." }],
    {
      summary: "Asked about Postgres hosting; Neon Launch is $19/month.",
      topics: ["postgres hosting", "pricing"],
      claims: [{ entity: "Neon", attribute: "Launch plan price", value: "$19/month", kind: "price", source: 1, prior_id: null, verdict: "new" }],
    },
  );
  await harness(first.llm, search, fixedClock("2026-11-03T14:05:00+05:30"), store).ask("What does Postgres hosting cost?", "monday-chat");
  const [original] = store.claimsFor(1);
  assert.equal(original!.sourceUrl, "https://neon.com/pricing");

  // Wednesday 11 November, a new chat.
  const second = scriptedLlm(
    [{ toolCalls: [searchCall("b", { query: "neon launch plan price" })] }, { text: "It changed: $19 → $25 [1]." }],
    {
      summary: "Re-checked Neon pricing.",
      topics: ["postgres hosting"],
      claims: [{ entity: "Neon", attribute: "Launch plan price", value: "$25/month", kind: "price", source: 1, prior_id: original!.id, verdict: "changed" }],
    },
  );
  await harness(second.llm, search, fixedClock("2026-11-11T23:44:00+05:30"), store).ask(
    "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    "new-chat",
  );

  // The model saw the dated conversation and the exact claim to re-check.
  const memory = second.requests[0]!.messages.find(m => m.role === "user" && m.content.startsWith("UNTRUSTED MEMORY RECORDS"))!;
  const context = JSON.parse((memory.content as string).slice((memory.content as string).indexOf("\n") + 1)) as string;
  assert.match(context, /"Last Tuesday" → Tue 3 Nov 2026\. \(It could also mean Tue 10 Nov 2026, but there are no conversations then\.\)/);
  assert.match(context, new RegExp(`\\(C${original!.id}\\) Neon · Launch plan price: \\$19/month`));
  // The memory step was told about the prior claim so it could link to it.
  assert.match(second.jsonPrompts[0]!, new RegExp(`id ${original!.id}: Neon · Launch plan price: \\$19/month`));

  const [updated] = store.claimsFor(2);
  assert.deepEqual(
    { value: updated!.value, prior: updated!.priorClaimId, verdict: updated!.verdict },
    { value: "$25/month", prior: original!.id, verdict: "changed" },
  );
});

test("earlier turns of the same chat are sent with their timestamps", async () => {
  const { llm, requests } = scriptedLlm([{ text: "one" }, { text: "two" }]);
  const { ask } = harness(llm, { search: async () => [] }, fixedClock("2026-11-11T10:00:00+05:30"));
  await ask("first question");
  await ask("second question");
  const sent = requests[1]!.messages;
  assert.deepEqual(sent.slice(2, 4), [
    { role: "user", content: "[Wed 11 Nov 2026, 10:00] first question" },
    { role: "assistant", content: "one" },
  ]);
});
