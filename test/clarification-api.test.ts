import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

test("HTTP clarification round-trip pins the original era, validates choices and replays completed retries", { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "asof-clarification-api-"));
  const modelRequests: Array<Record<string, any>> = [];
  const question = { question: "Which part of the history interests you?", why: "This focuses the sources and explanation.", options: [
    { label: "Political developments", detail: "Focus on institutions and negotiations" },
    { label: "Everyday life", detail: "Focus on daily experiences" },
  ] };
  const fake = createServer(async (req, res) => {
    const parts = []; for await (const chunk of req) parts.push(chunk);
    const body = JSON.parse(Buffer.concat(parts).toString());
    modelRequests.push(body);
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"status":"approved","issues":[],"summary":"done","topics":[],"claims":[]}' } }] }));
      return;
    }
    const canAsk = body.tools.some((tool: any) => tool.function.name === "ask_clarification");
    const delta = canAsk ? { tool_calls: [{ index: 0, id: "call-q", type: "function", function: { name: "ask_clarification", arguments: JSON.stringify(question) } }] } : { content: "Here is the political history, from your selected date." };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: canAsk ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  fake.listen(0, "127.0.0.1"); await once(fake, "listening");
  const address = fake.address(); assert.ok(address && typeof address !== "string");
  const portProbe = createServer(); portProbe.listen(0, "127.0.0.1"); await once(portProbe, "listening");
  const probeAddress = portProbe.address(); assert.ok(probeAddress && typeof probeAddress !== "string");
  const port = probeAddress.port; await new Promise<void>(resolve => portProbe.close(() => resolve()));
  let child: ChildProcess | undefined, logs = "";
  const post = (path: string, data: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const sse = async (response: Response) => { assert.equal(response.status, 200); return (await response.text()).split("\n\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))); };
  try {
    const mockBootstrap = `
      import { createApplication } from './src/server.ts';
      import { loadConfig } from './src/config.ts';
      import { createLlm } from './src/llm.ts';
      import { MemoryStore } from './src/memory/store.ts';
      import { QuestionStore } from './src/memory/questions.ts';
      import { SystemClock } from './src/clock.ts';
      const config = loadConfig(), store = new MemoryStore(config.dbPath), questions = new QuestionStore(config.dbPath);
      const llm = createLlm(config.llm, { spendPolicy: null, fetch: (...args) => fetch(...args) });
      const app = createApplication({ config, store, questions, deps: { llm, verifier: llm, store, questions,
        clock: new SystemClock(), search: { search: async () => { throw new Error('Unexpected lookup in a wire fixture'); } }, enricher: { schedule() {} } } });
      app.server.listen(config.port, config.host);
      process.once('SIGTERM', () => { void app.shutdown(); });
    `;
    child = spawn(process.execPath, ["--import", "tsx", "--disable-warning=ExperimentalWarning", "--input-type=module", "--eval", mockBootstrap], {
      env: { ...process.env, PORT: String(port), DB_PATH: join(directory, "memory.db"), AGENT_NOW: "", LLM_API_KEY: "wire-test", LLM_MODEL: "wire-test", LLM_FAST_MODEL: "wire-test", LLM_REASONING_EFFORT: "", LLM_API_MODE: "chat_completions", LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`, EXA_API_KEY: "unused-wire-test" }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", chunk => { logs += chunk; }); child.stderr!.on("data", chunk => { logs += chunk; });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/state`)).ok) { ready = true; break; } } catch {}
      if (child.exitCode != null) break;
      await delay(25);
    }
    assert.ok(ready, logs);
    const originalAt = "1948-01-14T12:00:00.000Z";
    const initial = await sse(await post("/api/chat", { sessionId: "wire-session", message: "Explain the history of India", asOf: originalAt, tz: "Asia/Kolkata" }));
    assert.deepEqual(initial.map(event => event.type), ["turn", "recall", "clarification"]);
    const card = initial.find(event => event.type === "clarification").card;
    assert.equal(card.time.effectiveAt, originalAt);
    assert.deepEqual((await (await fetch(`http://127.0.0.1:${port}/api/sessions/wire-session`)).json()).episodes, []);
    const pending = await (await fetch(`http://127.0.0.1:${port}/api/sessions/wire-session/clarification`)).json();
    assert.equal(pending.card.id, card.id);
    assert.equal((await post("/api/chat", { sessionId: "wrong-session", clarification: { id: card.id, selection: { optionId: "a" } } })).status, 409);
    assert.equal((await post("/api/chat", { sessionId: "wire-session", clarification: { id: card.id, selection: { optionId: "a", text: "injected" } } })).status, 400);
    assert.equal((await post("/api/chat", { sessionId: "wire-session", clarification: { id: card.id, selection: { optionId: "d" } } })).status, 409);
    await post("/api/clock", { sessionId: "other-tab", now: "2020-01-01T00:00:00Z" });
    const resumeBody = { sessionId: "wire-session", message: "tampered message", tz: "UTC", asOf: "2030-01-01T00:00:00Z", clarification: { id: card.id, selection: { optionId: "a" } } };
    const answer = await sse(await post("/api/chat", resumeBody));
    assert.ok(answer.some(event => event.type === "done"));
    assert.equal(answer.some(event => event.type === "clarification"), false);
    const resumedPrompt = modelRequests.filter(request => request.stream)[1]!;
    assert.equal(resumedPrompt.messages.at(-1).content, "Explain the history of India");
    assert.match(JSON.stringify(resumedPrompt.messages), /1948-01-14T12:00:00.000Z \(Asia\/Kolkata\)/);
    assert.match(JSON.stringify(resumedPrompt.messages), /Political developments: Focus on institutions and negotiations/);
    assert.deepEqual(resumedPrompt.tools.map((tool: any) => tool.function.name), ["web_search"]);
    const episodeId = answer.find(event => event.type === "done").episodeId;
    const saved = await (await fetch(`http://127.0.0.1:${port}/api/episodes/${episodeId}`)).json();
    assert.equal(saved.episode.question, "Explain the history of India"); assert.equal(saved.episode.askedAt, Date.parse(originalAt));
    assert.equal(saved.episode.execution.clarification.optionId, "a");
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/sessions/wire-session/clarification`)).json()).card, null);
    const callsBefore = modelRequests.length;
    const replay = await sse(await post("/api/chat", resumeBody));
    assert.equal(replay.find(event => event.type === "done").episodeId, episodeId);
    assert.equal(modelRequests.length, callsBefore);
    assert.equal((await post("/api/chat", { ...resumeBody, clarification: { id: card.id, selection: { optionId: "b" } } })).status, 409);
  } finally {
    if (child && child.exitCode == null) { child.kill(); await once(child, "exit"); }
    await new Promise<void>(resolve => fake.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
