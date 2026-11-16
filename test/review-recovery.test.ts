import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { reviewSimulationAnswer, type SimulationReviewInput } from "../src/agent/simulation.ts";
import { recoverReviewFailure } from "../src/agent/review-recovery.ts";
import type { ConversationAnchor } from "../src/agent/context.ts";

const supported = "Acme Starter costs $25 per seat each month when billed annually [1].";
const unsupported = "Acme Enterprise is available worldwide for $10 [2].";
const draft = `${supported}\n\n${unsupported}`;
const reference: ConversationAnchor = { episodeId: 8, ownerId: "local", sessionId: "pricing", sequence: 1,
  question: "Compare Acme prices", answer: draft, viewpointAt: 1704067200000, createdAt: 1704067200000,
  answerHash: createHash("sha256").update(draft).digest("hex"), truncated: false };
const referenceCheck = { episodeId: 8, answerHash: reference.answerHash, addressesTarget: true, coverage: "partial" };
const rejected = { status: "needs_revision", issues: [{ code: "unsupported_claim", detail: "Enterprise price and availability have not been established." }],
  safeAnswer: null, claimChecks: [], approvedFindings: [{ text: supported, sourceNumbers: [1], supported: true, applicable: true, selfContained: true }], referenceCheck };
const base: Omit<SimulationReviewInput, "llm"> = {
  question: "Re-check those prices", answer: draft, reference, viewpoint: new Date("2026-11-16T12:00:00Z"), kind: "verification",
  sources: [{ n: 1, url: "https://acme.example/pricing", title: "Pricing", text: "Starter: $25 per seat per month, annual billing." },
    { n: 2, url: "https://acme.example/enterprise", title: "Enterprise", text: "Contact sales for Enterprise pricing and region availability." }],
};
const review = (raw: unknown, input: Partial<SimulationReviewInput> = {}) => reviewSimulationAnswer({ ...base, llm: { json: async () => raw }, ...input });

test("only independently approved complete paragraphs survive a failed correction", async () => {
  const result = await review(rejected);
  assert.equal(result.status, "needs_revision");
  assert.deepEqual(result.approvedFindings, [{ text: supported, sourceNumbers: [1] }]);
  const recovery = recoverReviewFailure(result, true);
  assert.equal(recovery.quality, "supported_partial");
  assert.match(recovery.answer, /\$25 per seat each month when billed annually \[1\]/);
  assert.doesNotMatch(recovery.answer, /Enterprise|worldwide|\$10|\[2\]/);
  assert.match(recovery.answer, /remaining claims are still unverified/);
  assert.equal(recovery.failure.retryScope, "unfinished_claims");
});

test("a partial check cannot rescue an altered claim, dropped qualification, missing source or false approval", async () => {
  for (const finding of [
    { ...rejected.approvedFindings[0], text: "Acme Starter costs $25 [1]." },
    { ...rejected.approvedFindings[0], text: "Acme Starter costs $50 [1]." },
    { ...rejected.approvedFindings[0], sourceNumbers: [2] },
    { ...rejected.approvedFindings[0], sourceNumbers: [1, 1] },
    { ...rejected.approvedFindings[0], supported: false },
    { ...rejected.approvedFindings[0], applicable: false },
    { ...rejected.approvedFindings[0], selfContained: false },
    { ...rejected.approvedFindings[0], selfContained: undefined },
  ]) {
    const result = await review({ ...rejected, approvedFindings: [finding] });
    assert.equal(result.status, "needs_revision");
    assert.equal(result.reason, "invalid_review_output");
    assert.equal(result.approvedFindings, undefined);
    assert.equal(recoverReviewFailure(result, true).quality, "explicitly_unverified");
  }
});

test("conflicting claim checks cannot accompany independently approved findings", async () => {
  const result = await review({ ...rejected, claimChecks: [{ claim: supported, sourceNumbers: [1], supported: false, applicable: true }] });
  assert.equal(result.status, "needs_revision");
  assert.equal(result.reason, "invalid_review_output");
  assert.equal(result.approvedFindings, undefined);
});

