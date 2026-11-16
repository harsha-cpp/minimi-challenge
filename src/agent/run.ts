

import { createHash } from "node:crypto";
import { pinTurnTime, type Clock } from "../clock.ts";
import { ModelError, type ChatMessage, type Llm, type ToolCall } from "../llm.ts";
import { AdmissionError } from "../llm/gateway.ts";
import type { Enricher } from "../memory/enrich.ts";
import { type RecallResult, recall, renderMemory } from "../memory/recall.ts";
import type { Episode, MemoryStore, Source } from "../memory/store.ts";
import type { SearchHit, SearchProvider, SearchQuery } from "../search.ts";
import { normalizeQuery, withConcurrency } from "../search.ts";
import { WEB_SEARCH_TOOL } from "./prompt.ts";
import { prepareHistory, preparePrompt } from "./prepare.ts";
import { resolveRequestContext, type RequestContext } from "./context.ts";
import { turnPolicy } from "./prepare.ts";
import { EvidenceWindow } from "./evidence.ts";
import { reviewSimulationAnswer, type EvidenceQuality, type SimulationReview } from "./simulation.ts";
import { recordStage } from "../runtime/telemetry.ts";
import { citedNumbers } from "./citations.ts";
import { FAST_INSTRUCTIONS, FAST_LIMITS, FAST_WEB_SEARCH_TOOL, type ResponseMode } from "./response-mode.ts";
import { recheckSourceQuery, RECHECK_RESEARCH_INSTRUCTIONS, completionReserveMs, lookupAllowanceMs } from "./recheck.ts";
import { recoverReviewFailure, type ReviewRecovery } from "./review-recovery.ts";
import { REVIEWED_CLAIM_SCHEMA_VERSION, reviewCoverage, type ClaimCoverage, type ReviewedClaim } from "./claims.ts";
import type { ResearchProgress } from "../runtime/research-checkpoints.ts";
import { REVIEW_POLICY_VERSION } from "../runtime/versions.ts";
import { ASK_CLARIFICATION_TOOL, CLARIFICATION_INSTRUCTIONS, canClarify, parseClarification,
  type ClarificationAnswer, type ClarificationCard, type ClarificationPort } from "./clarification.ts";
export { citedNumbers } from "./citations.ts";

const MAX_SEARCH_ROUNDS = 3;
const MAX_SEARCH_CALLS = 12;
const TURN_TIMEOUT_MS = 120_000;

const HISTORY_TURNS = 8;

export interface Deps {
  llm: Llm;
  fastLlm?: Llm;
  search: SearchProvider;
  store: MemoryStore;
  clock: Clock;
  enricher: Pick<Enricher, "schedule">;

  verifier?: Pick<Llm, "json">;
  repairLlm?: Pick<Llm, "stream">;

  questions?: ClarificationPort;

  historicalCatalog?: (question: string, cutoff: Date) => Array<{ url: string }>;
  reviewTimeoutMs?: number;
  repairTimeoutMs?: number;
  searchTimeoutMs?: number;
  checkpoints?: { save(progress: ResearchProgress): void };
  /** Evaluation-only observation hook. Production traces retain counters rather than passage text. */
  onEvidence?: (sources: Source[]) => void;
}

export interface TurnInput {
  sessionId: string;
  ownerId?: string;
  turnId?: string;
  message: string;
  tz: string;
  signal?: AbortSignal;
  deadlineAt?: number;

  asOf?: Date;
  clarification?: ClarificationAnswer;
  recheckEpisodeId?: number;
  responseMode?: ResponseMode;
  retryUnfinished?: boolean;
  resumeCheckpoint?: ResearchProgress;
}

export interface Timings {
  recallMs: number;

  firstTokenMs: number | null;
  totalMs: number;
  searches: number;
  modelCalls: number;
  verificationMs?: number;
  verificationCalls?: number;
}

export type ReviewFailure = ReviewRecovery["failure"] & { retryEpisodeId?: number };

export type AgentEvent =
  | { type: "clarification"; card: ClarificationCard }
  | { type: "recall"; notes: string[]; ms: number }
  | { type: "search"; id: string; query: string; publishedAfter?: string; state: "running" | "done" | "failed"; results?: number; ms?: number; message?: string }
  | { type: "sources"; sources: Source[] }
  | { type: "text"; delta: string }

  | { type: "retract" }
  | { type: "verification"; state: "running" | "done" | "partial" | "failed" | "unavailable"; ms?: number }
  | { type: "claim_review"; claims: ReviewedClaim[]; coverage: ClaimCoverage[]; partial: boolean }
  | { type: "done"; episodeId: number; turnId?: string; quality: EvidenceQuality; cited: number[]; timings: Timings; reviewFailure?: ReviewFailure;
      reviewedClaims?: ReviewedClaim[]; claimCoverage?: ClaimCoverage[]; coverageTarget?: {originalClaims:number;requestedClaims:number;retryUnfinished:boolean} }
  | { type: "error"; message: string; code?: string };

