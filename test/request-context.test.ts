import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { resolveRequestContext, REQUEST_CONTEXT_LIMITS } from "../src/agent/context.ts";
import type { Episode } from "../src/memory/store.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const episode = (id: number, patch: Partial<Episode> = {}): Episode => ({
  id, sequence: id, ownerId: "local", sessionId: "visible", askedAt: Date.parse("2026-11-15T09:00:00Z"),
  createdAt: Date.parse("2026-11-15T09:00:01Z"), tz: "UTC", question: "Compare Kimi and Claude for coding",
  answer: "Kimi and Claude have different coding strengths.", summary: null, topics: null, ...patch,
});
const resolve = (message: string, history: Episode[] = []) => resolveRequestContext({ message, sessionId: "visible", history });
const missing = { kind: "missing_reference", memoryScope: "none" };
const standalone = { kind: "standalone", memoryScope: "none" };

test("subject-free verification requires an actual conversational predecessor", () => {
  for (const message of [
    "verify your claims now", "is that still true?", "fact check your previous answer", "verify this",
    "Please check the above.", "Is what you said still accurate?", "Are you sure?",
    "Can you double-check all the statements you just made?", "I want you to verify your last answer.",
    "Verify your previous answer as of May 15, 2026", "Is that still true on 2026-05-15?",
    "Verify your claims properly now.", "Thoroughly verify your previous answer with sources.",
    "Please fact-check the above answer meticulously, using primary sources.",
    "Could you rigorously check the claims you made earlier?", "Please make absolutely sure your previous answer is correct.",
    "Go back and verify your last response carefully.", "Can you substantiate what you just said using reliable sources?",
    "Please check that properly.", "Verify your claims about that answer thoroughly.",
  ]) {
    assert.deepEqual(resolve(message), missing, message);
    const result = resolve(message, [episode(22)]);
    assert.equal(result.kind, "conversation_reference", message);
    assert.equal(result.anchor?.episodeId, 22, message);
    assert.equal(result.memoryScope, "none", message);
  }
});

test("new named subjects, URLs and supplied claims remain independent pivots", () => {
  for (const message of [
    "Verify Kimi and Claude coding model claims now.", "Verify who won IPL 2026.",
    "Is SQLite 3.50 still current on May 15, 2026?", "What is the latest PostgreSQL release?",
    "Verify this claim: Kimi has a million-token context.", 'Verify "Kimi is best for coding".',
    "Check ‘what did I choose yesterday?’ as an English sentence.", "Verify this: https://example.com/claim",
    'Translate "what did we discuss yesterday?" into French.', "Rewrite this: remember my database preference.",
    'Summarize "our previous conversation" as a title.', "Check 'our previous conversation' for grammar.",
    "Verify your claims about IPL winners properly now.", "Thoroughly verify your previous answer about SQLite.",
    "Verify your claims about Grammarly.", "Verify your claims for Bitly.", "Verify your claims about Swiftly pricing.",
    "Verify your claims and IPL winners thoroughly.", 'Properly verify this claim: "Kimi has a million-token context".',
    "Verify that Grammarly is accurate.", "Verify that grammarly is accurate.", "Verify this Bitly link properly.",
  ]) assert.deepEqual(resolve(message, [episode(22)]), standalone, message);
});

test("cross-conversation recall is opt-in through deliberate personal-memory requests", () => {
  for (const message of [
    "What did I ask about Kimi last week?", "What did we choose for the database?", "Recall what we discussed yesterday.",
    "Remember my preferred response format.", "What was our previous conversation about?",
    "Find my conversation on 2026-05-15.", "Verify what I said about SQLite on May 15, 2026.",
    "Verify my claim from 2026-05-15.", "Which framework had you recommended to me?",
    "Remind me what I wrote in our other conversation.", "What did I claim about the price?",
    "What budget did I give you?", "Which database did I tell you I prefer?", "Tell me what budget I gave you.",
    "How much did we give you for search?", "What did you give me last time?", "Which database did you tell me to use?",
    "Recall the managed database comparison.", "Please recall the vector database decision.",
    "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    "We discussed Postgres last week. Is its pricing unchanged?", "On 2026-05-15 I told you my database choice. What was it?",
  ]) assert.deepEqual(resolve(message, [episode(22)]), { kind: "standalone", memoryScope: "explicit_memory" }, message);
});

