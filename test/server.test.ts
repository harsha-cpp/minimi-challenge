import assert from "node:assert/strict";
import { once, EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import { createApplication } from "../src/server.ts";
import type { Config } from "../src/config.ts";
import type { Llm } from "../src/llm.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { QuestionStore } from "../src/memory/questions.ts";
import { requestOwner, validateAccessPolicy, type AccessPolicy } from "../src/runtime/access.ts";
import { SseChannel } from "../src/runtime/sse.ts";
import type { ProviderSpendingPolicy } from "../src/runtime/provider-spending.ts";

async function wireFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!(init.headers as Record<string, string> | undefined)?.host) return fetch(url, init);
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: init.method ?? "GET", headers: init.headers as Record<string, string> }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers as Record<string, string> })));
    }); req.on("error", reject); req.end(init.body as string | undefined);
  });
}
const config = (): Config => ({ port: 0, host: "127.0.0.1", dbPath: ":memory:", temporalDbPath: ":memory:", llm: null, exaApiKey: null,
  startAt: null, missing: [], retrievalProfiles: false, access: { mode: "local", allowedOrigins: [], ownerTokens: {} },
  limits: { activeTurns: 2, queuedTurns: 3, activeModels: 1, queuedModels: 4, modelRequestsPerMinute: 1000, modelTokensPerMinute: 1_000_000,
    turnTimeoutMs: 3000, turnTokens: 100_000, turnModelCalls: 10, maxOutputTokens: 4096, shutdownMs: 100, traceRetentionDays: 14,
    maxTurnDollars: 1, inputDollarsPerMillion: null, outputDollarsPerMillion: null } });
const model = (): Llm => ({ json: async () => ({ status: "approved", issues: [] }), stream: async request => { const text = "Hello from the saved answer."; request.onText(text); return { text, toolCalls: [] }; } });
async function start(llm = model(), override?: Partial<Config>) {
  const settings = { ...config(), ...override }, store = new MemoryStore(":memory:"), questions = new QuestionStore(":memory:");
  const app = createApplication({ config: settings, store, questions, deps: { llm, store, clock: { simulated: false, now: () => new Date() },
    search: { search: async () => [] }, enricher: { schedule() {} } } });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening"); const address = app.server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => wireFetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { ...app, base, post };
}
const events = async (response: Response): Promise<Array<Record<string, any>>> => (await response.text()).split("\n\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));

test("public homepage issues private browser histories without exposing existing owner data", async () => {
  const access: AccessPolicy = { mode: "hosted", allowedOrigins: ["https://asof.example.com"], ownerTokens: { alice: "a".repeat(40) }, publicSessionSecret: "s".repeat(43) };
  const app = await start(model(), { access });
  const host = { host: "asof.example.com" }, origin = "https://asof.example.com";
  const body = { sessionId: "same-session", message: "Hello", mode: "live", tz: "UTC" };
  try {
    await events(await app.post("/api/chat", body, { ...host, authorization: `Bearer ${access.ownerTokens.alice}` }));
    const home = await wireFetch(app.base + "/", { headers: host });
    assert.equal(home.status, 200); assert.equal(home.headers.get("cache-control"), "no-store");
    const cookie = home.headers.get("set-cookie")!.split(";")[0]!;
    const otherHome = await wireFetch(app.base + "/", { headers: host });
    const otherCookie = otherHome.headers.get("set-cookie")!.split(";")[0]!;
    assert.notEqual(cookie, otherCookie);
    const first = await events(await app.post("/api/chat", body, { ...host, origin, cookie, "idempotency-key": "guest-turn" }));
    const done = first.find(event => event.type === "done")!; assert.ok(done);
    const memory = await wireFetch(app.base + "/api/memory", { headers: { ...host, cookie } });
    assert.equal((await memory.json()).episodes.length, 1);
    const otherMemory = await wireFetch(app.base + "/api/memory", { headers: { ...host, cookie: otherCookie } });
    assert.equal((await otherMemory.json()).episodes.length, 0);
    assert.equal((await wireFetch(app.base + `/api/turns/${done.turnId}`, { headers: { ...host, cookie: otherCookie } })).status, 404);
    assert.equal((await wireFetch(app.base + "/api/memory", { headers: host })).status, 401);
    assert.equal((await wireFetch(app.base + "/", { headers: { ...host, cookie } })).headers.get("set-cookie"), null);
    assert.equal((await app.post("/api/chat", body, { ...host, cookie })).status, 403);
    assert.equal((await wireFetch(app.base + "/", { headers: { host: "attacker.example" } })).status, 403);
    assert.equal((await wireFetch(app.base + "/", { headers: { ...host, authorization: "Bearer invalid" } })).status, 401);
    const replay = await events(await app.post("/api/chat", body, { ...host, origin, cookie, "idempotency-key": "guest-turn" }));
    assert.equal(replay.find(event => event.type === "done")!.recovered, true);
  } finally { await app.shutdown(); }
});

test("real-provider readiness refuses missing pricing controls before creating funded work", async () => {
  let walletOperations = 0;
  const policy: ProviderSpendingPolicy = { store: { reserve() { walletOperations++; throw new Error("must not reserve"); },
    getSummary() { walletOperations++; throw new Error("must not read wallet"); } },
    priceVersion: "unconfigured", modelPrices: {}, exaAttemptMaxDollars: null };
  const settings = { ...config(), llm: { apiKey: "unused-local-fixture", model: "test-model" }, exaApiKey: "unused-local-fixture" };
  const app = createApplication({ config: settings, spendingPolicy: policy });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const address = app.server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(base + "/healthz")).status, 200);
    const ready = await fetch(base + "/readyz"); assert.equal(ready.status, 503);
    const state = await ready.json(); assert.equal(state.ready, false);
    assert.ok(state.missing.includes("MODEL_DEPLOYMENT_PRICES_JSON"));
    assert.ok(state.missing.includes("SEARCH_MAX_ATTEMPT_DOLLARS"));
    const chat = await fetch(base + "/api/chat", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "unfunded", message: "Hello", mode: "live", tz: "UTC" }) });
    assert.equal(chat.status, 503); assert.equal(walletOperations, 0);
    assert.equal(app.store.count(), 0);
  } finally { await app.shutdown(); }
});

