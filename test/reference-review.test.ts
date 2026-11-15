import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { reviewSimulationAnswer } from "../src/agent/simulation.ts";
import type { ConversationAnchor } from "../src/agent/context.ts";
import { runTurn, type AgentEvent } from "../src/agent/run.ts";
import { MemoryStore, type Source } from "../src/memory/store.ts";
import type { Llm } from "../src/llm.ts";

const previous = "Kimi and Claude need a task-specific coding comparison.";
const reference: ConversationAnchor = { episodeId: 1, ownerId: "local", sessionId: "models", sequence: 1,
  question: "Compare Kimi and Claude for coding", answer: previous, viewpointAt: Date.parse("2026-11-15T00:00:00Z"),
  createdAt: Date.parse("2026-11-15T00:00:00Z"), answerHash: createHash("sha256").update(previous).digest("hex"), truncated: false };
const source: Source = { n: 1, url: "https://example.com/models", title: "Coding comparison", text: previous };
const referenceCheck = { episodeId: 1, answerHash: reference.answerHash, addressesTarget: true, coverage: "complete" };
const approved = { status: "approved", issues: [], quality: "supported", referenceCheck,
  claimChecks: [{ claim: previous, sourceNumbers: [1], supported: true, applicable: true }] };
const input = { question: "verify your claims now", answer: `${previous} [1]`, reference,
  sources: [source], viewpoint: new Date("2026-05-15T00:00:00Z"), researchedAt: new Date("2026-11-15T00:00:00Z"),
  kind: "simulation" as const, timeoutMs: 100 };

test("historical follow-up review checks the exact conversation reference and its passage support", async () => {
  const review = await reviewSimulationAnswer({ ...input, llm: { json: async request => {
    const payload = JSON.parse(request.user);
    assert.deepEqual(payload.reference, reference);
    assert.equal(payload.viewpoint, input.viewpoint.toISOString());
    assert.match(request.system, /historical EVENT date/);
    assert.match(request.system, /CONVERSATION REFERENCE CHECK/);
    assert.match(request.system, /claimChecks/);
    return approved;
  } } });
  assert.equal(review.status, "approved"); assert.equal(review.quality, "supported");
});

for (const check of [undefined, { ...referenceCheck, episodeId: 2 }, { ...referenceCheck, answerHash: "0".repeat(64) },
  { ...referenceCheck, addressesTarget: false }, { ...referenceCheck, coverage: "guessed" }]) {
  test(`cited correct facts cannot pass with a missing or mismatched conversation target: ${JSON.stringify(check)}`, async () => {
    const raw = { ...approved, referenceCheck: check };
    const review = await reviewSimulationAnswer({ ...input, llm: { json: async () => raw } });
    assert.equal(review.status, "needs_revision"); assert.equal(review.reason, "context_mismatch");
    assert.equal(review.issues[0]?.code, "wrong_context");
  });
}

test("a referenced historical answer also needs material claim checks, not just an echoed target ID", async () => {
  const review = await reviewSimulationAnswer({ ...input, llm: { json: async () => ({ ...approved, claimChecks: [] }) } });
  assert.equal(review.status, "needs_revision");
});

test("a truncated original answer cannot be approved as completely checked", async () => {
  const review = await reviewSimulationAnswer({ ...input, reference: { ...reference, truncated: true },
    llm: { json: async () => approved } });
  assert.equal(review.status, "needs_revision"); assert.equal(review.issues[0]?.code, "incomplete_answer");
  const partial = await reviewSimulationAnswer({ ...input, reference: { ...reference, truncated: true },
    llm: { json: async () => ({ ...approved, referenceCheck: { ...referenceCheck, coverage: "partial" } }) } });
  assert.equal(partial.status, "approved"); assert.equal(partial.quality, "supported_partial");
});

test("an unavailable reference review cannot publish a researched answer to another subject", async () => {
  const store = new MemoryStore(":memory:");
  try {
    store.saveEpisode({ sessionId: "models", askedAt: reference.viewpointAt, tz: "UTC", question: reference.question,
      answer: previous, sources: [], quality: "explicitly_unverified" });
    const events: AgentEvent[] = []; let calls = 0;
    const llm: Llm = { json: async () => { throw new Error("review unavailable"); }, stream: async request => {
      if (calls++ === 0) return { text: "", toolCalls: [{ id: "lookup", type: "function", function: {
        name: "web_search", arguments: JSON.stringify({ query: "IPL winners" }) } }] };
      const text = "Rajasthan Royals won the 2008 IPL [1].";
      request.onText(text); return { text, toolCalls: [] };
    } };
    await runTurn({ llm, store, clock: { now: () => new Date(reference.viewpointAt), simulated: false },
      search: { search: async () => [{ url: "https://example.com/ipl", title: "IPL", text: "Rajasthan Royals won the 2008 IPL." }] },
      enricher: { schedule() {} } }, { sessionId: "models", message: "verify your claims now", tz: "UTC" }, event => events.push(event));
    const prose = events.filter(event => event.type === "text").map(event => event.delta).join("");
    assert.doesNotMatch(prose, /IPL|Rajasthan/);
    assert.match(prose, /previous answer.*conversation/);
    const done = events.find(event => event.type === "done"); assert.ok(done && done.type === "done");
    assert.equal(done.quality, "explicitly_unverified");
    const saved = store.episode(done.episodeId)!;
    assert.doesNotMatch(saved.answer, /IPL|Rajasthan/);
    assert.equal((saved.execution?.requestContext as { anchorEpisodeId: number }).anchorEpisodeId, 1);
  } finally { store.close(); }
});
