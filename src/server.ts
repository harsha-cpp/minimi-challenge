import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentEvent, type Deps, runTurn } from "./agent/run.ts";
import { SystemClock } from "./clock.ts";
import { loadConfig, type Config } from "./config.ts";
import { createLlm } from "./llm.ts";
import { AdmissionError, AdmissionPool, createModelGateway, ModelBudget, ModelQuota, runWithModelContext, type ModelCallTrace } from "./llm/gateway.ts";
import { Enricher } from "./memory/enrich.ts";
import { MemoryStore, StoreConflictError, type DurableTurn } from "./memory/store.ts";
import { createExaSearch, withCache, withConcurrency, withProfile, retrievalProfile } from "./search.ts";
import { turnPolicy } from "./agent/prepare.ts";
import { validTimeZone } from "./time/zone.ts";
import { parseInstant } from "./time/instant.ts";
import { QuestionStore, QuestionConflict } from "./memory/questions.ts";
import { parseSelection, type ClarificationAnswer } from "./agent/clarification.ts";
import { AccessError, createGuestSession, ownerForToken, requestOwner } from "./runtime/access.ts";
import { SseChannel } from "./runtime/sse.ts";
import { defaultProviderSpending, type ProviderSpendingPolicy } from "./runtime/provider-spending.ts";
import { providerConfigurationIssues } from "./runtime/provider-readiness.ts";
import { POLICY_VERSION, finishTrace, newTrace, recordStage, recordUsage, serverEmission, withTrace, type TurnTrace } from "./runtime/telemetry.ts";
const root = fileURLToPath(new URL("..", import.meta.url));
const STATIC: Record<string, [file: string, type: string]> = {
  "/": ["public/index.html", "text/html; charset=utf-8"],
  "/favicon.svg": ["public/favicon.svg", "image/svg+xml"],
  "/minimi-logo.png": ["public/minimi-logo.png", "image/png"],
  "/app.js": ["public/app.js", "text/javascript; charset=utf-8"],
  "/recovery.js": ["public/recovery.js", "text/javascript; charset=utf-8"],
  "/citations.js": ["public/citations.js", "text/javascript; charset=utf-8"],
  "/style.css": ["public/style.css", "text/css; charset=utf-8"],
  "/vendor/marked.js": ["node_modules/marked/lib/marked.umd.js", "text/javascript; charset=utf-8"],
  "/vendor/purify.js": ["node_modules/dompurify/dist/purify.min.js", "text/javascript; charset=utf-8"],

  "/fonts/mono-400.woff2": ["node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2", "font/woff2"],
  "/fonts/mono-400-italic.woff2": ["node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-italic.woff2", "font/woff2"],
  "/fonts/mono-600.woff2": ["node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2", "font/woff2"],
  "/fonts/display-700.woff2": ["node_modules/@fontsource/barlow-condensed/files/barlow-condensed-latin-700-normal.woff2", "font/woff2"],
  "/fonts/display-800.woff2": ["node_modules/@fontsource/barlow-condensed/files/barlow-condensed-latin-800-normal.woff2", "font/woff2"],
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}
class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 100_000) throw new RequestError("Request body too large", 413); chunks.push(chunk); }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new RequestError("Expected a JSON object", 400); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RequestError("Expected a JSON object", 400);
  return parsed as Record<string, unknown>;
}
const validSession = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const modelTrace = (call: ModelCallTrace) => {
  recordStage("model_queue", call.queueMs, { purpose: call.purpose, priority: call.priority });
  recordStage("model_call", call.durationMs, { purpose: call.purpose, outcome: call.outcome, providerStarted: call.providerStarted, firstDeltaMs: call.firstDeltaMs, spendEstimateUsd: call.budget.spendUsd, priceVersion: call.budget.priceVersion, missingUsageCalls: call.budget.missingUsageCalls, externalCalls: call.budget.externalCalls, unknownExternalUsage: call.budget.unknownExternalUsage, externalSpendEstimateUsd: call.budget.externalSpendEstimateUsd, spendIsEstimated: call.budget.spendIsEstimated });
  if (call.providerStarted) recordUsage(call.usage ?? undefined);
};

