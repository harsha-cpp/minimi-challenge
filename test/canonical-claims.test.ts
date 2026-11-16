import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { makeReviewedClaim, canReuseReviewedClaim, passageHash, type ClaimScope } from "../src/agent/claims.ts";
import { reviewSimulationAnswer } from "../src/agent/simulation.ts";
import { runTurn, type AgentEvent } from "../src/agent/run.ts";
import { MemoryStore, type Source } from "../src/memory/store.ts";
import type { ConversationAnchor } from "../src/agent/context.ts";
import { REVIEW_POLICY_VERSION } from "../src/runtime/versions.ts";
import type { ResearchProgress } from "../src/runtime/research-checkpoints.ts";

const now = new Date("2026-11-17T12:00:00Z"), earlier = new Date("2026-11-10T12:00:00Z");
const scope: ClaimScope = {viewpointAt:now.toISOString(),tz:"UTC",kind:"verification",referenceAnswerHash:null};
const price: Source & {text:string} = {n:1,url:"https://example.com/price",title:"Acme price",text:"Acme costs $25 per seat monthly.",contentHash:"wrong-untrusted-hash",
  freshness:{requested:"fresh",acquisition:"live",ageStatus:"known",contentFetchedAt:now.toISOString()}};
const seats: Source & {text:string} = {...price,n:2,url:"https://example.com/seats",title:"Minimum seats",text:"Acme has a minimum of five seats."};
const checked = (text: string,n=1, extra: Record<string,unknown> = {}) => ({claim:text,sourceNumbers:[n],supported:true,applicable:true,...extra});
const make = (raw: Record<string,unknown>, at = scope) => makeReviewedClaim(raw,new Map([[1,price],[2,seats]]),at);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

test("review keeps canonical assertions and null unknowns without another model call", async () => {
  let calls=0;
  const result = await reviewSimulationAnswer({question:"Verify Acme pricing",answer:"Acme costs $25 per seat monthly [1].",viewpoint:now,researchedAt:now,kind:"verification",sources:[price],llm:{json:async request=>{
    calls++; assert.match(request.system,/complete factual assertion/);
    return {status:"approved",issues:[],quality:"supported",claimChecks:[checked("Acme costs $25 per seat monthly",1,{entity:"Acme",attribute:"price",value:"$25",conditions:["per seat","monthly"]})]};
  }}});
  assert.equal(calls,1); assert.equal(result.status,"approved"); assert.equal(result.reviewedClaims?.length,1);
  const claim=result.reviewedClaims![0]!;
  assert.equal(claim.effectiveDate,null); assert.equal(claim.referenceClaimId,null); assert.equal(claim.origin,"review");
  assert.equal(claim.sourceRefs[0]?.contentHash,passageHash(price.text!));
  assert.equal(claim.reviewerPolicyVersion,REVIEW_POLICY_VERSION); assert.equal(claim.status,"supported");
});

test("reviewed claims save with their episode atomically and reject stale evidence or forged references", () => {
  const store=new MemoryStore(":memory:");
  try {
    const claim=make(checked("Acme costs $25 per seat monthly"));
    const id=store.saveEpisode({ownerId:"alice",sessionId:"prices",askedAt:now.getTime(),tz:"UTC",question:"Verify Acme",answer:"Acme costs $25 [1].",sources:[price],reviewedClaims:[claim]});
    assert.deepEqual(store.reviewedClaimsFor(id,"alice"),[claim]); assert.deepEqual(store.reviewedClaimsFor(id,"bob"),[]);
    assert.equal(store.episode(id,"alice")!.execution?.reviewedClaimSchemaVersion,1);
    assert.throws(()=>store.saveEpisode({ownerId:"alice",sessionId:"prices",askedAt:now.getTime(),tz:"UTC",question:"Changed evidence",answer:"Acme [1].",
      sources:[{...price,text:"Different price"}],reviewedClaims:[claim]}),/evidence changed/);
    const foreignId="f".repeat(64), foreign=makeReviewedClaim(checked("Acme costs $25",1,{referenceClaimId:foreignId}),new Map([[1,price]]),scope,new Set([foreignId]));
    assert.throws(()=>store.saveEpisode({ownerId:"alice",sessionId:"prices",askedAt:now.getTime(),tz:"UTC",question:"Forged ref",answer:"Acme [1].",
      sources:[price],reviewedClaims:[foreign]}),/invalid original binding/);
    assert.equal(store.count(undefined,"alice"),1);
  } finally {store.close();}
});

