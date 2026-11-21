import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { makeReviewedClaim, type ClaimScope } from "../src/agent/claims.ts";
import { MemoryStore, type Source } from "../src/memory/store.ts";
import { runTurn, type AgentEvent } from "../src/agent/run.ts";

const then = Date.parse("2021-11-17T12:00:00Z"), now = Date.parse("2026-11-17T12:00:00Z");
const source: Source & { text: string } = { n:1,url:"https://example.com/pricing",title:"Pricing",text:"Acme costs $25 per seat monthly." };
const answer = "Acme costs $25 per seat monthly [1].";
const hash = createHash("sha256").update(answer).digest("hex");
const scope = (at: number,referenceAnswerHash: string | null): ClaimScope => ({viewpointAt:new Date(at).toISOString(),tz:"UTC",kind:"verification",referenceAnswerHash});

function setup() {
  const store = new MemoryStore(":memory:");
  const originalClaim = makeReviewedClaim({claim:source.text,sourceNumbers:[1],supported:true,applicable:true},new Map([[1,source]]),scope(then,null));
  const original = store.saveEpisode({ownerId:"alice",sessionId:"old-conversation",askedAt:then,tz:"UTC",question:"How much is Acme?",answer,sources:[source],reviewedClaims:[originalClaim]});
  const reviewedClaim = makeReviewedClaim({claim:source.text,sourceNumbers:[1],supported:true,applicable:true,referenceClaimId:originalClaim.id},new Map([[1,source]]),scope(now,hash),new Set([originalClaim.id]));
  const input = {
    ownerId:"alice",sessionId:"current-conversation",askedAt:now,createdAt:now,tz:"UTC",question:"Is that old answer still correct?",answer,sources:[source],
    reviewedClaims:[reviewedClaim],claimCoverage:[{claimId:originalClaim.id,status:"supported" as const,sourceNumbers:[1]}],
    coverageReference:{episodeId:original,answerHash:hash,scope:"selected_memory" as const},
    execution:{time:{simulated:true,tz:"UTC"},requestContext:{kind:"conversation_reference",referenceScope:"selected_memory",anchorEpisodeId:original,anchorAnswerHash:hash,anchorSessionId:"old-conversation"}},
  };
  return {store,original,input,originalClaim};
}

test("explicit selected-memory coverage stays in the current conversation and preserves its original", () => {
  const {store,original,input,originalClaim} = setup();
  try {
    const before = store.episode(original,"alice");
    const result = store.saveEpisode(input);
    assert.equal(store.episode(result,"alice")!.sessionId,"current-conversation");
    assert.deepEqual(store.episode(original,"alice"),before);
    assert.equal(store.reviewedClaimsFor(result,"alice")[0]!.referenceClaimId,originalClaim.id);
    const coverageScope = {viewpointAt:now,simulated:true,tz:"UTC",receivedAt:now};
    assert.deepEqual(store.latestClaimCoverageFor(original,"current-conversation","alice",coverageScope),input.claimCoverage);
    assert.deepEqual(store.latestClaimCoverageFor(original,"unrelated-conversation","alice",coverageScope),[]);
    assert.deepEqual(store.latestClaimCoverageFor(original,"current-conversation","bob",coverageScope),[]);
    assert.equal(store.latestClaimCoverageFor(original,"current-conversation","alice",{...coverageScope,viewpointAt:now+1})[0]!.status,"unresolved");
  } finally {store.close();}
});

test("ordinary re-checks cannot acquire a cross-conversation reference by attaching memory metadata", () => {
  const {store,input} = setup();
  try {
    assert.throws(() => store.saveEpisode({...input,coverageReference:{episodeId:input.coverageReference.episodeId,answerHash:hash}}),/Invalid claim coverage reference/);
    assert.equal(store.count(undefined,"alice"),1);
  } finally {store.close();}
});

test("selected-memory references require matching immutable context, owner and historical viewpoint", () => {
  const {store,input} = setup();
  try {
    for (const requestContext of [undefined,{...input.execution.requestContext,kind:"standalone"},
      {...input.execution.requestContext,referenceScope:undefined},
      {...input.execution.requestContext,anchorEpisodeId:99},
      {...input.execution.requestContext,anchorAnswerHash:"f".repeat(64)},
      {...input.execution.requestContext,anchorSessionId:"unrelated-conversation"}]) {
      assert.throws(() => store.saveEpisode({...input,execution:{...input.execution,requestContext}}),/Invalid claim coverage reference/);
    }
    assert.throws(() => store.saveEpisode({...input,ownerId:"bob"}),/Invalid claim coverage reference/);
    assert.throws(() => store.saveEpisode({...input,coverageReference:{...input.coverageReference,answerHash:"f".repeat(64)}}),/Invalid claim coverage reference/);
    assert.throws(() => store.saveEpisode({...input,askedAt:then-1,reviewedClaims:[]}),/Invalid claim coverage reference/);
    assert.equal(store.count(undefined,"alice"),1);
    assert.equal(store.count(undefined,"bob"),0);
    assert.equal(store.conversation("current-conversation","alice"),null,"failed writes roll back sequence allocation");
  } finally {store.close();}
});