export async function runTurn(deps: Deps, input: TurnInput, emit: (event: AgentEvent) => void): Promise<void> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const { llm, store, clock } = deps;
  const { sessionId, message, tz } = input;
  const responseMode = input.responseMode ?? "standard";
  const fast = responseMode === "fast";
  const resumed = input.resumeCheckpoint;
  const deadlineAt = input.deadlineAt ?? Date.now() + TURN_TIMEOUT_MS;
  const availableMs = Math.max(1, Math.ceil(deadlineAt - Date.now()));
  let synthesisReserveMs = completionReserveMs(availableMs, false);
  const remainingMs = () => deadlineAt - Date.now();
  const deadline = AbortSignal.timeout(Math.min(2_147_483_647, availableMs));
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const search = withConcurrency(deps.search, 4);
  let buffered = false;

  try {
    signal.throwIfAborted();
    const time = pinTurnTime(clock, tz, input.asOf);
    const now = new Date(time.effectiveAt);
    const simulated = time.simulated;
    let policy = turnPolicy(message, simulated);
    const recallStarted = performance.now();
    const durable = input.turnId ? store.getTurn(input.turnId, input.ownerId) : null;
    if (durable && durable.sessionId !== sessionId) throw new Error("Conversation context does not match this turn.");
    const prior = store.currentConversationHistory(sessionId, HISTORY_TURNS, input.ownerId, durable?.sequence);
    const target = input.recheckEpisodeId === undefined ? undefined : store.episode(input.recheckEpisodeId, input.ownerId);
    if (input.recheckEpisodeId !== undefined && (!target || target.sessionId !== sessionId
      || (durable && (target.sequence ?? target.id) >= durable.sequence))) throw new Error("The selected answer is unavailable in this conversation.");
    if (target && !prior.some(episode => episode.id === target.id)) prior.push(target);
    const requestContext = resolveRequestContext({ message, sessionId, ownerId: input.ownerId, history: prior, ...(target ? { targetEpisode: target } : {}) });
    const allReferenceClaims = requestContext.anchor ? store.canonicalClaimsFor(requestContext.anchor.episodeId,input.ownerId) : [];
    const retryUnfinished = Boolean(requestContext.anchor && (input.retryUnfinished || /\b(?:unfinished check|remaining claims|checking the rest)\b/i.test(message)));
    const unresolved = retryUnfinished ? new Set(store.latestClaimCoverageFor(requestContext.anchor!.episodeId,sessionId,input.ownerId,
      {viewpointAt:now.getTime(),simulated,tz,receivedAt:Date.parse(time.receivedAt)})
      .filter(claim => claim.status === "unresolved").map(claim => claim.claimId)) : new Set<string>();
    const referenceClaims = unresolved.size ? allReferenceClaims.filter(claim => unresolved.has(claim.id)) : allReferenceClaims;
    policy = turnPolicy(message, simulated, requestContext);
    recordStage("request_policy", 0, { intent: policy.intent });
    buffered = policy.requireSimulationReview || policy.requireVerificationEvidence;
    synthesisReserveMs = completionReserveMs(availableMs, buffered);
    const contextMetadata = requestContextMetadata(requestContext);
    // A reference comes from the thread's predecessor sequence, never a topic-ranked memory hit.
    const selected = requestContext.anchor ? prior.filter(episode => episode.id === requestContext.anchor!.episodeId).map(episode => ({
      ...episode, question: requestContext.anchor!.question, answer: requestContext.anchor!.answer,
    })) : prior;
    const history = prepareHistory(requestContext.anchor ? selected : selected.map(withoutLegacyFailure), tz,
      { answerChars: requestContext.anchor ? 12_000 : 3000 });
    const crossConversationMemory = requestContext.memoryScope === "explicit_memory"
      && !/\b(?:(?:this|current|same)\s+(?:chat|conversation|thread)|here)\b/i.test(message);
    recordStage("context_boundary", 0, { ...contextMetadata, historyTurns: history.ids.size, crossConversationMemory });
    if (requestContext.kind === "missing_reference") {
      const answer = "Which claims should I verify? Paste the claims or point me to an answer in this conversation.";
      const commitBegan = performance.now();
      const episodeId = store.saveEpisode({ sessionId, ownerId: input.ownerId, turnId: input.turnId,
        quality: "non_factual", createdAt: Date.parse(time.receivedAt), askedAt: now.getTime(), tz,
        question: message, answer, sources: [], execution: { time, responseMode, quality: "non_factual", intent: policy.intent,
          requestContext: contextMetadata, searches: 0, modelCalls: 0 } });
      recordStage("commit", performance.now() - commitBegan);
      emit({ type: "text", delta: answer });
      emit({ type: "done", episodeId, turnId: input.turnId, quality: "non_factual", cited: [],
        timings: { recallMs: 0, firstTokenMs: elapsed(), totalMs: elapsed(), searches: 0, modelCalls: 0 } });
      return;
    }
    const recalled = recall(store, message, now, tz, history.ids, input.ownerId, {
      sessionId, allowCrossSession: crossConversationMemory, disabled: requestContext.memoryScope === "none",
      allowRecent: requestContext.memoryScope === "explicit_memory",
    });
    recordStage("history_recall", performance.now() - recallStarted);
    emit({ type: "recall", notes: recallNotes(recalled), ms: Math.round(recalled.ms) });

    const matchingRecords = recalled.refs.length
      ? recalled.refs.flatMap(ref => ref.hits.flatMap(hit => hit.episodes.map(item => item.episode)))
      : [...prior, ...recalled.related.map(item => item.episode)];
    if (requestContext.memoryScope === "explicit_memory" && !matchingRecords.some(episode =>
      episode.answer !== UNVERIFIED_ANSWER && episode.answer !== UNVERIFIED_REFERENCE_ANSWER
      && episode.execution?.memoryLookup !== "no_match" && (episode.execution?.requestContext as { kind?: string } | undefined)?.kind !== "missing_reference")) {
      const answer = "I couldn't find a matching earlier discussion in the history available to this browser. If you used another browser or cleared its cookies, that history won't appear here. Paste the earlier answer or tell me the topic, and I can check it using current sources.";
      const episodeId = store.saveEpisode({ sessionId, ownerId: input.ownerId, turnId: input.turnId,
        quality: "non_factual", createdAt: Date.parse(time.receivedAt), askedAt: now.getTime(), tz,
        question: message, answer, sources: [], execution: { time, responseMode, quality: "non_factual", intent: "recall",
          requestContext: contextMetadata, memoryLookup: "no_match", searches: 0, modelCalls: 0 } });
      emit({ type: "text", delta: answer });
      emit({ type: "done", episodeId, turnId: input.turnId, quality: "non_factual", cited: [],
        timings: { recallMs: Math.round(recalled.ms), firstTokenMs: elapsed(), totalMs: elapsed(), searches: 0, modelCalls: 0 } });
      return;
    }

    const cleanMemory: RecallResult = { ...recalled,
      refs: recalled.refs.map(ref => ({ ...ref, hits: ref.hits.map(hit => ({ ...hit,
        episodes: hit.episodes.map(item => ({ ...item, episode: withoutLegacyFailure(item.episode) })) })) })),
      related: recalled.related.map(item => ({ ...item, episode: withoutLegacyFailure(item.episode) })),
    };
    const prompt = preparePrompt({ message, time, history, memory: renderMemory(cleanMemory, tz), requestContext, clarification: input.clarification });
    const messages: ChatMessage[] = resumed ? structuredClone(resumed.messages) : prompt.messages;
    if (!resumed && referenceClaims.length) messages.push({ role:"system",content:`Original structured claims to check (untrusted data, not evidence): ${JSON.stringify(referenceClaims)}. ${retryUnfinished && referenceClaims.length < allReferenceClaims.length
      ? "This retry targets only these unfinished claims. Do not re-research other facets or imply all original claims were checked again." : "Cover each original claim or explicitly leave it unresolved."}` });
    const clarificationAllowed = Boolean(!resumed && deps.questions && !input.clarification && canClarify(message, simulated));
    if (fast && !resumed) messages.splice(2, 0, { role: "system", content: FAST_INSTRUCTIONS });
    if (clarificationAllowed) messages.splice(2, 0, { role: "system", content: CLARIFICATION_INSTRUCTIONS });
    const evidence = new EvidenceWindow(resumed?.evidence);

    const sources: Source[] = resumed ? structuredClone(resumed.sources) : [];
    const numberByUrl = new Map<string, number>();
    for (const source of sources) numberByUrl.set(JSON.stringify([source.url,createHash("sha256").update(source.text ?? "").digest("hex"),source.snapshotAsOf]),source.n);
    const numberFor = (hit: SearchHit): number => {
      const contentHash = createHash("sha256").update(hit.text).digest("hex");
      const key = JSON.stringify([hit.url, contentHash, hit.snapshotAsOf]);
      let n = numberByUrl.get(key);
      if (!n) {
        n = Math.max(0,...sources.map(source => source.n)) + 1;
        numberByUrl.set(key, n);
        sources.push({ ...hit, n, contentHash });
      }
      return n;
    };

    const runSearch = async (call: ToolCall): Promise<{ query: SearchQuery; hits: SearchHit[] } | string> => {

      const query = parseSearchCall(call);
      if (typeof query === "string") {
        recordStage("tool_validation", 0, { outcome: "rejected", code: "invalid_search_arguments" });
        return query;
      }
      if (prompt.policy.fresh) query.freshness = "fresh";
      query.profile ??= policy.requireVerificationEvidence ? "verification" : simulated ? "historical" : undefined;
      const lookupMs = lookupAllowanceMs({ remainingMs: remainingMs(), reserveMs: synthesisReserveMs,
        fast, verification: buffered, configuredMs: deps.searchTimeoutMs });
      if (lookupMs < 1) {
        recordStage("search_admission", 0, { outcome: "rejected", code: "deadline_reserve" });
        return "Research deadline reached. Use the existing passages, identify unresolved facts, and finish the answer now.";
      }
      if (searches >= (fast ? FAST_LIMITS.searches : MAX_SEARCH_CALLS)) {
        recordStage("search_admission", 0, { outcome: "rejected", code: "search_budget" });
        return "Search budget exhausted. Answer using existing evidence and identify anything unverified.";
      }
      searches++;
      const began = performance.now();

      const base = { type: "search", id: call.id, query: simulated && buffered ? "Era research" : query.query,
        ...(!buffered && query.publishedAfter ? { publishedAfter: query.publishedAfter } : {}) } as const;
      emit({ ...base, state: "running" });
      try {
        const lookupSignal = AbortSignal.any([signal, AbortSignal.timeout(lookupMs)]);
        const hits = await abortable(search.search(query, lookupSignal), lookupSignal, lookupMs);
        signal.throwIfAborted();
        emit({ ...base, state: "done", results: hits.length, ms: Math.round(performance.now() - began) });
        return { query, hits };
      } catch (error) {
        if (signal?.aborted) throw error;
        recordStage("search_failure", performance.now() - began, { outcome: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "failed" });
        const message = buffered ? "A web lookup could not be completed; trying the available context." : "Search failed. The web lookup could not be completed.";
        emit({ ...base, state: "failed", ms: Math.round(performance.now() - began), message });

        return `${message} Give a useful answer from well-established history where possible, label any inference or hypothetical part, and identify only the specific facts you could not check. Never request archive access or describe a snapshot limitation.`;
      }
    };

    let answer = resumed?.draft ?? "";
    let firstTokenMs: number | null = null;
    let searches = resumed?.searches ?? 0;
    let modelCalls = resumed?.modelCalls ?? 0;
    let validationRetry = 0;
    let researchRounds = resumed?.researchRounds ?? 0;
    const checkpoint = (stage: ResearchProgress["stage"], draft?: string, review?: SimulationReview) => {
      signal.throwIfAborted();
      deps.checkpoints?.save({stage,messages:structuredClone(messages),sources:structuredClone(sources),searches,modelCalls,researchRounds,
        evidence:{...evidence.stats},...(draft ? {draft} : {}),...(review ? {review:structuredClone(review)} : {})});
      recordStage("research_checkpoint",0,{stage,resumed:Boolean(resumed)});
    };

    const targetSourceUrls = new Set(referenceClaims.flatMap(claim => claim.sourceRefs.map(source => source.url)));
    const originalSources = requestContext.anchor
      ? recheckSourceQuery(requestContext.anchor, store.sourcesFor(requestContext.anchor.episodeId, input.ownerId)
        .filter(source => !retryUnfinished || !unresolved.size || targetSourceUrls.has(source.url))) : undefined;
    if (originalSources && !resumed) {
      const call: ToolCall = { id: `recheck_sources_${requestContext.anchor!.episodeId}`, type: "function",
        function: { name: "web_search", arguments: JSON.stringify(originalSources) } };
      const began = performance.now();
      const result = await runSearch(call);
      const content = evidence.renderRound([result], numberFor)[0]!;
      messages.push({ role: "system", content: RECHECK_RESEARCH_INSTRUCTIONS },
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content });
      deps.onEvidence?.(structuredClone(sources));
      recordStage("recheck_source_reuse", performance.now() - began, { requestedUrls: originalSources.urls!.length,
        results: typeof result === "string" ? 0 : result.hits.length });
      checkpoint("researched");
    }

    for (let round = researchRounds + 1; !answer; round++) {
      let mustAnswer = round > (fast ? FAST_LIMITS.searchRounds + validationRetry : MAX_SEARCH_ROUNDS) || remainingMs() < synthesisReserveMs;
      let mayAsk = clarificationAllowed && round === 1 && !mustAnswer;
      const generate = () => {
        modelCalls++;
        return llm.stream({
          messages,
          tools: mustAnswer ? [] : mayAsk ? [fast ? FAST_WEB_SEARCH_TOOL : WEB_SEARCH_TOOL, ASK_CLARIFICATION_TOOL] : [fast ? FAST_WEB_SEARCH_TOOL : WEB_SEARCH_TOOL],
          toolChoice: mustAnswer ? "none" : "auto",
          signal,
          purpose: mustAnswer ? "synthesis" : "research",
          ...(fast ? { maxOutputTokens: FAST_LIMITS.outputTokens } : {}),
          onText: (delta) => {
            if (buffered || mayAsk) return;
            firstTokenMs ??= elapsed();
            emit({ type: "text", delta });
          },
        });
      };
      let turn: Awaited<ReturnType<Llm["stream"]>>;
      try { turn = await generate(); }
      catch (error) {
        if (mustAnswer || !(error instanceof AdmissionError) || !["budget", "deadline"].includes(error.code) || signal.aborted || remainingMs() <= 0) throw error;
        // Research cannot spend the reserved final call. Retry once, with tools disabled.
        // An actual exhausted account still fails this synthesis attempt with its own busy/error state.
        if (firstTokenMs !== null) { emit({ type: "retract" }); firstTokenMs = null; }
        mustAnswer = true; mayAsk = false;
        messages.push({ role: "system", content: "The remaining research allowance is reserved for completion. Finish now using the available passages. Clearly identify unresolved facts, avoid unsupported assertions, and do not call tools." });
        recordStage("synthesis_reserve", 0, { reason: error.code, outcome: "used" });
        turn = await generate();
      }

      if (!turn.toolCalls.length || mustAnswer) {
        answer = turn.text;
        if (mayAsk && !buffered && answer) { firstTokenMs ??= elapsed(); emit({ type: "text", delta: answer }); }
        break;
      }
      if (turn.toolCalls.length > 16) throw new Error("The model requested too many tools in one response.");

      const questions = turn.toolCalls.filter(call => call.function.name === ASK_CLARIFICATION_TOOL.function.name);
      if (mayAsk && questions.length === 1 && turn.toolCalls.length === 1) {
        const question = parseClarification(questions[0]!.function.arguments);
        if (question) {
          signal.throwIfAborted();
          const card = deps.questions!.create({ sessionId, message, time, question, responseMode });
          emit({ type: "clarification", card });
          return;
        }
      }

      if (firstTokenMs !== null) {
        emit({ type: "retract" });
        firstTokenMs = null;
      }
      messages.push({ role: "assistant", content: turn.text || null, tool_calls: turn.toolCalls,
        ...(turn.responseOutput ? { responseOutput: turn.responseOutput } : {}),
      });

      const results = await Promise.all(turn.toolCalls.map(call => call.function.name === ASK_CLARIFICATION_TOOL.function.name
        ? "No further clarification is available. Research and answer the original request using reasonable, explicitly stated assumptions."
        : runSearch(call)));
      const packStarted = performance.now();
      const contents = evidence.renderRound(results, numberFor);
      deps.onEvidence?.(structuredClone(sources));
      recordStage("evidence_packing", performance.now() - packStarted, { candidates: evidence.stats.rawCandidates,
        admitted: evidence.stats.admittedPassages, duplicates: evidence.stats.duplicatePassages });
      turn.toolCalls.forEach((call, i) => {
        const content = contents[i]!;
        messages.push({ role: "tool", tool_call_id: call.id, content });
      });
      if (fast && !validationRetry && results.every(result => typeof result === "string" && result.startsWith("Invalid arguments:"))) {
        validationRetry = 1;
        messages.push({ role: "system", content: "No web request ran because the tool arguments were invalid. Correct the arguments and use web_search now. Supply a nonempty query string and omit optional fields you do not need. You have one correction attempt; the original research limits still apply." });
        recordStage("tool_argument_retry", 0, { attempt: 1 });
      }
      if (!buffered) emit({ type: "sources", sources });
      researchRounds = round;
      checkpoint("researched");
    }

    signal.throwIfAborted();
    if (!answer.trim()) throw new Error("The model returned an empty answer.");
    if (!resumed?.review) checkpoint("drafted",answer);
    let cited = citedNumbers(answer);
    const invalidCitations = () => cited.some(n => n < 1 || n > sources.length);
    if (invalidCitations() && !buffered) {
      throw new Error("The answer cited unavailable evidence. Please retry.");
    }

    let review: SimulationReview | undefined;
    let reviewMs = 0, reviewCalls = 0, revisionCount = 0;
    const reviewKind = policy.requireVerificationEvidence ? "verification" : "simulation";
    const reviewAttempts: Array<{ kind: string; status: string; reason: string | null; calls: number; ms: number }> = [];
    let corrected = false;
    let rejectionObserved = false;
    let reviewFailure: ReviewFailure | undefined;
    let quality: EvidenceQuality = ["conversation", "creative", "transform", "recall"].includes(policy.intent)
      ? "non_factual" : "explicitly_unverified";
    const recover = (failedReview: SimulationReview) => {
      const recovery = recoverReviewFailure(failedReview, Boolean(requestContext.anchor));
      answer = recovery.answer;
      quality = recovery.quality;
      reviewFailure = { ...recovery.failure, ...(requestContext.anchor ? { retryEpisodeId: requestContext.anchor.episodeId } : {}) };
    };
    if (buffered) {
      emit({ type: "verification", state: "running" });
      const publishReviewed = (result: SimulationReview) => {
        if (deps.checkpoints && !result.reason && result.reviewedClaims?.length
          && (result.status === "needs_revision" && result.approvedFindings?.length
            || result.status === "approved" && ["supported","supported_partial"].includes(result.quality ?? ""))) {
          emit({type:"claim_review",claims:result.reviewedClaims,coverage:result.claimCoverage ?? [],
            partial:result.status !== "approved" || result.quality === "supported_partial"});
        }
      };
      const check = async (draft: string) => {
        const began = performance.now();
        const reviewAvailableMs = Math.max(1, Math.floor(remainingMs() - 500));
        const timeoutMs = Math.max(1, Math.min(deps.reviewTimeoutMs ?? (reviewKind === "verification" || requestContext.anchor ? 30_000 : 10_000),
          reviewAttempts.length ? reviewAvailableMs : Math.floor(reviewAvailableMs / 2)));
        const result = await reviewSimulationAnswer({ llm: deps.verifier ?? llm, question: message,
          answer: draft, viewpoint: now, researchedAt: new Date(time.receivedAt), tz, sources, signal,
          reference: requestContext.anchor, referenceClaims, kind: reviewKind, timeoutMs });
        const observation = { kind: reviewKind, status: result.status, reason: result.reason ?? null, calls: result.modelCalls, ms: result.ms };
        reviewAttempts.push(observation);
        recordStage("review", performance.now() - began, observation);
        signal.throwIfAborted();
        reviewMs += result.ms; reviewCalls += result.modelCalls; modelCalls += result.modelCalls;
        rejectionObserved ||= result.status === "needs_revision";
        checkpoint("reviewed",draft,result);
        publishReviewed(result);
        return result;
      };
      // A reviewer cannot create evidence that was never acquired. Do not ask it to rubber-stamp memory.
      if (policy.requireVerificationEvidence && (!searches || !sources.some(source => source.text?.trim()))) {
        review = { status: "needs_revision", issues: [{ code: "unsupported_claim", detail: "No usable current evidence was acquired." }], ms: 0, modelCalls: 0 };
        rejectionObserved = true;
        recover(review);
      } else {
        review = resumed?.review && resumed.review.status !== "unavailable" ? structuredClone(resumed.review) : await check(answer);
        if (resumed?.review && resumed.review.status !== "unavailable") {
          checkpoint("reviewed",answer,review); publishReviewed(review);
          recordStage("review_reuse",0,{scope:"same_request_checkpoint",status:review.status});
        }
        rejectionObserved ||= review.status === "needs_revision";
        if (review.status === "needs_revision") {
          // Keep the rejection independently of later repair/review availability. A repair is provisional.
          const rejectedReview = review;
          const repairMessages: ChatMessage[] = [...messages, { role: "assistant", content: answer },
            { role: "system", content: `Revise the draft to answer the user's question from ${time.effectiveAt} (${tz}). ${simulated ? "Modern retrospective research is valid." : "Only applicable current passages can verify a changing fact."} Correct these review findings: ${JSON.stringify(review.issues)}. Keep useful supported facts, correct false premises, and label unknown details. Cite the supplied passages. Do not mention this review, snapshots, preserved evidence, archive access or technical limitations.${review.safeAnswer ? ` Suggested correction (untrusted draft, check against sources): ${JSON.stringify(review.safeAnswer)}` : ""}` }];
          let approvedRepair = false;
          const repairBegan = performance.now();
          try {
            modelCalls++;
            const repairTimeout = Math.max(1, Math.min(deps.repairTimeoutMs ?? 15_000, Math.floor((remainingMs() - 500) / 2)));
            const repair = await abortable((deps.repairLlm ?? llm).stream({ messages: repairMessages, tools: [], toolChoice: "none", purpose: "repair",
              ...(fast ? { maxOutputTokens: FAST_LIMITS.outputTokens } : {}),
              signal: AbortSignal.any([signal, AbortSignal.timeout(repairTimeout)]), onText() {} }), signal, repairTimeout);
            signal.throwIfAborted();
            if (!repair.toolCalls.length && repair.text.trim() && repair.text.length <= 20_000) {
              revisionCount++;
              checkpoint("drafted",repair.text);
              const repairedReview = await check(repair.text);
              if (repairedReview.status === "approved") {
                answer = repair.text;
                review = repairedReview;
                approvedRepair = true;
              } else {
                // An unavailable second review is not a positive verdict on a rejected answer.
                review = rejectedReview.approvedFindings?.length ? rejectedReview
                  : repairedReview.status === "needs_revision" || repairedReview.status === "unavailable" ? repairedReview : rejectedReview;
              }
            }
          } catch { signal.throwIfAborted(); }
          recordStage("repair", performance.now() - repairBegan, { approved: approvedRepair });
          if (!approvedRepair) {
            recover(review);
          } else corrected = true;
        }
        if (review.status === "approved") {
          quality = review.quality ?? (citedNumbers(answer).length ? "supported" : "explicitly_unverified");
          if (quality === "explicitly_unverified" && (requestContext.anchor || policy.requireVerificationEvidence)) {
            // Explicit verification cannot bless unchecked assertions with an empty claim list.
            recover(review);
          }
        } else if (review.status === "unavailable" && !rejectionObserved
          && (requestContext.anchor || policy.requireVerificationEvidence)) {
          // Verification outages remain unresolved; unanchored era drafts keep their own wording and quality state.
          recover(review);
        }
      }
      if (referenceClaims.length < allReferenceClaims.length && quality === "supported") quality = "supported_partial";
      if (requestContext.anchor && quality === "supported_partial" && !reviewFailure) {
        answer = `This checks only part of my earlier answer; the remaining claims are unverified for the selected date.\n\n${answer}`;
      }
      cited = citedNumbers(answer);
      if (invalidCitations()) throw new Error("The answer cited unavailable evidence. Please retry.");
      emit({ type: "verification", state: quality === "supported_partial" ? "partial"
        : review.status === "unavailable" ? "unavailable" : rejectionObserved && !corrected ? "failed" : "done", ms: reviewMs });
      signal.throwIfAborted();
    }
    const citedSources = sources.filter((s) => cited.includes(s.n));
    const reviewedClaims = quality === "supported" || quality === "supported_partial"
      ? (review?.reviewedClaims ?? []).filter(claim => claim.sourceRefs.every(source => cited.includes(source.n))) : [];
    const claimCoverage = reviewCoverage(review?.claimCoverage,referenceClaims,reviewedClaims,cited);
    signal.throwIfAborted();
    const commitBegan = performance.now();
    const episodeId = store.saveEpisode({
      sessionId, ownerId: input.ownerId, turnId: input.turnId, quality, createdAt: Date.parse(time.receivedAt),
      askedAt: now.getTime(), tz, question: message, answer, sources: citedSources,
      ...(buffered ? { reviewedClaims } : {}),
      ...(claimCoverage.length ? { claimCoverage } : {}),
      ...(requestContext.anchor ? { coverageReference:{episodeId:requestContext.anchor.episodeId,answerHash:requestContext.anchor.answerHash} } : {}),
      execution: { time, responseMode, quality, rejectionObserved, requestContext: contextMetadata,
        intent: prompt.policy.intent, prompt: prompt.stats, evidence: { ...evidence.stats }, searches, modelCalls,
        ...(reviewFailure ? { reviewFailure } : {}),
        ...(buffered ? { reviewedClaimSchemaVersion:REVIEWED_CLAIM_SCHEMA_VERSION,reviewPolicyVersion:REVIEW_POLICY_VERSION } : {}),
        ...(referenceClaims.length ? { coverageTarget:{originalClaims:allReferenceClaims.length,requestedClaims:referenceClaims.length,retryUnfinished} } : {}),
        ...(review ? { review: { kind: reviewKind, status: review.status, reason: review.reason ?? (reviewAttempts.length || resumed?.review ? null : "no_usable_evidence"),
          calls: reviewCalls, ms: reviewMs, attempts: reviewAttempts, resumed:Boolean(resumed?.review) } } : {}),
        ...(input.clarification ? { clarification: input.clarification } : {}),
        ...(simulated ? { simulation: { mode: "era", research: "live-web", review: corrected ? "corrected" : review?.status ?? "not-required", revisionCount, reviewMs, reviewCalls } } : {}) },
    });

    recordStage("commit", performance.now() - commitBegan);
    // Buffered factual prose is published only after the episode/evidence/turn transaction commits.
    if (buffered) {
      emit({ type: "sources", sources: citedSources });
      firstTokenMs = elapsed();
      emit({ type: "text", delta: answer });
    } else if (resumed?.draft) {
      firstTokenMs = elapsed();
      emit({ type:"text",delta:answer });
    }
    emit({
      type: "done",
      episodeId, turnId: input.turnId, quality,
      cited,
      ...(reviewFailure ? { reviewFailure } : {}),
      ...(buffered ? { reviewedClaims } : {}),
      ...(claimCoverage.length ? { claimCoverage } : {}),
      ...(referenceClaims.length ? {coverageTarget:{originalClaims:allReferenceClaims.length,requestedClaims:referenceClaims.length,retryUnfinished}} : {}),
      timings: { recallMs: Math.round(recalled.ms), firstTokenMs, totalMs: elapsed(), searches, modelCalls,
        ...(review ? { verificationMs: reviewMs, verificationCalls: reviewCalls } : {}) },
    });

    const priorClaims = [...recalled.refs.flatMap((r) => r.hits.flatMap((h) => h.episodes)), ...recalled.related].flatMap(
      (e) => e.claims,
    );

    // Required work is already in the transactional outbox; scheduling is only a best-effort wakeup.
    if (!simulated) {
      try { deps.enricher.schedule(episodeId, { question: message, answer, sources: citedSources, priorClaims }, input.ownerId); }
      catch { recordStage("enrichment_wakeup", 0, { outcome: "deferred" }); }
    }
  } catch (error) {
    if (input.signal?.aborted) return;
    const code = deadline.aborted ? "turn_timeout" : error instanceof ModelError ? `model_${error.code}`
      : error instanceof AdmissionError ? `admission_${error.code}` : "turn_failed";
    emit({ type: "error", code, message: buffered || !(error instanceof ModelError || error instanceof AdmissionError)
      ? "The answer was interrupted. Please try again." : error.message });
  }
}

