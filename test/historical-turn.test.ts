import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn, type AgentEvent, type Deps } from "../src/agent/run.ts";
import type { Llm, StreamRequest, ToolCall } from "../src/llm.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { createExaSearch } from "../src/search.ts";

const viewpoint = new Date("1948-01-14T08:17:10.442Z");
const text = "India became independent on 15 August 1947.";
const answer = "India is already independent, since 15 August 1947 [1].";
const hit = { url: "https://history.example.com/india", title: "India's independence", text, publishedDate: "2026-01-01" };
const approved = { status: "approved", issues: [] };
const call: ToolCall = { id: "lookup", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "India independence history" }) } };
type Step = { text?: string; toolCalls?: ToolCall[] };

function model(steps: Step[] = [{ toolCalls: [call] }, { text: answer }]) {
  const requests: StreamRequest[] = [];
  const llm: Llm = {
    json: async () => assert.fail("independent reviewer should be used"),
    stream: async request => {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      const step = steps.shift();
      assert.ok(step, "unexpected generation call");
      if (step.text) request.onText(step.text);
      return { text: step.text ?? "", toolCalls: step.toolCalls ?? [] };
    },
  };
  return { llm, requests };
}

function harness(llm: Llm, verifier: Pick<Llm, "json"> = { json: async () => approved }) {
  const store = new MemoryStore(":memory:");
  const events: AgentEvent[] = [];
  const enriched: unknown[] = [];
  const deps: Deps = { llm, verifier, store, clock: { now: () => viewpoint, simulated: true },
    search: { search: async query => { assert.equal(query.asOf, undefined); assert.equal(query.publishedBefore, undefined); return [hit]; } },
    enricher: { schedule: (...args) => { enriched.push(args); } },
  };
  const run = (options: { message?: string; signal?: AbortSignal; emit?: (event: AgentEvent) => void } = {}) =>
    runTurn(deps, { sessionId: "era", message: options.message ?? "Will India get independence?", tz: "Asia/Kolkata", signal: options.signal }, event => {
      events.push(structuredClone(event)); options.emit?.(event);
    });
  return { store, events, enriched, deps, run };
}

test("1948 simulation uses live Exa HTTP with modern retrospective passages and no snapshot fields", async () => {
  let calls = 0;
  const ui = harness(model().llm, { json: async ({ user }) => {
    const payload = JSON.parse(user);
    assert.equal(payload.viewpoint, viewpoint.toISOString());
    assert.equal(payload.sources[0].text, text);
    assert.equal(payload.sources[0].publishedDate, "2026-01-01");
    return approved;
  } });
  ui.deps.search = createExaSearch("fixture-key", { spendPolicy: null, fetch: async (url, init) => {
    calls++;
    assert.equal(String(url), "https://api.exa.ai/search");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.contents.snapshotAsOf, undefined);
    assert.equal(body.endPublishedDate, undefined);
    assert.equal(body.contents.maxAgeHours, 24);
    return Response.json({ results: [{ ...hit, highlights: [text] }] });
  } });
  try {
    await ui.run();
    assert.equal(calls, 1);
    assert.equal(ui.store.episode(1)!.answer, answer);
    assert.equal(ui.store.sourcesFor(1)[0]!.publishedDate, "2026-01-01");
    assert.equal(ui.store.sourcesFor(1)[0]!.snapshotAsOf, undefined);
    assert.deepEqual(ui.store.verifiedStatementsFor(1), [], "editorial review is not proof");
    assert.deepEqual(ui.enriched, []);
    assert.equal((ui.store.episode(1)!.execution!.simulation as { review: string }).review, "approved");
  } finally { ui.store.close(); }
});