test("partial findings require the exact conversation reference and partial scope", async () => {
  for (const check of [undefined, { ...referenceCheck, episodeId: 9 }, { ...referenceCheck, answerHash: "0".repeat(64) },
    { ...referenceCheck, addressesTarget: false }, { ...referenceCheck, coverage: "complete" }, { ...referenceCheck, coverage: "unresolved" }]) {
    const result = await review({ ...rejected, referenceCheck: check });
    assert.equal(result.status, "needs_revision");
    assert.equal(result.approvedFindings, undefined);
  }
  const wrongContext = await review({ ...rejected, issues: [{ code: "wrong_context", detail: "This answer concerns another product." }] });
  assert.equal(wrongContext.approvedFindings, undefined);
});

test("duplicate paragraphs and findings on approved verdicts are rejected", async () => {
  const duplicate = await review({ ...rejected, approvedFindings: [rejected.approvedFindings[0], rejected.approvedFindings[0]] });
  assert.equal(duplicate.reason, "invalid_review_output");
  assert.equal(duplicate.approvedFindings, undefined);
  const approval = await review({ ...rejected, status: "approved", issues: [], quality: "supported_partial",
    claimChecks: [{ claim: "Starter cost", sourceNumbers: [1], supported: true, applicable: true }] });
  assert.equal(approval.status, "unavailable");
  assert.equal(approval.approvedFindings, undefined);
});

test("an empty optional findings array does not manufacture a recovery or invalidate an otherwise valid review", async () => {
  const negative = await review({ ...rejected, approvedFindings: [], referenceCheck: undefined });
  assert.equal(negative.status, "needs_revision");
  assert.equal(negative.reason, undefined);
  assert.equal(negative.approvedFindings, undefined);
  const positive = await review({ status: "approved", issues: [], quality: "supported_partial", approvedFindings: [], referenceCheck,
    claimChecks: [{ claim: "Starter cost", sourceNumbers: [1], supported: true, applicable: true }] });
  assert.equal(positive.status, "approved");
  assert.equal(positive.quality, "supported_partial");
});

test("verification retains uncited newer contradictions and event and commercial distinctions", async () => {
  const conflict = { n: 3, title: "New Acme pricing", url: "https://acme.example/update", publishedDate: "2026-11-16",
    text: "Acme Starter now costs $30 per seat per month with annual billing. The old $25 price no longer applies." };
  await review(rejected, { sources: [...base.sources, conflict],
    llm: { json: async request => {
      const input = JSON.parse(request.user);
      assert.deepEqual(input.sources.map((source: { n: number }) => source.n), [1, 2, 3]);
      assert.equal(input.sources[0].text, base.sources[0]!.text);
      assert.equal(input.sources[2].text, conflict.text);
      assert.equal(input.sources[2].publishedDate, conflict.publishedDate);
      assert.match(request.system, /ALL supplied passages for contradictions/);
      assert.match(request.system, /publication date alone cannot establish/);
      assert.match(request.system, /billing period, per-seat versus total charge/);
      assert.match(request.system, /announced, preview, generally available and restricted access/);
      return rejected;
    } } });
});

test("candidate evidence is not removed by missing lexical overlap or an uncited alias", async () => {
  const alias = { n: 3, title: "Subscription changes", url: "https://updates.example/renaming", text: "Zeta Basic: 30 USD / user / year. Effective immediately." };
  await review(rejected, { sources: [...base.sources, alias], llm: { json: async request => {
    const input = JSON.parse(request.user);
    assert.equal(input.sources.find((source: { n: number }) => source.n === 3).text, alias.text);
    return rejected;
  } } });
});

