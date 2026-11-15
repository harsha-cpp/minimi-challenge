import assert from "node:assert/strict";
import { once } from "node:events";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { Llm } from "../src/llm.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { QuestionStore } from "../src/memory/questions.ts";
import { createApplication } from "../src/server.ts";
import type { SearchProvider } from "../src/search.ts";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>, label: string, timeout = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeout}ms`)), timeout); })]); }
  finally { if (timer) clearTimeout(timer); }
}
const config = (dbPath: string): Config => ({ port: 0, host: "127.0.0.1", dbPath, temporalDbPath: ":memory:", llm: null, exaApiKey: null,
  startAt: null, missing: [], retrievalProfiles: false, access: { mode: "local", allowedOrigins: [], ownerTokens: {} },
  limits: { activeTurns: 2, queuedTurns: 3, activeModels: 2, queuedModels: 4, modelRequestsPerMinute: 1000, modelTokensPerMinute: 1_000_000,
    turnTimeoutMs: 30_000, turnTokens: 100_000, turnModelCalls: 10, maxOutputTokens: 4096, shutdownMs: 100, traceRetentionDays: 14,
    maxTurnDollars: 1, inputDollarsPerMillion: null, outputDollarsPerMillion: null } });
const body = { sessionId: "recovery", message: "Hello", tz: "UTC", mode: "live" };
const events = (text: string): Array<Record<string, any>> => text.split("\n\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
async function start(llm: Llm, store = new MemoryStore(":memory:"), dbPath = ":memory:", search: SearchProvider = { search: async () => [] }) {
  const app = createApplication({ config: config(dbPath), store, questions: new QuestionStore(":memory:"), deps: {
    llm, store, search, clock: { simulated: false, now: () => new Date() }, enricher: { schedule() {} },
  } });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const address = app.server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, value: unknown, key?: string) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(value) });
  return { ...app, base, post };
}
function rawChat(base: string, value: unknown, key: string): Promise<{ response: IncomingMessage; drop(): void; text(): string; ended: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const req = request(base + "/api/chat", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key } }, response => {
      let text = ""; response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; });
      response.on("error", () => {});
      const ended = new Promise<void>(done => { response.once("end", done); response.once("close", done); });
      resolve({ response, drop: () => { response.destroy(); req.destroy(); }, text: () => text, ended });
    }); req.on("error", reject); req.end(JSON.stringify(value));
  });
}
async function terminal(app: Awaited<ReturnType<typeof start>>, turnId: string) {
  return bounded((async () => {
    for (;;) {
      const saved = await (await fetch(`${app.base}/api/turns/${turnId}`)).json();
      if (saved.turn.status !== "running") return saved;
      await delay(5);
    }
  })(), "terminal durable state");
}
function gatedModel() {
  const entered = deferred(), aborted = deferred(), finish = deferred(); let calls = 0;
  const llm: Llm = { json: async () => ({}), stream: async req => {
    calls++; req.signal?.addEventListener("abort", aborted.resolve, { once: true }); entered.resolve();
    // Intentionally ignore abort in the provider. The shared gateway must stop awaiting/publication.
    await finish.promise; req.onText("A late provider answer."); return { text: "A late provider answer.", toolCalls: [] };
  } };
  return { llm, entered, aborted, finish, calls: () => calls };
}

test("real socket disconnect before commit cancels generation and late provider output cannot persist", { timeout: 6000 }, async () => {
  const model = gatedModel(), app = await start(model.llm);
  try {
    const client = await rawChat(app.base, body, "disconnect-before");
    const turnId = String(client.response.headers["x-turn-id"]);
    await bounded(model.entered.promise, "provider entry");
    assert.equal(app.store.getTurn(turnId)!.status, "running");
    client.drop(); await bounded(model.aborted.promise, "disconnect propagation"); await client.ended;
    const saved = await terminal(app, turnId);
    assert.equal(saved.turn.status, "failed"); assert.equal(saved.turn.errorCode, "cancelled");
    assert.equal(app.store.count(), 0); assert.equal(app.store.traceFor(turnId)!.outcome, "cancelled");
    model.finish.resolve(); await delay(0);
    assert.equal(app.store.count(), 0); assert.equal(events(client.text()).some(event => event.type === "done"), false);
    const retry = await app.post("/api/chat", body, "disconnect-before");
    assert.equal(retry.status, 409); await retry.text(); assert.equal(model.calls(), 1);
  } finally { model.finish.resolve(); await app.shutdown(); }
});

test("explicit turn cancellation aborts active provider and leaves a recoverable cancelled attempt", { timeout: 6000 }, async () => {
  const model = gatedModel(), app = await start(model.llm);
  try {
    const response = await app.post("/api/chat", body, "explicit-cancel"); const turnId = response.headers.get("x-turn-id")!;
    const streamed = response.text(); await bounded(model.entered.promise, "provider entry");
    const cancelled = await app.post(`/api/turns/${turnId}`, {}); assert.equal(cancelled.status, 200); await cancelled.text();
    await bounded(model.aborted.promise, "explicit cancellation propagation");
    assert.equal(events(await bounded(streamed, "cancelled stream EOF")).some(event => event.type === "done"), false);
    const saved = await terminal(app, turnId); assert.equal(saved.turn.errorCode, "cancelled"); assert.equal(saved.episode, undefined);
    assert.equal(app.store.count(), 0);
    model.finish.resolve(); await delay(0); assert.equal(app.store.count(), 0);
  } finally { model.finish.resolve(); await app.shutdown(); }
});

test("real socket loss immediately after commit recovers the same answer across restart and duplicate POST", { timeout: 6000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-http-restart-")), path = join(dir, "memory.db");
  class DisconnectStore extends MemoryStore {
    onCommit?: () => void;
    override saveEpisode(input: Parameters<MemoryStore["saveEpisode"]>[0]): number { const id = super.saveEpisode(input); this.onCommit?.(); return id; }
  }
  const store = new DisconnectStore(path), model = gatedModel(); let app = await start(model.llm, store, path), closed = false;
  try {
    const client = await rawChat(app.base, body, "disconnect-after"); const turnId = String(client.response.headers["x-turn-id"]);
    await bounded(model.entered.promise, "provider entry");
    const committed = deferred(); store.onCommit = () => { client.drop(); committed.resolve(); };
    model.finish.resolve(); await bounded(committed.promise, "answer commit"); await client.ended;
    const saved = await terminal(app, turnId); const episodeId = saved.turn.episodeId;
    assert.equal(saved.turn.status, "completed"); assert.equal(saved.episode.answer, "A late provider answer.");
    assert.equal(events(client.text()).some(event => event.type === "done"), false, "the disconnected client cannot use completion delivery as its only record");
    await app.shutdown(); closed = true;
    let regenerated = 0;
    const restarted = await start({ json: async () => ({}), stream: async () => { regenerated++; throw new Error("must recover without generation"); } }, new MemoryStore(path), path);
    app = restarted; closed = false;
    const recovered = await (await fetch(`${app.base}/api/turns/${turnId}`)).json();
    assert.equal(recovered.turn.episodeId, episodeId); assert.equal(recovered.turn.status, "completed");
    const replay = await app.post("/api/chat", body, "disconnect-after"); const done = events(await replay.text()).find(event => event.type === "done")!;
    assert.equal(done.episodeId, episodeId); assert.equal(done.recovered, true); assert.equal(regenerated, 0); assert.equal(app.store.count(), 1);
  } finally { model.finish.resolve(); if (!closed) await app.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("shutdown is bounded with an uncooperative provider and late completion cannot write after reopen", { timeout: 6000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-http-shutdown-")), path = join(dir, "memory.db");
  const model = gatedModel(), app = await start(model.llm, new MemoryStore(path), path); let closed = false;
  try {
    const client = await rawChat(app.base, body, "shutdown-active"); const turnId = String(client.response.headers["x-turn-id"]);
    await bounded(model.entered.promise, "provider entry");
    const began = performance.now(); await bounded(app.shutdown(), "bounded shutdown", 1900); closed = true;
    assert.ok(performance.now() - began < 2000); await bounded(model.aborted.promise, "shutdown propagation"); await client.ended;
    const restored = new MemoryStore(path);
    try {
      assert.equal(restored.getTurn(turnId)!.status, "failed"); assert.equal(restored.getTurn(turnId)!.errorCode, "cancelled"); assert.equal(restored.count(), 0);
      model.finish.resolve(); await delay(0); assert.equal(restored.count(), 0);
      assert.equal(restored.integrityCheck().ok, true);
    } finally { restored.close(); }
  } finally { model.finish.resolve(); if (!closed) await app.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("buffered verification disk failure never emits the factual draft or a completed event", { timeout: 6000 }, async () => {
  class FailingStore extends MemoryStore {
    override saveEpisode(): number { throw new Error("Injected disk write failure with private detail"); }
  }
  let rounds = 0;
  const draft = "Fictional Cloud costs $25 per month [1].";
  const llm: Llm = { stream: async req => {
    if (++rounds === 1) return { text: "", toolCalls: [{ id: "lookup", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "Fictional Cloud current pricing" }) } }] };
    req.onText(draft); return { text: draft, toolCalls: [] };
  }, json: async () => ({ status: "approved", issues: [], safeAnswer: null, quality: "supported", claimChecks: [{ claim: "Fictional Cloud costs $25 per month", sourceNumbers: [1], supported: true, applicable: true }] }) };
  const app = await start(llm, new FailingStore(":memory:"), ":memory:", { search: async () => [{ url: "https://example.com/pricing", title: "Cloud pricing", text: "Fictional Cloud costs $25 per month.", retrievedAt: new Date().toISOString(), freshness: { requested: "fresh", acquisition: "live", ageStatus: "known", contentFetchedAt: new Date().toISOString() } }] });
  try {
    const response = await app.post("/api/chat", { ...body, message: "Verify current Fictional Cloud pricing." }, "disk-failure"); const turnId = response.headers.get("x-turn-id")!;
    const received = events(await response.text());
    assert.equal(received.some(event => event.type === "text"), false); assert.equal(received.some(event => event.type === "done"), false);
    assert.ok(received.some(event => event.type === "error")); assert.doesNotMatch(JSON.stringify(received), /Injected disk write failure|private detail/);
    assert.equal(app.store.count(), 0); assert.equal(app.store.getTurn(turnId)!.status, "failed");
  } finally { await app.shutdown(); }
});


test("actual SIGKILL leaves one interrupted durable turn and clean restart never regenerates the old key", { timeout: 12000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-sigkill-")), path = join(dir, "memory.db"), fixture = join(dir, "crash-fixture.mts");
  writeFileSync(fixture, `
    import { once } from "node:events";
    import { createApplication } from ${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)};
    import { MemoryStore } from ${JSON.stringify(new URL("../src/memory/store.ts", import.meta.url).href)};
    import { QuestionStore } from ${JSON.stringify(new URL("../src/memory/questions.ts", import.meta.url).href)};
    const store = new MemoryStore(${JSON.stringify(path)});
    const app = createApplication({ config: ${JSON.stringify(config(path))}, store, questions: new QuestionStore(":memory:"), deps: {
      llm: { json: async () => ({}), stream: async () => {
        process.send?.({ kind: "entered" }); await new Promise(() => {}); return { text: "unreachable", toolCalls: [] };
      } }, store, clock: { simulated: false, now: () => new Date() }, search: { search: async () => [] }, enricher: { schedule() {} },
    } });
    app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
    process.send?.({ kind: "ready", port: app.server.address().port });
  `);
  const child = fork(fixture, { execArgv: ["--import", "tsx", "--disable-warning=ExperimentalWarning"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
  const entered = deferred();
  const ready = new Promise<number>((resolve, reject) => {
    child.on("message", value => { const message = value as { kind: string; port: number }; if (message.kind === "ready") resolve(message.port); if (message.kind === "entered") entered.resolve(); });
    child.once("error", reject); child.once("exit", () => reject(new Error(`Crash fixture exited before readiness: ${stderr}`)));
  });
  const exited = once(child, "exit"); let app: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const port = await bounded(ready, "child application readiness", 5000);
    const client = await rawChat(`http://127.0.0.1:${port}`, body, "sigkill-key");
    const turnId = String(client.response.headers["x-turn-id"]);
    await bounded(entered.promise, "child provider entry");
    child.kill("SIGKILL"); const [, signal] = await bounded(exited, "child process exit"); assert.equal(signal, "SIGKILL"); await client.ended;
    let calls = 0;
    app = await start({ json: async () => ({}), stream: async () => { calls++; return { text: "new answer", toolCalls: [] }; } }, new MemoryStore(path), path);
    const recovered = await (await fetch(`${app.base}/api/turns/${turnId}`)).json();
    assert.equal(recovered.turn.status, "interrupted"); assert.equal(recovered.turn.errorCode, "process_interrupted");
    assert.equal(app.store.traceFor(turnId)!.outcome, "interrupted");
    assert.equal(app.store.traceFor(turnId)!.usageStatus, "unknown_after_restart");
    assert.equal(app.store.count(), 0); assert.equal(app.store.integrityCheck().ok, true);
    const duplicate = await app.post("/api/chat", body, "sigkill-key"); assert.equal(duplicate.status, 409); await duplicate.text(); assert.equal(calls, 0);
    const fresh = await app.post("/api/chat", body, "sigkill-new-key"); assert.ok(events(await fresh.text()).some(event => event.type === "done"));
    assert.equal(calls, 1); assert.equal(app.store.count(), 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited.catch(() => {}); await app?.shutdown(); rmSync(dir, { recursive: true, force: true });
  }
});
