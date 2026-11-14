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