test("HTTP idempotency, lost completion recovery, redacted traces and explicit client rendering", async () => {
  let calls = 0; const llm = model(); const stream = llm.stream; llm.stream = request => { calls++; return stream(request); };
  const app = await start(llm);
  try {
    const body = { sessionId: "chat", message: "Hello", mode: "live", tz: "UTC" };
    const first = await app.post("/api/chat", body, { "idempotency-key": "request-1" });
    const turnId = first.headers.get("x-turn-id")!; assert.ok(turnId);
    const saved = await events(first); const done = saved.find(event => event.type === "done")!; assert.ok(done);
    assert.equal(done.turnId, turnId); assert.equal(done.quality, "non_factual");
    const replay = await events(await app.post("/api/chat", body, { "idempotency-key": "request-1" }));
    assert.equal(replay.find(event => event.type === "done")!.episodeId, done.episodeId); assert.equal(calls, 1); assert.equal(app.store.count(), 1);
    assert.equal((await app.post("/api/chat", { ...body, message: "Different input" }, { "idempotency-key": "request-1" })).status, 409);
    const byKey = await (await fetch(`${app.base}/api/turns/by-key/request-1`)).json(); assert.equal(byKey.turn.id, turnId);
    const recovered = await (await fetch(`${app.base}/api/turns/${turnId}`)).json(); assert.equal(recovered.episode.answer, "Hello from the saved answer.");
    const trace = app.store.traceFor(turnId)!; assert.equal(trace.outcome, "completed"); assert.equal(trace.missingUsage, 1); assert.ok((trace.stages as any[]).some(stage => stage.name === "commit")); assert.doesNotMatch(JSON.stringify(trace), /Hello from the saved answer/);
    await app.post(`/api/turns/${turnId}/render`, { firstRenderMs: 42 }); assert.equal(app.store.traceFor(turnId)!.clientFirstRenderMs, 42);
    const page = await (await fetch(`${app.base}/api/memory?limit=1`)).json(); assert.equal(page.episodes.length, 1);
  } finally { await app.shutdown(); }
});