export function createApplication(options: { config?: Config; store?: MemoryStore; questions?: QuestionStore; deps?: Deps | null; spendingPolicy?: ProviderSpendingPolicy } = {}) {
  const config = options.config ?? loadConfig();
  const missing = [...config.missing];
  const clock = new SystemClock();
  const store = options.store ?? new MemoryStore(config.dbPath);
  const questions = options.questions ?? new QuestionStore(config.dbPath);
  store.recoverInterruptedTurns();
  store.purgeOperational(Date.now() - config.limits.traceRetentionDays * 86_400_000);
  const turns = new AdmissionPool({ maxActive: config.limits.activeTurns, maxQueued: config.limits.queuedTurns, foregroundReserve: 0 });
  const models = new AdmissionPool({ maxActive: config.limits.activeModels, maxQueued: config.limits.queuedModels });
  const quota = new ModelQuota({ requestsPerMinute: config.limits.modelRequestsPerMinute, tokensPerMinute: config.limits.modelTokensPerMinute, completionRequests: config.limits.modelCompletionRequests, completionTokens: config.limits.modelCompletionTokens });
  const prices = config.limits.inputDollarsPerMillion !== null && config.limits.outputDollarsPerMillion !== null
    ? { version: process.env.MODEL_PRICE_VERSION ?? "operator-v1", inputPerMillionUsd: config.limits.inputDollarsPerMillion, outputPerMillionUsd: config.limits.outputDollarsPerMillion } : undefined;
  const budget = () => new ModelBudget({ maxCalls: config.limits.turnModelCalls, maxTokens: config.limits.turnTokens, reserveCalls: Math.min(2, config.limits.turnModelCalls - 1), reserveTokens: Math.min(12_000, Math.floor(config.limits.turnTokens / 4)),
    ...(prices ? { prices, maxSpendUsd: config.limits.maxTurnDollars } : {}) });
  let deps: Deps | null = options.deps ?? null;
  let worker: Enricher | undefined;
  if (options.deps === undefined && config.llm && config.exaApiKey) {
    const spendingPolicy = options.spendingPolicy ?? defaultProviderSpending();
    const issues = providerConfigurationIssues(config, spendingPolicy);
    missing.push(...issues.filter(name => !missing.includes(name)));
    if (!issues.length) {
      const llm = createModelGateway(createLlm(config.llm, { spendPolicy: spendingPolicy }), { pool: models, quota, defaultBudget: { maxCalls: config.limits.turnModelCalls, maxTokens: config.limits.turnTokens, ...(prices ? { prices, maxSpendUsd: config.limits.maxTurnDollars } : {}) }, outputTokens: config.limits.maxOutputTokens, onCall: modelTrace });
      const verifier = createModelGateway(createLlm({ ...config.llm, fastModel: config.llm.model }, { spendPolicy: spendingPolicy }), { pool: models, quota, defaultBudget: { maxCalls: config.limits.turnModelCalls, maxTokens: config.limits.turnTokens, ...(prices ? { prices, maxSpendUsd: config.limits.maxTurnDollars } : {}) }, onCall: modelTrace });
      worker = new Enricher(llm, store);
      deps = { llm, verifier, clock, store, search: withCache(withConcurrency(createExaSearch(config.exaApiKey, { spendPolicy: spendingPolicy, maxAttemptCostDollars: config.limits.searchAttemptDollars ?? null }), 4, 16)), enricher: worker, questions };
    }
  }
  if (options.deps) {
    const llm = createModelGateway(options.deps.llm, { pool: models, quota, defaultBudget: { maxCalls: config.limits.turnModelCalls, maxTokens: config.limits.turnTokens, ...(prices ? { prices, maxSpendUsd: config.limits.maxTurnDollars } : {}) }, outputTokens: config.limits.maxOutputTokens, onCall: modelTrace });
    const reviewer = options.deps.verifier ? { ...options.deps.llm, json: options.deps.verifier.json.bind(options.deps.verifier) } : options.deps.llm;
    deps = { ...options.deps, llm, verifier: createModelGateway(reviewer, { pool: models, quota, defaultBudget: { maxCalls: config.limits.turnModelCalls, maxTokens: config.limits.turnTokens, ...(prices ? { prices, maxSpendUsd: config.limits.maxTurnDollars } : {}) }, onCall: modelTrace }) };
  }
  const eventLoop = monitorEventLoopDelay({ resolution: 20 }); eventLoop.enable();
  let draining = false;
  const controllers = new Set<AbortController>();
  const activeRequests = new Set<Promise<void>>();
  const counters: Record<string, number> = {};
  const count = (name: string) => { counters[name] = (counters[name] ?? 0) + 1; };
  const defaultViewpoint = config.startAt?.getTime() ?? null;
  const state = (ownerId: string, sessionId?: string) => {
    const conversation = sessionId ? store.conversation(sessionId, ownerId) : null;
    const viewpoint = conversation ? conversation.viewpointAt : defaultViewpoint;
    return { now: new Date(viewpoint ?? Date.now()).toISOString(), simulated: viewpoint !== null,
      mode: viewpoint !== null ? "era" : "live", model: config.llm?.model ?? null, missing,
      episodes: store.count(Number.MAX_SAFE_INTEGER, ownerId), policyVersion: POLICY_VERSION,
      simulation: { mode: "era", research: "live-web", review: "event-time-and-sources" },
      features: { clarifications: true, durableTurns: true, conversationTime: true },
      ...(conversation ? { conversation } : {}) };
  };
  const turnResult = (turn: DurableTurn, ownerId: string) => ({ turn,
    ...(turn.episodeId !== null ? { episode: store.episode(turn.episodeId, ownerId), sources: store.sourcesFor(turn.episodeId, ownerId) } : {}),
  });
  const replay = (res: ServerResponse, turn: DurableTurn, ownerId: string) => {
    const episode = turn.episodeId !== null ? store.episode(turn.episodeId, ownerId) : null;
    if (!episode) return sendJson(res, 200, turnResult(turn, ownerId));
    const sources = store.sourcesFor(episode.id, ownerId);
    const channel = new SseChannel(res, () => {});
    channel.send({ type: "turn", turnId: turn.id, provisional: false });
    channel.send({ type: "sources", sources }); channel.send({ type: "text", delta: episode.answer });
    channel.send({ type: "done", turnId: turn.id, episodeId: episode.id, quality: episode.quality ?? "explicitly_unverified", cited: sources.map(source => source.n),
      timings: { recallMs: 0, firstTokenMs: 0, totalMs: 0, searches: 0, modelCalls: 0 }, recovered: true }); channel.end();
  };
  async function handleChat(req: IncomingMessage, res: ServerResponse, ownerId: string): Promise<void> {
    if (draining) return sendJson(res, 503, { error: "Service is shutting down.", code: "draining" });
    const body = await readJson(req);
    let message = typeof body.message === "string" ? body.message.trim() : "";
    if ((!body.clarification && (!message || message.length > 8000)) || !validSession(body.sessionId)) throw new RequestError("Expected a session ID and a message of 1 to 8000 characters.", 400);
    const sessionId = body.sessionId;
    const recheckEpisodeId = body.recheckEpisodeId;
    if (recheckEpisodeId !== undefined) {
      if (!Number.isSafeInteger(recheckEpisodeId) || Number(recheckEpisodeId) < 1 || body.clarification !== undefined) throw new RequestError("Invalid saved answer reference.", 400);
      const target = store.episode(Number(recheckEpisodeId), ownerId);
      if (!target || target.sessionId !== sessionId) throw new RequestError("Saved answer not found in this conversation.", 404);
    }
    let asOf: Date | undefined;
    if (body.asOf !== undefined && body.asOf !== null) {
      const parsed = parseInstant(body.asOf); if (!parsed) throw new RequestError("asOf must be a real ISO timestamp with a timezone.", 400); asOf = parsed;
    }
    if (body.mode !== undefined && !["live", "era"].includes(String(body.mode))) throw new RequestError("mode must be live or era.", 400);
    if (body.mode === "live" && asOf) throw new RequestError("Live mode cannot have a simulated viewpoint.", 400);
    if (body.mode === "era" && !asOf) throw new RequestError("Era mode requires asOf.", 400);
    const previous = store.conversation(sessionId, ownerId);
    const viewpoint = body.mode === "live" || body.asOf === null ? null : asOf?.getTime() ?? previous?.viewpointAt ?? defaultViewpoint;
    const selected = viewpoint === null ? undefined : new Date(viewpoint);
    let resumed: ReturnType<QuestionStore["begin"]> | undefined;
    let clarification: ClarificationAnswer | undefined;
    let release: (() => void) | undefined;
    let turn: DurableTurn | undefined;
    let channel: SseChannel | undefined;
    const deadlineAt = Date.now() + config.limits.turnTimeoutMs;
    const abort = new AbortController(); controllers.add(abort);
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(config.limits.turnTimeoutMs)]);
    const onClose = () => { if (!res.writableEnded) abort.abort(); };
    res.on("close", onClose); req.on("aborted", () => abort.abort());
    try {
      if (body.clarification !== undefined) {
        const raw = body.clarification as Record<string, unknown> | null;
        if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !["id", "selection"].includes(key)) || typeof raw.id !== "string" || !/^[a-f0-9-]{36}$/i.test(raw.id)) throw new RequestError("Invalid clarification reference.", 400);
        const selection = parseSelection(raw.selection); if (!selection) throw new RequestError("Choose an option, enter a detail of at most 1000 characters, or skip.", 400);
        resumed = questions.begin(raw.id, sessionId, selection, ownerId);
        message = resumed.card.message; clarification = resumed.selection!;
        if (resumed.episodeId != null) {
          const episode = store.episode(resumed.episodeId, ownerId);
          if (!episode?.turnId) throw new RequestError("Saved clarification answer is unavailable.", 409);
          const completed = store.getTurn(episode.turnId, ownerId); if (!completed) throw new RequestError("Saved turn is unavailable.", 409);
          return replay(res, completed, ownerId);
        }
      }
      const effectiveViewpoint = resumed ? resumed.card.time.simulated ? Date.parse(resumed.card.time.effectiveAt) : null : selected?.getTime() ?? null;
      if (effectiveViewpoint !== null && effectiveViewpoint > Date.now()) throw new RequestError("Choose a date and time in the past, or return to live mode.", 400, "future_viewpoint");
      const effectiveMode = effectiveViewpoint === null ? "live" : "era";
      const tz = resumed?.card.time.tz ?? validTimeZone(typeof body.tz === "string" ? body.tz : undefined);
      const key = req.headers["idempotency-key"] ?? body.idempotencyKey ?? randomUUID();
      if (typeof key !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(key)) throw new RequestError("Invalid idempotency key.", 400);
      const requestHash = createHash("sha256").update(JSON.stringify({ sessionId, message, tz, mode: effectiveMode, asOf: effectiveViewpoint, clarification: clarification ?? null,
        ...(recheckEpisodeId !== undefined ? { recheckEpisodeId } : {}) })).digest("hex");
      const begun = store.beginTurn({ ownerId, sessionId, idempotencyKey: key, requestHash, viewpointAt: effectiveViewpoint, mode: effectiveMode });
      turn = begun.turn;
      if (begun.created) requestControllers.set(turn.id, abort);
      res.setHeader("x-turn-id", turn.id);
      if (!begun.created) {
        if (turn.status === "completed") return replay(res, turn, ownerId);
        res.setHeader("retry-after", "1");
        return sendJson(res, turn.status === "running" ? 202 : 409, { ...turnResult(turn, ownerId), code: turn.status === "running" ? "turn_in_progress" : "turn_terminal", error: turn.status === "running" ? "This answer is already running." : "This attempt ended. Submit a new key to try again." });
      }
      const trace = newTrace(turn.id, config.llm?.model ?? null, effectiveMode);
      const persistTrace = (updated: TurnTrace) => {
        try { const priorTrace = store.traceFor(turn!.id, ownerId); store.saveTrace(turn!.id, ownerId,
          { ...updated, clientFirstRenderMs: priorTrace?.clientFirstRenderMs ?? updated.clientFirstRenderMs }); }
        catch { count("trace_write_failed"); }
      };
      persistTrace(trace);
      await withTrace(trace, async () => {
        let outcome = "failed";
        try {
          const admissionStarted = performance.now();
          release = await turns.acquire({ ownerId, signal, deadlineAt: Date.now() + Math.min(15_000, config.limits.turnTimeoutMs - 500) });
          recordStage("turn_admission", performance.now() - admissionStarted, { active: turns.stats.active, queued: turns.stats.queued });
          if (!deps) throw new RequestError(`Missing configuration: ${missing.join(", ")}.`, 503, "not_configured");
          channel = new SseChannel(res, () => abort.abort());
          channel.send({ type: "turn", turnId: turn!.id, provisional: true });
          const questionPort = { create: (input: Parameters<QuestionStore["create"]>[0]) => questions.create({ ...input, ownerId }) };
          const policy = turnPolicy(message, effectiveMode === "era");
          const requestDeps: Deps = { ...deps, store, clock: { now: () => new Date(effectiveViewpoint ?? Date.now()), simulated: effectiveMode === "era" },
            questions: questionPort, search: withProfile(deps.search, retrievalProfile(message, { simulated: effectiveMode === "era", verify: policy.requireVerificationEvidence }), config.retrievalProfiles) };
          await runWithModelContext({ ownerId, turnId: turn!.id, budget: budget(), deadlineAt, deadlineReserveMs: Math.min(12_000, Math.floor(config.limits.turnTimeoutMs / 3)) },
            () => runTurn(requestDeps, { ownerId, turnId: turn!.id, sessionId, message, tz, asOf: effectiveViewpoint === null ? undefined : new Date(effectiveViewpoint), clarification,
              ...(recheckEpisodeId !== undefined ? { recheckEpisodeId: Number(recheckEpisodeId) } : {}), deadlineAt, signal }, event => {
              if (event.type === "text") serverEmission();
              if (event.type === "done") { outcome = "completed"; trace.quality = event.quality; count(`quality_${event.quality}`); if (resumed) questions.finish(resumed.card.id, event.episodeId); }
              if (event.type === "clarification") outcome = "clarification_required";
              if (event.type === "error") outcome = event.code ?? "generation_failed";
              channel!.send(event);
            }));
          if (store.getTurn(turn!.id, ownerId)?.status === "completed") outcome = "completed";
          else {
            outcome = signal.aborted ? abort.signal.aborted ? "cancelled" : "deadline" : outcome;
            store.failTurn(turn!.id, outcome, ownerId);
          }
        } catch (error) {
          outcome = error instanceof AdmissionError ? `admission_${error.code}` : signal.aborted ? "cancelled" : "infrastructure_error";
          store.failTurn(turn!.id, outcome, ownerId);
          if (!res.headersSent) { res.setHeader("retry-after", "2"); sendJson(res, 503, { error: error instanceof RequestError ? error.message : "Service is busy. Try again shortly.", code: outcome, turnId: turn!.id }); }
          else channel?.send({ type: "error", message: "The answer could not be completed. Check its saved status before retrying." });
        } finally {
          count(outcome);
          const terminal = finishTrace(outcome)!;
          persistTrace(terminal);
          release?.(); channel?.end();
        }
      }, persistTrace);
    } finally { if (resumed) questions.release(resumed.card.id); controllers.delete(abort); if (turn && requestControllers.get(turn.id) === abort) requestControllers.delete(turn.id); res.removeListener("close", onClose); }
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost"), path = url.pathname;
    if (req.method === "GET" && path === "/healthz") return sendJson(res, 200, { status: "alive" });
    if (req.method === "GET" && path === "/readyz") return sendJson(res, !draining && deps ? 200 : 503,
      { ready: !draining && Boolean(deps), policyVersion: POLICY_VERSION, ...(missing.length ? { missing } : {}) });
    if (config.access.mode === "hosted" && path === "/api/auth" && req.method === "POST") {
      if (!config.access.allowedOrigins.includes(req.headers.origin ?? "") || !config.access.allowedOrigins.some(origin => new URL(origin).host === req.headers.host)) throw new AccessError(403, "invalid_origin");
      const body = await readJson(req); const token = typeof body.token === "string" ? body.token : "";
      if (!ownerForToken(token, config.access)) throw new AccessError(401, "authentication_required");
      res.setHeader("set-cookie", `asof_owner=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`); return sendJson(res, 200, { ok: true });
    }
    if (config.access.mode === "hosted" && path === "/login" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end('<!doctype html><title>Sign in · asof</title><main><h1>Sign in to asof</h1><form><label>Access token <input name="token" type="password" required autocomplete="current-password"></label><button>Sign in</button><p role="alert"></p></form><script>document.querySelector("form").onsubmit=async e=>{e.preventDefault();const r=await fetch("/api/auth",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:e.target.token.value})});if(r.ok)location.href="/";else document.querySelector("p").textContent="The token was not accepted."}</script></main>'); return;
    }
    let ownerId: string;
    try { ownerId = requestOwner(req, config.access); }
    catch (error) {
      if (!(error instanceof AccessError) || error.status !== 401 || path !== "/" || req.method !== "GET" || req.headers.authorization !== undefined) throw error;
      if (!config.access.publicSessionSecret) { res.writeHead(302, { location: "/login" }).end(); return; }
      const guest = createGuestSession(config.access);
      ownerId = guest.ownerId;
      res.setHeader("set-cookie", guest.cookie);
    }
    if (req.method === "GET" && STATIC[path]) { const [file, type] = STATIC[path]; res.writeHead(200, { "content-type": type, "cache-control": path === "/" ? "no-store" : "no-cache" }).end(await readFile(root + file)); return; }
    const sessionId = url.searchParams.get("sessionId");
    if (req.method === "GET" && path === "/api/state") return sendJson(res, 200, state(ownerId, validSession(sessionId) ? sessionId : undefined));
    if (req.method === "GET" && path === "/api/metrics" && config.access.mode === "local") return sendJson(res, 200, { counters, turns: turns.stats, models: models.stats, quota: quota.stats, jobs: store.memoryJobCounts(), sqlite: store.metrics, eventLoop: { p95Ms: eventLoop.percentile(95) / 1e6, maxMs: eventLoop.max / 1e6 } });
    const pendingMatch = /^\/api\/sessions\/([a-zA-Z0-9_-]{1,64})\/clarification$/.exec(path);
    if (req.method === "GET" && pendingMatch) return sendJson(res, 200, { card: questions.pending(pendingMatch[1]!, ownerId) });
    const sessionMatch = /^\/api\/sessions\/([a-zA-Z0-9_-]{1,64})$/.exec(path);
    if (req.method === "GET" && sessionMatch) {
      const episodes = store.sessionHistory(sessionMatch[1]!, 100, Number.MAX_SAFE_INTEGER, ownerId).map(episode => ({ episode, sources: store.sourcesFor(episode.id, ownerId) }));
      return sendJson(res, 200, { episodes, conversation: store.conversation(sessionMatch[1]!, ownerId) });
    }
    const turnKeyMatch = /^\/api\/turns\/by-key\/([^/]{1,384})$/.exec(path);
    if (req.method === "GET" && turnKeyMatch) {
      let key: string;
      try { key = decodeURIComponent(turnKeyMatch[1]!); } catch { throw new RequestError("Invalid request key.", 400); }
      if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(key)) throw new RequestError("Invalid request key.", 400);
      const turn = store.turnForKey(key, ownerId);
      return sendJson(res, turn ? 200 : 404, turn ? turnResult(turn, ownerId) : { error: "Turn not found" });
    }
    const renderMatch = /^\/api\/turns\/([a-zA-Z0-9-]{1,64})\/render$/.exec(path);
    if (req.method === "POST" && renderMatch) {
      const turn = store.getTurn(renderMatch[1]!, ownerId); if (!turn) return sendJson(res, 404, { error: "Turn not found" });
      const body = await readJson(req);
      if (typeof body.firstRenderMs !== "number" || !Number.isInteger(body.firstRenderMs) || body.firstRenderMs < 0 || body.firstRenderMs > 300_000) throw new RequestError("Invalid rendering duration.", 400);
      const trace = store.traceFor(turn.id, ownerId);
      if (trace) store.saveTrace(turn.id, ownerId, { ...trace, clientFirstRenderMs: trace.clientFirstRenderMs ?? body.firstRenderMs });
      return sendJson(res, 200, { ok: true });
    }
    const turnMatch = /^\/api\/turns\/([a-zA-Z0-9-]{1,64})(\/trace)?$/.exec(path);
    if (req.method === "GET" && turnMatch) {
      const turn = store.getTurn(turnMatch[1]!, ownerId); if (!turn) return sendJson(res, 404, { error: "Turn not found" });
      return sendJson(res, 200, turnMatch[2] ? { trace: store.traceFor(turn.id, ownerId) } : turnResult(turn, ownerId));
    }
    if (req.method === "POST" && turnMatch && !turnMatch[2]) {
      const turn = store.getTurn(turnMatch[1]!, ownerId); if (!turn) return sendJson(res, 404, { error: "Turn not found" });
      requestControllers.get(turn.id)?.abort(); return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && path === "/api/memory") {
      const cursor = url.searchParams.get("cursor"), limit = url.searchParams.get("limit");
      if (cursor !== null && !/^[1-9]\d*$/.test(cursor) || limit !== null && !/^(?:[1-9]\d?|100)$/.test(limit)) throw new RequestError("Invalid pagination parameters.", 400);
      const page = store.ledgerPage({ ownerId, limit: limit ? Number(limit) : 50, beforeId: cursor ? Number(cursor) : undefined });
      return sendJson(res, 200, { episodes: page.items.map(({ episode, ...detail }) => ({ ...episode, ...detail })), nextCursor: page.nextCursor });
    }
    const episodeMatch = /^\/api\/episodes\/(\d+)$/.exec(path);
    if (req.method === "GET" && episodeMatch) {
      const id = Number(episodeMatch[1]), episode = store.episode(id, ownerId); if (!episode) return sendJson(res, 404, { error: "Episode not found" });
      return sendJson(res, 200, { episode, claims: store.claimsFor(id, ownerId), sources: store.sourcesFor(id, ownerId), verifiedStatements: store.verifiedStatementsFor(id, ownerId) });
    }
    if (req.method === "POST" && path === "/api/clock") {
      const body = await readJson(req); if (!validSession(body.sessionId)) throw new RequestError("Clock changes require a conversation sessionId.", 400);
      const target = body.now === null ? null : parseInstant(body.now); if (body.now !== null && !target) throw new RequestError("Invalid date.", 400);
      if (target && target.getTime() > Date.now()) throw new RequestError("Choose a date and time in the past, or return to live mode.", 400, "future_viewpoint");
      store.updateConversation({ ownerId, sessionId: body.sessionId, mode: target ? "era" : "live", viewpointAt: target?.getTime() ?? null });
      return sendJson(res, 200, state(ownerId, body.sessionId));
    }
    if (req.method === "POST" && path === "/api/chat") return handleChat(req, res, ownerId);
    sendJson(res, 404, { error: "Not found" });
  }
  const requestControllers = new Map<string, AbortController>();
  const server = createServer((req, res) => {
    const work = handle(req, res).catch(error => {
      const known = error instanceof RequestError || error instanceof AccessError || error instanceof StoreConflictError || error instanceof QuestionConflict;
      if (!res.headersSent) sendJson(res, error instanceof RequestError || error instanceof AccessError ? error.status : known ? 409 : 500,
        { error: error instanceof RequestError || error instanceof QuestionConflict || error instanceof StoreConflictError ? error.message : known ? "Request denied." : "Internal error", ...(known && "code" in error ? { code: error.code } : {}) });
      else res.end();
      if (!known) { count("request_error"); console.error(JSON.stringify({ event: "request_error", code: "internal_error" })); }
    }).finally(() => activeRequests.delete(work));
    activeRequests.add(work);
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => shutdownPromise ??= (async () => {
    draining = true; turns.close();
    const closed = new Promise<void>(resolveClosed => server.close(() => resolveClosed()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...activeRequests]), new Promise<void>(done => { timer = setTimeout(done, config.limits.shutdownMs); })]); clearTimeout(timer);
    for (const controller of controllers) controller.abort();
    models.close(); server.closeAllConnections();
    await Promise.race([Promise.allSettled([...activeRequests]), new Promise<void>(done => { timer = setTimeout(done, 1000); })]); clearTimeout(timer);
    if (worker) await worker.stop();
    await closed; eventLoop.disable(); store.checkpoint(); questions.close(); store.close();
  })();
  return { server, store, questions, shutdown, state, counters, turns, models, missing };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig(); const app = createApplication({ config });
  app.server.listen(config.port, config.host, () => {
    console.log(`asof is running at http://localhost:${config.port}`);
    if (app.missing.length) console.log(`Not configured yet: ${app.missing.join(", ")} (see .env.example)`);
  });
  for (const name of ["SIGINT", "SIGTERM"] as const) process.once(name, () => { void app.shutdown().catch(() => { process.exitCode = 1; }); });
}
