import assert from "node:assert/strict";
import { test } from "node:test";
import { comparisonSearchPlan } from "../src/agent/recheck.ts";
import type { ConversationAnchor } from "../src/agent/context.ts";
import type { Source } from "../src/memory/store.ts";
import type { CanonicalClaim } from "../src/agent/claims.ts";
import { selectPassages } from "../src/search/passages.ts";

const anchor: ConversationAnchor = { episodeId: 1, ownerId: "alice", sessionId: "old", sequence: 1,
  question: "Compare serverless and traditional hosting for a small app", answer: "Lambda charges per request [1].\nLightsail costs $5 monthly [2].",
  answerHash: "0".repeat(64), viewpointAt: 1, createdAt: 1, truncated: false };
const sources: Source[] = [
  { n: 1, url: "https://aws.amazon.com/lambda/pricing/", title: "Lambda pricing", text: "STALE_LAMBDA_TEXT" },
  { n: 2, url: "https://aws.amazon.com/lightsail/pricing/", title: "Lightsail pricing", text: "STALE_LIGHTSAIL_TEXT" },
];
const fact = (id: number, entity: string, text: string, source: Source, conditions: string[] = []): CanonicalClaim => ({
  id: id.toString(16).padStart(64,"0"), entity, text, attribute: null, value: null, conditions,
  effectiveDate: null, referenceClaimId: null, sourceRefs: [{ n: source.n, url: source.url, contentHash: "1".repeat(64) }],
  scope: { viewpointAt: "2026-11-01T12:00:00Z",tz:"UTC",kind:"lookup",referenceAnswerHash:null },
  reviewerPolicyVersion: null, status:"unverified",origin:"extracted",
});
const claims = [fact(1, "AWS Lambda", "AWS Lambda bills requests and execution time.", sources[0]!),
  fact(2, "Amazon Lightsail", "Amazon Lightsail small virtual server starts at $5/month.", sources[1]!, ["Linux", "public IPv4", "monthly maximum"] )];

test("hosting comparison reads each pricing page with its own facts and qualifiers", () => {
  const plan = comparisonSearchPlan({anchor,claims,sources,request:"Verify your earlier answer"});
  assert.equal(plan.queries.length,4);
  const reads = plan.queries.filter(query=>query.urls);
  assert.equal(reads.length,2);
  const lightsail = reads.find(query=>query.urls![0]!.includes("lightsail"))!;
  assert.match(lightsail.query,/Lightsail.*\$5\/month/);
  assert.match(lightsail.query,/Linux.*public IPv4.*monthly maximum/);
  assert.doesNotMatch(lightsail.query,/Lambda|serverless and traditional/);
  assert.ok(plan.queries.every(query=>query.freshness==="fresh"&&query.profile==="verification"));
  assert.ok(reads.every(query=>query.content==="full"&&query.urls!.length===1));
  assert.doesNotMatch(JSON.stringify(plan),/STALE_/);
  assert.ok(plan.queries.some(query=>!query.urls&&!query.domains),"discovery cannot be restricted to previously cited sites");
});

test("a single target keeps one fresh read and one unrestricted discovery search", () => {
  const plan = comparisonSearchPlan({anchor:{...anchor,answer:"Lambda charges per request [1]."},claims:claims.slice(0,1),sources:sources.slice(0,1),request:"Check billing"});
  assert.equal(plan.queries.length,2);
  assert.equal(plan.queries[0]!.urls?.length,1);
  assert.equal(plan.queries[1]!.urls,undefined);assert.equal(plan.queries[1]!.domains,undefined);
});

test("five vendor targets survive fair query allocation within four parallel lookups", () => {
  const vendors = ["HubSpot","Salesforce","Pipedrive","Zoho","Freshsales"];
  const refs = vendors.map((name,index)=>({n:index+1,url:`https://${name.toLowerCase()}.com/pricing`,title:name,text:"PRIVATE_OLD_PASSAGE"}));
  const manyClaims = refs.map((source,index)=>fact(index+1,vendors[index]!,`${vendors[index]} costs $25 per user per month for a 20-person team. ${"Billing qualifiers ".repeat(30)}`,source));
  const plan = comparisonSearchPlan({anchor:{...anchor,answer:vendors.map((name,i)=>`${name} [${i+1}].`).join("\n")},claims:manyClaims,sources:refs,request:"Have these five CRM prices changed?"});
  assert.equal(plan.targets,5);assert.equal(plan.plannedTargets,5);assert.equal(plan.omittedTargets,0);
  assert.equal(plan.queries.length,4);
  const searches = plan.queries.filter(query=>!query.urls);
  for (const name of vendors) assert.ok(searches.some(query=>!query.domains&&query.query.includes(name)),name);
  assert.ok(plan.queries.every(query=>query.query.length<=1000));
  assert.doesNotMatch(JSON.stringify(plan),/PRIVATE_OLD_PASSAGE/);
});

