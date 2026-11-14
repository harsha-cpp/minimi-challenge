import assert from "node:assert/strict";
import { test } from "node:test";
import { type AgentEvent, citedNumbers, runTurn } from "../src/agent/run.ts";
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

    const verifier = { json: async () => ({ status: "approved", issues: [] }) };
    await runTurn({ llm, search, store, clock, enricher, verifier }, { sessionId, message, tz: TZ }, (e) => events.push(e));
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
  assert.match(requests[0]!.messages[1]!.content as string, /2026-11-11T04:30:00.000Z \(Asia\/Kolkata\)/);
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
      await bothStarted;
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

  const memory = second.requests[0]!.messages.find(m => m.role === "user" && m.content.startsWith("UNTRUSTED MEMORY RECORDS"))!;
  const context = JSON.parse((memory.content as string).split("\n").slice(1).join("\n")) as string;
  assert.match(context, /"Last Tuesday" → Tue 3 Nov 2026\. \(It could also mean Tue 10 Nov 2026, but there are no conversations then\.\)/);
  assert.match(context, new RegExp(`\\(C${original!.id}\\) Neon · Launch plan price: \\$19/month`));

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

test("malformed tool JSON is reported to the model without calling search", async () => {
  for (const args of ["null", "[]", '{"query":"x","published_after":"2026-02-30"}', '{"query":"x","domains":"example.com"}']) {
    const { llm, requests } = scriptedLlm([
      { toolCalls: [{ id: "bad", type: "function", function: { name: "web_search", arguments: args } }] },
      { text: "I could not perform that search." },
    ]);
    const { ask, store } = harness(llm, { search: async () => assert.fail("invalid call reached search") }, fixedClock("2026-11-11T10:00Z"));
    await ask("q");
    assert.equal(store.count(), 1);
    assert.match(requests[1]!.messages.at(-1)!.content as string, /Invalid arguments/);
  }
});

test("search call budgets and per-turn concurrency are enforced across rounds", async () => {
  const calls = (round: number) => Array.from({ length: 5 }, (_, i) => searchCall(`${round}-${i}`, { query: `q${round}-${i}` }));
  const { llm, requests } = scriptedLlm([
    { toolCalls: calls(1) }, { toolCalls: calls(2) }, { toolCalls: calls(3) }, { text: "Some lookups could not be completed." },
  ]);
  let count = 0, active = 0, peak = 0;
  const search: SearchProvider = { search: async () => {
    count++; active++; peak = Math.max(peak, active);
    await new Promise<void>(resolve => setImmediate(resolve));
    active--; return [];
  } };
  const { ask } = harness(llm, search, fixedClock("2026-11-11T10:00Z"));
  const events = await ask("research");
  assert.equal(count, 12);
  assert.equal(peak, 4);
  assert.ok(requests[3]!.messages.some(m => m.role === "tool" && m.content.includes("budget exhausted")));
  assert.equal(events.find(e => e.type === "done")?.timings.searches, 12);
});

test("the same URL with changed evidence keeps distinct citation observations", async () => {
  const { llm } = scriptedLlm([
    { toolCalls: [searchCall("a", { query: "pricing", urls: ["https://example.com/pricing"], freshness: "fresh" })] },
    { toolCalls: [searchCall("b", { query: "pricing", urls: ["https://example.com/pricing"], freshness: "fresh" })] },
    { text: "The source changed during research: $19 [1] to $25 [2]." },
  ]);
  let call = 0;
  const search: SearchProvider = { search: async query => {
    assert.equal(query.freshness, "fresh");
    assert.deepEqual(query.urls, ["https://example.com/pricing"]);
    return [{ url: "https://example.com/pricing", title: "Pricing", text: ++call === 1 ? "$19" : "$25", retrievedAt: "2026-11-12T10:00:00.000Z" }];
  } };
  const { ask, store } = harness(llm, search, fixedClock("2026-11-03T10:00Z"));
  await ask("verify");
  const sources = store.sourcesFor(1);
  assert.equal(sources.length, 2);
  assert.notEqual(sources[0]!.contentHash, sources[1]!.contentHash);
  assert.equal(sources[0]!.retrievedAt, "2026-11-12T10:00:00.000Z");
  assert.equal(store.episode(1)!.askedAt, Date.parse("2026-11-03T10:00Z"));
});