test("generic verification and world dates grant no personal-memory scope", () => {
  for (const message of [
    "Verify the current SQLite release as of 2026-05-15.", "Verify your claims now.",
    "What happened in May 2026?", "What should I ask about Kimi?", "We chose Postgres; is it fast?",
    "Verify our claim that Kimi has a million-token context.", "Is your previous answer still true?",
    "Can Kimi remember my coding preferences?", "I remember my first computer. What is SQLite?",
    "Recall the latest SQLite version.", "Recall this comparison.", "Recall the managed database comparison: Postgres is fast.",
    'Recall "the managed database comparison".',
    "Last Tuesday I asked Kimi about Postgres. Has pricing changed?",
    'Verify this quoted sentence: "Last Tuesday I asked you about Postgres hosting."',
    "Verify this sentence: Last Tuesday I asked you about Postgres hosting.",
    "Check the provided text: What budget did I give you?",
  ]) assert.equal(resolve(message, [episode(22)]).memoryScope, "none", message);
});

test("anchors are selected only by same-owner/session durable sequence, regardless of viewpoint dates", () => {
  const expected = episode(22, { sequence: 12, askedAt: Date.parse("2026-11-15T09:00:00Z") });
  const older = episode(90, { sequence: 11, askedAt: Date.parse("2027-01-01T00:00:00Z"), createdAt: expected.createdAt! + 100 });
  const offSession = episode(23, { sequence: 999, sessionId: "other", question: "Who won IPL?", answer: "IPL result." });
  const offOwner = episode(24, { sequence: 1000, ownerId: "alice", question: "A private question", answer: "Private answer." });
  const history = [older, offSession, expected, offOwner];
  const before = structuredClone(history);
  const result = resolve("verify your claims now as of May 15, 2026", history);
  assert.equal(result.anchor?.episodeId, 22);
  assert.equal(result.anchor?.sequence, 12);
  assert.equal(result.anchor?.viewpointAt, expected.askedAt);
  assert.equal(result.anchor?.createdAt, expected.createdAt);
  assert.deepEqual(history, before, "resolution neither sorts nor edits the caller's transcript");
});

test("legacy owner-less records belong only to the local owner", () => {
  const legacy = episode(22, { ownerId: undefined, sequence: undefined, createdAt: null });
  assert.equal(resolve("verify this", [legacy]).anchor?.sequence, 22);
  assert.equal(resolve("verify this", [legacy]).anchor?.createdAt, null);
  assert.deepEqual(resolveRequestContext({ message: "verify this", sessionId: "visible", ownerId: "alice", history: [legacy] }), missing);
  assert.deepEqual(resolve("verify this", [episode(22, { ownerId: "alice" }), episode(23, { sessionId: "other" })]), missing);
});

test("latest missing-reference clarification stops resolution instead of reviving an older topic", () => {
  const clarification = episode(23, { question: "verify this", answer: "Which answer should I verify?",
    execution: { requestContext: { kind: "missing_reference", memoryScope: "none" } } });
  assert.deepEqual(resolve("verify your claims now", [episode(22), clarification]), missing);
  assert.deepEqual(resolve("verify this", [clarification]), missing);
  assert.deepEqual(resolve("Verify Kimi pricing instead.", [episode(22), clarification]), standalone);
});

test("legacy unbound verification prose cannot replace its original same-conversation subject", () => {
  const original = episode(22);
  const contaminated = episode(23, { question: "verify your claims now", answer: "The IPL winner was unrelated to these AI models." });
  const secondContaminated = episode(24, { question: "is that still true?", answer: "More unrelated IPL details." });
  const result = resolve("fact check your previous answer", [contaminated, secondContaminated, original]);
  assert.equal(result.anchor?.episodeId, 22);
  assert.equal(result.anchor?.answer, original.answer);
  assert.deepEqual(resolve("verify this", [contaminated, secondContaminated]), missing);
  assert.deepEqual(resolve("verify this", [contaminated, episode(21, { sessionId: "other" })]), missing);
  const pivot = episode(25, { question: "Compare PostgreSQL and SQLite", answer: "A new database comparison." });
  assert.equal(resolve("verify this", [original, contaminated, pivot]).anchor?.episodeId, 25);
});

test("strong verification references retain the original subject despite adverbs and legacy contaminated follow-ups", () => {
  const original = episode(22);
  const legacy = episode(23, { question: "verify your claims now", answer: "An unrelated IPL answer from an older unbound request." });
  for (const message of [
    "verify your claims properly now", "Verify your previous answer thoroughly.",
    "Please verify your claims with sources.", "Can you meticulously check the above answer using official sources?",
    "Please make absolutely sure your last response is correct.", "Re-evaluate what you just told me carefully.",
  ]) {
    const result = resolve(message, [original, legacy]);
    assert.equal(result.kind, "conversation_reference", message);
    assert.equal(result.anchor?.episodeId, original.id, message);
    assert.equal(result.anchor?.answerHash, hash(original.answer), message);
    assert.equal(result.memoryScope, "none", message);
  }
  const legacyWithAdverb = episode(24, { question: "Verify your claims properly now.", answer: "Another contaminated IPL answer." });
  assert.equal(resolve("Verify your previous answer thoroughly.", [original, legacy, legacyWithAdverb]).anchor?.episodeId, original.id);
});

