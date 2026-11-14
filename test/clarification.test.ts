import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { canClarify, parseClarification, parseSelection, type ClarificationAnswer } from "../src/agent/clarification.ts";
import { runTurn, type AgentEvent } from "../src/agent/run.ts";
import { pinTurnTime } from "../src/clock.ts";
import type { Llm, StreamRequest, ToolCall } from "../src/llm.ts";
import { QuestionConflict, QuestionStore } from "../src/memory/questions.ts";
import { MemoryStore } from "../src/memory/store.ts";

const raw = { question: "What matters most for this choice?", why: "This changes which tools and plans I compare.", options: [
  { label: "Small team", detail: "Simple collaboration with a low budget" },
  { label: "Growing company", detail: "Automation and reporting across teams" },
] };
const question = parseClarification(JSON.stringify(raw))!;
const clock = { now: () => new Date("1948-01-14T12:00:00Z"), simulated: true };
const time = pinTurnTime(clock, "Asia/Kolkata");
const askCall = (args: unknown = raw): ToolCall => ({ id: "ask-1", type: "function", function: { name: "ask_clarification", arguments: JSON.stringify(args) } });
const searchCall: ToolCall = { id: "web-1", type: "function", function: { name: "web_search", arguments: '{"query":"small team project tools low budget"}' } };

test("clarification opportunity excludes direct facts, supplied text, creative tasks and explicit opt-outs", () => {
  for (const message of ["Who won the 2023 Nobel Physics Prize?", "When did India become independent?", "hello", "Write a haiku about rain", 'Rewrite this: choose the best laptop', "What did I ask you yesterday?", "Recommend a laptop. Don't ask me any questions.", "Compare CRM tools, just answer.", "Help me choose. Use your best judgment."]) {
    assert.equal(canClarify(message, true), false, message);
  }
  for (const message of ["Help me choose a project management tool", "What should I learn about investing?", "Compare CRM options", "Explain machine learning", "Find me a good hotel", "Any laptop recommendations?", "Suggest a weekend trip"]) assert.equal(canClarify(message, true), true, message);
});

test("model question schema bounds choices and prevents duplicates, injected fields and generated skip options", () => {
  assert.deepEqual(question.options.map(o => o.id), ["a", "b"]);
  for (const value of [null, {}, { ...raw, options: [raw.options[0]] }, { ...raw, options: Array(5).fill(raw.options[0]) },
    { ...raw, options: [raw.options[0], { ...raw.options[0], label: "SMALL TEAM" }] },
    { ...raw, options: [raw.options[0], { label: "Other", detail: "Anything else" }] },
    { ...raw, question: "x".repeat(181) }, { ...raw, why: "x\u0000" }, { ...raw, selected: "a" },
    { ...raw, options: [{ ...raw.options[0], url: "https://bad.test" }, raw.options[1]] }]) {
    assert.equal(parseClarification(JSON.stringify(value)), null, JSON.stringify(value));
  }
  assert.equal(parseClarification("not json"), null);
});

test("selection accepts exactly one bounded preference, server option ID or explicit skip", () => {
  assert.deepEqual(parseSelection({ text: "  A small\nteam   in India " }), { text: "A small team in India" });
  assert.deepEqual(parseSelection({ optionId: "b" }), { optionId: "b" });
  assert.deepEqual(parseSelection({ skip: true }), { skip: true });
  for (const value of [null, [], {}, { skip: false }, { text: " " }, { text: "x".repeat(1001) }, { text: "\u0000" }, { optionId: "e" }, { optionId: "a", text: "injected label" }, { skip: true, fake: true }]) assert.equal(parseSelection(value), null);
});