test("a first client render before commit survives terminal trace persistence", async () => {
  let resume!: () => void; let emitted!: () => void;
  const ready = new Promise<void>(resolve => { emitted = resolve; }), gate = new Promise<void>(resolve => { resume = resolve; });
  const llm = model(); llm.stream = async request => { request.onText("Hello"); emitted(); await gate; return { text: "Hello", toolCalls: [] }; };
  const app = await start(llm);
  try {
    const running = app.post("/api/chat", { sessionId: "render", message: "Hello", mode: "live", tz: "UTC" }, { "idempotency-key": "render-key" });
    await ready;
    const turnId = app.store.turnForKey("render-key")!.id;
    await app.post(`/api/turns/${turnId}/render`, { firstRenderMs: 12 });
    resume(); await events(await running);
    assert.equal(app.store.traceFor(turnId)!.clientFirstRenderMs, 12);
    await app.post(`/api/turns/${turnId}/render`, { firstRenderMs: 99 }); assert.equal(app.store.traceFor(turnId)!.clientFirstRenderMs, 12);
  } finally { resume(); await app.shutdown(); }
});

test("conversation dates are scoped and live mode resets prior simulated mode", async () => {
  const app = await start();
  try {
    assert.equal((await app.post("/api/clock", { now: "1948-01-14T12:00:00Z" })).status, 400);
    await app.post("/api/clock", { sessionId: "a", now: "1948-01-14T12:00:00Z" });
    await app.post("/api/clock", { sessionId: "b", now: "2020-01-01T12:00:00Z" });
    const a = await (await fetch(app.base + "/api/state?sessionId=a")).json(); const b = await (await fetch(app.base + "/api/state?sessionId=b")).json();
    assert.match(a.now, /^1948/); assert.match(b.now, /^2020/);
    await events(await app.post("/api/chat", { sessionId: "a", message: "Hello", mode: "live", tz: "UTC" }));
    assert.equal(app.store.conversation("a")!.viewpointAt, null); assert.equal(app.store.conversation("b")!.viewpointAt, Date.parse("2020-01-01T12:00:00Z"));
  } finally { await app.shutdown(); }
});

test("100 offered turns keep bounded turn/model work; rejected turns never enter providers", async () => {
  let active = 0, peak = 0, calls = 0; let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
  const llm: Llm = { json: async () => ({}), stream: async request => { calls++; active++; peak = Math.max(peak, active); await gate; active--; request.onText("Hello"); return { text: "Hello", toolCalls: [] }; } };
  const app = await start(llm);
  try {
    const pending = Array.from({ length: 100 }, (_, i) => app.post("/api/chat", { sessionId: `burst-${i}`, message: "Hello", mode: "live", tz: "UTC" }, { "idempotency-key": `burst-${i}` }));
    for (let i = 0; i < 200 && app.turns.stats.rejected < 95; i++) await delay(5);
    assert.ok(app.turns.stats.active <= 2); assert.ok(app.turns.stats.queued <= 3); assert.ok(app.turns.stats.rejected >= 95);
    finish(); const responses = await Promise.all(pending); await Promise.all(responses.map(response => response.text()));
    assert.equal(peak, 1); assert.ok(calls <= 5); assert.equal(responses.filter(response => response.status === 503).length, 95);
    assert.equal(app.store.count(), 5); assert.equal(app.models.stats.active, 0);
  } finally { finish(); await app.shutdown(); }
});

test("duplicate in-flight requests and same-conversation writes have defined conflicts", async () => {
  let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; }); const llm = model(); const original = llm.stream;
  llm.stream = async request => { await gate; return original(request); };
  const app = await start(llm);
  try {
    const body = { sessionId: "same", message: "Hello", mode: "live", tz: "UTC" };
    const first = app.post("/api/chat", body, { "idempotency-key": "same-key" });
    for (let i = 0; i < 100 && app.models.stats.active === 0; i++) await delay(5);
    const duplicate = await app.post("/api/chat", body, { "idempotency-key": "same-key" }); assert.equal(duplicate.status, 202); await duplicate.text();
    assert.equal((await app.post("/api/chat", body, { "idempotency-key": "different-key" })).status, 409);
    finish(); await events(await first); assert.equal(app.store.count(), 1);
  } finally { finish(); await app.shutdown(); }
});

