import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { ChatMessage, Llm } from "../src/llm.ts";
import { Enricher } from "../src/memory/enrich.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { QuestionStore } from "../src/memory/questions.ts";
import { createApplication } from "../src/server.ts";
import type { SearchProvider, SearchQuery } from "../src/search.ts";

const MODEL_QUESTION = "How do Kimi and Claude compare for coding?";
const MODEL_ANSWER = "We discussed Kimi and Claude coding benchmarks, and claimed Kimi was the better coding model.";
const VERIFY = "verify your claims now";
const VIEWPOINT = "2026-05-15T14:02:00Z";
const MODEL_DATE = Date.parse("2026-11-15T14:00:00Z");
const IPL_DATE = Date.parse("2026-05-15T09:00:00Z");

const settings = (): Config => ({
  port: 0, host: "127.0.0.1", dbPath: ":memory:", temporalDbPath: ":memory:", llm: null,
  exaApiKey: null, startAt: null, missing: [], retrievalProfiles: false,
  access: { mode: "local", allowedOrigins: [], ownerTokens: {} },
  limits: { activeTurns: 2, queuedTurns: 3, activeModels: 2, queuedModels: 4,
    modelRequestsPerMinute: 1000, modelTokensPerMinute: 1_000_000, turnTimeoutMs: 5000,
    turnTokens: 100_000, turnModelCalls: 10, maxOutputTokens: 4096, shutdownMs: 100,
    traceRetentionDays: 14, maxTurnDollars: 1, inputDollarsPerMillion: null, outputDollarsPerMillion: null },
});

// All stores and providers are isolated mocks. These regressions never open a user database.
async function fixture(includeModelConversation: boolean, legacyUnboundFollowup = false, wrongDraft = false,
  beforeReview?: () => Promise<void>) {
  const store = new MemoryStore(":memory:");
  store.saveEpisode({ sessionId: "cricket-chat", askedAt: IPL_DATE, tz: "UTC",
    question: "Verify your IPL winners claims for 2008–2025.", answer: "Verified IPL winners: Rajasthan Royals won in 2008.",
    sources: [], quality: "explicitly_unverified" });
  if (includeModelConversation) store.saveEpisode({ sessionId: "model-chat", askedAt: MODEL_DATE, tz: "UTC",
    question: MODEL_QUESTION, answer: MODEL_ANSWER, sources: [], quality: "explicitly_unverified" });
  if (legacyUnboundFollowup) store.saveEpisode({ sessionId: "model-chat", askedAt: Date.parse(VIEWPOINT), tz: "UTC",
    question: VERIFY, answer: "Verified: these are the IPL winners for 2008–2025. Rajasthan Royals won in 2008.",
    sources: [], quality: "supported", execution: { intent: "verify", quality: "supported" } });
  const requests: ChatMessage[][] = [], queries: SearchQuery[] = [];
  const reviewReferences: Array<{ episodeId: number; answerHash: string }> = [];
  let selectedTopic: "models" | "cricket" = "cricket";
  const llm: Llm = {
    json: async request => {
      await beforeReview?.();
      const input = JSON.parse(request.user) as { reference?: { episodeId: number; answerHash: string } };
      if (input.reference) reviewReferences.push({ episodeId: input.reference.episodeId, answerHash: input.reference.answerHash });
      return { status: "approved", issues: [], quality: "supported", claimChecks: [{
        claim: selectedTopic === "models" ? "The Kimi and Claude comparison depends on the coding task." : "Rajasthan Royals won the 2008 IPL.",
        sourceNumbers: [1], supported: true, applicable: true,
      }], ...(input.reference ? { referenceCheck: { episodeId: input.reference.episodeId,
        answerHash: input.reference.answerHash, addressesTarget: !wrongDraft,
        coverage: wrongDraft ? "unresolved" : "complete" } } : {}) };
    },
    stream: async request => {
      requests.push(structuredClone(request.messages));
      const current = request.messages.filter(message => message.role === "user").at(-1)?.content ?? "";
      const localModelAnswer = request.messages.some(message => message.role === "assistant"
        && typeof message.content === "string" && /Kimi/.test(message.content) && /Claude/.test(message.content));
      selectedTopic = wrongDraft || /\bIPL\b/i.test(current) ? "cricket" : localModelAnswer ? "models" : "cricket";
      if (!request.messages.some(message => message.role === "tool")) return { text: "", toolCalls: [{
        id: "context-lookup", type: "function", function: { name: "web_search", arguments: JSON.stringify({
          query: selectedTopic === "models" ? "Kimi Claude coding comparison official benchmarks" : "IPL winners 2008 2025 official",
        }) },
      }] };
      const text = selectedTopic === "models"
        ? "The Kimi and Claude comparison depends on the coding task [1]."
        : "Rajasthan Royals won the 2008 IPL [1].";
      request.onText(text);
      return { text, toolCalls: [] };
    },
  };
  const search: SearchProvider = { search: async query => {
    queries.push(structuredClone(query));
    return [{ url: /IPL/.test(query.query) ? "https://example.com/ipl" : "https://example.com/models",
      title: /IPL/.test(query.query) ? "IPL record" : "Coding model comparison",
      text: /IPL/.test(query.query) ? "Rajasthan Royals won the 2008 IPL."
        : "The Kimi and Claude comparison depends on the coding task.",
      freshness: { requested: "fresh", acquisition: "live", ageStatus: "known", contentFetchedAt: "2026-11-15T14:00:00Z" } }];
  } };
  const app = createApplication({ config: settings(), store, questions: new QuestionStore(":memory:"),
    deps: { llm, search, store, clock: { now: () => new Date(MODEL_DATE), simulated: false }, enricher: { schedule() {} } } });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const address = app.server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ...app, base, post, requests, queries, reviewReferences };
}