test("pending question survives restart, is bound to its conversation, and uses saved option text", () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-questions-")), path = join(dir, "test.db");
  let store = new QuestionStore(path);
  try {
    const card = store.create({ sessionId: "s", message: "Help me choose a tool", time, question });
    store.close(); store = new QuestionStore(path);
    assert.deepEqual(store.pending("s"), card);
    assert.equal(store.pending("another"), null);
    assert.throws(() => store.begin(card.id, "another", { optionId: "a" }), QuestionConflict);
    assert.throws(() => store.begin(card.id, "s", { optionId: "d" }), QuestionConflict);
    const saved = store.begin(card.id, "s", { optionId: "a" });
    assert.equal(saved.card.time.effectiveAt, time.effectiveAt);
    assert.equal(saved.selection!.answer, "Small team: Simple collaboration with a low budget");
    assert.throws(() => store.begin(card.id, "s", { optionId: "a" }), /already being prepared/);
    store.release(card.id);
    assert.throws(() => store.begin(card.id, "s", { optionId: "b" }), /different choice/);
    assert.equal(store.pending("s")!.selection!.optionId, "a");
    store.begin(card.id, "s", { optionId: "a" }); store.finish(card.id, 42); store.release(card.id);
    assert.equal(store.pending("s"), null);
    assert.equal(store.begin(card.id, "s", { optionId: "a" }).episodeId, 42);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("custom choices and skip persist as user context, and expired questions cannot resume", () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-questions-")), path = join(dir, "test.db");
  const store = new QuestionStore(path);
  try {
    const card = store.create({ sessionId: "custom", message: "Help me choose", time, question });
    assert.equal(store.begin(card.id, "custom", { text: "For teachers in India" }).selection!.answer, "For teachers in India");
    store.release(card.id);
    const skip = store.create({ sessionId: "skip", message: "Help me choose", time, question });
    assert.equal(store.begin(skip.id, "skip", { skip: true }).selection!.skipped, true);
    store.release(skip.id);
    const db = new DatabaseSync(path);
    db.prepare("UPDATE clarification_questions SET expires_at = ?").run(Date.now() - 1); db.close();
    assert.equal(store.pending("skip"), null);
    assert.throws(() => store.begin(skip.id, "skip", { skip: true }), /expired/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

function harness(steps: Array<{ text?: string; tools?: ToolCall[] }>, simulated = false) {
  const store = new MemoryStore(":memory:"), questions = new QuestionStore(":memory:");
  const requests: StreamRequest[] = [], events: AgentEvent[] = [], queries: string[] = [];
  let enriched = 0;
  const llm: Llm = { async stream(request) {
    requests.push({ ...request, messages: structuredClone(request.messages) });
    const step = steps.shift(); assert.ok(step, "Unexpected extra model call");
    if (step.text) request.onText(step.text);
    return { text: step.text ?? "", toolCalls: step.tools ?? [] };
  }, json: async () => assert.fail("No independent planner is needed") };
  const deps = { llm, store, questions, clock: { ...clock, simulated },
    enricher: { schedule() { enriched++; } }, verifier: { json: async () => ({ status: "approved", issues: [] }) },
    search: { async search(query: { query: string }) { queries.push(query.query); return [{ url: "https://example.com/tools", title: "Tools", text: "The basic plan supports a small team on a low budget." }]; } } };
  return { deps, requests, events, queries, enriched: () => enriched,
    async run(clarification?: ClarificationAnswer) {
      events.length = 0;
      await runTurn(deps, { sessionId: "s", message: "Help me choose a project management tool", tz: "Asia/Kolkata", clarification }, e => events.push(e));
    }, close() { store.close(); questions.close(); } };
}

test("asking pauses before research, with no fabricated answer, episode, enrichment, or open model call", async () => {
  const h = harness([{ text: "Let me ask first.", tools: [askCall()] }], true);
  try {
    await h.run();
    assert.deepEqual(h.events.map(e => e.type), ["recall", "clarification"]);
    assert.equal(h.requests.length, 1); assert.equal(h.queries.length, 0);
    assert.equal(h.deps.store.count(), 0); assert.equal(h.enriched(), 0);
    const card = h.deps.questions.pending("s")!;
    assert.equal(card.message, "Help me choose a project management tool");
    assert.equal(card.time.simulated, true); assert.equal(card.time.effectiveAt, time.effectiveAt);
  } finally { h.close(); }
});

test("optional clarification adds no planner call or duplicate text when the model answers directly", async () => {
  const h = harness([{ text: "Use these criteria to decide." }]);
  try {
    await h.run();
    assert.equal(h.requests.length, 1); assert.equal(h.deps.questions.pending("s"), null);
    assert.deepEqual(h.events.filter(e => e.type === "text"), [{ type: "text", delta: "Use these criteria to decide." }]);
    assert.ok(h.events.some(e => e.type === "done")); assert.equal(h.deps.store.count(), 1);
  } finally { h.close(); }
});

test("a selected preference reaches search and the final request, is saved, and cannot trigger a second clarification", async () => {
  const h = harness([{ tools: [askCall()] }, { tools: [searchCall] }, { text: "For your small team, compare the basic plans. [1]" }], true);
  try {
    await h.run();
    const card = h.deps.questions.pending("s")!;
    const choice = h.deps.questions.begin(card.id, "s", { optionId: "a" });
    await h.run(choice.selection!);
    const resume = h.requests[1]!;
    assert.deepEqual(resume.tools.map(t => t.function.name), ["web_search"]);
    assert.match(JSON.stringify(resume.messages), /Small team: Simple collaboration with a low budget/);
    assert.equal(resume.messages.at(-1)!.content, card.message);
    assert.match(JSON.stringify(resume.messages), /not sourced factual evidence/);
    assert.equal(h.queries.length, 1);
    const episode = h.deps.store.episode(1)!;
    assert.equal(episode.question, card.message);
    assert.deepEqual(episode.execution!.clarification, choice.selection);
    assert.equal(episode.askedAt, Date.parse(time.effectiveAt));
    assert.equal(h.events.some(e => e.type === "clarification"), false);
    assert.ok(h.events.some(e => e.type === "done"));
  } finally { h.close(); }
});

test("invalid or simultaneous clarification calls fall back to bounded research instead of a question loop", async () => {
  for (const tools of [[askCall({ ...raw, options: [] })], [askCall(), searchCall]]) {
    const h = harness([{ tools }, { text: "A useful answer using stated assumptions." }]);
    try {
      await h.run();
      assert.equal(h.deps.questions.pending("s"), null);
      assert.deepEqual(h.requests[1]!.tools.map(t => t.function.name), ["web_search"]);
      assert.match(JSON.stringify(h.requests[1]!.messages), /No further clarification is available/);
      assert.ok(h.events.some(e => e.type === "done"));
    } finally { h.close(); }
  }
});