test("local Host and Origin policy rejects cross-site reads/writes before storage or provider work", async () => {
  const app = await start();
  try {
    assert.equal((await fetch(app.base + "/api/memory", { headers: { origin: "https://evil.example.com" } })).status, 403);
    assert.equal((await wireFetch(app.base + "/api/memory", { headers: { host: "evil.example.com" } })).status, 403);
    assert.equal((await app.post("/api/chat", { sessionId: "bad", message: "Hello" }, { origin: "null" })).status, 403);
    assert.equal(app.store.count(), 0);
  } finally { await app.shutdown(); }
});

test("hosted identity is authenticated, owner-scoped on every detail/recall/recovery route", async () => {
  const access: AccessPolicy = { mode: "hosted", allowedOrigins: ["https://asof.example.com"], ownerTokens: { alice: "a".repeat(40), bob: "b".repeat(40) } };
  validateAccessPolicy(access); const app = await start(model(), { access });
  const headers = (owner: "alice" | "bob") => ({ host: "asof.example.com", authorization: `Bearer ${access.ownerTokens[owner]}` });
  const get = (path: string, owner: "alice" | "bob") => wireFetch(app.base + path, { headers: headers(owner) });
  try {
    const done = (await events(await app.post("/api/chat", { sessionId: "shared-name", message: "Hello", mode: "live", tz: "UTC" }, { ...headers("alice"), "idempotency-key": "alice:key" }))).find(event => event.type === "done")!;
    assert.equal((await get("/api/turns/by-key/alice%3Akey", "alice")).status, 200);
    assert.equal((await get("/api/turns/by-key/alice%3Akey", "bob")).status, 404);
    assert.equal((await app.post(`/api/turns/${done.turnId}`, {}, headers("bob"))).status, 404);
    assert.equal((await get(`/api/episodes/${done.episodeId}`, "bob")).status, 404); assert.equal((await get(`/api/turns/${done.turnId}`, "bob")).status, 404);
    assert.equal((await (await get("/api/memory", "bob")).json()).episodes.length, 0);
    assert.equal((await (await get("/api/sessions/shared-name", "bob")).json()).episodes.length, 0);
    assert.equal((await get(`/api/turns/${done.turnId}/trace`, "bob")).status, 404);
    assert.equal((await wireFetch(app.base + "/api/memory", { headers: { host: "asof.example.com" } })).status, 401);
    const cookieRequest = { headers: { host: "asof.example.com", cookie: `asof_owner=${access.ownerTokens.alice}` }, method: "POST" } as IncomingMessage;
    assert.throws(() => requestOwner(cookieRequest, access), /origin_required/);
    assert.equal(app.store.sessionHistory("shared-name", 8, Number.MAX_SAFE_INTEGER, "bob").length, 0);
  } finally { await app.shutdown(); }
});

test("SSE buffers stay bounded for slow clients, drain resumes ordering, and stalled readers cancel", async () => {
  class Slow extends EventEmitter {
    writableLength = 0; writableEnded = false; values: string[] = []; destroyed = false; blocked = true;
    writeHead() { return this; } write(value: string) { this.values.push(value); return !this.blocked; }
    end() { this.writableEnded = true; } destroy() { this.destroyed = true; this.emit("close"); }
  }
  const slow = new Slow(); let cancels = 0; const channel = new SseChannel(slow as unknown as ServerResponse, () => { cancels++; }, 200, 10);
  channel.send({ n: 1 }); channel.send({ n: 2 }); assert.equal(slow.values.length, 1);
  slow.blocked = false; slow.emit("drain"); channel.end(); assert.equal(slow.values.length, 2); assert.equal(slow.writableEnded, true); assert.equal(cancels, 0);
  const stalled = new Slow(); const bounded = new SseChannel(stalled as unknown as ServerResponse, () => { cancels++; }, 200, 10); bounded.send({ n: 1 });
  await delay(20); assert.equal(stalled.destroyed, true); assert.ok(cancels >= 1);
  const overflow = new Slow(); const capped = new SseChannel(overflow as unknown as ServerResponse, () => { cancels++; }, 100, 1000); capped.send({ text: "x".repeat(200) }); assert.equal(overflow.destroyed, true);
});