test("selected-memory authorization never permits claims belonging to another original", () => {
  const {store,input} = setup();
  try {
    const foreignId = "f".repeat(64);
    const forged = makeReviewedClaim({claim:source.text,sourceNumbers:[1],supported:true,applicable:true,referenceClaimId:foreignId},new Map([[1,source]]),scope(now,hash),new Set([foreignId]));
    assert.throws(() => store.saveEpisode({...input,reviewedClaims:[forged]}),/invalid original binding/);
    assert.throws(() => store.saveEpisode({...input,claimCoverage:[{claimId:foreignId,status:"supported",sourceNumbers:[1]}]}),/unknown original claim/);
    assert.equal(store.count(undefined,"alice"),1);
  } finally {store.close();}
});

test("an implicit retry of a selected-memory partial check keeps the original unfinished claims in this chat", async () => {
  const store = new MemoryStore(":memory:");
  const seats = {...source,n:2,url:"https://example.com/seats",title:"Minimum seats",text:"Acme requires five seats."};
  const oldAnswer = `${answer} Acme requires five seats [2].`;
  const answerHash = createHash("sha256").update(oldAnswer).digest("hex");
  const originals = [source,seats].map(item => makeReviewedClaim({claim:item.text,sourceNumbers:[item.n],supported:true,applicable:true},new Map([[item.n,item]]),scope(then,null)));
  const original = store.saveEpisode({ownerId:"alice",sessionId:"old",askedAt:then,tz:"UTC",question:"Acme price and minimum seats?",answer:oldAnswer,sources:[source,seats],reviewedClaims:originals});
  store.saveEpisode({ownerId:"alice",sessionId:"old",askedAt:then,tz:"UTC",question:"Unrelated Zebracorp",answer:"Zebracorp should never enter this check.",sources:[]});
  store.saveEpisode({ownerId:"alice",sessionId:"current",askedAt:then,tz:"UTC",question:"Other unrelated topic",answer:"Orangefish should never enter this check.",sources:[]});
  const targets: number[] = [], requested: string[][] = [], queried: string[][] = [];
  try {
    for (const attempt of [0,1]) {
      const events: AgentEvent[] = [];
      await runTurn({store,clock:{now:()=>new Date(now),simulated:true},enricher:{schedule(){}},search:{search:async query => {
        queried.push(query.urls ?? []);
        return attempt ? [{...seats,n:1}] : [source,seats];
      }},llm:{stream:async request => {
        const prompt = JSON.stringify(request.messages);
        assert.doesNotMatch(prompt,/Zebracorp|Orangefish/);
        return {text:attempt ? "Acme requires five seats [1]." : answer,toolCalls:[]};
      },json:async request => {
        const payload = JSON.parse(request.user);
        targets.push(payload.reference.episodeId);
        requested.push(payload.referenceClaims.map((claim: {id:string}) => claim.id));
        const wanted = originals[attempt]!;
        return {status:"approved",issues:[],quality:attempt ? "supported" : "supported_partial",
          referenceCheck:{episodeId:original,answerHash,addressesTarget:true,coverage:attempt ? "complete" : "partial"},
          claimChecks:[{claim:wanted.text,sourceNumbers:[1],supported:true,applicable:true,referenceClaimId:wanted.id}],
          claimCoverage:payload.referenceClaims.map((claim: {id:string}) => ({claimId:claim.id,status:claim.id===wanted.id ? "supported" : "unresolved",sourceNumbers:claim.id===wanted.id ? [1] : []}))};
      }}},{ownerId:"alice",sessionId:"current",message:attempt ? "Retry the unfinished check" : "Is the answer I selected still correct?",tz:"UTC",responseMode:"fast",
        ...(attempt ? {} : {memoryReferenceEpisodeId:original})},event => events.push(event));
      const done = events.find(event => event.type === "done");
      assert.ok(done && done.type === "done",JSON.stringify(events.at(-1)));
      const saved = store.episode(done.episodeId,"alice")!;
      assert.equal(saved.sessionId,"current"); assert.equal(saved.askedAt,now);
      assert.equal(saved.quality,"supported_partial",JSON.stringify({attempt,targets,requested,execution:saved.execution}));
      assert.equal((saved.execution!.requestContext as Record<string,unknown>).anchorEpisodeId,original);
    }
    assert.deepEqual(targets,[original,original]);
    assert.deepEqual(requested,[originals.map(claim => claim.id),[originals[1]!.id]]);
    assert.deepEqual(queried[1],[seats.url]);
    assert.ok(store.latestClaimCoverageFor(original,"current","alice",{viewpointAt:now,simulated:true,tz:"UTC",receivedAt:now}).every(claim => claim.status === "supported"));
  } finally {store.close();}
});
