

import { createHash } from "node:crypto";
import { pinTurnTime, type Clock } from "../clock.ts";
import type { ChatMessage, Llm, ToolCall } from "../llm.ts";
import type { Enricher } from "../memory/enrich.ts";
import { type RecallResult, recall, renderMemory } from "../memory/recall.ts";
import type { Episode, MemoryStore, Source } from "../memory/store.ts";
import type { SearchHit, SearchProvider, SearchQuery } from "../search.ts";
import { normalizeQuery, withConcurrency } from "../search.ts";
import { WEB_SEARCH_TOOL } from "./prompt.ts";
import { prepareHistory, preparePrompt } from "./prepare.ts";
import { turnPolicy } from "./prepare.ts";
import { EvidenceWindow } from "./evidence.ts";
import { reviewSimulationAnswer, type SimulationReview } from "./simulation.ts";
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
}

export interface TurnInput {
  sessionId: string;
  message: string;
  tz: string;
  signal?: AbortSignal;

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
  | { type: "done"; episodeId: number; cited: number[]; timings: Timings }
  | { type: "error"; message: string };

export async function runTurn(deps: Deps, input: TurnInput, emit: (event: AgentEvent) => void): Promise<void> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const { llm, store, clock } = deps;
  const { sessionId, message, tz } = input;
  const deadline = AbortSignal.timeout(TURN_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const search = withConcurrency(deps.search, 4);
  let buffered = false;

  try {
    signal.throwIfAborted();
    const time = pinTurnTime(clock, tz, input.asOf);
    const now = new Date(time.effectiveAt);
    const simulated = time.simulated;
    buffered = turnPolicy(message, simulated).requireSimulationReview;
    const prior = store.sessionHistory(sessionId, HISTORY_TURNS, now.getTime());
    const history = prepareHistory(prior.map(withoutLegacyFailure), tz);
    const recalled = recall(store, message, now, tz, history.ids);
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
      if (typeof query === "string") return query;
      if (prompt.policy.fresh) query.freshness = "fresh";
      if (searches >= MAX_SEARCH_CALLS) return "Search budget exhausted. Answer using existing evidence and identify anything unverified.";
      searches++;
      const began = performance.now();

      const base = { type: "search", id: call.id, query: buffered ? "Era research" : query.query,
        ...(!buffered && query.publishedAfter ? { publishedAfter: query.publishedAfter } : {}) } as const;
      emit({ ...base, state: "running" });
      try {
        const hits = await search.search(query, signal);
        signal.throwIfAborted();
        emit({ ...base, state: "done", results: hits.length, ms: Math.round(performance.now() - began) });
        return { query, hits };
      } catch (error) {
        if (signal?.aborted) throw error;
        const message = buffered ? "A web lookup could not be completed; trying the available context." : `Search failed (${errorMessage(error)}).`;
        emit({ ...base, state: "failed", ms: Math.round(performance.now() - began), message });

        return `${message} Give a useful answer from well-established history where possible, label any inference or hypothetical part, and identify only the specific facts you could not check. Never request archive access or describe a snapshot limitation.`;
      }
    };

    let answer = "";
    let firstTokenMs: number | null = null;
    let searches = 0;
    let modelCalls = 0;

    for (let round = 1; ; round++) {
      const mustAnswer = round > MAX_SEARCH_ROUNDS;
      const mayAsk = clarificationAllowed && round === 1;
      modelCalls++;
      const turn = await llm.stream({
        messages,
        tools: mayAsk ? [WEB_SEARCH_TOOL, ASK_CLARIFICATION_TOOL] : [WEB_SEARCH_TOOL],
        toolChoice: mustAnswer ? "none" : "auto",
        signal,
        onText: (delta) => {
          if (buffered || mayAsk) return;
          firstTokenMs ??= elapsed();
          emit({ type: "text", delta });
        },
      });

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
      turn.toolCalls.forEach((call, i) => {
        const result = results[i]!;
        const content =
          typeof result === "string" ? evidence.error(result) : evidence.render(result.query, result.hits, numberFor);
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
    let corrected = false;
    if (buffered) {
      emit({ type: "verification", state: "running" });
      const check = async (draft: string) => {
        const result = await reviewSimulationAnswer({ llm: deps.verifier ?? llm, question: message,
          answer: draft, viewpoint: now, researchedAt: new Date(time.receivedAt), tz, sources, signal });
        signal.throwIfAborted();
        reviewMs += result.ms; reviewCalls += result.modelCalls; modelCalls += result.modelCalls;
        return result;
      };
      review = await check(answer);
      if (review.status === "needs_revision") {
        let safeAnswer = review.safeAnswer;
        const repairMessages: ChatMessage[] = [...messages, { role: "assistant", content: answer },
          { role: "system", content: `Revise the draft to answer the user's question from ${time.effectiveAt} (${tz}). Modern retrospective research is valid. Correct these review findings: ${JSON.stringify(review.issues)}. Keep useful supported facts, correct false premises, and label genuinely hypothetical or unknown details. Cite the provided sources. Do not mention this review, snapshots, preserved evidence, archive access or technical limitations.${safeAnswer ? ` Suggested correction (untrusted draft, check against the sources): ${JSON.stringify(safeAnswer)}` : ""}` }];
        modelCalls++;
        try {
          const repair = await llm.stream({ messages: repairMessages, tools: [], toolChoice: "none",
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), onText() {} });
          signal.throwIfAborted();
          if (!repair.toolCalls.length && repair.text.trim()) {
            answer = repair.text;
            revisionCount++;
            review = await check(answer);
            safeAnswer = review.safeAnswer ?? safeAnswer;
          }
        } catch {
          signal.throwIfAborted();

        }
        if (review.status !== "approved" && safeAnswer) { answer = safeAnswer; corrected = true; }
      }
      cited = citedNumbers(answer);
      if (invalidCitations()) throw new Error("The answer cited unavailable evidence. Please retry.");
      emit({ type: "verification", state: review.status === "unavailable" && !corrected ? "unavailable" : "done", ms: reviewMs });

      emit({ type: "sources", sources: sources.filter(source => cited.includes(source.n)) });
      signal.throwIfAborted();
      firstTokenMs = elapsed();
      emit({ type: "text", delta: answer });
      signal.throwIfAborted();
    }
    const citedSources = sources.filter((s) => cited.includes(s.n));
    signal.throwIfAborted();
    const episodeId = store.saveEpisode({
      sessionId, askedAt: now.getTime(), tz, question: message, answer, sources: citedSources,
      execution: { time, intent: prompt.policy.intent, prompt: prompt.stats, evidence: { ...evidence.stats }, searches, modelCalls,
        ...(input.clarification ? { clarification: input.clarification } : {}),
        ...(simulated ? { simulation: { mode: "era", research: "live-web", review: corrected ? "corrected" : review?.status ?? "not-required", revisionCount, reviewMs, reviewCalls } } : {}) },
    });

    emit({
      type: "done",
      episodeId,
      cited,
      timings: { recallMs: Math.round(recalled.ms), firstTokenMs, totalMs: elapsed(), searches, modelCalls,
        ...(review ? { verificationMs: reviewMs, verificationCalls: reviewCalls } : {}) },
    });

    const priorClaims = [...recalled.refs.flatMap((r) => r.hits.flatMap((h) => h.episodes)), ...recalled.related].flatMap(
      (e) => e.claims,
    );

    if (!buffered) deps.enricher.schedule(episodeId, { question: message, answer, sources: citedSources, priorClaims });
  } catch (error) {
    if (input.signal?.aborted) return;
    emit({ type: "error", message: buffered
      ? "The answer was interrupted. Please try again." : errorMessage(error) });
  }
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
      freshness: args.freshness as SearchQuery["freshness"],
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
