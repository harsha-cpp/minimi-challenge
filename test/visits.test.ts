import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { VisitStore, VISIT_LIMITS, activityReport, markTestVisitor, optionalVisitStore } from "../src/runtime/visits.ts";
import { activityCommand } from "../scripts/activity.ts";
import { createApplication } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";

const at=Date.parse("2026-11-17T12:00:00Z");
function temporary() { const dir=mkdtempSync(join(tmpdir(),"asof-visits-"));return {dir,path:join(dir,"app.db"),clean:()=>rmSync(dir,{recursive:true,force:true})}; }

test("page requests retain timestamps with credential pseudonyms, not raw request or owner data", async () => {
  const t=temporary();const visits=new VisitStore(t.path,()=>at);
  try {
    visits.record("guest_secret-cookie-a");visits.record("guest_secret-cookie-a");visits.record("guest_secret-cookie-b");
    await nextTurn();
    const r=activityReport(t.path,{since:at-1,until:at+1,now:at,timeZone:"Asia/Kolkata"});
    assert.equal(r.pageRequests.total,3);assert.equal(r.pageRequests.browserCredentials,2);
    assert.equal(r.pageRequests.rows[0]!.at,"2026-11-17T12:00:00.000Z");
    assert.match(r.pageRequests.rows[0]!.localTime,/17:30:00/);
    assert.equal(r.pageRequests.rows[0]!.visitor,r.pageRequests.rows[1]!.visitor);
    assert.notEqual(r.pageRequests.rows[0]!.visitor,r.pageRequests.rows[2]!.visitor);
    assert.doesNotMatch(JSON.stringify(r),/secret-cookie|salt|user.agent|127\.0\.0\.1/);
    assert.deepEqual(Object.keys(r.pageRequests.rows[0]!).sort(),["at","attribution","localTime","visitor"]);
  } finally { visits.close();t.clean(); }
});

test("operator test labels separate activity without removing it and match durable chat status", async () => {
  const t=temporary();const visits=new VisitStore(t.path,()=>at);
  try {
    visits.record("test-browser");await nextTurn();
    const visitor=activityReport(t.path,{since:at-1,until:at+1,now:at}).pageRequests.rows[0]!.visitor;
    const db=new DatabaseSync(t.path);db.exec("CREATE TABLE turns(owner_id TEXT,created_at INTEGER,status TEXT,quality TEXT,error_code TEXT)");
    const save=db.prepare("INSERT INTO turns VALUES (?,?,?,?,?)");
    save.run("test-browser",at,"completed","supported",null);save.run("visitor",at,"waiting_input",null,null);
    for(let index=0;index<3;index++)save.run("visitor",at,"failed",null,"provider_error");db.close();
    markTestVisitor(t.path,visitor,"release-check",at);
    const r=activityReport(t.path,{since:at-1,until:at+1,now:at});
    assert.equal(r.pageRequests.total,1);assert.equal(r.pageRequests.byAttribution.operator_labelled_test,1);
    assert.equal(r.chatRequests.total,5);assert.equal(r.chatRequests.byAttribution.operator_labelled_test,1);
    assert.equal(r.chatRequests.byAttribution.unknown_visitor,4);
    assert.equal(r.chatRequests.byStatus.waiting_input,1);assert.equal(r.chatRequests.byStatus.failed,3);
    assert.equal(r.chatRequests.rows[0]!.visitor,visitor);
    assert.deepEqual(r.alerts,[{code:"recent_turn_failures",count:3,windowMinutes:15}]);
    assert.match(r.interpretation,/not people/);assert.match(r.interpretation,/not identified reviewers/);
  } finally { visits.close();t.clean(); }
});

test("retention and row caps bound persistence, while report limits do not falsify totals", async () => {
  const t=temporary();let now=at;const visits=new VisitStore(t.path,()=>now);
  try {
    visits.record("old");await nextTurn();now+=15*86_400_000;
    visits.record("current");await nextTurn();
    assert.equal(activityReport(t.path,{since:at-1,until:now+1,now}).pageRequests.total,1);
    const db=new DatabaseSync(t.path);db.exec("BEGIN");const add=db.prepare("INSERT INTO page_visits(visited_at,visitor_id) VALUES (?,?)");
    for(let index=0;index<VISIT_LIMITS.rows+2;index++)add.run(now,"v_"+"a".repeat(24));db.exec("COMMIT");db.close();
    visits.record("last");await nextTurn();
    const r=activityReport(t.path,{since:at-1,until:now+1,now,limit:2});
    assert.equal(r.pageRequests.total,VISIT_LIMITS.rows);assert.equal(r.pageRequests.rows.length,2);
    assert.equal(r.pageRequests.omittedRows,VISIT_LIMITS.rows-2);
    for(let index=0;index<VISIT_LIMITS.queued+3;index++)visits.record("queued");
    assert.equal(visits.stats.dropped,3);
  } finally { visits.close();t.clean(); }
});

test("database contention drops optional telemetry promptly and shutdown drains without hanging", async () => {
  const t=temporary();const visits=new VisitStore(t.path,()=>at), blocker=new DatabaseSync(t.path);
  try {
    blocker.exec("BEGIN IMMEDIATE");visits.record("blocked");await nextTurn();
    assert.equal(visits.stats.dropped,1);assert.equal(visits.stats.written,0);
    blocker.exec("ROLLBACK");visits.record("saved-on-shutdown");visits.close();
    assert.equal(activityReport(t.path,{since:at-1,until:at+1,now:at}).pageRequests.total,1);
    assert.equal(optionalVisitStore(join(t.dir,"missing","no.db")),undefined);
  } finally { visits.close();blocker.close();t.clean(); }
});

