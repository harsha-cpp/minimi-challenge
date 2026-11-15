import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn, type AgentEvent, type Deps } from "../src/agent/run.ts";
import { EvidenceWindow } from "../src/agent/evidence.ts";
import { turnPolicy, PROMPT_LIMITS } from "../src/agent/prepare.ts";
import { reviewSimulationAnswer } from "../src/agent/simulation.ts";
import type { Llm, ToolCall } from "../src/llm.ts";
import { MemoryStore } from "../src/memory/store.ts";
import type { SearchHit } from "../src/search.ts";

const hit: SearchHit = { url: "https://example.com/price", title: "Current price", text: "The current price is $25 monthly.",
  freshness: { requested: "fresh", acquisition: "live", ageStatus: "known", contentFetchedAt: new Date().toISOString() } };
const call: ToolCall = { id: "lookup", type: "function", function: { name: "web_search", arguments: '{"query":"current price"}' } };
const answer = "The current price is $25 monthly [1].";
const approved = { status: "approved", issues: [], quality: "supported", claimChecks: [
  { claim: "The current price is $25 monthly.", sourceNumbers: [1], supported: true, applicable: true },
] };
const rejected = (safeAnswer: unknown = null) => ({ status: "needs_revision", issues: [
  { code: "unsupported_claim", detail: "The passage does not establish this current value." },
], safeAnswer });

function harness(options: { lookup?: "none" | "empty" | "failed" | "irrelevant"; reviews?: unknown[]; simulated?: boolean;
  repair?: "error" | "timeout" | string; saveFailure?: boolean; question?: string; draft?: string } = {}) {
  const store = new MemoryStore(":memory:");
  const events: AgentEvent[] = [];
  let generations = 0, checks = 0, lookups = 0;
  const draft = options.draft ?? answer;
  const drafts = options.lookup === "none" ? [{ text: draft, toolCalls: [] }] : [{ text: "", toolCalls: [call] }, { text: draft, toolCalls: [] }];
  const llm: Llm = {
    json: async () => ({}),
    async stream(request) {
      generations++;
      const step = drafts.shift();
      if (step) { request.onText(step.text); return step; }
      if (options.repair === "timeout") return new Promise(() => {});
      if (options.repair === "error") throw new Error("PRIVATE_REPAIR_FAILURE");
      return { text: options.repair ?? "REJECTED_REPAIR $100 is correct [1].", toolCalls: [] };
    },
  };
  const deps: Deps = { store, llm, verifier: { json: async () => {
    const value = options.reviews?.[checks] ?? approved; checks++;
    if (value instanceof Error) throw value;
    if (value === "timeout") return new Promise(() => {});
    return value;
  } }, clock: { simulated: options.simulated ?? false, now: () => new Date("2026-11-15T00:00:00Z") },
  search: { search: async query => {
    lookups++;
    assert.equal(query.freshness, "fresh");
    if (options.lookup === "failed") throw new Error("PRIVATE_PROVIDER_FAILURE");
    if (options.lookup === "empty") return [];
    if (options.lookup === "irrelevant") return [{ ...hit, text: "This is a recipe for soup." }];
    return [hit];
  } }, enricher: { schedule() {} }, reviewTimeoutMs: 5, repairTimeoutMs: 5 };
  if (options.saveFailure) store.saveEpisode = () => { throw new Error("disk full"); };
  const run = () => runTurn(deps, { message: options.question ?? "Verify the current Acme price.", sessionId: "s", tz: "UTC" }, event => {
    if (event.type === "text") assert.equal(store.count(), 1, "factual prose must already be committed");
    events.push(event);
  });
  return { store, run, events, counts: () => ({ generations, checks, lookups }) };
}