const UNVERIFIED_ANSWER = "I couldn't verify the requested facts from the available evidence. The check remains unresolved.";
const UNVERIFIED_REFERENCE_ANSWER = "I couldn't complete the check of my previous answer in this conversation. Those claims remain unverified for the selected date.";

function requestContextMetadata(context: RequestContext) {
  return { kind: context.kind, memoryScope: context.memoryScope, ...(context.anchor ? {
    anchorEpisodeId: context.anchor.episodeId, anchorAnswerHash: context.anchor.answerHash,
    anchorSequence: context.anchor.sequence, anchorViewpointAt: context.anchor.viewpointAt,
    anchorTruncated: context.anchor.truncated,
  } : {}) };
}

async function abortable<T>(operation: Promise<T>, parent: AbortSignal, timeoutMs: number): Promise<T> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function withoutLegacyFailure(episode: Episode): Episode {
  return /^I could not verify this as of /i.test(episode.answer) && /snapshot|preserved evidence|historical evidence|no cited/i.test(episode.answer)
    ? { ...episode, answer: "An earlier research attempt did not answer this question. Research it anew using live sources.", summary: null }
    : episode;
}

function parseSearchCall(call: ToolCall): SearchQuery | string {
  if (call.function.name !== WEB_SEARCH_TOOL.function.name) return `Unknown tool "${call.function.name}".`;
  let args: Record<string, unknown>;
  try {
    const raw: unknown = JSON.parse(call.function.arguments || "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
    args = raw as Record<string, unknown>;
  } catch {
    return 'Invalid arguments: expected a JSON object with a "query" string.';
  }
  for (const name of ["domains", "urls"]) {
    if (args[name] !== undefined && (!Array.isArray(args[name]) || args[name].some((v: unknown) => typeof v !== "string"))) {
      return `Invalid arguments: ${name} must be an array of strings.`;
    }
  }
  try {
    return normalizeQuery({
      query: args.query as string, publishedAfter: args.published_after as string | undefined,
      domains: args.domains as string[] | undefined, urls: args.urls as string[] | undefined,
      freshness: args.freshness as SearchQuery["freshness"], content: args.content as SearchQuery["content"],
      profile: args.profile as SearchQuery["profile"],
    });
  } catch (error) { return `Invalid arguments: ${errorMessage(error)}`; }
}

function recallNotes(result: RecallResult): string[] {
  const count = (n: number) => `${n} conversation${n === 1 ? "" : "s"}`;
  const notes = result.refs.map((ref) => {
    if (!ref.hits.length) return `"${ref.text}" → ${ref.empty.map((r) => r.label).join(" or ")}: nothing in memory`;
    return ref.hits.map((h) => `"${ref.text}" → ${h.range.label}: ${count(h.episodes.length)}`).join("; ");
  });
  if (result.related.length) notes.push(`${count(result.related.length)} matched by topic`);
  return notes;
}