test("read-only reports preserve database bytes and disclose absent historical instrumentation", () => {
  const t=temporary();const db=new DatabaseSync(t.path);db.exec("CREATE TABLE turns(owner_id TEXT,created_at INTEGER,status TEXT,quality TEXT,error_code TEXT); INSERT INTO turns VALUES ('private',1,'cancelled',NULL,'cancelled')");db.close();
  try {
    const before=readFileSync(t.path);
    const r=activityReport(t.path,{since:0,until:2,now:2});
    assert.equal(r.pageLogging.available,false);assert.equal(r.pageRequests.total,0);
    assert.equal(r.chatRequests.total,1);assert.equal(r.chatRequests.rows[0]!.visitor,null);
    assert.deepEqual(readFileSync(t.path),before);
    assert.throws(()=>activityCommand(["report",t.path,"--since","2026-11-17"]),/explicit UTC offset/);
    assert.throws(()=>activityCommand(["report",t.path,"--limit","2001"]),/Invalid activity/);
  } finally { t.clean(); }
});

test("HTTP logs only successful HTML loads and ignores spoofed test markers, health and asset requests", async () => {
  const t=temporary();const config=loadConfig();
  config.dbPath=t.path;config.llm=null;config.exaApiKey=null;config.missing=[];
  config.access={mode:"hosted",allowedOrigins:[],ownerTokens:{alice:"a".repeat(40)}};
  const app=createApplication({config,deps:null});app.server.listen(0,"127.0.0.1");await once(app.server,"listening");
  const address=app.server.address();assert.ok(address && typeof address!=="string");const base=`http://127.0.0.1:${address.port}`;config.access.allowedOrigins.push(base);
  try {
    const headers={authorization:"Bearer "+"a".repeat(40),"x-asof-test":"release-smoke"};
    assert.equal((await fetch(base+"/?secret=do-not-record",{headers})).status,200);
    assert.equal((await fetch(base+"/app.js",{headers})).status,200);
    assert.equal((await fetch(base+"/healthz")).status,200);
    assert.equal((await fetch(base+"/readyz")).status,503);
    assert.equal((await fetch(base+"/",{headers:{authorization:"Bearer wrong"}})).status,401);
    await nextTurn();
    const r=activityReport(t.path,{since:Date.now()-60_000});
    assert.equal(r.pageRequests.total,1);assert.equal(r.pageRequests.byAttribution.unknown_visitor,1);
    assert.doesNotMatch(JSON.stringify(r),/do-not-record|release-smoke|alice/);
    assert.equal((await fetch(base+"/api/activity",{headers})).status,404);
  } finally { await app.shutdown();t.clean(); }
});

test("idle records disappear from read-only reports at the cutoff and hourly cleanup removes storage", async context => {
  context.mock.timers.enable({apis:["setInterval"]});
  const t=temporary();let now=at;const visits=new VisitStore(t.path,()=>now);
  try {
    visits.record("idle-browser");await nextTurn();
    now+=15*86_400_000;
    const before=readFileSync(t.path);
    const report=activityReport(t.path,{since:at-1,until:now,now});
    assert.equal(report.pageRequests.total,0);assert.deepEqual(report.pageRequests.rows,[]);
    assert.equal(report.pageLogging.retainedSince,new Date(now-14*86_400_000).toISOString());
    assert.deepEqual(readFileSync(t.path),before,"retention filtering does not mutate the database during a report");
    const db=new DatabaseSync(t.path,{readOnly:true});
    assert.equal((db.prepare("SELECT count(*) AS n FROM page_visits").get() as {n:number}).n,1);
    context.mock.timers.tick(3_600_000);
    assert.equal((db.prepare("SELECT count(*) AS n FROM page_visits").get() as {n:number}).n,0);
    db.close();visits.close();context.mock.timers.tick(3_600_000);
  } finally { visits.close();context.mock.timers.reset();t.clean(); }
});

test("large chat intervals return bounded rows with full SQL totals and separate unconfirmed-answer alerts", () => {
  const t=temporary();const db=new DatabaseSync(t.path);
  db.exec("CREATE TABLE turns(owner_id TEXT,created_at INTEGER,status TEXT,quality TEXT,error_code TEXT); BEGIN");
  const add=db.prepare("INSERT INTO turns VALUES (?,?,?,?,?)");
  for(let index=0;index<1200;index++)add.run("visitor",at-index,"completed","supported",null);
  for(let index=0;index<3;index++)add.run("visitor",at+index,"completed","explicitly_unverified",null);
  add.run("visitor",at,"cancelled",null,"cancelled");db.exec("COMMIT");db.close();
  try {
    const r=activityReport(t.path,{since:at-2000,until:at+10,now:at+10,limit:2});
    assert.equal(r.chatRequests.total,1204);assert.equal(r.chatRequests.rows.length,2);assert.equal(r.chatRequests.omittedRows,1202);
    assert.equal(r.chatRequests.byStatus.completed,1203);assert.equal(r.chatRequests.byStatus.cancelled,1);
    assert.equal(r.chatRequests.byQuality.explicitly_unverified,3);
    assert.deepEqual(r.alerts,[{code:"recent_unconfirmed_answers",count:3,windowMinutes:15}],"uncertainty is observable without falsely calling it a provider failure");
  } finally { t.clean(); }
});
