import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn, type AgentEvent } from "../src/agent/run.ts";
import { MemoryStore } from "../src/memory/store.ts";

const now = new Date("2026-11-17T12:00:00Z");
const question = "What did we discuss earlier, and is it still correct?";

function addAnswer(store: MemoryStore, ownerId: string, topic: string, at = now.getTime() - 1000) {
  return store.saveEpisode({ ownerId, sessionId: `old-${topic}`, askedAt: at, tz: "UTC",
    question: `What is ${topic}'s price?`, answer: `${topic} costs $25 monthly [1].`,
    quality: "supported", execution: { intent: "lookup" },
    sources: [{ n: 1, title: `${topic} pricing`, url: `https://example.com/${topic}`, text: `${topic} costs $25 monthly.` }] });
}

async function withoutProviders(store: MemoryStore, message = question) {
  let calls = 0;
  const forbidden = async (): Promise<never> => { calls++; throw new Error("An ambiguous memory request must not start paid research"); };
  const events: AgentEvent[] = [];
  await runTurn({ store, llm: { stream: forbidden, json: forbidden }, search: { search: forbidden },
    clock: { now: () => now, simulated: false }, enricher: { schedule() {} } },
  { ownerId: "alice", sessionId: "current", message, tz: "UTC" }, event => events.push(event));
  assert.equal(calls, 0, "resolve the topic before making provider calls");
  const done = events.find(event => event.type === "done");
  assert.ok(done && done.type === "done", JSON.stringify(events));
  assert.equal(done.quality, "non_factual");
  assert.equal(done.timings.searches, 0); assert.equal(done.timings.modelCalls, 0);
  const saved = store.episode(done.episodeId, "alice")!;
  assert.equal(saved.sessionId, "current"); assert.equal(saved.question, message);
  return saved.answer;
}

test("ambiguous memory verification asks for the intended answer before any provider calls", async () => {
  const store = new MemoryStore(":memory:");
  try {
    addAnswer(store, "alice", "Acme"); addAnswer(store, "alice", "Beta");
    addAnswer(store, "bob", "PrivateCorp");
    const answer = await withoutProviders(store);
    assert.match(answer, /which|choose|select/i);
    assert.doesNotMatch(answer, /PrivateCorp|remain unverified|available evidence did not establish/i);
  } finally { store.close(); }
});