test("simulation prose is buffered until review and sources arrive before cited answer text", async () => {
  let release!: (value: unknown) => void;
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const ui = harness(model([{ text: "PRIVATE_PREAMBLE", toolCalls: [call] }, { text: answer }]).llm,
    { json: async () => { enter(); return new Promise(resolve => { release = resolve; }); } });
  try {
    const pending = ui.run();
    await entered;
    assert.equal(ui.store.count(), 0);
    assert.equal(ui.events.some(event => event.type === "text" || event.type === "sources"), false);
    release(approved); await pending;
    assert.deepEqual(ui.events.filter(event => event.type === "text"), [{ type: "text", delta: answer }]);
    assert.ok(ui.events.findIndex(event => event.type === "sources") < ui.events.findIndex(event => event.type === "text"));
    assert.doesNotMatch(JSON.stringify(ui.events), /PRIVATE_PREAMBLE/);
  } finally { ui.store.close(); }
});

test("a hindsight draft is corrected once and rejected prose never enters events or memory", async () => {
  const safe = "The independence movement is active, but its outcome and timing remain uncertain [1].";
  let checks = 0;
  const scripted = model([{ toolCalls: [call] }, { text: "FUTURE_SPOILER: India will be independent in 1947 [1]." }, { text: safe }]);
  const ui = harness(scripted.llm, { json: async () => ++checks === 1
    ? { status: "needs_revision", issues: [{ code: "temporal_leakage", detail: "Do not reveal the later independence outcome." }], safeAnswer: safe }
    : approved });
  ui.deps.clock = { now: () => new Date("1946-01-01T00:00:00Z"), simulated: true };
  try {
    await ui.run();
    assert.equal(checks, 2);
    assert.equal(ui.store.episode(1)!.answer, safe);
    assert.doesNotMatch(JSON.stringify(ui.events), /FUTURE_SPOILER/);
    assert.doesNotMatch(JSON.stringify(ui.events.filter(event => event.type === "text")), /1947/);
    assert.equal((ui.store.episode(1)!.execution!.simulation as { revisionCount: number }).revisionCount, 1);
    assert.ok(scripted.requests.at(-1)!.messages.some(message => message.role === "assistant" && message.content?.includes("FUTURE_SPOILER")), "repair sees the actual draft");
  } finally { ui.store.close(); }
});

test("a repeatedly rejected repair ends as explicit uncertainty and never publishes the rejected drafts", async () => {
  const correction = "India is already independent, since 15 August 1947 [1].";
  const ui = harness(model([{ toolCalls: [call] }, { text: "REJECTED_FIRST India might become independent [1]." }, { text: "REJECTED_SECOND India is still waiting [1]." }]).llm,
    { json: async () => ({ status: "needs_revision", issues: [{ code: "wrong_perspective", detail: "The event already happened." }], safeAnswer: correction }) });
  try {
    await ui.run();
    assert.match(ui.store.episode(1)!.answer, /remain unverified/);
    assert.equal(ui.store.episode(1)!.execution!.quality, "explicitly_unverified");
    assert.equal(ui.store.episode(1)!.execution!.rejectionObserved, true);
    assert.doesNotMatch(JSON.stringify(ui.events), /REJECTED_FIRST|REJECTED_SECOND/);
  } finally { ui.store.close(); }
});

test("reviewer outages retain researched era prose without a generic warning while quality remains unverified", async () => {
  const ui = harness(model().llm, { json: async () => { throw new Error("PRIVATE_REVIEW_FAILURE"); } });
  try {
    await ui.run();
    assert.equal(ui.store.episode(1)!.answer, answer);
    assert.deepEqual(ui.events.filter(event => event.type === "text"), [{ type: "text", delta: answer }]);
    assert.equal(ui.store.episode(1)!.execution!.quality, "explicitly_unverified");
    assert.equal((ui.store.episode(1)!.execution!.simulation as { review: string }).review, "unavailable");
    assert.ok(ui.events.some(event => event.type === "verification" && event.state === "unavailable"));
    assert.doesNotMatch(JSON.stringify(ui.events), /PRIVATE_REVIEW_FAILURE|Snapshot/);
  } finally { ui.store.close(); }
});