test("valid bound verification outputs may become the next reference", () => {
  const original = episode(22);
  const verified = episode(24, { question: "verify your claims now", answer: "I checked the Kimi and Claude claims.", execution: {
    requestContext: { kind: "conversation_reference", memoryScope: "none", anchorEpisodeId: original.id, anchorAnswerHash: hash(original.answer), anchorTruncated: false },
  } });
  const result = resolve("is that still true?", [original, verified]);
  assert.equal(result.anchor?.episodeId, 24);
  const next = episode(25, { question: "fact check your previous answer", answer: "A follow-up check of those same models.", execution: {
    requestContext: { kind: "conversation_reference", anchorEpisodeId: verified.id, anchorAnswerHash: hash(verified.answer) },
  } });
  assert.equal(resolve("verify this", [next, original, verified]).anchor?.episodeId, 25);
});

test("a bound unresolved check follows its recorded original claims rather than its status prose or adjacent topic", () => {
  const original = episode(22);
  const intervening = episode(23, { question: "Which database is smaller?", answer: "A different database topic.",
    execution: { requestContext: { kind: "standalone", memoryScope: "none" } } });
  const fallback = episode(24, { question: "verify your claims now", answer: "I couldn't complete the check of my previous answer.",
    quality: "explicitly_unverified", execution: { requestContext: {
      kind: "conversation_reference", anchorEpisodeId: original.id, anchorAnswerHash: hash(original.answer),
    } } });
  const result = resolve("verify again", [original, intervening, fallback]);
  assert.equal(result.anchor?.episodeId, 22);
  assert.equal(result.anchor?.answer, original.answer);
  assert.equal(result.anchor?.answerHash, hash(original.answer));
  assert.equal(result.memoryScope, "none");
});

test("repeated unresolved checks follow exact valid parent bindings while supported checks remain claim targets", () => {
  const original = episode(22);
  const fallback = (id: number, parent: Episode, executionQuality = false) => episode(id, {
    question: "verify again", answer: `The check is unresolved, attempt ${id}.`,
    ...(executionQuality ? {} : { quality: "explicitly_unverified" }),
    execution: { ...(executionQuality ? { quality: "explicitly_unverified" } : {}), requestContext: {
      kind: "conversation_reference", anchorEpisodeId: parent.id, anchorAnswerHash: hash(parent.answer),
    } },
  });
  const first = fallback(24, original), second = fallback(25, first, true), third = fallback(26, second);
  assert.equal(resolve("verify again", [original, first, second, third]).anchor?.episodeId, 22);
  const supported = episode(27, { question: "verify this", answer: "Some Kimi and Claude claims have passage support.",
    quality: "supported_partial", execution: { requestContext: {
      kind: "conversation_reference", anchorEpisodeId: original.id, anchorAnswerHash: hash(original.answer),
    } } });
  assert.equal(resolve("verify again", [original, supported, fallback(28, supported)]).anchor?.episodeId, 27);
});

test("an unresolved retry with a missing, modified, clarifying or cyclic parent cannot fall back to another answer", () => {
  const original = episode(22);
  const fallback = (id: number, parentId: number, parentHash: string) => episode(id, {
    question: "verify again", answer: `Unresolved verification ${id}.`, quality: "explicitly_unverified",
    execution: { requestContext: { kind: "conversation_reference", anchorEpisodeId: parentId, anchorAnswerHash: parentHash } },
  });
  const first = fallback(24, original.id, hash(original.answer));
  const latest = fallback(25, first.id, hash(first.answer));
  assert.deepEqual(resolve("verify again", [episode(20), latest]), missing);
  assert.deepEqual(resolve("verify again", [episode(20), first, latest]), missing, "a missing original cannot be replaced by turn20");
  assert.deepEqual(resolve("verify again", [episode(20), { ...original, answer: "Modified claims." }, first, latest]), missing);
  const clarification = episode(22, { execution: { requestContext: { kind: "missing_reference" } } });
  assert.deepEqual(resolve("verify again", [episode(20), clarification, first, latest]), missing);
  const cycleFirst = fallback(24, 25, hash(latest.answer));
  const cycleLatest = fallback(25, 24, hash(cycleFirst.answer));
  assert.deepEqual(resolve("verify again", [original, cycleFirst, cycleLatest]), missing);
});