test("dated memory verification never substitutes a nearby or foreign answer", async () => {
  const store = new MemoryStore(":memory:");
  try {
    addAnswer(store, "alice", "Acme");
    addAnswer(store, "bob", "PrivateCorp", Date.parse("2026-11-03T12:00:00Z"));
    const answer = await withoutProviders(store, "What did I ask on 3 November 2026, and is it still correct?");
    assert.match(answer, /couldn't find|no matching|no .*discussion/i);
    assert.doesNotMatch(answer, /Acme|PrivateCorp|remain unverified/);
  } finally { store.close(); }
});

import { makeReviewedClaim, type CanonicalClaim } from "../src/agent/claims.ts";
import type { Llm } from "../src/llm.ts";
import type { SearchQuery } from "../src/search.ts";

const price = { n: 1, url: "https://example.com/Acme", title: "Acme pricing", text: "Acme costs $25 monthly.",
  freshness: { requested: "fresh" as const, acquisition: "live" as const, ageStatus: "known" as const, contentFetchedAt: now.toISOString() } };
const seats = { ...price, n: 2, url: "https://example.com/Acme/seats", title: "Acme seats", text: "Acme requires five seats." };
const previousAt = now.getTime() - 60_000;

async function comparisonCase(options: { mode?: "explicit" | "auto" | "same"; scenario?: "same" | "changed" | "partial" | "invalid-source" | "empty" | "failure" } = {}) {
  const store = new MemoryStore(":memory:");
  const originals = [price, seats].map(source => makeReviewedClaim({ claim: source.text, sourceNumbers: [source.n] },
    new Map([[source.n, source]]), { viewpointAt: new Date(previousAt).toISOString(), tz: "UTC", kind: "verification", referenceAnswerHash: null }));
  const originalSession = options.mode === "same" ? "current" : "old";
  const original = store.saveEpisode({ ownerId: "alice", sessionId: originalSession, askedAt: previousAt, tz: "UTC",
    question: "What are Acme's price and minimum seats?", answer: "Acme costs $25 monthly [1]. Acme requires five seats [2].",
    sources: [price, seats], reviewedClaims: originals, quality: "supported", execution: { intent: "lookup" } });
  addAnswer(store, "bob", "PrivateCorp");
  const searches: SearchQuery[] = [];
  let comparisons = 0, oldModelCalls = 0;
  const legacy = async (): Promise<never> => { oldModelCalls++; throw new Error("A live comparison must not use planning, drafting or repeat review"); };
  const comparisonVerifier: Pick<Llm, "json"> = { json: async request => {
    comparisons++;
    const input = JSON.parse(request.user);
    assert.equal(input.reference.episodeId, original);
    assert.equal(input.reference.sessionId, originalSession);
    assert.doesNotMatch(request.user, /PrivateCorp/);
    assert.equal(input.originalClaims.length, 2);
    if (options.scenario === "failure") throw new Error("Provider unavailable");
    const sourceNumber = (needle: string) => input.sources.find((source: {text?:string}) => source.text?.includes(needle))?.n;
    const items = (input.originalClaims as CanonicalClaim[]).map((claim, index) => ({ referenceClaimId: claim.id, original: claim.text,
      status: options.scenario === "partial" && index === 1 ? "unresolved" : options.scenario === "changed" && index === 0 ? "changed" : "supported",
      statement: options.scenario === "changed" && index === 0 ? "Acme costs $30 monthly." : claim.text,
      sourceNumbers: options.scenario === "partial" && index === 1 ? [] : [options.scenario === "invalid-source" && index === 1 ? 999 : sourceNumber(index ? "five seats" : "monthly")],
      support: options.scenario === "partial" && index === 1 ? [] : [{ n: sourceNumber(index ? "five seats" : "monthly"), quote: index ? seats.text : options.scenario === "changed" ? "Acme costs $30 monthly." : price.text }],
    }));
    return { referenceCheck: { episodeId: original, answerHash: input.reference.answerHash, addressesTarget: true,
      coverage: options.scenario === "partial" ? "partial" : "complete" }, items };
  } };
  try {
    const events: AgentEvent[] = [];
    const message = options.mode === "auto" ? question : "Is that answer still correct?";
    await runTurn({ store, llm: { stream: legacy, json: legacy }, comparisonVerifier,
      search: { search: async query => { searches.push(query); return options.scenario === "empty" ? [] :
        [{ ...price, text: options.scenario === "changed" ? "Acme costs $30 monthly." : price.text }, seats]; } },
      clock: { now: () => now, simulated: false }, enricher: { schedule() {} } },
    { ownerId: "alice", sessionId: "current", message, tz: "UTC", ...(options.mode !== "auto" && options.mode !== "same" ? { memoryReferenceEpisodeId: original } : {}) }, event => events.push(event));
    assert.equal(oldModelCalls, 0);
    assert.ok(searches.length >= 1 && searches.length <= 2, `bounded search count: ${searches.length}`);
    assert.ok(searches.every(query => query.freshness === "fresh"));
    assert.equal(comparisons, options.scenario === "empty" ? 0 : 1);
    const done = events.find(event => event.type === "done");
    assert.ok(done && done.type === "done", JSON.stringify(events));
    const saved = store.episode(done.episodeId, "alice")!;
    assert.equal(saved.sessionId, "current"); assert.equal(saved.question, message);
    assert.equal((saved.execution!.requestContext as {anchorEpisodeId:number}).anchorEpisodeId, original);
    assert.equal(store.currentConversationHistory(originalSession, 10, "alice").length, options.mode === "same" ? 2 : 1);
    return { answer: saved.answer, quality: done.quality, coverage: store.claimCoverageFor(saved.id, "alice"), originals, comparisons };
  } finally { store.close(); }
}

for (const mode of ["explicit", "auto", "same"] as const) {
  test(`${mode} prior-answer verification uses fresh sources and one final comparison in the current chat`, async () => {
    const result = await comparisonCase({ mode });
    assert.equal(result.quality, "supported"); assert.match(result.answer, /Still correct/);
    assert.equal(result.coverage.length, 2); assert.ok(result.coverage.every(item => item.status === "supported"));
  });
}

test("a correction is retained separately from unchanged details", async () => {
  const result = await comparisonCase({ scenario: "changed" });
  assert.match(result.answer, /Changed or corrected/); assert.match(result.answer, /\$30/);
  assert.deepEqual(result.coverage.map(item => item.status), ["changed", "supported"]);
});

for (const scenario of ["partial", "invalid-source"] as const) {
  test(`${scenario} comparison keeps the confirmed detail and names the unchecked one`, async () => {
    const result = await comparisonCase({ scenario });
    assert.equal(result.quality, "supported_partial"); assert.match(result.answer, /Acme costs \$25/);
    assert.match(result.answer, /Could not confirm/); assert.match(result.answer, /five seats/);
    assert.deepEqual(result.coverage.map(item => item.status), ["supported", "unresolved"]);
  });
}

for (const scenario of ["empty", "failure"] as const) {
  test(`${scenario} lookup/comparison does not say the previous answer is unchanged`, async () => {
    const result = await comparisonCase({ scenario });
    assert.equal(result.quality, "explicitly_unverified"); assert.match(result.answer, /Acme/);
    assert.doesNotMatch(result.answer, /Still correct|requested claims remain unverified|available evidence did not establish/);
    assert.ok(result.coverage.every(item => item.status === "unresolved"));
  });
}

test("a memory verification scoped to here cannot select another chat", async () => {
  const store = new MemoryStore(":memory:");
  try {
    addAnswer(store, "alice", "Acme");
    const answer = await withoutProviders(store, "What did we discuss here earlier, and is it still correct?");
    assert.match(answer, /couldn't find|which|select/i);
    assert.doesNotMatch(answer, /Acme|Still correct/);
  } finally { store.close(); }
});

import type { ResearchProgress } from "../src/runtime/research-checkpoints.ts";

test("an unfinished live comparison retries only missing details and resumes its approved result without provider calls", async () => {
  const store = new MemoryStore(":memory:");
  const originals = [price, seats].map(source => makeReviewedClaim({ claim: source.text, sourceNumbers: [source.n] },
    new Map([[source.n, source]]), { viewpointAt: new Date(previousAt).toISOString(), tz: "UTC", kind: "verification", referenceAnswerHash: null }));
  const original = store.saveEpisode({ownerId:"alice",sessionId:"old",askedAt:previousAt,tz:"UTC",
    question:"Acme price and minimum seats?",answer:"Acme costs $25 monthly [1]. Acme requires five seats [2].",sources:[price,seats],reviewedClaims:originals});
  let comparisons = 0, searchCalls = 0;
  const requested: string[][] = [], directReads: string[][] = [];
  let checkpoint: ResearchProgress | undefined;
  const forbidden = async (): Promise<never> => { throw new Error("No draft or repair should run"); };
  try {
    for (const phase of ["first", "retry-interrupted", "resume"] as const) {
      const events: AgentEvent[] = [];
      await runTurn({store,clock:{now:()=>now,simulated:false},enricher:{schedule(){}},llm:{json:forbidden,stream:forbidden},
        checkpoints:{save(progress){if(phase === "retry-interrupted" && progress.stage === "reviewed") {checkpoint=structuredClone(progress);throw new Error("Simulated interruption before commit");}}},
        search:{search:async query=>{assert.notEqual(phase,"resume","approved resume must not search again");searchCalls++;if(query.urls)directReads.push(query.urls);return [price,seats];}},
        comparisonVerifier:{json:async request=>{
          assert.notEqual(phase,"resume","approved resume must not compare again");comparisons++;
          const input=JSON.parse(request.user);assert.equal(input.reference.episodeId,original);
          requested.push(input.originalClaims.map((claim:CanonicalClaim)=>claim.id));
          return {referenceCheck:{episodeId:original,answerHash:input.reference.answerHash,addressesTarget:true,coverage:phase==="first"?"partial":"complete"},
            items:input.originalClaims.map((claim:CanonicalClaim)=>{
              const missing=phase==="first" && claim.id===originals[1]!.id;
              const source=input.sources.find((entry:{text?:string})=>entry.text===claim.text);
              return {referenceClaimId:claim.id,original:claim.text,status:missing?"unresolved":"supported",statement:claim.text,
                sourceNumbers:missing?[]:[source.n],support:missing?[]:[{n:source.n,quote:claim.text}]};
            })};
        }}},
      {ownerId:"alice",sessionId:"current",message:phase==="first"?"Verify the selected answer":"Retry the unfinished check",tz:"UTC",memoryReferenceEpisodeId:original,
        ...(phase!=="first"?{retryUnfinished:true}:{}),...(phase==="resume"?{resumeCheckpoint:checkpoint!}:{})},event=>events.push(event));
      if(phase==="retry-interrupted") {assert.equal(events.at(-1)?.type,"error");assert.ok(checkpoint);continue;}
      const done=events.find(event=>event.type==="done");assert.ok(done&&done.type==="done",JSON.stringify(events));
      const saved=store.episode(done.episodeId,"alice")!;
      assert.equal(saved.sessionId,"current");assert.equal(saved.execution?.memoryReferenceEpisodeId,original);
      assert.equal(done.quality,"supported_partial");
      if(phase==="resume") {
        assert.equal((saved.answer.match(/This checks only the previously unfinished parts/g)??[]).length,1);
        assert.equal(store.claimCoverageFor(saved.id,"alice").length,1);
        assert.equal(store.claimCoverageFor(saved.id,"alice")[0]!.claimId,originals[1]!.id);
      }
    }
    assert.deepEqual(requested,[originals.map(claim=>claim.id),[originals[1]!.id]]);
    assert.deepEqual(directReads,[ [price.url,seats.url], [seats.url] ]);
    assert.equal(comparisons,2);assert.equal(searchCalls,4);
    assert.ok(store.latestClaimCoverageFor(original,"current","alice",{viewpointAt:now.getTime(),simulated:false,tz:"UTC",receivedAt:Date.now()}).every(item=>item.status==="supported"));
  } finally {store.close();}
});
