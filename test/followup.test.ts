import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {test} from "node:test";
import {followupFocus, selectOrdinal} from "../src/agent/followup.ts";
import {resolveRequestContext} from "../src/agent/context.ts";
import {MemoryStore} from "../src/memory/store.ts";
import {runTurn, type AgentEvent} from "../src/agent/run.ts";
const record={id:1,sequence:1,ownerId:"alice",sessionId:"current",question:"Compare hosting options",answer:"1. Alpha costs $10 monthly [1].\n2. Beta costs $20 monthly [2].",askedAt:Date.parse("2026-11-17T10:00Z"),tz:"UTC",summary:null,topics:null};
const resolve=(message:string,history=[record])=>resolveRequestContext({message,history,ownerId:"alice",sessionId:"current"});
test("short facet follow-ups retain this chat's factual subject",()=>{
 for(const q of ["What about pricing?","And how about availability?","What about their release date?"]) assert.equal(resolve(q).anchor?.episodeId,1);
 for(const q of ["What about Redis pricing?","What about weather?","Check the second option at https://example.com","check the second option: Acme is free"]) assert.equal(followupFocus(q),undefined);
 assert.equal(resolve("What about pricing?",[{...record,ownerId:"bob"}]).kind,"missing_reference");
 assert.equal(resolve("What about pricing?",[{...record,sessionId:"other"}]).kind,"missing_reference");
});
test("ordinal references select the exact numbered item without changing its full answer hash",()=>{
 const selected=resolve("Can you re-check the second option, particularly its price?");
 assert.equal(selected.focus?.excerpt,"2. Beta costs $20 monthly [2].");
 assert.equal(selected.anchor?.answer,record.answer);
 assert.equal(resolve("Check the fifth option").kind,"missing_reference");
 assert.equal(selectOrdinal("1. First list\n2. Item\n1. Second list\n2. Item",2),undefined);
});
test("ordinal tables accept entity rows and reject feature comparisons or multiple tables",()=>{
 assert.equal(selectOrdinal("| Provider | Price |\n|---|---|\n| Alpha | $10 |\n| Beta | $20 |",2),"| Provider | Price |\n|---|---|\n| Beta | $20 |");
 assert.equal(selectOrdinal("| Feature | Alpha | Beta |\n|---|---|---|\n| Price | $10 | $20 |",1),undefined);
 assert.equal(selectOrdinal("- Alpha\n- Beta",2),undefined);
});
test("ordinal live check researches only selected item's sources and preserves current chat",async()=>{
 const store=new MemoryStore(":memory:");const {id,sequence,summary,topics,...saved}=record;
 const source=(n:number,name:string)=>({n,url:`https://example.com/${name}`,title:name,text:`${name} costs $${n*10} monthly.`});
 const original=store.saveEpisode({...saved,sources:[source(1,"Alpha"),source(2,"Beta")],quality:"supported"});
 const requests:string[]=[];const events:AgentEvent[]=[];
 try {
  await runTurn({store,clock:{now:()=>new Date("2026-11-17T12:00Z"),simulated:false},enricher:{schedule(){}},
   llm:{stream:async()=>{throw Error("no planning")},json:async()=>{throw Error("no legacy review")}},
   comparisonVerifier:{json:async request=>{const data=JSON.parse(request.user);assert.doesNotMatch(data.reference.answer,/Alpha/);assert.equal(data.reference.episodeId,original);return {referenceCheck:{episodeId:original,answerHash:data.reference.answerHash,addressesTarget:true,coverage:"partial"},items:[{original:"Beta costs $20 monthly",status:"supported",statement:"Beta costs $20 monthly.",sourceNumbers:[1],support:[{n:1,quote:"Beta costs $20 monthly."}]}]};}},
   search:{search:async query=>{requests.push(JSON.stringify(query));return [source(2,"Beta")];}}},
   {ownerId:"alice",sessionId:"current",message:"Check the second option",tz:"UTC"},event=>events.push(event));
  const done=events.find(event=>event.type==="done");assert.ok(done&&done.type==="done",JSON.stringify(events));
  assert.ok(requests.length<=4);assert.doesNotMatch(requests.join(" "),/Alpha/);
  const result=store.episode(done.episodeId,"alice")!;assert.equal(result.sessionId,"current");assert.match(result.answer,/only option 2/);assert.match(result.answer,/Beta/);assert.doesNotMatch(result.answer,/Alpha/);assert.equal(done.quality,"supported_partial");
 }finally{store.close()}
});