test("ordinary background extraction creates unverified observations, never an approved verdict", () => {
  const store=new MemoryStore(":memory:");
  try {
    const id=store.saveEpisode({sessionId:"prices",askedAt:earlier.getTime(),tz:"UTC",question:"Acme price",answer:"Acme costs $10 [1].",sources:[price]});
    store.enrich(id,{summary:"Acme pricing",topics:["Acme"],claims:[{entity:"Acme",attribute:"price",value:"$10",kind:"fact",sourceUrl:price.url,priorClaimId:null,verdict:"new"}]});
    const [claim]=store.canonicalClaimsFor(id); assert.ok(claim);
    assert.equal(claim.status,"unverified"); assert.equal(claim.origin,"extracted"); assert.equal(claim.reviewerPolicyVersion,null);
    assert.equal(claim.conditions,null); assert.equal(claim.effectiveDate,null); assert.deepEqual(store.reviewedClaimsFor(id),[]);
    assert.equal(canReuseReviewedClaim(claim as any,{text:claim.text,scope:claim.scope,sources:[price],researchStartedAt:now.getTime()}),false);
  } finally {store.close();}
});

test("identical content alone cannot reuse a verdict under another date, policy, scope or unknown freshness", () => {
  const claim=make(checked("Acme costs $25 per seat monthly"));
  const input={text:claim.text,scope,sources:[price],researchStartedAt:now.getTime()};
  assert.equal(canReuseReviewedClaim(claim,input),true);
  for(const change of [
    {scope:{...scope,viewpointAt:new Date(now.getTime()+1).toISOString()}},
    {scope:{...scope,tz:"Asia/Kolkata"}}, {policyVersion:"future-policy"},
    {sources:[{...price,text:"Acme costs $30"}]}, {sources:[{...price,freshness:undefined}]},
    {sources:[{...price,freshness:{...price.freshness!,acquisition:"cached" as const}}]},
    {sources:[price,seats]}, {researchStartedAt:now.getTime()+1},
  ]) assert.equal(canReuseReviewedClaim(claim,{...input,...change}),false,JSON.stringify(change));
});

test("whole-answer approval cannot manufacture missing original-claim coverage", async () => {
  const originals=[make(checked("Acme costs $25",1)),make(checked("Acme requires five seats",2))];
  const reference:ConversationAnchor={episodeId:1,ownerId:"local",sessionId:"prices",sequence:1,question:"Acme price and seats",answer:"$25 [1], five seats [2].",answerHash:hash("$25 [1], five seats [2]."),viewpointAt:earlier.getTime(),createdAt:earlier.getTime(),truncated:false};
  const raw={status:"approved",issues:[],quality:"supported",referenceCheck:{episodeId:1,answerHash:reference.answerHash,addressesTarget:true,coverage:"complete"},
    claimChecks:[checked("Acme costs $25",1,{referenceClaimId:originals[0]!.id})],
    claimCoverage:[{claimId:originals[0]!.id,status:"supported",sourceNumbers:[1]}]};
  const input={question:"Recheck",answer:"Acme costs $25 [1].",viewpoint:now,researchedAt:now,kind:"verification" as const,sources:[price,seats],reference,referenceClaims:originals};
  const result=await reviewSimulationAnswer({...input,llm:{json:async()=>raw}});
  assert.equal(result.quality,"supported_partial"); assert.deepEqual(result.claimCoverage?.map(claim=>claim.status),["supported","unresolved"]);
  for(const coverage of [[{claimId:"a".repeat(64),status:"supported",sourceNumbers:[1]}],
    [{claimId:originals[1]!.id,status:"supported",sourceNumbers:[1]}]]) {
    const bad=await reviewSimulationAnswer({...input,llm:{json:async()=>({...raw,claimCoverage:coverage})}});
    assert.notEqual(bad.status,"approved"); assert.equal(bad.reviewedClaims,undefined);
  }
});