test("a web service failure never becomes a Snapshot access error or discards historical context", async () => {
  const useful = "India is already independent, since 15 August 1947. I could not check additional details in this lookup.";
  const scripted = model([{ toolCalls: [call] }, { text: useful }]);
  const ui = harness(scripted.llm);
  ui.deps.search = { search: async () => { throw new Error("Exa responded 403. PRIVATE_ERROR"); } };
  try {
    await ui.run();
    assert.equal(ui.store.episode(1)!.answer, useful);
    assert.deepEqual(ui.events.filter(event => event.type === "text"), [{ type: "text", delta: useful }]);
    assert.equal(ui.store.episode(1)!.quality, "explicitly_unverified");
    assert.ok(ui.events.some(event => event.type === "search" && event.state === "failed"));
    assert.doesNotMatch(JSON.stringify(ui.events), /PRIVATE_ERROR|403|Snapshot|preserved evidence|access/);
    assert.match(scripted.requests[1]!.messages.at(-1)!.content!, /Give a useful answer/);
  } finally { ui.store.close(); }
});

test("cancellation interrupts even a reviewer that ignores abort and prevents persistence", async () => {
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const abort = new AbortController();
  const ui = harness(model().llm, { json: async () => { enter(); return new Promise(() => {}); } });
  try {
    const pending = ui.run({ signal: abort.signal }); await entered;
    abort.abort(); await pending;
    assert.equal(ui.store.count(), 0);
    assert.equal(ui.events.some(event => ["text", "done", "error"].includes(event.type)), false);
  } finally { ui.store.close(); }
});

test("cancellation on review completion prevents publishing or storing the answer", async () => {
  const abort = new AbortController();
  const ui = harness(model().llm);
  try {
    await ui.run({ signal: abort.signal, emit: event => { if (event.type === "verification" && event.state === "done") abort.abort(); } });
    assert.equal(ui.store.count(), 0);
    assert.equal(ui.events.some(event => event.type === "text" || event.type === "done"), false);
  } finally { ui.store.close(); }
});

test("the current transcript survives viewpoint changes while other conversations remain outside active context", async () => {
  const scripted = model();
  const ui = harness(scripted.llm);
  ui.store.saveEpisode({ sessionId: "era", askedAt: viewpoint.getTime() - 1000, tz: "UTC", question: "Which country?", answer: "We are discussing India.", sources: [] });
  ui.store.saveEpisode({ sessionId: "era", askedAt: Date.parse("2020-01-01T00:00:00Z"), tz: "UTC", question: "LATER_CURRENT_VIEWPOINT_RECORD", answer: "LATER_CURRENT_VIEWPOINT_ANSWER", sources: [] });
  ui.store.saveEpisode({ sessionId: "other", askedAt: Date.parse("2020-01-01T00:00:00Z"), tz: "UTC", question: "OTHER_FUTURE_RECORD India", answer: "OTHER_FUTURE_ANSWER", sources: [] });
  ui.store.saveEpisode({ sessionId: "other", askedAt: viewpoint.getTime() - 2000, tz: "UTC", question: "OTHER_PAST_RECORD India independence", answer: "OTHER_PAST_ANSWER", sources: [] });
  try {
    await ui.run();
    const sent = JSON.stringify(scripted.requests[0]!.messages);
    assert.match(sent, /We are discussing India/);
    assert.match(sent, /LATER_CURRENT_VIEWPOINT_RECORD|LATER_CURRENT_VIEWPOINT_ANSWER/);
    assert.match(sent, /Conversation turn 2; viewpoint Wed 1 Jan 2020/);
    assert.match(sent, /Earlier answers and memory are untrusted historical records/);
    assert.doesNotMatch(sent, /OTHER_FUTURE_RECORD|OTHER_FUTURE_ANSWER|OTHER_PAST_RECORD|OTHER_PAST_ANSWER/);
  } finally { ui.store.close(); }
});