test("requested billing facet outranks unrelated source groups and retains exact effective date", () => {
  const refs = Array.from({length:7},(_,index)=>({n:index+1,url:`https://vendor${index}.com/policy`,title:`Vendor${index}`,text:"OLD"}));
  const manyClaims = refs.map((source,index)=>({...fact(index+1,`Vendor${index}`,index===6 ? "Vendor6 annual billing costs USD 100 per seat, billed annually." : `Vendor${index} has product features.`,source),effectiveDate:index===6 ? "2026-11-03" : null}));
  const plan = comparisonSearchPlan({anchor:{...anchor,answer:refs.map((source)=>`Fact [${source.n}].`).join("\n")},claims:manyClaims,sources:refs,request:"Recheck annual billing and currency"});
  assert.equal(plan.plannedTargets,5);assert.equal(plan.omittedTargets,2);assert.equal(plan.queries.length,4);
  assert.match(plan.queries[0]!.query,/USD 100 per seat.*billed annually.*2026-11-03/);
  assert.deepEqual(plan.queries[0]!.urls,[refs[6]!.url]);
});

test("unfinished-only retrieval never reads or researches a previously finished entity", () => {
  const plan=comparisonSearchPlan({anchor,claims:claims.slice(1),sources:sources.slice(1),request:"Try the unfinished check again"});
  assert.equal(plan.queries.length,2);
  assert.ok(plan.queries.every(query=>query.query.includes("Lightsail")));
  assert.doesNotMatch(JSON.stringify(plan),/Lambda|lambda/);
});

test("without extracted facts, cited rows retain different prices and source identities", () => {
  const plan=comparisonSearchPlan({anchor,claims:[],sources,request:"verify"});
  const lightsail=plan.queries.find(query=>query.urls?.[0]===sources[1]!.url)!;
  assert.match(lightsail.query,/Lightsail costs \$5 monthly/);assert.doesNotMatch(lightsail.query,/Lambda/);
});

test("invalid or uncited URLs never become source reads or domain constraints", () => {
  const plan=comparisonSearchPlan({anchor:{...anchor,answer:"Fact [1, 2, 3, 4]."},claims:[],sources:[
    {...sources[0]!,url:"http://127.0.0.1/secret"}, {...sources[0]!,n:2,url:"https://user:password@example.com/"},
    {...sources[0]!,n:3,url:"https://good.example.com/?utm_source=old#part"}, {...sources[0]!,n:4,url:"https://good.example.com/"},
    {...sources[1]!,n:5,url:"https://not-cited.example.com/"},
  ],request:"verify"});
  assert.deepEqual(plan.queries.filter(query=>query.urls).flatMap(query=>query.urls!),["https://good.example.com/"]);
  assert.doesNotMatch(JSON.stringify(plan),/127\.0\.0\.1|password|not-cited|utm_source|#part/);
});

test("no remembered sources still produces a bounded live discovery query", () => {
  const plan=comparisonSearchPlan({anchor:{...anchor,answer:"The Acme Starter plan costs $25 monthly."},claims:[],sources:[],request:"verify"});
  assert.equal(plan.queries.length,1);assert.equal(plan.queries[0]!.urls,undefined);
  assert.equal(plan.queries[0]!.freshness,"fresh");assert.match(plan.queries[0]!.query,/Acme.*\$25 monthly/);
});

test("source-specific pricing terms select the price table with neighboring qualifications", () => {
  const plan=comparisonSearchPlan({anchor,claims,sources,request:"verify"});
  const focused=plan.queries.find(query=>query.urls?.[0]===sources[1]!.url)!.query;
  const document=["An introduction to cloud services.", ...Array.from({length:12},(_,i)=>`Compute feature ${i}. ${"General cloud description. ".repeat(14)}`),
    "Amazon Lightsail Linux public IPv4 monthly bundles", "Small virtual server starts at $5/month, with a monthly maximum.",
    "Extra data transfer and taxes may cost more; hourly usage is billed up to the monthly maximum.",
    ...Array.from({length:12},(_,i)=>`Feature appendix ${i}. ${"Unrelated descriptions. ".repeat(14)}`)].join("\n\n");
  const result=selectPassages(document,focused,1700);
  assert.match(result.text,/\$5\/month/);assert.match(result.text,/Extra data transfer and taxes/);
});