test("a targeted retry checks only unfinished original facets and persists its fresh coverage", async () => {
  const store=new MemoryStore(":memory:");
  const oldScope={...scope,viewpointAt:earlier.toISOString()};
  const originalClaims=[make(checked("Acme costs $25",1),oldScope),make(checked("Acme requires five seats",2),oldScope)];
  const originalAnswer="Acme costs $25 [1]. Acme requires five seats [2].";
  const original=store.saveEpisode({sessionId:"prices",askedAt:earlier.getTime(),tz:"UTC",question:"Acme price and seats",answer:originalAnswer,sources:[price,seats],reviewedClaims:originalClaims});
  const queried:string[][]=[];
  let attempt=0;
  try {
    for(const retryUnfinished of [false,true]) {
      const events:AgentEvent[]=[];
      await runTurn({store,clock:{now:()=>now,simulated:false},enricher:{schedule(){}},search:{search:async query=>{
        queried.push(query.urls ?? []); return retryUnfinished ? [{...seats,n:1}] : [price,seats];
      }},llm:{stream:async()=>({text:retryUnfinished ? "Acme requires five seats [1]." : "Acme costs $25 [1]. The seat minimum is not yet checked.",toolCalls:[]}),json:async request=>{
        const payload=JSON.parse(request.user), wanted=retryUnfinished ? originalClaims[1]! : originalClaims[0]!;
        assert.equal(payload.referenceClaims.length,retryUnfinished ? 1 : 2);
        return {status:"approved",issues:[],quality:"supported_partial",referenceCheck:{episodeId:original,answerHash:hash(originalAnswer),addressesTarget:true,coverage:"partial"},
          claimChecks:[checked(retryUnfinished ? "Acme requires five seats" : "Acme costs $25",1,{referenceClaimId:wanted.id})],
          claimCoverage:payload.referenceClaims.map((claim:any)=>({claimId:claim.id,status:claim.id===wanted.id ? "supported" : "unresolved",sourceNumbers:claim.id===wanted.id ? [1] : []}))};
      }}},{sessionId:"prices",message:retryUnfinished ? "Retry the unfinished check" : "Recheck now",recheckEpisodeId:original,tz:"UTC",retryUnfinished,responseMode:"fast"},event=>events.push(event));
      const done=events.find(event=>event.type==="done");assert.ok(done&&done.type==="done");
      assert.equal(done.quality,"supported_partial"); assert.equal(done.claimCoverage?.length,retryUnfinished ? 1 : 2);
      assert.equal(store.reviewedClaimsFor(done.episodeId).length,1);assert.equal(store.claimCoverageFor(done.episodeId).length,retryUnfinished ? 1 : 2);
      attempt++;
    }
    assert.equal(attempt,2); assert.deepEqual(queried[1],[seats.url]);
    const continuationScope={viewpointAt:now.getTime(),simulated:false,tz:"UTC",receivedAt:Date.now()};
    assert.ok(store.latestClaimCoverageFor(original,"prices","local",continuationScope).every(claim=>claim.status==="supported"));
    for (const incompatible of [{...continuationScope,viewpointAt:now.getTime()+86400000},{...continuationScope,simulated:true},
      {...continuationScope,receivedAt:Date.now()+121_000},{...continuationScope,tz:"Asia/Kolkata"}]) {
      assert.ok(store.latestClaimCoverageFor(original,"prices","local",incompatible).every(claim=>claim.status==="unresolved"));
    }
    assert.ok(store.latestClaimCoverageFor(original,"prices").every(claim=>claim.status==="unresolved"),"unscoped coverage is never authority to skip checks");
    assert.deepEqual(store.latestClaimCoverageFor(original,"prices","other-owner"),[]);
  } finally {store.close();}
});