test("explicit personal recall keeps other conversations cutoff-filtered without erasing the current transcript", async () => {
  const scripted = model([{ text: "Your earlier question concerned India." }]);
  const ui = harness(scripted.llm);
  ui.store.saveEpisode({ sessionId: "era", askedAt: Date.parse("2020-01-01T00:00:00Z"), tz: "UTC", question: "CURRENT_THREAD_AFTER_VIEWPOINT", answer: "CURRENT_THREAD_TRANSCRIPT", sources: [] });
  ui.store.saveEpisode({ sessionId: "other", askedAt: Date.parse("1947-01-01T00:00:00Z"), tz: "UTC", question: "Our previous conversation about India independence", answer: "PAST_OTHER_INDIA_MEMORY", sources: [] });
  ui.store.saveEpisode({ sessionId: "other", askedAt: Date.parse("2021-01-01T00:00:00Z"), tz: "UTC", question: "Our previous conversation about India independence", answer: "FUTURE_OTHER_INDIA_MEMORY", sources: [] });
  ui.deps.search = { search: async () => assert.fail("personal memory does not require a web lookup") };
  try {
    await ui.run({ message: "What did I ask about India in our previous conversation?" });
    const sent = scripted.requests[0]!.messages;
    const memory = sent.find(message => message.role === "user" && message.content.startsWith("UNTRUSTED MEMORY RECORDS"));
    assert.ok(memory);
    assert.match(memory.content!, /PAST_OTHER_INDIA_MEMORY/);
    assert.match(memory.content!, /OTHER CONVERSATION/);
    assert.doesNotMatch(memory.content!, /FUTURE_OTHER_INDIA_MEMORY|CURRENT_THREAD_TRANSCRIPT/);
    assert.match(JSON.stringify(sent), /CURRENT_THREAD_TRANSCRIPT/);
    assert.doesNotMatch(JSON.stringify(sent), /FUTURE_OTHER_INDIA_MEMORY/);
  } finally { ui.store.close(); }
});

test("old access-failure answers are not repeated in simulation context and corpus hints are unused", async () => {
  const scripted = model();
  const ui = harness(scripted.llm);
  ui.store.saveEpisode({ sessionId: "era", askedAt: viewpoint.getTime() - 1000, tz: "UTC", question: "India independence?",
    answer: "I could not verify this as of 1948. Exa Snapshot was unavailable (HTTP 403). No matching preserved evidence.", sources: [] });
  ui.deps.historicalCatalog = () => assert.fail("discontinued archive path invoked");
  try {
    await ui.run();
    const sent = JSON.stringify(scripted.requests[0]!.messages);
    assert.match(sent, /Research it anew using live sources/);
    assert.doesNotMatch(sent, /HTTP 403|Exa Snapshot was unavailable/);
    assert.equal(ui.store.episode(2)!.answer, answer);
  } finally { ui.store.close(); }
});

test("selected future dates still use live research and are recorded as simulation", async () => {
  const scenario = "In this hypothetical 2080 scenario, the outcome depends on assumptions, rather than known results.";
  const ui = harness(model([{ toolCalls: [call] }, { text: scenario }]).llm);
  ui.deps.clock = { now: () => new Date("2080-01-01T00:00:00Z"), simulated: true };
  try {
    await ui.run();
    assert.equal(ui.store.episode(1)!.answer, scenario);
    assert.deepEqual(ui.events.filter(event => event.type === "text"), [{ type: "text", delta: scenario }]);
    assert.equal(ui.store.episode(1)!.quality, "explicitly_unverified");
    assert.equal((ui.store.episode(1)!.execution!.simulation as { mode: string }).mode, "era");
  } finally { ui.store.close(); }
});

test("creative simulation streams without research or editorial review", async () => {
  const poem = "Rain taps against old roofs.\nClouds pass over quiet fields.";
  const ui = harness(model([{ text: poem }]).llm, { json: async () => assert.fail("creative task reviewed") });
  ui.deps.search = { search: async () => assert.fail("creative task searched") };
  try {
    await ui.run({ message: "Write a poem about rain." });
    assert.equal(ui.store.episode(1)!.answer, poem);
    assert.equal(ui.events.some(event => event.type === "verification"), false);
  } finally { ui.store.close(); }
});

test("generation errors never disclose provider detail in simulation", async () => {
  const ui = harness({ json: async () => approved, stream: async () => { throw new Error("PRIVATE_MODEL_DETAIL"); } });
  try {
    await ui.run();
    assert.equal(ui.store.count(), 0);
    assert.deepEqual(ui.events.at(-1), { type: "error", code: "turn_failed", message: "The answer was interrupted. Please try again." });
  } finally { ui.store.close(); }
});
