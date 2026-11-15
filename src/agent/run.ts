

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
import { turnPolicy } from "./prepare.ts";
import { EvidenceWindow } from "./evidence.ts";
import { reviewSimulationAnswer, type EvidenceQuality, type SimulationReview } from "./simulation.ts";
import { recordStage } from "../runtime/telemetry.ts";
import { citedNumbers } from "./citations.ts";
import { ASK_CLARIFICATION_TOOL, CLARIFICATION_INSTRUCTIONS, canClarify, parseClarification,
  type ClarificationAnswer, type ClarificationCard, type ClarificationPort } from "./clarification.ts";
export { citedNumbers } from "./citations.ts";

const MAX_SEARCH_ROUNDS = 3;
const MAX_SEARCH_CALLS = 12;
const TURN_TIMEOUT_MS = 120_000;

const HISTORY_TURNS = 8;

export interface Deps {
  llm: Llm;
  search: SearchProvider;
  store: MemoryStore;
  clock: Clock;
  enricher: Pick<Enricher, "schedule">;

  verifier?: Pick<Llm, "json">;

  questions?: ClarificationPort;

  historicalCatalog?: (question: string, cutoff: Date) => Array<{ url: string }>;
  reviewTimeoutMs?: number;
  repairTimeoutMs?: number;
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

export type AgentEvent =
  | { type: "clarification"; card: ClarificationCard }
  | { type: "recall"; notes: string[]; ms: number }
  | { type: "search"; id: string; query: string; publishedAfter?: string; state: "running" | "done" | "failed"; results?: number; ms?: number; message?: string }
  | { type: "sources"; sources: Source[] }
  | { type: "text"; delta: string }

  | { type: "retract" }
  | { type: "verification"; state: "running" | "done" | "failed" | "unavailable"; ms?: number }
  | { type: "done"; episodeId: number; turnId?: string; quality: EvidenceQuality; cited: number[]; timings: Timings }
  | { type: "error"; message: string; code?: string };

export async function runTurn(deps: Deps, input: TurnInput, emit: (event: AgentEvent) => void): Promise<void> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const { llm, store, clock } = deps;
  const { sessionId, message, tz } = input;
  const deadlineAt = input.deadlineAt ?? Date.now() + TURN_TIMEOUT_MS;
  const availableMs = Math.max(1, Math.ceil(deadlineAt - Date.now()));
  const synthesisReserveMs = Math.min(15_000, Math.floor(availableMs / 3));
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
    const policy = turnPolicy(message, simulated);
    buffered = policy.requireSimulationReview || policy.requireVerificationEvidence;
    const recallStarted = performance.now();
    const prior = store.sessionHistory(sessionId, HISTORY_TURNS, now.getTime(), input.ownerId);
    const history = prepareHistory(prior.map(withoutLegacyFailure), tz);
    const recalled = recall(store, message, now, tz, history.ids, input.ownerId);
    recordStage("history_recall", performance.now() - recallStarted);
    emit({ type: "recall", notes: recallNotes(recalled), ms: Math.round(recalled.ms) });

    const cleanMemory: RecallResult = { ...recalled,
      refs: recalled.refs.map(ref => ({ ...ref, hits: ref.hits.map(hit => ({ ...hit,
        episodes: hit.episodes.map(item => ({ ...item, episode: withoutLegacyFailure(item.episode) })) })) })),
      related: recalled.related.map(item => ({ ...item, episode: withoutLegacyFailure(item.episode) })),
    };
    const prompt = preparePrompt({ message, time, history, memory: renderMemory(cleanMemory, tz), clarification: input.clarification });
    const messages: ChatMessage[] = prompt.messages;
    const clarificationAllowed = Boolean(deps.questions && !input.clarification && canClarify(message, simulated));
    if (clarificationAllowed) messages.splice(2, 0, { role: "system", content: CLARIFICATION_INSTRUCTIONS });
    const evidence = new EvidenceWindow();