test("explicit selected-memory retry retains ordinal scope and the original full-answer hash",()=>{
 const initial=resolve("Check the second option");
 const retry=resolveRequestContext({message:"Check the second option",ownerId:"alice",sessionId:"another",history:[],selectedMemoryEpisode:record,viewpointAt:Date.parse("2026-11-17T12:00Z")});
 assert.equal(retry.focus?.excerpt,initial.focus?.excerpt);assert.equal(retry.anchor?.answerHash,initial.anchor?.answerHash);assert.equal(retry.referenceScope,"selected_memory");
});

test("two plans from the same provider cannot expand an ordinal check to the other plan",async()=>{
 const {makeReviewedClaim}=await import("../src/agent/claims.ts");
 const store=new MemoryStore(":memory:");const at=Date.parse("2026-11-17T10:00Z");
 const sources=[{n:1,title:"Basic",url:"https://example.com/basic",text:"Acme Basic costs $10 monthly."},{n:2,title:"Pro",url:"https://example.com/pro",text:"Acme Pro costs $20 monthly."}];
 const claims=sources.map(source=>makeReviewedClaim({claim:source.text,entity:"Acme",sourceNumbers:[source.n]},new Map(sources.map(s=>[s.n,s])),{viewpointAt:new Date(at).toISOString(),tz:"UTC",kind:"verification",referenceAnswerHash:null}));
 const id=store.saveEpisode({ownerId:"alice",sessionId:"current",askedAt:at,tz:"UTC",question:"Compare Acme plans",answer:"1. Acme Basic costs $10 monthly. [1]\n2. Acme Pro costs $20 monthly. [2]\n\nOverall, Acme Basic costs $10 monthly. [1]",sources,reviewedClaims:claims,quality:"supported"});
 const events:AgentEvent[]=[];
 try{
 await runTurn({store,clock:{now:()=>new Date(at+60000),simulated:false},enricher:{schedule(){}},llm:{stream:async()=>{throw Error("Unexpected")},json:async()=>{throw Error("Unexpected")}},search:{search:async()=>[sources[1]!]},comparisonVerifier:{json:async request=>{const data=JSON.parse(request.user);assert.equal(data.originalClaims.length,1);assert.equal(data.originalClaims[0].text,"Acme Pro costs $20 monthly.");assert.doesNotMatch(data.reference.answer,/Basic/);return {referenceCheck:{episodeId:id,answerHash:data.reference.answerHash,addressesTarget:true,coverage:"partial"},items:[{referenceClaimId:data.originalClaims[0].id,original:data.originalClaims[0].text,status:"supported",statement:"Acme Pro costs $20 monthly.",sourceNumbers:[1],support:[{n:1,quote:"Acme Pro costs $20 monthly."}]}]}}}},
 {ownerId:"alice",sessionId:"current",message:"Check the second option",tz:"UTC"},event=>events.push(event));
 assert.ok(events.some(event=>event.type==="done"),JSON.stringify(events));
 }finally{store.close()}
});


test("ordinal extraction ends before a closing paragraph or heading",()=>{
 const answer="1. Basic costs $10.\n2. Pro costs $20.\n  Includes support.\n\nOverall, Basic is cheaper.\n\n## Notes\nBasic costs $10.";
 assert.equal(selectOrdinal(answer,2),"2. Pro costs $20.\n  Includes support.");
 assert.equal(selectOrdinal("1. Basic\n2. Pro\n\n## Conclusion\nBasic wins",2),"2. Pro");
 assert.equal(selectOrdinal("1. Basic\n\n2. Pro\n\nOverall, Basic wins",2),"2. Pro");
});