test("unknown citation numbers are rejected before a claim enters memory", async () => {
  const { llm } = scriptedLlm([{ text: "A fabricated claim [99]." }]);
  const { ask, store } = harness(llm, { search: async () => [] }, fixedClock("2026-11-11T10:00Z"));
  const events = await ask("q");
  assert.equal(store.count(), 0);
  assert.equal(events.at(-1)?.type, "error");
});

test("citation validation ignores code and links, and includes lists and tables", () => {
  assert.deepEqual(citedNumbers('Use `[99]` or [100](https://example.com).\n\n```js\n[101]\n```\n\n- A claim [1, 2].\n\n| Claim | Source |\n| --- | --- |\n| Yes | [3] |'), [1, 2, 3]);
});

test("cancelled turns are not saved even if a model ignores the signal", async () => {
  const abort = new AbortController();
  const llm: Llm = { json: async () => ({}), stream: async () => {
    abort.abort(); return { text: "late answer", toolCalls: [] };
  } };
  const store = new MemoryStore(":memory:");
  const events: AgentEvent[] = [];
  await runTurn({ llm, store, clock: fixedClock("2026-11-11T10:00Z"), search: { search: async () => [] }, enricher: new Enricher(llm, store) },
    { sessionId: "cancel", message: "q", tz: TZ, signal: abort.signal }, e => events.push(e));
  assert.equal(store.count(), 0);
  assert.equal(events.some(e => e.type === "done" || e.type === "error"), false);
  store.close();
});

test("era viewpoint stays pinned while research remains live if the shared clock changes", async () => {
  const asOf = new Date("2020-11-03T09:00:17.123Z");
  let simulated = true;
  const clock: Clock = { now: () => asOf, get simulated() { return simulated; } };
  let streams = 0;
  const llm: Llm = {
    json: async () => ({}),
    stream: async request => {
      if (++streams === 1) {
        simulated = false;
        return { text: "", toolCalls: [searchCall("a", { query: "price" })] };
      }
      request.onText("It was $19 [1].");
      return { text: "It was $19 [1].", toolCalls: [] };
    },
  };
  const search: SearchProvider = { search: async query => {
    assert.equal(query.asOf, undefined);
    assert.equal(query.freshness, "fresh");
    return [{ url: "https://example.com", title: "Historical pricing", text: "The price in 2020 was $19." }];
  } };
  const { ask, store } = harness(llm, search, clock);
  await ask("Is the price still correct?");
  assert.equal(store.sourcesFor(1)[0]!.snapshotAsOf, undefined);
  assert.equal((store.episode(1)!.execution!.time as { effectiveAt: string }).effectiveAt, asOf.toISOString());
  assert.equal((store.episode(1)!.execution!.time as { simulated: boolean }).simulated, true);
});

test("uncertain historical details do not become a capture-access refusal", async () => {
  const { llm } = scriptedLlm([{ toolCalls: [searchCall("a", { query: "price" })] }, { text: "The exact price at the selected date is uncertain." }]);
  const clock: Clock = { now: () => new Date("2020-11-03T09:00Z"), simulated: true };
  const { ask, store } = harness(llm, { search: async () => [{ url: "https://example.com", title: "Live", text: "$500" }] }, clock);
  await ask("What was the price?");
  assert.equal(store.episode(1)!.answer, "The exact price at the selected date is uncertain.");
  assert.equal(store.sourcesFor(1).length, 0);
});

test("historical creative and transformation answers are preserved without search or retraction", async () => {
  const clock: Clock = { now: () => new Date("2020-11-03T09:00Z"), simulated: true };
  for (const [question, answer] of [
    ["Write a haiku about rain.", "Rain taps on the roof\nQuiet streets reflect the moon\nClouds drift into sleep."],
    ["Translate into French: The current price is unknown.", "Le prix actuel est inconnu."],
    ["Summarize this text: We planned, built, and tested the app.", "The team built and tested the app."],
  ]) {
    const { llm } = scriptedLlm([{ text: answer }]);
    const { ask, store } = harness(llm, { search: async () => assert.fail("no search needed") }, clock);
    const events = await ask(question!);
    assert.equal(store.episode(1)!.answer, answer);
    assert.equal(events.some(e => e.type === "retract" || e.type === "error"), false);
    assert.equal(events.at(-1)?.type, "done");
    store.close();
  }
});