async function readEvents(response: Response): Promise<Array<Record<string, any>>> {
  assert.equal(response.status, 200);
  return (await response.text()).split("\n\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
}

test("a backward viewpoint retains the visible model discussion as the verification reference instead of IPL memory", async () => {
  const app = await fixture(true);
  try {
    const visible = await (await fetch(app.base + "/api/sessions/model-chat")).json();
    assert.equal(visible.episodes.at(-1).episode.answer, MODEL_ANSWER);
    assert.ok(visible.episodes.at(-1).episode.askedAt > Date.parse(VIEWPOINT));
    const changed = await app.post("/api/clock", { sessionId: "model-chat", now: VIEWPOINT });
    assert.equal(changed.status, 200);
    const clock = await changed.json(); assert.equal(clock.conversation.sessionId, "model-chat");
    assert.equal(clock.conversation.viewpointAt, Date.parse(VIEWPOINT));

    const events = await readEvents(await app.post("/api/chat", {
      sessionId: "model-chat", message: VERIFY, tz: "UTC", mode: "era", asOf: VIEWPOINT,
    }));
    assert.ok(app.requests[0]?.some(message => message.role === "assistant" && message.content === MODEL_ANSWER),
      "visible conversation history must survive a backward viewpoint; it is a reference record, not verified era evidence");
    assert.ok(app.queries.length > 0);
    assert.ok(app.queries.every(query => /Kimi.*Claude|Claude.*Kimi/i.test(query.query)));
    assert.doesNotMatch(JSON.stringify(app.queries), /IPL|Rajasthan/i);
    const done = events.find(event => event.type === "done"); assert.ok(done);
    assert.equal(done.quality, "supported");
    assert.deepEqual(app.reviewReferences[0], { episodeId: 2,
      answerHash: createHash("sha256").update(MODEL_ANSWER).digest("hex") });
    const saved = app.store.episode(done.episodeId)!;
    assert.equal(saved.sessionId, "model-chat"); assert.equal(saved.askedAt, Date.parse(VIEWPOINT));
    assert.match(saved.answer, /Kimi.*Claude/); assert.doesNotMatch(saved.answer, /IPL|Rajasthan/);
    assert.equal(saved.sequence, 2, "conversation sequence follows the visible exchange, not its viewpoint date");
  } finally { await app.shutdown(); }
});

test("a deictic verification without a current-conversation answer asks what to verify rather than borrowing IPL memory", async () => {
  const app = await fixture(false);
  try {
    const events = await readEvents(await app.post("/api/chat", {
      sessionId: "empty-model-chat", message: VERIFY, tz: "UTC", mode: "era", asOf: VIEWPOINT,
    }));
    const prose = events.filter(event => event.type === "text").map(event => event.delta).join("");
    assert.equal(app.queries.length, 0, "another conversation cannot supply a missing referent for 'your claims'");
    assert.equal(app.requests.length, 0, "missing reference scope is resolved before any generation or paid provider work");
    assert.match(prose, /(?:which|what).{0,60}(?:answer|claim)|(?:paste|specify|provide).{0,60}(?:claim|answer|text)/i,
      "the missing referent needs a real user clarification");
    assert.doesNotMatch(prose, /IPL|Rajasthan|2008/);
    const done = events.find(event => event.type === "done"); assert.ok(done);
    assert.equal(done.quality, "non_factual");
    assert.equal(app.store.episode(done.episodeId)!.answer, prose);
    assert.equal(app.store.episode(done.episodeId)!.sessionId, "empty-model-chat");

    const repeated = await readEvents(await app.post("/api/chat", {
      sessionId: "empty-model-chat", message: VERIFY, tz: "UTC", mode: "era", asOf: VIEWPOINT,
    }));
    assert.equal(app.requests.length, 0, "the saved scope question must not become a new factual verification target");
    assert.equal(app.queries.length, 0);
    const repeatedDone = repeated.find(event => event.type === "done"); assert.ok(repeatedDone);
    assert.notEqual(repeatedDone.episodeId, done.episodeId);
    assert.equal(repeatedDone.quality, "non_factual");
    assert.match(app.store.episode(repeatedDone.episodeId)!.answer, /Which claims should I verify/i);
  } finally { await app.shutdown(); }
});

test("an explicitly named cricket verification can change topics after a model discussion", async () => {
  const app = await fixture(true);
  try {
    const events = await readEvents(await app.post("/api/chat", {
      sessionId: "model-chat", message: "Verify the IPL winner for 2008.", tz: "UTC", mode: "era", asOf: VIEWPOINT,
    }));
    assert.equal(events.some(event => event.type === "clarification"), false);
    assert.ok(app.queries.some(query => /IPL/.test(query.query)));
    const done = events.find(event => event.type === "done"); assert.ok(done);
    assert.match(app.store.episode(done.episodeId)!.answer, /Rajasthan Royals.*2008/);
  } finally { await app.shutdown(); }
});

test("retrying after a legacy unbound IPL follow-up checks the original model answer without rewriting the bad record", async () => {
  const app = await fixture(true, true);
  try {
    const badRecord = app.store.episode(3)!;
    assert.match(badRecord.answer, /Verified:.*IPL/);
    const events = await readEvents(await app.post("/api/chat", {
      sessionId: "model-chat", message: VERIFY, tz: "UTC", mode: "era", asOf: VIEWPOINT,
    }));
    assert.ok(app.requests[0]?.some(message => message.role === "assistant" && message.content === MODEL_ANSWER));
    assert.ok(app.requests[0]?.filter(message => message.role === "assistant")
      .every(message => !/IPL|Rajasthan/.test(message.content ?? "")), "the bad unbound follow-up must not become the next anchor");
    assert.ok(app.queries.length > 0);
    assert.ok(app.queries.every(query => /Kimi.*Claude|Claude.*Kimi/i.test(query.query)));
    assert.equal(app.reviewReferences[0]?.episodeId, 2, "the reviewer checks the original model answer identity");
    assert.equal(app.reviewReferences[0]?.answerHash, createHash("sha256").update(MODEL_ANSWER).digest("hex"));
    const done = events.find(event => event.type === "done"); assert.ok(done);
    assert.equal(done.quality, "supported");
    const saved = app.store.episode(done.episodeId)!;
    assert.match(saved.answer, /Kimi.*Claude/); assert.doesNotMatch(saved.answer, /IPL|Rajasthan/);
    assert.equal(saved.sequence, 3);
    assert.equal(app.store.episode(3)!.answer, badRecord.answer, "quarantine excludes the referent without changing audit history");
  } finally { await app.shutdown(); }
});

test("factually supported IPL prose cannot pass a model-answer verification when review rejects its reference scope", async () => {
  const app = await fixture(true, false, true);
  try {
    const events = await readEvents(await app.post("/api/chat", {
      sessionId: "model-chat", message: VERIFY, tz: "UTC", mode: "era", asOf: VIEWPOINT,
    }));
    assert.ok(app.queries.some(query => /IPL/.test(query.query)), "the scripted model intentionally researches the wrong topic");
    assert.ok(app.reviewReferences.length > 0);
    assert.ok(app.reviewReferences.every(reference => reference.episodeId === 2));
    const prose = events.filter(event => event.type === "text").map(event => event.delta).join("");
    assert.doesNotMatch(prose, /IPL|Rajasthan|2008/,
      "valid citations cannot make a rejected answer to the wrong question safe to publish");
    const done = events.find(event => event.type === "done"); assert.ok(done);
    assert.equal(done.quality, "explicitly_unverified");
    const saved = app.store.episode(done.episodeId)!;
    assert.doesNotMatch(saved.answer, /IPL|Rajasthan|2008/);
    assert.equal(saved.execution!.rejectionObserved, true);
  } finally { await app.shutdown(); }
});

test("the durable worker does not spend model calls or import older claims for a missing-reference scope question", async () => {
  const app = await fixture(false);
  let worker: Enricher | undefined;
  try {
    app.store.enrich(1, { summary: "An earlier IPL discussion", topics: ["ipl"], claims: [{
      entity: "IPL", attribute: "2008 winner", value: "Rajasthan Royals", kind: "fact",
      sourceUrl: null, priorClaimId: null, verdict: "new",
    }] });
    const events = await readEvents(await app.post("/api/chat", {
      sessionId: "empty-model-chat", message: VERIFY, tz: "UTC", mode: "era", asOf: VIEWPOINT,
    }));
    const done = events.find(event => event.type === "done"); assert.ok(done);
    assert.equal(app.requests.length, 0); assert.equal(app.queries.length, 0);
    app.store.enqueueMemoryJob(done.episodeId, { question: "A stale payload", answer: "IPL claims from another session",
      sources: [], priorClaims: app.store.claimsFor(1) });
    let priorLookups = 0;
    const lookup = app.store.priorClaimsForEpisode.bind(app.store);
    app.store.priorClaimsForEpisode = (...args) => { priorLookups++; return lookup(...args); };
    let backgroundCalls = 0;
    worker = new Enricher({ json: async () => {
      backgroundCalls++;
      return { summary: "A scope question", topics: [], claims: [] };
    }, stream: async () => { throw new Error("Background enrichment must not stream"); } }, app.store);
    await worker.idle();
    assert.equal(priorLookups, 0, "the scope question must not reconstruct claims from another exchange or its stale payload");
    assert.equal(backgroundCalls, 0, "the missing-reference path is zero-provider-work even after its durable job runs");
    assert.deepEqual(app.store.claimsFor(done.episodeId), []);
    assert.equal(app.store.memoryJobCounts().completed, 2);
  } finally { await worker?.stop(); await app.shutdown(); }
});

test("Are you sure enters fresh buffered verification of the current answer before publishing factual text", async () => {
  let enterReview!: () => void, releaseReview!: () => void;
  const entered = new Promise<void>(resolve => { enterReview = resolve; });
  const gate = new Promise<void>(resolve => { releaseReview = resolve; });
  const app = await fixture(true, false, false, async () => { enterReview(); await gate; });
  const observed: Array<Record<string, any>> = [];
  let consuming: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await app.post("/api/chat", { sessionId: "model-chat", message: "Are you sure?", tz: "UTC", mode: "live" });
    assert.equal(response.status, 200);
    consuming = (async () => {
      const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = "";
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const batches = buffer.split("\n\n"); buffer = batches.pop()!;
          for (const batch of batches) if (batch.startsWith("data: ")) observed.push(JSON.parse(batch.slice(6)));
        }
      } finally { reader.releaseLock(); }
    })();
    await Promise.race([entered, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("The anchored synonym never reached verification review")), 1000);
    })]);
    clearTimeout(timer); timer = undefined;
    await nextTurn(); await nextTurn();
    assert.equal(observed.some(event => event.type === "text"), false, "verification prose stays buffered while review is pending");
    assert.equal(app.store.count(), 2, "a draft waiting for review is not committed");
    assert.ok(app.queries.length > 0);
    assert.ok(app.queries.every(query => query.freshness === "fresh"));
    releaseReview(); await consuming;
    const done = observed.find(event => event.type === "done"); assert.ok(done);
    assert.equal(done.quality, "supported");
    const saved = app.store.episode(done.episodeId)!;
    assert.equal(saved.execution!.intent, "verify");
    assert.match(saved.answer, /Kimi.*Claude/);
    assert.deepEqual(app.reviewReferences[0], { episodeId: 2,
      answerHash: createHash("sha256").update(MODEL_ANSWER).digest("hex") });
    const firstText = observed.findIndex(event => event.type === "text");
    assert.ok(firstText > observed.findIndex(event => event.type === "verification"));
    assert.ok(firstText < observed.findIndex(event => event.type === "done"));
    const turn = app.store.getTurn(done.turnId)!;
    assert.equal(turn.status, "completed"); assert.equal(turn.episodeId, done.episodeId);
  } finally {
    if (timer) clearTimeout(timer);
    releaseReview(); await consuming?.catch(() => {}); await app.shutdown();
  }
});