for (const persisted of [true,false]) test(`reviewed progress requires durable save, persisted=${persisted}`,async()=>{
  const store=new MemoryStore(":memory:"),events:AgentEvent[]=[];
  let generations=0,savedReview=false;
  try {
    await runTurn({store,clock:{now:()=>now,simulated:false},enricher:{schedule(){}},search:{search:async()=>[price]},
      checkpoints:{save(progress){if(progress.stage==="reviewed"){if(!persisted)throw new Error("disk full");savedReview=true;}}},
      llm:{stream:async()=>++generations===1 ? {text:"",toolCalls:[{id:"search",type:"function",function:{name:"web_search",arguments:'{"query":"Acme pricing"}'}}]}
        : {text:"Acme costs $25 per seat monthly [1].",toolCalls:[]},json:async()=>({status:"approved",issues:[],quality:"supported",claimChecks:[checked("Acme costs $25 per seat monthly")]})}},
    {sessionId:"progress",message:"Verify Acme price",tz:"UTC"},event=>{if(event.type==="claim_review")assert.equal(savedReview,true);events.push(event);});
    assert.equal(events.some(event=>event.type==="claim_review"),persisted);
    assert.equal(store.count(),persisted?1:0);
    assert.equal(events.at(-1)?.type,persisted?"done":"error");
  } finally {store.close();}
});

test("malformed rejection metadata cannot publish otherwise approved-looking partial findings",async()=>{
  const store=new MemoryStore(":memory:"),events:AgentEvent[]=[];
  let generations=0;
  const paragraph="Acme costs $25 per seat monthly [1].";
  try {
    await runTurn({store,clock:{now:()=>now,simulated:false},enricher:{schedule(){}},search:{search:async()=>[price]},checkpoints:{save(){}},
      llm:{stream:async request=>{if(request.purpose==="repair")throw new Error("repair unavailable");return ++generations===1
        ? {text:"",toolCalls:[{id:"search",type:"function",function:{name:"web_search",arguments:'{"query":"Acme pricing"}'}}]}
        : {text:paragraph+"\n\nAcme allows unlimited seats.",toolCalls:[]};},json:async()=>({status:"needs_revision",issues:[{code:"unsupported_claim",detail:"Seat count unknown"}],safeAnswer:{malformed:true},claimChecks:[],
          approvedFindings:[{text:paragraph,sourceNumbers:[1],supported:true,applicable:true,selfContained:true}]})}},
    {sessionId:"malformed",message:"Verify Acme price and seats",tz:"UTC"},event=>events.push(event));
    assert.equal(events.some(event=>event.type==="claim_review"),false);
    const done=events.find(event=>event.type==="done");assert.ok(done&&done.type==="done");assert.deepEqual(done.reviewedClaims,[]);
  } finally {store.close();}
});

test("a bound reviewed checkpoint resumes without repeating search, synthesis or review",async()=>{
  const store=new MemoryStore(":memory:");let saved:ResearchProgress|undefined,generations=0;
  try {
    await runTurn({store,clock:{now:()=>now,simulated:false},enricher:{schedule(){}},search:{search:async()=>[price]},
      checkpoints:{save(progress){if(progress.stage==="reviewed"){saved=structuredClone(progress);throw new Error("process interrupted after durable write");}}},
      llm:{stream:async()=>++generations===1 ? {text:"",toolCalls:[{id:"search",type:"function",function:{name:"web_search",arguments:'{"query":"Acme pricing"}'}}]}
        : {text:"Acme costs $25 per seat monthly [1].",toolCalls:[]},json:async()=>({status:"approved",issues:[],quality:"supported",claimChecks:[checked("Acme costs $25 per seat monthly")]})}},
    {sessionId:"resume",message:"Verify Acme price",tz:"UTC"},()=>{});
    assert.ok(saved); assert.equal(store.count(),0);
    const events:AgentEvent[]=[];
    await runTurn({store,clock:{now:()=>now,simulated:false},enricher:{schedule(){}},checkpoints:{save(){}},
      search:{search:async()=>assert.fail("must reuse checkpoint research")},llm:{stream:async()=>assert.fail("must reuse draft"),json:async()=>assert.fail("must reuse reviewed verdict")}},
    {sessionId:"resume",message:"Verify Acme price",tz:"UTC",resumeCheckpoint:saved},event=>events.push(event));
    const done=events.find(event=>event.type==="done");assert.ok(done&&done.type==="done"); assert.equal(done.quality,"supported");
    assert.equal(done.reviewedClaims?.length,1);assert.ok(events.some(event=>event.type==="claim_review"));
  } finally {store.close();}
});
