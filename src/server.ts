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
import { FAST_LIMITS } from "./agent/response-mode.ts";
import { validTimeZone } from "./time/zone.ts";
import { parseInstant } from "./time/instant.ts";
import { QuestionStore, QuestionConflict } from "./memory/questions.ts";
import { parseSelection, type ClarificationAnswer } from "./agent/clarification.ts";
import { AccessError, createGuestSession, ownerForToken, requestOwner } from "./runtime/access.ts";
import { SseChannel } from "./runtime/sse.ts";
import { defaultProviderSpending, type ProviderSpendingPolicy } from "./runtime/provider-spending.ts";
import { providerConfigurationIssues } from "./runtime/provider-readiness.ts";
import { POLICY_VERSION, finishTrace, newTrace, recordStage, recordUsage, serverEmission, withTrace, type TurnTrace } from "./runtime/telemetry.ts";
import { summarizeTraces } from "./runtime/latency-report.ts";
import { ResearchCheckpoints, RESEARCH_CHECKPOINT_TTL_MS, type ResearchCheckpoint, type ResearchRequest } from "./runtime/research-checkpoints.ts";
import { executionPolicyFingerprint } from "./runtime/versions.ts";
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
class TurnAbort extends Error {
  constructor(readonly kind: "explicit" | "disconnect" | "shutdown") { super("Turn stopped"); this.name = "AbortError"; }
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

export function createApplication(options: { config?: Config; store?: MemoryStore; questions?: QuestionStore; checkpoints?: ResearchCheckpoints; deps?: Deps | null; spendingPolicy?: ProviderSpendingPolicy } = {}) {
  const config = options.config ?? loadConfig();
  const missing = [...config.missing];
  const clock = new SystemClock();
  const store = options.store ?? new MemoryStore(config.dbPath);
  const questions = options.questions ?? new QuestionStore(config.dbPath);
  const checkpoints = options.checkpoints ?? new ResearchCheckpoints(config.dbPath);
  store.recoverInterruptedTurns();
  store.purgeOperational(Date.now() - config.limits.traceRetentionDays * 86_400_000);
  const turns = new AdmissionPool({ maxActive: config.limits.activeTurns, maxQueued: config.limits.queuedTurns, foregroundReserve: 0 });
  const models = new AdmissionPool({ maxActive: config.limits.activeModels, maxQueued: config.limits.queuedModels });
  const quota = new ModelQuota({ requestsPerMinute: config.limits.modelRequestsPerMinute, tokensPerMinute: config.limits.modelTokensPerMinute, completionRequests: config.limits.modelCompletionRequests, completionTokens: config.limits.modelCompletionTokens });
  const prices = config.limits.inputDollarsPerMillion !== null && config.limits.outputDollarsPerMillion !== null
    ? { version: process.env.MODEL_PRICE_VERSION ?? "operator-v1", inputPerMillionUsd: config.limits.inputDollarsPerMillion, outputPerMillionUsd: config.limits.outputDollarsPerMillion } : undefined;
  const budget = (prior?: ResearchCheckpoint["usage"]) => {
    if (prices && prior?.spendUsd === null) throw new RequestError("The previous attempt's cost could not be bounded. Start fresh research after its usage is reconciled.", 409, "checkpoint_budget_unknown");
    const calls = config.limits.turnModelCalls - (prior?.calls ?? 0), tokens = config.limits.turnTokens - (prior?.tokens ?? 0);
    const dollars = config.limits.maxTurnDollars - (prior?.spendUsd ?? 0);
    if (calls < 1 || tokens < 1 || prices && dollars <= 0) throw new RequestError("This attempt has exhausted its research allowance. Start a new request.", 409, "checkpoint_budget_exhausted");
    return new ModelBudget({ maxCalls: calls, maxTokens: tokens, reserveCalls: Math.min(2, calls - 1), reserveTokens: Math.min(12_000, Math.floor(tokens / 4)),
      ...(prices ? { prices, maxSpendUsd: dollars } : {}) });
  };
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const policyHash = digest({ implementation: executionPolicyFingerprint(), policy: POLICY_VERSION, limits: config.limits,
    model: config.llm?.model, fastModel: config.llm?.fastModel, reasoningEffort: config.llm?.reasoningEffort,
    endpoint: config.llm?.baseUrl, apiMode: config.llm?.apiMode, tokenLimitParameter: config.llm?.tokenLimitParameter,
    supportsStreamUsage: config.llm?.supportsStreamUsage, maxOutputTokens: config.llm?.maxOutputTokens, maxJsonOutputTokens: config.llm?.maxJsonOutputTokens,
    retrievalProfiles: config.retrievalProfiles });
  const checkpointContext = (request: ResearchRequest, ownerId: string) => {
    const conversation = store.conversation(request.sessionId, ownerId);
    const targetId = request.recheckEpisodeId ?? request.memoryReferenceEpisodeId;
    const target = targetId === undefined ? null : store.episode(targetId, ownerId);
    return digest({ episodes: store.count(Number.MAX_SAFE_INTEGER, ownerId), mode: conversation?.mode, viewpointAt: conversation?.viewpointAt,
      history: store.currentConversationHistory(request.sessionId, 8, ownerId).map(episode => [episode.id, episode.sequence, digest([episode.question, episode.answer]), digest(store.canonicalClaimsFor(episode.id, ownerId))]),
      target: target ? [target.id, digest(target.answer), digest(store.canonicalClaimsFor(target.id, ownerId))] : null });
  };
  const usableCheckpoint = (turn: DurableTurn, ownerId: string) => {
    if (!["failed", "interrupted", "running"].includes(turn.status)) return null;
    const saved = checkpoints.get(turn.id, ownerId);
    if (!saved || saved.sessionId !== turn.sessionId || saved.policyHash !== policyHash || saved.contextHash !== checkpointContext(saved.request, ownerId)) return null;
    if (turn.status !== "running") { try { budget(saved.usage); } catch { return null; } }
    return saved;
  };
  let deps: Deps | null = options.deps ?? null;
  let worker: Enricher | undefined;
  if (options.deps === undefined && config.llm && config.exaApiKey) {
    const spendingPolicy = options.spendingPolicy ?? defaultProviderSpending();
    const issues = providerConfigurationIssues(config, spendingPolicy);
    missing.push(...issues.filter(name => !missing.includes(name)));
    if (!issues.length) {
      const llm = createModelGateway(createLlm(config.llm, { spendPolicy: spendingPolicy }), { pool: models, quota, defaultBudget: { maxCalls: config.limits.turnModelCalls, maxTokens: config.limits.turnTokens, ...(prices ? { prices, maxSpendUsd: config.limits.maxTurnDollars } : {}) }, outputTokens: config.limits.maxOutputTokens, onCall: modelTrace });
      const verifier = createModelGateway(createLlm({ ...config.llm, fastModel: config.llm.model, maxJsonOutputTokens: 4000 }, { spendPolicy: spendingPolicy }), { pool: models, quota, defaultBudget: { maxCalls: config.limits.turnModelCalls, maxTokens: config.limits.turnTokens, ...(prices ? { prices, maxSpendUsd: config.limits.maxTurnDollars } : {}) }, onCall: modelTrace });
      const fastLlm = config.llm.fastModel ? createModelGateway(createLlm({ ...config.llm, model: config.llm.fastModel, maxOutputTokens: FAST_LIMITS.outputTokens }, { spendPolicy: spendingPolicy }),
        { pool: models, quota, outputTokens: FAST_LIMITS.outputTokens, onCall: modelTrace }) : undefined;
      worker = new Enricher(llm, store);
      deps = { llm, fastLlm, verifier, clock, store, search: withCache(withConcurrency(createExaSearch(config.exaApiKey, { spendPolicy: spendingPolicy, maxAttemptCostDollars: config.limits.searchAttemptDollars ?? null }), 4, 16)), enricher: worker, questions };
    }
  }
  if (options.deps) {
    const llm = createModelGateway(options.deps.llm, { pool: models, quota, defaultBudget: { maxCalls: config.limits.turnModelCalls, maxTokens: config.limits.turnTokens, ...(prices ? { prices, maxSpendUsd: config.limits.maxTurnDollars } : {}) }, outputTokens: config.limits.maxOutputTokens, onCall: modelTrace });
    const reviewer = options.deps.verifier ? { ...options.deps.llm, json: options.deps.verifier.json.bind(options.deps.verifier) } : options.deps.llm;
    deps = { ...options.deps, llm, verifier: createModelGateway(reviewer, { pool: models, quota, defaultBudget: { maxCalls: config.limits.turnModelCalls, maxTokens: config.limits.turnTokens, ...(prices ? { prices, maxSpendUsd: config.limits.maxTurnDollars } : {}) }, onCall: modelTrace }) };
    if (options.deps.fastLlm) deps.fastLlm = createModelGateway(options.deps.fastLlm, { pool: models, quota, outputTokens: FAST_LIMITS.outputTokens, onCall: modelTrace });
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
      features: { clarifications: true, durableTurns: true, conversationTime: true, researchResume: true, fastMode: Boolean(deps?.fastLlm) },
      ...(conversation ? { conversation } : {}) };
  };
  const turnResult = (turn: DurableTurn, ownerId: string) => {
    const saved = usableCheckpoint(turn, ownerId);
    const review = saved?.progress.review;
    const publishFindings = review && !review.reason && (review.status === "approved" && ["supported", "supported_partial"].includes(review.quality ?? "")
      || review.status === "needs_revision" && Boolean(review.approvedFindings?.length));
    return { turn,
    ...(saved ? { checkpoint: { available: turn.status !== "running", stage: saved.progress.stage, expiresAt: saved.expiresAt,
      request: { ...saved.request, asOf: saved.request.asOf === null ? null : new Date(saved.request.asOf).toISOString(), clarification: undefined },
      ...(publishFindings && review.approvedFindings ? { approvedFindings: review.approvedFindings } : {}),
      ...(publishFindings && review.reviewedClaims ? { reviewedClaims: review.reviewedClaims } : {}) } } : {}),
    ...(turn.status === "waiting_input" ? { clarification: turn.clarificationId ? questions.pendingById(turn.clarificationId, ownerId) : null } : {}),
    ...(turn.episodeId !== null ? { episode: store.episode(turn.episodeId, ownerId), sources: store.sourcesFor(turn.episodeId, ownerId),
      canonicalClaims: store.canonicalClaimsFor(turn.episodeId, ownerId), reviewedClaims: store.reviewedClaimsFor(turn.episodeId, ownerId),
      claimCoverage: store.claimCoverageFor(turn.episodeId, ownerId), coverageTarget: store.episode(turn.episodeId, ownerId)?.execution?.coverageTarget } : {}),
    };
  };
  const replay = (res: ServerResponse, turn: DurableTurn, ownerId: string) => {
    const episode = turn.episodeId !== null ? store.episode(turn.episodeId, ownerId) : null;
    if (!episode) return sendJson(res, 200, turnResult(turn, ownerId));
    const sources = store.sourcesFor(episode.id, ownerId);
    const channel = new SseChannel(res, () => {});
    channel.send({ type: "turn", turnId: turn.id, provisional: false });
    channel.send({ type: "sources", sources }); channel.send({ type: "text", delta: episode.answer });
    channel.send({ type: "done", turnId: turn.id, episodeId: episode.id, quality: episode.quality ?? "explicitly_unverified", cited: sources.map(source => source.n),
      timings: { recallMs: 0, firstTokenMs: 0, totalMs: 0, searches: 0, modelCalls: 0 },
      reviewedClaims: store.reviewedClaimsFor(episode.id, ownerId), claimCoverage: store.claimCoverageFor(episode.id, ownerId),
      coverageTarget: episode.execution?.coverageTarget,
      ...(episode.execution?.reviewFailure ? { reviewFailure: episode.execution.reviewFailure } : {}), recovered: true }); channel.end();
  };
  const resumeBody = (body: Record<string, unknown>, original: ResearchRequest) => {
    const savedBody = { sessionId: original.sessionId, message: original.message, tz: original.tz, mode: original.mode,
      asOf: original.asOf === null ? null : new Date(original.asOf).toISOString(), responseMode: original.responseMode,
      retryUnfinished: original.retryUnfinished ?? false,
      ...(original.recheckEpisodeId !== undefined ? { recheckEpisodeId: original.recheckEpisodeId } : {}),
      ...(original.memoryReferenceEpisodeId !== undefined ? { memoryReferenceEpisodeId: original.memoryReferenceEpisodeId } : {}) };
    for (const [name, value] of Object.entries(savedBody)) {
      if (body[name] !== undefined && body[name] !== value) throw new RequestError("Resume the original request, or start fresh research for changed input.", 409, "checkpoint_request_changed");
    }
    if (body.clarification !== undefined || body.recheckEpisodeId !== undefined && original.recheckEpisodeId === undefined
      || body.memoryReferenceEpisodeId !== undefined && original.memoryReferenceEpisodeId === undefined) throw new RequestError("Research checkpoint request changed.", 409, "checkpoint_request_changed");
    return { ...body, ...savedBody };
  };
  async function handleChat(req: IncomingMessage, res: ServerResponse, ownerId: string): Promise<void> {
    if (draining) return sendJson(res, 503, { error: "Service is shutting down.", code: "draining" });
    let body = await readJson(req);
    let resumedResearch: ResearchCheckpoint | undefined;
    const resumeTurnId = body.resumeTurnId;
    if (resumeTurnId !== undefined) {
      if (typeof resumeTurnId !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(resumeTurnId)) throw new RequestError("Invalid research checkpoint.", 400, "invalid_checkpoint");
      const requestKey = req.headers["idempotency-key"] ?? body.idempotencyKey;
      const priorResume = typeof requestKey === "string" ? checkpoints.resumption(requestKey, ownerId) : null;
      if (priorResume) {
        if (priorResume.fromTurnId !== resumeTurnId) throw new RequestError("This request key belongs to another resumed turn.", 409, "idempotency_conflict");
        resumeBody(body, priorResume.request);
        const existing = store.getTurn(priorResume.turnId, ownerId);
        if (!existing) throw new RequestError("Resumed turn not found.", 404, "checkpoint_not_found");
        res.setHeader("x-turn-id", existing.id);
        if (existing.status === "completed") return replay(res, existing, ownerId);
        return sendJson(res, existing.status === "running" ? 202 : 409, { ...turnResult(existing, ownerId),
          code: existing.status === "running" ? "turn_in_progress" : "turn_terminal" });
      }
      const priorTurn = store.getTurn(resumeTurnId, ownerId);
      if (!priorTurn || body.sessionId !== undefined && body.sessionId !== priorTurn.sessionId) throw new RequestError("Research checkpoint not found.", 404, "checkpoint_not_found");
      if (!["failed", "interrupted"].includes(priorTurn.status)) throw new RequestError("This turn cannot resume research.", 409, "checkpoint_not_resumable");
      resumedResearch = usableCheckpoint(priorTurn, ownerId) ?? undefined;
      if (!resumedResearch) throw new RequestError("This research checkpoint expired or its context changed. Ask again for fresh research.", 409, "checkpoint_invalidated");
      body = resumeBody(body, resumedResearch.request);
    }
    let message = typeof body.message === "string" ? body.message.trim() : "";
    if ((!body.clarification && (!message || message.length > 8000)) || !validSession(body.sessionId)) throw new RequestError("Expected a session ID and a message of 1 to 8000 characters.", 400);
    const sessionId = body.sessionId;
    if (body.responseMode !== undefined && body.responseMode !== "standard" && body.responseMode !== "fast") throw new RequestError("responseMode must be standard or fast.", 400);
    const recheckEpisodeId = body.recheckEpisodeId;
    const memoryReferenceEpisodeId = body.memoryReferenceEpisodeId;
    if (recheckEpisodeId !== undefined && memoryReferenceEpisodeId !== undefined) throw new RequestError("Select one saved answer reference.", 400);
    if (memoryReferenceEpisodeId !== undefined && (!Number.isSafeInteger(memoryReferenceEpisodeId) || Number(memoryReferenceEpisodeId) < 1 || body.clarification !== undefined)) throw new RequestError("Invalid historical answer reference.", 400);
    const memoryTarget = memoryReferenceEpisodeId === undefined ? null : store.episode(Number(memoryReferenceEpisodeId), ownerId);
    if (memoryReferenceEpisodeId !== undefined && !memoryTarget) throw new RequestError("Historical answer not found.", 404);
    if (body.retryUnfinished !== undefined && typeof body.retryUnfinished !== "boolean") throw new RequestError("retryUnfinished must be a boolean.", 400);
    if (body.retryUnfinished === true && recheckEpisodeId === undefined && memoryReferenceEpisodeId === undefined) throw new RequestError("Retrying unfinished claims requires a saved answer.", 400, "invalid_retry_target");
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
    let clarification: ClarificationAnswer | undefined = resumedResearch?.request.clarification;
    let release: (() => void) | undefined;
    let turn: DurableTurn | undefined;
    let channel: SseChannel | undefined;
    const deadlineAt = Date.now() + config.limits.turnTimeoutMs;
    const abort = new AbortController(); controllers.add(abort);
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(config.limits.turnTimeoutMs)]);
    const abortOutcome = () => abort.signal.aborted ? abort.signal.reason instanceof TurnAbort && abort.signal.reason.kind === "explicit" ? "cancelled" : "interrupted" : "deadline";
    const onClose = () => { if (!res.writableEnded) abort.abort(new TurnAbort("disconnect")); };
    res.on("close", onClose); req.on("aborted", () => abort.abort(new TurnAbort("disconnect")));
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
      if (memoryTarget && memoryTarget.askedAt > (effectiveViewpoint ?? Date.now())) throw new RequestError("Choose a topic from on or before the selected date.", 400, "future_memory_reference");
      const effectiveMode = effectiveViewpoint === null ? "live" : "era";
      const responseMode = resumed?.card.responseMode ?? (body.responseMode === "fast" ? "fast" : "standard");
      if (responseMode === "fast" && !deps?.fastLlm) throw new RequestError("Fast mode is not configured. Choose Standard mode.", 400, "fast_mode_unavailable");
      const tz = resumed?.card.time.tz ?? validTimeZone(typeof body.tz === "string" ? body.tz : undefined);
      const key = req.headers["idempotency-key"] ?? body.idempotencyKey ?? randomUUID();
      if (typeof key !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(key)) throw new RequestError("Invalid idempotency key.", 400);
      const requestIdentity = { sessionId, message, tz, mode: effectiveMode, asOf: effectiveViewpoint, clarification: clarification ?? null,
        ...(responseMode === "fast" ? { responseMode } : {}),
        ...(body.retryUnfinished === true ? { retryUnfinished: true } : {}),
        ...(recheckEpisodeId !== undefined ? { recheckEpisodeId } : {}),
        ...(memoryReferenceEpisodeId !== undefined ? { memoryReferenceEpisodeId } : {}) };
      const researchRequestHash = digest(requestIdentity);
      if (resumedResearch && resumedResearch.requestHash !== researchRequestHash) throw new RequestError("Research checkpoint request changed.", 409, "checkpoint_request_changed");
      const requestHash = resumeTurnId === undefined ? researchRequestHash : digest({ ...requestIdentity, resumeTurnId });
      const begun = store.beginTurn({ ownerId, sessionId, idempotencyKey: key, requestHash, viewpointAt: effectiveViewpoint, mode: effectiveMode });
      turn = begun.turn;
      if (begun.created) requestControllers.set(turn.id, abort);
      res.setHeader("x-turn-id", turn.id);
      if (!begun.created) {
        if (turn.status === "completed") return replay(res, turn, ownerId);
        if (turn.status === "waiting_input" && turn.clarificationId) {
          const card = questions.pendingById(turn.clarificationId, ownerId);
          if (card) {
            const replayChannel = new SseChannel(res, () => {});
            replayChannel.send({ type: "turn", turnId: turn.id, provisional: false });
            replayChannel.send({ type: "clarification", card }); replayChannel.end(); return;
          }
        }
        res.setHeader("retry-after", "1");
        return sendJson(res, turn.status === "running" ? 202 : 409, { ...turnResult(turn, ownerId), code: turn.status === "running" ? "turn_in_progress" : "turn_terminal", error: turn.status === "running" ? "This answer is already running." : "This attempt ended. Submit a new key to try again." });
      }
      if (resumedResearch) checkpoints.recordResumption({ ownerId, idempotencyKey: key, turnId: turn.id, fromTurnId: resumedResearch.turnId, request: resumedResearch.request });
      const trace = newTrace(turn.id, (responseMode === "fast" ? config.llm?.fastModel : config.llm?.model) ?? null, effectiveMode);
      const persistTrace = (updated: TurnTrace) => {
        try { const priorTrace = store.traceFor(turn!.id, ownerId); store.saveTrace(turn!.id, ownerId,
          { ...updated, clientFirstRenderMs: priorTrace?.clientFirstRenderMs ?? updated.clientFirstRenderMs }); }
        catch { count("trace_write_failed"); }
      };
      persistTrace(trace);
      await withTrace(trace, async () => {
        recordStage("response_mode", 0, { mode: responseMode });
        let outcome = "failed";
        let activeBudget: ModelBudget | undefined;
        try {
          const admissionStarted = performance.now();
          release = await turns.acquire({ ownerId, signal, deadlineAt: Date.now() + Math.min(15_000, config.limits.turnTimeoutMs - 500) });
          recordStage("turn_admission", performance.now() - admissionStarted, { active: turns.stats.active, queued: turns.stats.queued });
          if (!deps) throw new RequestError(`Missing configuration: ${missing.join(", ")}.`, 503, "not_configured");
          channel = new SseChannel(res, () => abort.abort(new TurnAbort("disconnect")));
          channel.send({ type: "turn", turnId: turn!.id, provisional: true });
          const questionPort = { create: (input: Parameters<QuestionStore["create"]>[0]) => questions.create({ ...input, ownerId }) };
          const policy = turnPolicy(message, effectiveMode === "era");
          const checkpointRequest: ResearchRequest = { sessionId, message, tz, mode: effectiveMode, asOf: effectiveViewpoint, responseMode,
            ...(clarification ? { clarification } : {}), ...(body.retryUnfinished === true ? { retryUnfinished: true } : {}),
            ...(recheckEpisodeId !== undefined ? { recheckEpisodeId: Number(recheckEpisodeId) } : {}),
            ...(memoryReferenceEpisodeId !== undefined ? { memoryReferenceEpisodeId: Number(memoryReferenceEpisodeId) } : {}) };
          const checkpointCreatedAt = resumedResearch?.createdAt ?? Date.now();
          const checkpointEffectiveAt = resumedResearch?.effectiveAt ?? new Date(effectiveViewpoint ?? Date.now()).toISOString();
          const checkpointContextHash = checkpointContext(checkpointRequest, ownerId);
          const requestBudget = budget(resumedResearch?.usage);
          activeBudget = requestBudget;
          if (resumedResearch) {
            checkpoints.save({ ...resumedResearch, turnId: turn!.id, contextHash: checkpointContextHash });
            // The continuation owns this evidence now. A failed continuation resumes from its own
            // charged usage, so retrying the older turn cannot reset the per-request allowance.
            checkpoints.remove(resumedResearch.turnId, ownerId);
          }
          const requestDeps: Deps = { ...deps, store, clock: { now: () => new Date(checkpointEffectiveAt), simulated: effectiveMode === "era" },
            ...(responseMode === "fast" ? { llm: deps.fastLlm!, repairLlm: deps.llm } : {}),
            checkpoints: { save(progress) {
              if (signal.aborted || store.getTurn(turn!.id, ownerId)?.status !== "running") throw new Error("Research checkpoint turn is no longer active.");
              const usage = requestBudget.snapshot;
              checkpoints.save({ version: 1, ownerId, turnId: turn!.id, sessionId, requestHash: researchRequestHash,
                contextHash: checkpointContextHash, policyHash, effectiveAt: checkpointEffectiveAt, createdAt: checkpointCreatedAt,
                expiresAt: resumedResearch?.expiresAt ?? checkpointCreatedAt + RESEARCH_CHECKPOINT_TTL_MS, request: checkpointRequest, progress,
                usage: { calls: (resumedResearch?.usage.calls ?? 0) + usage.calls, tokens: (resumedResearch?.usage.tokens ?? 0) + usage.tokens,
                  spendUsd: usage.spendUsd === null ? null : (resumedResearch?.usage.spendUsd ?? 0) + usage.spendUsd } });
            } },
            questions: questionPort, search: withProfile(deps.search, retrievalProfile(message, { simulated: effectiveMode === "era", verify: policy.requireVerificationEvidence }), config.retrievalProfiles) };
          await runWithModelContext({ ownerId, turnId: turn!.id, budget: requestBudget, deadlineAt, deadlineReserveMs: Math.min(12_000, Math.floor(config.limits.turnTimeoutMs / 3)),
            beforeProvider() {
              const saved = checkpoints.get(turn!.id, ownerId);
              if (!saved) return;
              const usage = requestBudget.snapshot;
              checkpoints.save({ ...saved, progress: { ...saved.progress, modelCalls: Math.max(saved.progress.modelCalls, (resumedResearch?.usage.calls ?? 0) + usage.calls) },
                usage: { calls: (resumedResearch?.usage.calls ?? 0) + usage.calls, tokens: (resumedResearch?.usage.tokens ?? 0) + usage.tokens,
                  spendUsd: usage.spendUsd === null ? null : (resumedResearch?.usage.spendUsd ?? 0) + usage.spendUsd } });
            } },
            () => runTurn(requestDeps, { ownerId, turnId: turn!.id, sessionId, message, tz, responseMode, asOf: effectiveViewpoint === null ? undefined : new Date(effectiveViewpoint), clarification,
              ...(recheckEpisodeId !== undefined ? { recheckEpisodeId: Number(recheckEpisodeId) } : {}),
            ...(memoryReferenceEpisodeId !== undefined ? { memoryReferenceEpisodeId: Number(memoryReferenceEpisodeId) } : {}),
              ...(body.retryUnfinished === true ? { retryUnfinished: true } : {}),
              ...(resumedResearch ? { resumeCheckpoint: resumedResearch.progress } : {}), deadlineAt, signal }, event => {
              if (event.type === "text") serverEmission();
              if (event.type === "done") { outcome = "completed"; trace.quality = event.quality; count(`quality_${event.quality}`); checkpoints.remove(turn!.id, ownerId); if (resumedResearch) checkpoints.remove(resumedResearch.turnId, ownerId); if (resumed) questions.finish(resumed.card.id, event.episodeId); }
              if (event.type === "clarification") { outcome = "waiting_input"; store.waitForInput(turn!.id, event.card.id, ownerId); }
              if (event.type === "error") outcome = event.code ?? "generation_failed";
              channel!.send(event);
            }));
          if (store.getTurn(turn!.id, ownerId)?.status === "completed") outcome = "completed";
          else if (store.getTurn(turn!.id, ownerId)?.status === "waiting_input") outcome = "waiting_input";
          else {
            outcome = signal.aborted ? abortOutcome() : outcome;
            store.failTurn(turn!.id, outcome, ownerId);
          }
        } catch (error) {
          outcome = signal.aborted ? abortOutcome() : error instanceof AdmissionError ? `admission_${error.code}` : "infrastructure_error";
          store.failTurn(turn!.id, outcome, ownerId);
          if (!res.headersSent) { res.setHeader("retry-after", "2"); sendJson(res, 503, { error: error instanceof RequestError ? error.message : "Service is busy. Try again shortly.", code: outcome, turnId: turn!.id }); }
          else channel?.send({ type: "error", message: "The answer could not be completed. Check its saved status before retrying." });
        } finally {
          const saved = checkpoints.get(turn!.id, ownerId);
          if (saved && activeBudget && outcome !== "completed") {
            const usage = activeBudget.snapshot;
            try { checkpoints.save({ ...saved, progress: { ...saved.progress, modelCalls: Math.max(saved.progress.modelCalls, (resumedResearch?.usage.calls ?? 0) + usage.calls) }, usage: { calls: (resumedResearch?.usage.calls ?? 0) + usage.calls,
              tokens: (resumedResearch?.usage.tokens ?? 0) + usage.tokens,
              spendUsd: usage.spendUsd === null ? null : (resumedResearch?.usage.spendUsd ?? 0) + usage.spendUsd } }); }
            catch { count("checkpoint_write_failed"); }
          }
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
    if (req.method === "GET" && path === "/api/metrics" && config.access.mode === "local") return sendJson(res, 200, { counters, turns: turns.stats, models: models.stats, quota: quota.stats, jobs: store.memoryJobCounts(), sqlite: store.metrics, eventLoop: { p95Ms: eventLoop.percentile(95) / 1e6, maxMs: eventLoop.max / 1e6 }, latency: summarizeTraces(store.recentTraces()) });
    const pendingMatch = /^\/api\/sessions\/([a-zA-Z0-9_-]{1,64})\/clarification$/.exec(path);
    if (req.method === "GET" && pendingMatch) return sendJson(res, 200, { card: questions.pending(pendingMatch[1]!, ownerId) });
    const sessionMatch = /^\/api\/sessions\/([a-zA-Z0-9_-]{1,64})$/.exec(path);
    if (req.method === "GET" && sessionMatch) {
      const episodes = store.sessionHistory(sessionMatch[1]!, 100, Number.MAX_SAFE_INTEGER, ownerId).map(episode => ({ episode, sources: store.sourcesFor(episode.id, ownerId),
        canonicalClaims: store.canonicalClaimsFor(episode.id, ownerId), reviewedClaims: store.reviewedClaimsFor(episode.id, ownerId),
        claimCoverage: store.claimCoverageFor(episode.id, ownerId), coverageTarget: episode.execution?.coverageTarget }));
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
      checkpoints.remove(turn.id, ownerId);
      requestControllers.get(turn.id)?.abort(new TurnAbort("explicit")); return sendJson(res, 200, { ok: true });
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
      return sendJson(res, 200, { episode, claims: store.claimsFor(id, ownerId), sources: store.sourcesFor(id, ownerId), verifiedStatements: store.verifiedStatementsFor(id, ownerId),
        canonicalClaims: store.canonicalClaimsFor(id, ownerId), reviewedClaims: store.reviewedClaimsFor(id, ownerId),
        claimCoverage: store.claimCoverageFor(id, ownerId), coverageTarget: episode.execution?.coverageTarget });
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
    for (const controller of controllers) controller.abort(new TurnAbort("shutdown"));
    models.close(); server.closeAllConnections();
    await Promise.race([Promise.allSettled([...activeRequests]), new Promise<void>(done => { timer = setTimeout(done, 1000); })]); clearTimeout(timer);
    if (worker) await worker.stop();
    await closed; eventLoop.disable(); checkpoints.close(); store.checkpoint(); questions.close(); store.close();
  })();
  return { server, store, questions, checkpoints, shutdown, state, counters, turns, models, missing };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig(); const app = createApplication({ config });
  app.server.listen(config.port, config.host, () => {
    console.log(`asof is running at http://localhost:${config.port}`);
    if (app.missing.length) console.log(`Not configured yet: ${app.missing.join(", ")} (see .env.example)`);
  });
  for (const name of ["SIGINT", "SIGTERM"] as const) process.once(name, () => { void app.shutdown().catch(() => { process.exitCode = 1; }); });
}