test("bounded acquisition and omitted-context metadata reaches the reviewer outside source text", async () => {
  const passageSelection = { selection: "query-passages" as const, receivedCharacters: 400_000, omittedCharacters: 388_000,
    requestedCharacters: 400_000, acquisitionMayBeTruncated: true, boundedDocumentHash: "d".repeat(64) };
  await review(rejected, { sources: [{ ...base.sources[0]!, retrieval: { profile: "verification", mode: "auto", content: "full",
    policyVersion: "profiles-passages-v2", passageSelection } }, base.sources[1]!], llm: { json: async request => {
    const payload = JSON.parse(request.user);
    assert.deepEqual(payload.sources[0].passageSelection, passageSelection);
    assert.equal(payload.sources[0].text, base.sources[0]!.text);
    assert.match(request.system, /not a complete document/);
    assert.match(request.system, /Do not infer document-wide absence/);
    return rejected;
  } } });
});

test("byte-identical passages are sent once while every source keeps its number, date and freshness", async () => {
  const repeated = "Search result material repeated across mirrors. ".repeat(60);
  const candidates = Array.from({ length: 12 }, (_, i) => ({ n: i + 3, title: `Candidate ${i}`, url: `https://candidate${i}.example`, text: repeated,
    publishedDate: `2026-11-${String(i + 1).padStart(2, "0")}` }));
  await review(rejected, { sources: [...base.sources, ...candidates], llm: { json: async request => {
    const input = JSON.parse(request.user);
    assert.equal(input.sources.length, 14);
    assert.equal(input.sources[2].text, repeated);
    for (let i = 3; i < input.sources.length; i++) {
      assert.equal(input.sources[i].samePassageAs, 3);
      assert.equal(input.sources[i].text, undefined);
      assert.equal(input.sources[i].url, candidates[i - 2]!.url);
      assert.equal(input.sources[i].publishedDate, candidates[i - 2]!.publishedDate);
    }
    assert.ok(request.user.length < repeated.length * 3, "exact deduplication materially reduces repeated candidate evidence without hiding observations");
    return rejected;
  } } });
});

test("oversized uncited contradictory evidence cannot be silently discarded to approve a cited claim", async () => {
  let calls = 0;
  const result = await review(rejected, { sources: [...base.sources,
    { n: 3, title: "Acme new price", url: "https://acme.example/new", text: "Acme now costs $30, not $25. ".repeat(2000) }],
    llm: { json: async () => { calls++; return { status: "approved", issues: [] }; } } });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "review_limit");
  assert.equal(calls, 0);
});

test("oversized cited context is not silently truncated for a positive verification verdict", async () => {
  let calls = 0;
  const result = await review(rejected, { sources: [{ ...base.sources[0]!, text: "x".repeat(40_001) }, base.sources[1]!],
    llm: { json: async () => { calls++; return { status: "approved", issues: [] }; } } });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "review_limit");
  assert.equal(calls, 0);
  assert.equal(recoverReviewFailure(result, true).failure.reason, "review_limit");
});

test("timeouts, provider failure and insufficient evidence have distinct recoverable outcomes", async () => {
  const keepAlive = setTimeout(() => {}, 100);
  try {
    const timeout = await review(null, { timeoutMs: 5, llm: { json: async () => new Promise(() => {}) } });
    const outage = await review(null, { llm: { json: async () => { throw new Error("secret internal endpoint"); } } });
    const insufficient = await review({ ...rejected, approvedFindings: undefined });
    for (const [result, reason] of [[timeout, "review_timeout"], [outage, "review_unavailable"], [insufficient, "insufficient_evidence"]] as const) {
      const recovery = recoverReviewFailure(result, true);
      assert.equal(recovery.failure.reason, reason);
      assert.equal(recovery.quality, "explicitly_unverified");
      assert.match(recovery.answer, /previous answer in this conversation/);
      assert.doesNotMatch(recovery.answer, /secret internal endpoint|\$25|\$10/);
    }
  } finally { clearTimeout(keepAlive); }
});