for (const simulated of [true,false]) test(`ordinal ${simulated ? "simulated" : "legacy live"} checks keep the selected excerpt throughout research and review`,async()=>{
 const {makeReviewedClaim}=await import("../src/agent/claims.ts");
 const store=new MemoryStore(":memory:");const at=Date.parse("2026-09-01T10:00Z");
 const answer="1. Acme Basic costs $10 monthly. [1]\n\n2. Acme Pro costs $20 monthly. [2]\n\nOverall, Acme Basic is cheaper.";
 const hash=createHash("sha256").update(answer).digest("hex");
 const sources=[{n:1,title:"Basic",url:"https://example.com/basic",text:"Acme Basic costs $10 monthly."},{n:2,title:"Pro",url:"https://example.com/pro",text:"Acme Pro costs $20 monthly."}];
 const claims=sources.map(source=>makeReviewedClaim({claim:source.text,entity:"Acme",sourceNumbers:[source.n]},new Map(sources.map(s=>[s.n,s])),{viewpointAt:new Date(at).toISOString(),tz:"UTC",kind:"verification",referenceAnswerHash:null}));
 const id=store.saveEpisode({ownerId:"alice",sessionId:"current",askedAt:at,tz:"UTC",question:"Compare Acme plans",answer,sources,reviewedClaims:claims,quality:"supported"});
 const events:AgentEvent[]=[];let searches=0,generations=0,reviews=0;
 try {
  await runTurn({store,clock:{now:()=>new Date(at+60000),simulated},enricher:{schedule(){}},
   search:{search:async query=>{searches++;assert.deepEqual(query.urls,[sources[1]!.url]);assert.doesNotMatch(JSON.stringify(query),/Basic|basic/);return [sources[1]!];}},
   llm:{stream:async request=>{
    generations++;assert.doesNotMatch(JSON.stringify(request.messages),/Basic|basic/);
    assert.ok(request.messages.some(message=>message.role==="assistant" && message.content==="2. Acme Pro costs $20 monthly. [2]"));
    assert.match(JSON.stringify(request.messages),/Only an excerpt/);
    return {text:"Acme Pro costs $20 monthly. [1]",toolCalls:[]};
   },json:async request=>{
    reviews++;const data=JSON.parse(request.user);
    assert.equal(data.reference.answer,"2. Acme Pro costs $20 monthly. [2]");
    assert.equal(data.reference.answerHash,hash);assert.equal(data.reference.episodeId,id);assert.equal(data.reference.truncated,true);
    assert.doesNotMatch(request.user,/Basic|basic/);assert.deepEqual(data.referenceClaims.map((claim:{id:string})=>claim.id),[claims[1]!.id]);
    return {status:"approved",issues:[],quality:"supported",referenceCheck:{episodeId:id,answerHash:hash,addressesTarget:true,coverage:"partial"},
     claimChecks:[{claim:sources[1]!.text,sourceNumbers:[1],supported:true,applicable:true,referenceClaimId:claims[1]!.id}],
     claimCoverage:[{claimId:claims[1]!.id,status:"supported",sourceNumbers:[1]}]};
   }}},
   {ownerId:"alice",sessionId:"current",message:"Check the second option",tz:"UTC"},event=>events.push(event));
  const done=events.find(event=>event.type==="done");assert.ok(done&&done.type==="done",JSON.stringify(events));
  assert.equal(searches,1);assert.equal(generations,1);assert.equal(reviews,1);assert.equal(done.quality,"supported_partial");
  const saved=store.episode(done.episodeId,"alice")!;
  assert.equal(saved.sessionId,"current");assert.match(saved.answer,/^This checks only option 2 from the earlier answer\./);assert.doesNotMatch(saved.answer,/Basic/);
  const binding=saved.execution?.requestContext as {anchorEpisodeId:number;anchorAnswerHash:string;anchorTruncated:boolean};
  assert.equal(binding.anchorEpisodeId,id);assert.equal(binding.anchorAnswerHash,hash);assert.equal(binding.anchorTruncated,true);
  assert.equal(saved.execution?.reviewFailure && (saved.execution.reviewFailure as {retryEpisodeId:number}).retryEpisodeId,id);
  assert.deepEqual(store.claimCoverageFor(done.episodeId,"alice"),[{claimId:claims[1]!.id,status:"supported",sourceNumbers:[1]}]);
  assert.equal(store.episode(id,"alice")!.answer,answer);
 }finally{store.close()}
});