    const sources: Source[] = [];
    const numberByUrl = new Map<string, number>();
    const numberFor = (hit: SearchHit): number => {
      const contentHash = createHash("sha256").update(hit.text).digest("hex");
      const key = JSON.stringify([hit.url, contentHash, hit.snapshotAsOf]);
      let n = numberByUrl.get(key);
      if (!n) {
        n = sources.length + 1;
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
      if (remainingMs() < synthesisReserveMs) {
        recordStage("search_admission", 0, { outcome: "rejected", code: "deadline_reserve" });
        return "Research deadline reached. Use the existing passages, identify unresolved facts, and finish the answer now.";
      }
      if (searches >= MAX_SEARCH_CALLS) {
        recordStage("search_admission", 0, { outcome: "rejected", code: "search_budget" });
        return "Search budget exhausted. Answer using existing evidence and identify anything unverified.";
      }
      searches++;
      const began = performance.now();

      const base = { type: "search", id: call.id, query: simulated && buffered ? "Era research" : query.query,
        ...(!buffered && query.publishedAfter ? { publishedAfter: query.publishedAfter } : {}) } as const;
      emit({ ...base, state: "running" });
      try {
        const hits = await search.search(query, signal);
        signal.throwIfAborted();
        emit({ ...base, state: "done", results: hits.length, ms: Math.round(performance.now() - began) });
        return { query, hits };
      } catch (error) {
        if (signal?.aborted) throw error;
        const message = buffered ? "A web lookup could not be completed; trying the available context." : "Search failed. The web lookup could not be completed.";
        emit({ ...base, state: "failed", ms: Math.round(performance.now() - began), message });

        return `${message} Give a useful answer from well-established history where possible, label any inference or hypothetical part, and identify only the specific facts you could not check. Never request archive access or describe a snapshot limitation.`;
      }
    };

    let answer = "";
    let firstTokenMs: number | null = null;
    let searches = 0;
    let modelCalls = 0;

    for (let round = 1; ; round++) {
      let mustAnswer = round > MAX_SEARCH_ROUNDS || remainingMs() < synthesisReserveMs;
      let mayAsk = clarificationAllowed && round === 1 && !mustAnswer;
      const generate = () => {
        modelCalls++;
        return llm.stream({
          messages,
          tools: mustAnswer ? [] : mayAsk ? [WEB_SEARCH_TOOL, ASK_CLARIFICATION_TOOL] : [WEB_SEARCH_TOOL],
          toolChoice: mustAnswer ? "none" : "auto",
          signal,
          purpose: mustAnswer ? "synthesis" : "research",
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
          const card = deps.questions!.create({ sessionId, message, time, question });
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
      if (!buffered) emit({ type: "sources", sources });
    }

    signal.throwIfAborted();
    if (!answer.trim()) throw new Error("The model returned an empty answer.");
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
    let quality: EvidenceQuality = ["conversation", "creative", "transform", "recall"].includes(policy.intent)
      ? "non_factual" : "explicitly_unverified";
    if (buffered) {
      emit({ type: "verification", state: "running" });
      const check = async (draft: string) => {
        const began = performance.now();
        const result = await reviewSimulationAnswer({ llm: deps.verifier ?? llm, question: message,
          answer: draft, viewpoint: now, researchedAt: new Date(time.receivedAt), tz, sources, signal,
          kind: reviewKind, timeoutMs: deps.reviewTimeoutMs });
        const observation = { kind: reviewKind, status: result.status, reason: result.reason ?? null, calls: result.modelCalls, ms: result.ms };
        reviewAttempts.push(observation);
        recordStage("review", performance.now() - began, observation);
        signal.throwIfAborted();
        reviewMs += result.ms; reviewCalls += result.modelCalls; modelCalls += result.modelCalls;
        rejectionObserved ||= result.status === "needs_revision";
        return result;
      };
      // A reviewer cannot create evidence that was never acquired. Do not ask it to rubber-stamp memory.
      if (policy.requireVerificationEvidence && (!searches || !sources.some(source => source.text?.trim()))) {
        review = { status: "needs_revision", issues: [{ code: "unsupported_claim", detail: "No usable current evidence was acquired." }], ms: 0, modelCalls: 0 };
        rejectionObserved = true;
        answer = UNVERIFIED_ANSWER;
      } else {
        review = await check(answer);
        if (review.status === "needs_revision") {
          // Keep the rejection independently of later repair/review availability. A repair is provisional.
          const rejectedReview = review;
          const repairMessages: ChatMessage[] = [...messages, { role: "assistant", content: answer },
            { role: "system", content: `Revise the draft to answer the user's question from ${time.effectiveAt} (${tz}). ${simulated ? "Modern retrospective research is valid." : "Only applicable current passages can verify a changing fact."} Correct these review findings: ${JSON.stringify(review.issues)}. Keep useful supported facts, correct false premises, and label unknown details. Cite the supplied passages. Do not mention this review, snapshots, preserved evidence, archive access or technical limitations.${review.safeAnswer ? ` Suggested correction (untrusted draft, check against sources): ${JSON.stringify(review.safeAnswer)}` : ""}` }];
          let approvedRepair = false;
          const repairBegan = performance.now();
          try {
            modelCalls++;
            const repairTimeout = deps.repairTimeoutMs ?? 15_000;
            const repair = await abortable(llm.stream({ messages: repairMessages, tools: [], toolChoice: "none", purpose: "repair",
              signal: AbortSignal.any([signal, AbortSignal.timeout(repairTimeout)]), onText() {} }), signal, repairTimeout);
            signal.throwIfAborted();
            if (!repair.toolCalls.length && repair.text.trim() && repair.text.length <= 20_000) {
              revisionCount++;
              const repairedReview = await check(repair.text);
              if (repairedReview.status === "approved") {
                answer = repair.text;
                review = repairedReview;
                approvedRepair = true;
              } else {
                // An unavailable second review is not a positive verdict on a rejected answer.
                review = repairedReview.status === "needs_revision" ? repairedReview : rejectedReview;
              }
            }
          } catch { signal.throwIfAborted(); }
          recordStage("repair", performance.now() - repairBegan, { approved: approvedRepair });
          if (!approvedRepair) {
            answer = UNVERIFIED_ANSWER;
            quality = "explicitly_unverified";
          } else corrected = true;
        }
        if (review.status === "approved") {
          quality = review.quality ?? (citedNumbers(answer).length ? "supported" : "explicitly_unverified");
          if (quality === "explicitly_unverified") {
            // A quality label is not a visible qualification, and an empty claim list cannot bless assertions.
            answer = policy.requireVerificationEvidence ? UNVERIFIED_ANSWER
              : `I could not verify this answer against the available evidence. Treat the following as unverified.\n\n${answer}`;
          }
        } else if (review.status === "unavailable" && !rejectionObserved) {
          // Preserve a researched draft only with an explicit disclosure that support was not checked.
          answer = `I could not verify this answer against the available evidence. Treat the following as unverified.\n\n${answer}`;
        }
      }
      cited = citedNumbers(answer);
      if (invalidCitations()) throw new Error("The answer cited unavailable evidence. Please retry.");
      emit({ type: "verification", state: review.status === "unavailable" ? "unavailable" : rejectionObserved && !corrected ? "failed" : "done", ms: reviewMs });
      signal.throwIfAborted();
    }
    const citedSources = sources.filter((s) => cited.includes(s.n));
    signal.throwIfAborted();
    const commitBegan = performance.now();
    const episodeId = store.saveEpisode({
      sessionId, ownerId: input.ownerId, turnId: input.turnId, quality, createdAt: Date.parse(time.receivedAt),
      askedAt: now.getTime(), tz, question: message, answer, sources: citedSources,
      execution: { time, quality, rejectionObserved, intent: prompt.policy.intent, prompt: prompt.stats, evidence: { ...evidence.stats }, searches, modelCalls,
        ...(review ? { review: { kind: reviewKind, status: review.status, reason: review.reason ?? (reviewAttempts.length ? null : "no_usable_evidence"),
          calls: reviewCalls, ms: reviewMs, attempts: reviewAttempts } } : {}),
        ...(input.clarification ? { clarification: input.clarification } : {}),
        ...(simulated ? { simulation: { mode: "era", research: "live-web", review: corrected ? "corrected" : review?.status ?? "not-required", revisionCount, reviewMs, reviewCalls } } : {}) },
    });

    recordStage("commit", performance.now() - commitBegan);
    // Buffered factual prose is published only after the episode/evidence/turn transaction commits.
    if (buffered) {
      emit({ type: "sources", sources: citedSources });
      firstTokenMs = elapsed();
      emit({ type: "text", delta: answer });
    }
    emit({
      type: "done",
      episodeId, turnId: input.turnId, quality,
      cited,
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