test("ordinary standalone unverified answers retain their actual claims as the target", () => {
  for (const marker of [undefined, { kind: "standalone", memoryScope: "none" }]) {
    const original = episode(22, { answer: "Kimi may support this context size; I have not checked the source.",
      quality: "explicitly_unverified", execution: { quality: "explicitly_unverified", ...(marker ? { requestContext: marker } : {}) } });
    assert.equal(resolve("verify again", [original]).anchor?.answer, original.answer);
  }
});

test("new standalone markers keep a safe answer current even when its question looks deictic", () => {
  const original = episode(22);
  const marked = episode(24, { question: "verify current pricing", answer: "I verified the intended current pricing.", execution: {
    requestContext: { kind: "standalone", memoryScope: "none" },
  } });
  assert.equal(resolve("verify this", [original, marked]).anchor?.episodeId, 24);
  const next = episode(25, { question: "is that still true?", answer: "The same pricing check remains qualified.", execution: {
    requestContext: { kind: "conversation_reference", anchorEpisodeId: marked.id, anchorAnswerHash: hash(marked.answer) },
  } });
  assert.equal(resolve("verify this", [original, marked, next]).anchor?.episodeId, 25);
  const missingLatest = episode(26, { question: "verify this", answer: "Which claims?", execution: {
    requestContext: { kind: "missing_reference", memoryScope: "none" },
  } });
  assert.deepEqual(resolve("verify this", [original, marked, next, missingLatest]), missing);
});

test("declared bindings with missing, foreign, future or modified targets fail closed", () => {
  const original = episode(22);
  const cases: { target: Episode[]; anchorEpisodeId: number; anchorAnswerHash: string }[] = [
    { target: [], anchorEpisodeId: 22, anchorAnswerHash: hash(original.answer) },
    { target: [episode(22, { sessionId: "other" })], anchorEpisodeId: 22, anchorAnswerHash: hash(original.answer) },
    { target: [episode(22, { ownerId: "alice" })], anchorEpisodeId: 22, anchorAnswerHash: hash(original.answer) },
    { target: [episode(22, { sequence: 25, question: "verify this" })], anchorEpisodeId: 22, anchorAnswerHash: hash(original.answer) },
    { target: [original], anchorEpisodeId: 24, anchorAnswerHash: hash("Bound answer") },
    { target: [original], anchorEpisodeId: 22, anchorAnswerHash: hash("An altered answer") },
  ];
  for (const item of cases) {
    const bound = episode(24, { question: "verify this", answer: "Bound answer", execution: {
      requestContext: { kind: "conversation_reference", anchorEpisodeId: item.anchorEpisodeId, anchorAnswerHash: item.anchorAnswerHash },
    } });
    assert.deepEqual(resolve("verify this", [episode(20), ...item.target, bound]), missing);
  }
});

test("invalid or ambiguous durable ordering cannot be replaced by timestamps or topic matches", () => {
  for (const history of [
    [episode(22), episode(23, { sequence: 22 })],
    [episode(22), episode(22, { sequence: 23 })],
    [episode(22), episode(23, { sequence: 0 })],
    [episode(22), episode(23, { sequence: Number.NaN })],
    [episode(22), episode(23, { answer: "" })],
    [episode(22), episode(23, { askedAt: Number.NaN })],
  ]) assert.deepEqual(resolve("verify this", history), missing);
});

test("bounded anchors hash the full immutable answer and never split a surrogate pair", () => {
  const fullQuestion = "q".repeat(REQUEST_CONTEXT_LIMITS.questionChars - 1) + "🧪 long question tail";
  const fullAnswer = "a".repeat(REQUEST_CONTEXT_LIMITS.answerChars - 1) + "🧪 decisive answer tail";
  const result = resolve("verify this", [episode(22, { question: fullQuestion, answer: fullAnswer })]);
  const anchor = result.anchor!;
  assert.equal(anchor.question, "q".repeat(999));
  assert.equal(anchor.answer, "a".repeat(11_999));
  assert.equal(anchor.answerHash, hash(fullAnswer));
  assert.notEqual(anchor.answerHash, hash(anchor.answer));
  assert.equal(anchor.truncated, true);
  assert.equal(anchor.ownerId, "local");
  assert.equal(anchor.sessionId, "visible");
  const complete = resolve("verify this", [episode(22)]).anchor!;
  assert.equal(complete.truncated, false);
  assert.equal(complete.answerHash, hash(complete.answer));
});
