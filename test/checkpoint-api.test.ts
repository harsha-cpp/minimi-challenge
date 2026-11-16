import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fork } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/server.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { ResearchCheckpoints } from "../src/runtime/research-checkpoints.ts";
import type { Config } from "../src/config.ts";
import type { Llm } from "../src/llm.ts";
import { makeReviewedClaim } from "../src/agent/claims.ts";

const settings = (dbPath: string): Config => ({ port: 0, host: "127.0.0.1", dbPath, temporalDbPath: ":memory:", llm: null, exaApiKey: null,
  startAt: null, missing: [], retrievalProfiles: false, access: { mode: "hosted", allowedOrigins: [], ownerTokens: { alice: "a".repeat(40), bob: "b".repeat(40) } },
  limits: { activeTurns: 2, queuedTurns: 3, activeModels: 2, queuedModels: 4, modelRequestsPerMinute: 1000, modelTokensPerMinute: 1_000_000,
    turnTimeoutMs: 5000, turnTokens: 100_000, turnModelCalls: 10, maxOutputTokens: 4096, shutdownMs: 100, traceRetentionDays: 14,
    maxTurnDollars: 1, inputDollarsPerMillion: null, outputDollarsPerMillion: null } });
const question = { sessionId: "prices", message: "What is Acme's price?", mode: "live", tz: "UTC" };
const lookup = { text: "", toolCalls: [{ id: "lookup", type: "function" as const, function: { name: "web_search", arguments: '{"query":"Acme price"}' } }] };
const answer = "Acme costs $25 monthly [1].";
const decode = async (response: Response) => (await response.text()).split("\n\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
async function start(path: string, mode: "fail" | "answer" | "gate", options: { profiles?: boolean; checkpoints?: ResearchCheckpoints } = {}) {
  const config = settings(path); config.retrievalProfiles = options.profiles ?? false;
  const store = new MemoryStore(path); let calls = 0, searches = 0;
  let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
  const llm: Llm = { json: async () => ({}), stream: async request => {
    calls++;
    if (mode !== "answer" && calls === 1) return lookup;
    if (mode === "fail") throw new Error("Synthetic synthesis outage");
    if (mode === "gate") { entered(); return new Promise(() => {}); }
    request.onText(answer); return { text: answer, toolCalls: [] };
  } };
  const app = createApplication({ config, store, ...(options.checkpoints ? { checkpoints: options.checkpoints } : {}), deps: {
    llm, store, clock: { now: () => new Date(), simulated: false }, enricher: { schedule() {} },
    search: { search: async () => { searches++; return [{ url: "https://acme.example/pricing", title: "Pricing", text: "Acme costs $25 monthly.", retrievedAt: new Date().toISOString() }]; } },
  } });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const address = app.server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`; config.access.allowedOrigins.push(base);
  const headers = (owner = "alice") => ({ authorization: `Bearer ${owner === "alice" ? "a".repeat(40) : "b".repeat(40)}`, "content-type": "application/json" });
  return { ...app, base, waiting, calls: () => calls, searches: () => searches,
    get: (url: string, owner?: string) => fetch(base + url, { headers: headers(owner) }),
    post: (body: unknown, key: string, owner?: string, url = "/api/chat") => fetch(base + url, { method: "POST", headers: { ...headers(owner), "idempotency-key": key }, body: JSON.stringify(body) }) };
}

test("failed synthesis resumes durable fresh research after restart and replay never repeats providers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-resume-api-")), path = join(dir, "app.db");
  let app = await start(path, "fail");
  try {
    const initial = await app.post(question, "initial"); const turnId = initial.headers.get("x-turn-id")!;
    assert.ok((await decode(initial)).some(event => event.type === "error"));
    assert.equal(app.searches(), 1);
    const saved = await (await app.get(`/api/turns/${turnId}`)).json();
    assert.equal(saved.turn.status, "failed"); assert.equal(saved.checkpoint.available, true); assert.equal(saved.checkpoint.stage, "researched");
    assert.equal(saved.checkpoint.request.message, question.message);
    assert.doesNotMatch(JSON.stringify(saved), /Acme costs \$25|messages|sources|Private/);
    assert.equal((await app.get(`/api/turns/${turnId}`, "bob")).status, 404);
    assert.equal((await app.post({ resumeTurnId: turnId }, "foreign", "bob")).status, 404);
    assert.equal((await app.post({ resumeTurnId: turnId, sessionId: "other" }, "cross-session")).status, 404);
    assert.equal((await app.post({ resumeTurnId: turnId, message: "Changed question" }, "changed")).status, 409);
    await app.shutdown(); app = await start(path, "answer");
    const resumed = await app.post({ resumeTurnId: turnId, sessionId: question.sessionId }, "resume");
    const events = await decode(resumed), done = events.find(event => event.type === "done");
    assert.ok(done, JSON.stringify(events));
    assert.equal(app.searches(), 0); assert.equal(app.calls(), 1);
    assert.equal(app.store.episode(done.episodeId, "alice")!.answer, answer);
    assert.equal(done.timings.modelCalls, 3);
    const replayed = await decode(await app.post({ resumeTurnId: turnId }, "resume"));
    assert.equal(replayed.find(event => event.type === "done").episodeId, done.episodeId);
    assert.equal(replayed.find(event => event.type === "done").recovered, true);
    assert.equal(app.calls(), 1); assert.equal(app.searches(), 0);
    assert.equal((await app.post({ resumeTurnId: turnId, message: "Different" }, "resume")).status, 409);
  } finally { await app.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

for (const change of ["policy", "context", "clock", "expiry"] as const) test(`checkpoint resume rejects changed ${change} before provider work`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-resume-invalid-")), path = join(dir, "app.db");
  let app = await start(path, "fail");
  try {
    const initial = await app.post(question, "initial"); const turnId = initial.headers.get("x-turn-id")!; await decode(initial);
    await app.shutdown();
    app = await start(path, "answer", { profiles: change === "policy", ...(change === "expiry" ? { checkpoints: new ResearchCheckpoints(path, () => Date.now() + 180_000) } : {}) });
    if (change === "context") app.store.saveEpisode({ ownerId: "alice", sessionId: "other-thread", askedAt: Date.now(), tz: "UTC", question: "New memory", answer: "New context", sources: [] });
    if (change === "clock") app.store.updateConversation({ ownerId: "alice", sessionId: question.sessionId, mode: "era", viewpointAt: Date.parse("2020-01-01T00:00:00Z") });
    const response = await app.post({ resumeTurnId: turnId }, "resume");
    assert.equal(response.status, 409); assert.equal((await response.json()).code, "checkpoint_invalidated");
    assert.equal(app.calls(), 0); assert.equal(app.searches(), 0);
  } finally { await app.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("explicit cancellation deletes research and cannot be resumed", async () => {
  const app = await start(":memory:", "gate");
  try {
    const initial = await app.post(question, "cancel"); const turnId = initial.headers.get("x-turn-id")!;
    const streamed = decode(initial); await app.waiting;
    assert.ok(app.checkpoints.get(turnId, "alice"));
    await app.post({}, "cancel-action", "alice", `/api/turns/${turnId}`); await streamed;
    assert.equal(app.checkpoints.get(turnId, "alice"), null);
    const response = await app.post({ resumeTurnId: turnId }, "resume-cancelled");
    assert.equal(response.status, 409); assert.equal((await response.json()).code, "checkpoint_not_resumable");
    assert.equal(app.calls(), 2); assert.equal(app.searches(), 1);
  } finally { await app.shutdown(); }
});

test("checkpoint status cannot publish findings from invalid or explicitly unverified review output", async () => {
  const app = await start(":memory:", "fail");
  try {
    const initial = await app.post(question, "invalid-review"); const turnId = initial.headers.get("x-turn-id")!; await decode(initial);
    const saved = app.checkpoints.get(turnId, "alice")!;
    const claim = makeReviewedClaim({ claim: answer, sourceNumbers: [1] }, new Map(saved.progress.sources.map(source => [source.n, source])),
      { viewpointAt: saved.effectiveAt, tz: "UTC", kind: "verification", referenceAnswerHash: null });
    for (const verdict of [
      { status: "needs_revision" as const, reason: "invalid_review_output" as const, issues: [{ code: "unsupported_claim" as const, detail: "Invalid correction" }] },
      { status: "approved" as const, quality: "explicitly_unverified" as const, issues: [] },
    ]) {
      app.checkpoints.save({ ...saved, progress: { ...saved.progress, stage: "reviewed", draft: answer, review: { ...verdict, ms: 1, modelCalls: 1,
        approvedFindings: [{ text: answer, sourceNumbers: [1] }], reviewedClaims: [claim] } } });
      const status = await (await app.get(`/api/turns/${turnId}`)).json();
      assert.equal(status.checkpoint.available, true);
      assert.equal(status.checkpoint.approvedFindings, undefined); assert.equal(status.checkpoint.reviewedClaims, undefined);
      assert.doesNotMatch(JSON.stringify(status), /Acme costs \$25/);
    }
  } finally { await app.shutdown(); }
});

test("a dropped SSE connection preserves researched progress for an explicit resume", { timeout: 6000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-checkpoint-disconnect-")), path = join(dir, "app.db");
  let app = await start(path, "gate");
  const abort = new AbortController();
  try {
    const initial = await fetch(app.base + "/api/chat", { method: "POST", signal: abort.signal,
      headers: { authorization: `Bearer ${"a".repeat(40)}`, "content-type": "application/json", "idempotency-key": "drop" }, body: JSON.stringify(question) });
    const turnId = initial.headers.get("x-turn-id")!;
    const ended = initial.text().catch(() => "disconnected"); await app.waiting;
    abort.abort(); await ended;
    let status: any;
    for (let i = 0; i < 100; i++) {
      status = await (await app.get(`/api/turns/${turnId}`)).json();
      if (status.turn.status !== "running") break;
      await delay(5);
    }
    assert.equal(status.turn.status, "interrupted"); assert.equal(status.checkpoint.available, true);
    await app.shutdown(); app = await start(path, "answer");
    const done = (await decode(await app.post({ resumeTurnId: turnId }, "resume-drop"))).find(event => event.type === "done");
    assert.ok(done); assert.equal(app.searches(), 0); assert.equal(app.calls(), 1);
  } finally { abort.abort(); await app.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("reviewed claims and coverage metadata remain available after reloading scoped episode and session views", async () => {
  const app = await start(":memory:", "answer");
  try {
    const now = Date.now(), source = { n: 1, url: "https://acme.example/pricing", title: "Pricing", text: "Acme costs $25 monthly." };
    const claim = makeReviewedClaim({ claim: "Acme costs $25 monthly.", sourceNumbers: [1] }, new Map([[1, source]]),
      { viewpointAt: new Date(now).toISOString(), tz: "UTC", kind: "verification", referenceAnswerHash: null });
    const episodeId = app.store.saveEpisode({ ownerId: "alice", sessionId: "prices", askedAt: now, tz: "UTC", question: question.message,
      answer, sources: [source], reviewedClaims: [claim], quality: "supported" });
    const details = await (await app.get(`/api/episodes/${episodeId}`)).json();
    const session = await (await app.get("/api/sessions/prices")).json();
    assert.deepEqual(details.reviewedClaims, [claim]); assert.deepEqual(details.canonicalClaims, [claim]); assert.deepEqual(details.claimCoverage, []);
    assert.deepEqual(session.episodes[0].reviewedClaims, [claim]); assert.deepEqual(session.episodes[0].claimCoverage, []);
    assert.equal((await app.get(`/api/episodes/${episodeId}`, "bob")).status, 404);
    assert.deepEqual((await (await app.get("/api/sessions/prices", "bob")).json()).episodes, []);
  } finally { await app.shutdown(); }
});

test("SIGKILL during synthesis preserves research and its in-flight allowance for explicit resume", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-checkpoint-crash-")), path = join(dir, "app.db"), fixture = join(dir, "crash.mts");
  writeFileSync(fixture, `
    import {once} from 'node:events';
    import {createApplication} from ${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)};
    import {MemoryStore} from ${JSON.stringify(new URL("../src/memory/store.ts", import.meta.url).href)};
    const config=${JSON.stringify(settings(path))}; const store=new MemoryStore(${JSON.stringify(path)}); let calls=0;
    const app=createApplication({config,store,deps:{store,clock:{now:()=>new Date(),simulated:false},enricher:{schedule(){}},
      llm:{json:async()=>({}),stream:async()=>{if(++calls===1)return ${JSON.stringify(lookup)};process.send?.({kind:'synthesis'});return new Promise(()=>{});}},
      search:{search:async()=>[{url:'https://acme.example/pricing',title:'Pricing',text:'Acme costs $25 monthly.',retrievedAt:new Date().toISOString()}]}}});
    app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const port=app.server.address().port;
    config.access.allowedOrigins.push('http://127.0.0.1:'+port);process.send?.({kind:'ready',port});
  `);
  const child = fork(fixture, { execArgv: ["--import", "tsx", "--disable-warning=ExperimentalWarning"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let app: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const [ready] = await once(child, "message"); assert.equal(ready.kind, "ready");
    const synthesis = once(child, "message");
    const response = await fetch(`http://127.0.0.1:${ready.port}/api/chat`, { method: "POST",
      headers: { authorization: `Bearer ${"a".repeat(40)}`, "content-type": "application/json", "idempotency-key": "crash" }, body: JSON.stringify(question) });
    const turnId = response.headers.get("x-turn-id")!; const ended = response.text().catch(() => "disconnected");
    assert.equal((await synthesis)[0].kind, "synthesis");
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; await ended;
    app = await start(path, "answer");
    const status = await (await app.get(`/api/turns/${turnId}`)).json();
    assert.equal(status.turn.status, "interrupted"); assert.equal(status.checkpoint.available, true);
    const checkpoint = app.checkpoints.get(turnId, "alice")!;
    assert.equal(checkpoint.usage.calls, 2, "in-flight provider allowance is persisted before the provider starts");
    assert.ok(checkpoint.usage.tokens > 0);
    const events = await decode(await app.post({ resumeTurnId: turnId }, "resume-crash"));
    const done = events.find(event => event.type === "done"); assert.ok(done, JSON.stringify(events));
    assert.equal(done.timings.modelCalls, 3); assert.equal(app.calls(), 1); assert.equal(app.searches(), 0);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await app?.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