for (const lookup of ["none", "empty", "failed"] as const) {
  test(`current verification cannot rubber-stamp ${lookup} search evidence`, async () => {
    const h = harness({ lookup });
    try {
      await h.run();
      assert.equal(h.events.at(-1)?.type, "done");
      const terminal = h.events.at(-1);
      assert.equal(terminal?.type === "done" && terminal.quality, "explicitly_unverified");
      assert.match(h.store.episode(1)!.answer, /couldn't verify/);
      assert.doesNotMatch(h.store.episode(1)!.answer, /\$25/);
      assert.equal(h.counts().checks, 0, "absence of evidence is determined before model review");
    } finally { h.store.close(); }
  });
}

test("irrelevant passages with valid citation numbers are rejected as unsupported", async () => {
  const h = harness({ lookup: "irrelevant", reviews: [rejected(), rejected()], repair: "REJECTED_REPAIR $100 is correct [1]." });
  try {
    await h.run();
    assert.match(h.store.episode(1)!.answer, /couldn't verify/);
    assert.equal(h.store.episode(1)!.execution!.rejectionObserved, true);
    assert.doesNotMatch(JSON.stringify(h.events), /REJECTED_REPAIR|\$25|\$100/);
  } finally { h.store.close(); }
});

test("current verification requires explicit support/applicability checks, then publishes after commit", async () => {
  const h = harness();
  try {
    await h.run();
    assert.equal(h.store.episode(1)!.answer, answer);
    assert.equal(h.store.episode(1)!.execution!.quality, "supported");
    const terminal = h.events.at(-1);
    assert.equal(terminal?.type === "done" && terminal.quality, "supported");
    assert.equal(h.counts().checks, 1);
  } finally { h.store.close(); }
});

for (const unavailable of [new Error("PRIVATE_REVIEW_FAILURE"), "timeout"]) {
  test(`current verification review ${unavailable instanceof Error ? "outage" : "timeout"} cannot publish an unchecked Verified draft`, async () => {
    const h = harness({ reviews: [unavailable], draft: "Verified: the current price is $25 monthly [1]." });
    const keepAlive = setTimeout(() => {}, 100);
    try {
      await h.run();
      const saved = h.store.episode(1)!;
      assert.equal(saved.quality, "explicitly_unverified");
      assert.match(saved.answer, /couldn't verify/);
      assert.doesNotMatch(saved.answer, /Verified:|\$25|Treat the following as unverified/);
      const prose = h.events.filter(event => event.type === "text").map(event => event.delta).join("");
      assert.equal(prose, saved.answer);
      assert.doesNotMatch(prose, /I could not verify this answer against the available evidence/);
      assert.deepEqual(h.counts(), { generations: 2, checks: 1, lookups: 1 });
      assert.ok(h.events.some(event => event.type === "done" && event.quality === "explicitly_unverified"));
    } finally { clearTimeout(keepAlive); h.store.close(); }
  });
}

for (const malformed of [{ status: "approved", issues: [] }, { ...approved, claimChecks: [] },
  { ...approved, claimChecks: [{ claim: "Price is $25", sourceNumbers: [1], supported: false, applicable: true }] },
  { ...approved, claimChecks: [{ claim: "Price is $25", sourceNumbers: [1], supported: true, applicable: false }] }]) {
  test(`an incomplete support verdict cannot finish as supported: ${JSON.stringify(malformed)}`, async () => {
    const h = harness({ reviews: [malformed, malformed] });
    try {
      await h.run();
      assert.equal(h.store.episode(1)!.execution!.quality, "explicitly_unverified");
      assert.match(h.store.episode(1)!.answer, /unverified|couldn't verify/);
    } finally { h.store.close(); }
  });
}

for (const correction of ["Wrong [99].", "", "x".repeat(6001), "x".repeat(20_000)]) {
  for (const second of [new Error("PRIVATE_REVIEW_OUTAGE"), "timeout"]) {
    test(`negative verdict survives malformed correction (${correction.length}) and ${second instanceof Error ? "outage" : second}`, async () => {
      const h = harness({ reviews: [rejected(correction), second], repair: "REJECTED_REPAIR $100 is correct [1]." });
      const keepAlive = setTimeout(() => {}, 100);
      try {
        await h.run();
        assert.equal(h.store.episode(1)!.execution!.rejectionObserved, true);
        assert.match(h.store.episode(1)!.answer, /couldn't verify/);
        assert.doesNotMatch(JSON.stringify(h.events), /REJECTED_REPAIR|\$25|\$100|PRIVATE_/);
      } finally { clearTimeout(keepAlive); h.store.close(); }
    });
  }
}

for (const repair of ["error", "timeout"] as const) {
  test(`negative verdict survives repair ${repair}`, async () => {
    const h = harness({ reviews: [rejected(null)], repair });
    const keepAlive = setTimeout(() => {}, 100);
    try {
      await h.run();
      assert.match(h.store.episode(1)!.answer, /couldn't verify/);
      assert.equal(h.store.episode(1)!.execution!.rejectionObserved, true);
      assert.doesNotMatch(JSON.stringify(h.events), /\$25|PRIVATE_/);
    } finally { clearTimeout(keepAlive); h.store.close(); }
  });
}

test("a commit failure cannot expose buffered factual prose", async () => {
  const h = harness({ saveFailure: true });
  try {
    await h.run();
    assert.equal(h.store.count(), 0);
    assert.equal(h.events.some(event => event.type === "text" || event.type === "done"), false);
    assert.equal(h.events.at(-1)?.type, "error");
  } finally { h.store.close(); }
});

test("supported uncertainty is approved without manufacturing factual assertions", async () => {
  const review = await reviewSimulationAnswer({ llm: { json: async () => ({ status: "approved", issues: [], quality: "explicitly_unverified", claimChecks: [] }) },
    kind: "verification", question: "Verify the current price", answer: "The exact price remains uncertain.", sources: [ { ...hit, n: 1 } ], viewpoint: new Date(), timeoutMs: 100 });
  assert.equal(review.status, "approved");
  assert.equal(review.quality, "explicitly_unverified");
});

test("supplied-text transformations and ordinary conversation preserve the no-review path", () => {
  for (const question of ['Translate into French: Verify the current price.', 'Rewrite "verify the latest price" politely.', 'hi']) {
    assert.equal(turnPolicy(question, false).requireVerificationEvidence, false);
  }
  assert.equal(turnPolicy("Rewrite this text and verify current prices: plan is $10.", false).requireVerificationEvidence, true);
});

test("exact repeated observations consume compact references and leave room for later decisive evidence", () => {
  const evidence = new EvidenceWindow();
  const hits = Array.from({ length: 5 }, (_, n) => ({ ...hit, url: `https://example.com/${n}`, text: `${n} ` + "p".repeat(2500) }));
  let count = 0;
  const number = () => ++count;
  const outputs = [evidence.render({ query: "initial" }, hits, number), evidence.render({ query: "again" }, hits, number),
    evidence.render({ query: "yet again" }, hits, number), evidence.render({ query: "decisive" }, [{ ...hit, url: "https://primary.example/fact", text: "The decisive new fact." }], number)];
  assert.equal(count, 6);
  assert.equal(evidence.stats.duplicatePassages, 10);
  assert.match(outputs[1]!, /\[1\] Same observation/);
  assert.match(outputs[3]!, /\[6\][\s\S]*decisive new fact/);
  assert.ok(outputs[1]!.length < 1000);
  assert.ok(outputs.join("").length <= PROMPT_LIMITS.toolChars);
});

test("round packing shares capacity across query facets and preserves a later expansion reserve", () => {
  const evidence = new EvidenceWindow();
  let next = 0;
  const first = evidence.renderRound(["left", "right"].map(query => ({ query: { query }, hits: Array.from({ length: 5 }, (_, n) =>
    ({ ...hit, url: `https://example.com/${query}/${n}`, text: query + "x".repeat(6000) })) })), () => ++next);
  assert.ok(first.every(output => output.includes("PASSAGE")));
  assert.ok(first.join("").length <= PROMPT_LIMITS.toolChars * 0.75);
  const final = evidence.render({ query: "missing facet" }, [{ ...hit, url: "https://example.com/final", text: "Final missing facet supported by a decisive passage." }], () => ++next);
  assert.match(final, /Final missing facet supported/);
  assert.equal(evidence.stats.toolChars, first.join("").length + final.length);
});


test("an explicitly-unverified reviewer label with no checked claims cannot publish an assertive verification draft", async () => {
  const h = harness({ reviews: [{ status: "approved", issues: [], quality: "explicitly_unverified", claimChecks: [] }] });
  try {
    await h.run();
    const episode = h.store.episode(1)!;
    assert.equal(episode.quality, "explicitly_unverified");
    assert.match(episode.answer, /couldn't verify/);
    assert.doesNotMatch(episode.answer, /\$25/);
    assert.doesNotMatch(JSON.stringify(h.events.filter(event => event.type === "text")), /\$25/);
    assert.deepEqual(h.store.sourcesFor(1), []);
  } finally { h.store.close(); }
});

test("review summaries persist bounded failure reasons without drafts or review findings", async () => {
  const h = harness({ reviews: ["timeout"] });
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await h.run();
    const summary = h.store.episode(1)!.execution!.review as { kind: string; status: string; reason: string; calls: number; attempts: unknown[] };
    assert.equal(summary.kind, "verification");
    assert.equal(summary.status, "unavailable");
    assert.equal(summary.reason, "review_timeout");
    assert.equal(summary.calls, 1);
    assert.equal(summary.attempts.length, 1);
    assert.doesNotMatch(JSON.stringify(summary), /\$25|question|draft|issues|safeAnswer|sources|PRIVATE_/);
  } finally { clearTimeout(keepAlive); h.store.close(); }
});
