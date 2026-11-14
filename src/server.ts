/**
 * One Node process: serves the page, streams chat turns as server-sent events,
 * and exposes the clock and the memory log to the interface.
 */
import { readFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { type AgentEvent, type Deps, runTurn } from "./agent/run.ts";
import { SystemClock } from "./clock.ts";
import { loadConfig } from "./config.ts";
import { createLlm } from "./llm.ts";
import { Enricher } from "./memory/enrich.ts";
import { MemoryStore } from "./memory/store.ts";
import { createExaSearch, withCache, withConcurrency } from "./search.ts";
import { validTimeZone } from "./time/zone.ts";
import { parseInstant } from "./time/instant.ts";

const config = loadConfig();
const clock = new SystemClock();
if (config.startAt) clock.travelTo(config.startAt);
const store = new MemoryStore(config.dbPath);

// Without keys the server still starts, and the page says which ones are missing.
let deps: Deps | null = null;
if (config.llm && config.exaApiKey) {
  const llm = createLlm(config.llm);
  const exa = withCache(withConcurrency(createExaSearch(config.exaApiKey)));
  deps = { llm, store, clock, search: exa, enricher: new Enricher(llm, store),
    verifier: createLlm({ ...config.llm, fastModel: config.llm.model }) };
}

const root = fileURLToPath(new URL("..", import.meta.url));
const STATIC: Record<string, [file: string, type: string]> = {
  "/": ["public/index.html", "text/html; charset=utf-8"],
  "/app.js": ["public/app.js", "text/javascript; charset=utf-8"],
  "/citations.js": ["public/citations.js", "text/javascript; charset=utf-8"],
  "/style.css": ["public/style.css", "text/css; charset=utf-8"],
  "/vendor/marked.js": ["node_modules/marked/lib/marked.umd.js", "text/javascript; charset=utf-8"],
  "/vendor/purify.js": ["node_modules/dompurify/dist/purify.min.js", "text/javascript; charset=utf-8"],
  // Fonts are shipped with the app so the page looks the same on every machine.
  "/fonts/mono-400.woff2": ["node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2", "font/woff2"],
  "/fonts/mono-400-italic.woff2": ["node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-italic.woff2", "font/woff2"],
  "/fonts/mono-600.woff2": ["node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2", "font/woff2"],
  "/fonts/display-700.woff2": ["node_modules/@fontsource/barlow-condensed/files/barlow-condensed-latin-700-normal.woff2", "font/woff2"],
  "/fonts/display-800.woff2": ["node_modules/@fontsource/barlow-condensed/files/barlow-condensed-latin-800-normal.woff2", "font/woff2"],
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100_000) throw new RequestError("Request body too large", 413);
    chunks.push(chunk);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new RequestError("Expected a JSON object", 400); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RequestError("Expected a JSON object", 400);
  return parsed as Record<string, unknown>;
}

function state() {
  return {
    now: clock.now().toISOString(),
    simulated: clock.simulated,
    model: config.llm?.model ?? null,
    missing: config.missing,
    episodes: store.count(clock.now().getTime()),
    simulation: { mode: "era", research: "live-web", review: "event-time-and-sources" },
  };
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.slice(0, 64) : "";
  if (!message || message.length > 8000 || !sessionId) {
    return sendJson(res, 400, { error: "Expected { sessionId, message } with a message of 1 to 8000 characters." });
  }
  let asOf: Date | undefined;
  if (body.asOf !== undefined) {
    const parsed = parseInstant(body.asOf);
    if (!parsed) return sendJson(res, 400, { error: "asOf must be a real ISO timestamp with a timezone." });
    asOf = parsed;
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const emit = (event: AgentEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  if (!deps) {
    emit({ type: "error", message: `Missing configuration: ${config.missing.join(", ")}. Copy .env.example to .env, fill it in and restart.` });
    return void res.end();
  }

  // Closing the tab or pressing stop cancels the model and search calls in flight.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  const tz = validTimeZone(typeof body.tz === "string" ? body.tz : undefined);
  await runTurn(deps, { sessionId, message, tz, asOf, signal: abort.signal }, emit);
  res.end();
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (req.method === "GET" && STATIC[path]) {
    const [file, type] = STATIC[path];
    return void res.writeHead(200, { "content-type": type, "cache-control": "no-cache" }).end(await readFile(root + file));
  }
  if (req.method === "GET" && path === "/api/state") return sendJson(res, 200, state());
  if (req.method === "GET" && path === "/api/memory") {
    const episodes = store.recent(100, clock.now().getTime()).map((e) => {
      const verifiedStatements = store.verifiedStatementsFor(e.id);
      const simulation = (e.execution?.simulation as { mode?: string } | undefined)?.mode === "era";
      return { ...e, answer: simulation ? e.answer : undefined, claims: store.claimsFor(e.id), verifiedStatements,
        sources: verifiedStatements.length || simulation ? store.sourcesFor(e.id).map(({ n, url, title, archive, temporal }) => ({ n, url, title, archive, temporal })) : [] };
    });
    return sendJson(res, 200, { episodes });
  }
  const episodeMatch = /^\/api\/episodes\/(\d+)$/.exec(path);
  if (req.method === "GET" && episodeMatch) {
    const id = Number(episodeMatch[1]);
    const episode = store.episode(id);
    if (!episode || episode.askedAt > clock.now().getTime()) return sendJson(res, 404, { error: "Episode not found" });
    return sendJson(res, 200, { episode, claims: store.claimsFor(id), sources: store.sourcesFor(id), verifiedStatements: store.verifiedStatementsFor(id) });
  }
  if (req.method === "POST" && path === "/api/clock") {
    // Body: { now: ISO string } to travel, { now: null } to return to the present.
    const { now } = await readJson(req);
    if (now === null) clock.reset();
    else {
      const target = parseInstant(now);
      if (!target) return sendJson(res, 400, { error: "Invalid date." });
      clock.travelTo(target);
    }
    return sendJson(res, 200, state());
  }
  if (req.method === "POST" && path === "/api/chat") return handleChat(req, res);

  sendJson(res, 404, { error: "Not found" });
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (error instanceof RequestError && !res.headersSent) return sendJson(res, error.status, { error: error.message });
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: "Internal error" });
    else res.end();
  });
});

server.listen(config.port, "127.0.0.1", () => {
  console.log(`asof is running at http://localhost:${config.port}`);
  if (config.missing.length) console.log(`Not configured yet: ${config.missing.join(", ")} (see .env.example)`);
  if (clock.simulated) console.log(`Clock starts at ${clock.now().toISOString()} (AGENT_NOW)`);
});