for (const question of ["What did I ask on 3 November?", "Recall the managed database comparison."]) {
  test(`a budget-omitted turn remains available through recall: ${question}`, async () => {
    const store = new MemoryStore(":memory:");
    const oldest = store.saveEpisode({ sessionId: "s1", askedAt: Date.parse("2026-11-03T09:00Z"), tz: TZ, question: "managed database comparison", answer: "The retained-answer marker is $19. " + "old ".repeat(1000), sources: [] });
    store.enrich(oldest, { summary: "Compared managed database hosts", topics: ["managed database", "comparison"], claims: [{ entity: "Fictional Cloud", attribute: "price", value: "$19", kind: "price", sourceUrl: "https://example.com/pricing", priorClaimId: null, verdict: "new" }] });
    for (let day = 4; day <= 10; day++) {
      store.saveEpisode({ sessionId: "s1", askedAt: Date.parse(`2026-11-${String(day).padStart(2, "0")}T09:00Z`), tz: TZ, question: `Unrelated question ${day}`, answer: "padding ".repeat(1000), sources: [] });
    }
    const { llm, requests } = scriptedLlm([{ text: "Your earlier comparison had the $19 plan." }]);
    const { ask } = harness(llm, { search: async () => assert.fail("recall alone is sufficient") }, fixedClock("2026-11-11T10:00Z"), store);
    await ask(question);
    const sent = requests[0]!.messages;
    const memoryMessage = sent.find(m => m.role === "user" && m.content.startsWith("UNTRUSTED MEMORY RECORDS"));
    assert.ok(memoryMessage, "omitted history must be recalled");
    const memory = JSON.parse((memoryMessage.content as string).split("\n").slice(1).join("\n")) as string;
    assert.match(memory, /retained-answer marker is \$19/);
    assert.match(memory, /Fictional Cloud · price: \$19/);
    assert.doesNotMatch(memory, /this is in the current chat, above/);
    assert.equal(sent.some(m => m.role === "assistant" && m.content?.includes("retained-answer marker")), false);
    store.close();
  });
}

for (const answer of ["<div>A fact [1].</div>", "<p>A fact &#91;1&#93;.</p>", "<code>[0]</code> A fact [1]."]) {
  test(`historical HTML citations preserve their source evidence: ${answer}`, async () => {
    const { llm } = scriptedLlm([{ toolCalls: [searchCall("html", { query: "historical fact" })] }, { text: answer }]);
    const clock: Clock = { now: () => new Date("2020-11-03T09:00Z"), simulated: true };
    const { ask, store } = harness(llm, { search: async () => [{ url: "https://example.com/fact", title: "Fact", text: "A fact." }] }, clock);
    const events = await ask("What was the fact at this time?");
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(store.episode(1)!.answer, answer);
    assert.equal(store.sourcesFor(1)[0]!.text, "A fact.");
    store.close();
  });
}

test("simulation web failures do not expose the discontinued capture-access message", async () => {
  const { llm } = scriptedLlm([{ toolCalls: [searchCall("a", { query: "historical price" })] }, { text: "I could not verify that." }]);
  const clock: Clock = { now: () => new Date("2020-11-03T09:00Z"), simulated: true };
  const { ask, store } = harness(llm, { search: async query => {
    assert.equal(query.asOf, undefined);
    throw new Error("Exa responded 403.");
  } }, clock);
  const events = await ask("What was the price at that time?");
  const failed = events.find(e => e.type === "search" && e.state === "failed");
  assert.ok(failed?.type === "search");
  assert.match(failed.message!, /A web lookup could not be completed/);
  assert.doesNotMatch(JSON.stringify(events), /HTTP 403|Snapshot|preserved evidence/);
  assert.equal(store.episode(1)!.answer, "I could not verify that.");
  assert.equal(store.sourcesFor(1).length, 0);
  store.close();
});
