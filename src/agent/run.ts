/**
 * One turn of the agent, start to finish:
 *
 *   recall (code, ms) → model ⇄ web_search (parallel) → stream answer → save → enrich (background)
 *
 * There is no router or planner call in front of the model. The work a router
 * would do is done by code that is exact and free (date resolution, memory
 * lookup), which leaves a single model deciding whether and what to search
 * with everything already in front of it. A message that needs no search costs
 * exactly one model call.
 */
import { createHash } from "node:crypto";
import { pinTurnTime, type Clock } from "../clock.ts";
import type { ChatMessage, Llm, ToolCall } from "../llm.ts";
import type { Enricher } from "../memory/enrich.ts";
import { type RecallResult, recall, renderMemory } from "../memory/recall.ts";
import type { MemoryStore, Source } from "../memory/store.ts";
import type { SearchHit, SearchProvider, SearchQuery } from "../search.ts";
import { withConcurrency } from "../search.ts";
import { preparePrompt } from "./prepare.ts";
import { EvidenceWindow } from "./evidence.ts";
import { formatInstant } from "../time/zone.ts";
import { SYSTEM_PROMPT, WEB_SEARCH_TOOL, buildContext } from "./prompt.ts";

/** Rounds in which the model may search. After these it must answer with what it has. */
const MAX_SEARCH_ROUNDS = 3;
/** Earlier turns of the current chat sent verbatim; anything older is reached through recall. */
const HISTORY_TURNS = 8;
const HISTORY_ANSWER_CHARS = 6000;

export interface Deps {
  llm: Llm;
  search: SearchProvider;
  store: MemoryStore;
  clock: Clock;
  enricher: Enricher;
}

export interface TurnInput {
  sessionId: string;
  message: string;
  tz: string;
  signal?: AbortSignal;
}

export interface Timings {
  recallMs: number;
  /** Until the first word of the final answer reached the client. */
  firstTokenMs: number | null;
  totalMs: number;
  searches: number;
  modelCalls: number;
}

export type AgentEvent =
  | { type: "recall"; notes: string[]; ms: number }
  | { type: "search"; id: string; query: string; publishedAfter?: string; state: "running" | "done" | "failed"; results?: number; ms?: number }
  | { type: "sources"; sources: Source[] }
  | { type: "text"; delta: string }
  /** Text streamed ahead of a tool call was a preamble, not the answer: discard it. */
  | { type: "retract" }
  | { type: "done"; episodeId: number; cited: number[]; timings: Timings }
  | { type: "error"; message: string };

export async function runTurn(deps: Deps, input: TurnInput, emit: (event: AgentEvent) => void): Promise<void> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const { llm, store, clock } = deps;
  const { sessionId, message, tz, signal } = input;

  const search = withConcurrency(deps.search, 4);
  try {
    const now = clock.now();
    const history = store.sessionHistory(sessionId, HISTORY_TURNS);
    const recalled = recall(store, message, now, tz, new Set(history.map((e) => e.id)));
    emit({ type: "recall", notes: recallNotes(recalled), ms: Math.round(recalled.ms) });

    const time = pinTurnTime(clock, tz);
    const prompt = preparePrompt({message, time, history, memory:renderMemory(recalled,tz)});
    const messages: ChatMessage[] = prompt.messages;
    const evidence = new EvidenceWindow();

    // Sources are numbered once per turn, so [3] means the same page in every search result and in the answer.
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
      const query = parseSearchCall(call, clock.simulated ? now : undefined);
      if (typeof query === "string") return query;
      const began = performance.now();
      const base = { type: "search", id: call.id, query: query.query, publishedAfter: query.publishedAfter } as const;
      emit({ ...base, state: "running" });
      try {
        const hits = await search.search(query, signal);
        emit({ ...base, state: "done", results: hits.length, ms: Math.round(performance.now() - began) });
        return { query, hits };
      } catch (error) {
        if (signal?.aborted) throw error;
        emit({ ...base, state: "failed", ms: Math.round(performance.now() - began) });
        // A failed search is information for the model, not a reason to fail the turn.
        return `Search failed (${errorMessage(error)}). Answer with what you have and say what you could not verify.`;
      }
    };

    let answer = "";
    let firstTokenMs: number | null = null;
    let searches = 0;
    let modelCalls = 0;

    for (let round = 1; ; round++) {
      const mustAnswer = round > MAX_SEARCH_ROUNDS;
      modelCalls++;
      const turn = await llm.stream({
        messages,
        tools: [WEB_SEARCH_TOOL],
        toolChoice: mustAnswer ? "none" : "auto",
        signal,
        onText: (delta) => {
          firstTokenMs ??= elapsed();
          emit({ type: "text", delta });
        },
      });

      if (!turn.toolCalls.length || mustAnswer) {
        answer = turn.text;
        break;
      }

      if (firstTokenMs !== null) {
        emit({ type: "retract" });
        firstTokenMs = null;
      }
      messages.push({ role: "assistant", content: turn.text || null, tool_calls: turn.toolCalls });

      // All of a round's searches run at once; the round takes as long as its slowest search.
      const results = await Promise.all(turn.toolCalls.map(runSearch));
      searches += results.filter((r) => typeof r !== "string").length;
      turn.toolCalls.forEach((call, i) => {
        const result = results[i]!;
        const content =
          typeof result === "string" ? evidence.error(result) : evidence.render(result.query, result.hits, numberFor);
        messages.push({ role: "tool", tool_call_id: call.id, content });
      });
      emit({ type: "sources", sources });
    }

    if (!answer.trim()) throw new Error("The model returned an empty answer.");

    const cited = citedNumbers(answer).filter((n) => n <= sources.length);
    const citedSources = sources.filter((s) => cited.includes(s.n));
    const episodeId = store.saveEpisode({ sessionId, askedAt: now.getTime(), tz, question: message, answer, sources: citedSources });

    emit({
      type: "done",
      episodeId,
      cited,
      timings: { recallMs: Math.round(recalled.ms), firstTokenMs, totalMs: elapsed(), searches, modelCalls },
    });

    const priorClaims = [...recalled.refs.flatMap((r) => r.hits.flatMap((h) => h.episodes)), ...recalled.related].flatMap(
      (e) => e.claims,
    );
    deps.enricher.schedule(episodeId, { question: message, answer, sources: citedSources, priorClaims });
  } catch (error) {
    if (signal?.aborted) return;
    emit({ type: "error", message: errorMessage(error) });
  }
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function parseSearchCall(call: ToolCall, asOf: Date | undefined): SearchQuery | string {
  if (call.function.name !== WEB_SEARCH_TOOL.function.name) return `Unknown tool "${call.function.name}".`;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return 'Invalid arguments: expected a JSON object with a "query" string.';
  }
  if (typeof args.query !== "string" || !args.query.trim()) return 'Missing "query".';
  const publishedAfter = typeof args.published_after === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.published_after);
  const domains = Array.isArray(args.domains) ? args.domains.filter((d): d is string => typeof d === "string" && d.length > 0) : [];
  return {
    query: args.query.trim(),
    publishedAfter: publishedAfter ? (args.published_after as string) : undefined,
    domains: domains.length ? domains : undefined,
    asOf,
  };
}

function formatHits(query: SearchQuery, hits: Array<{ n: number; hit: SearchHit }>): string {
  const filter = query.publishedAfter ? ` (published after ${query.publishedAfter})` : "";
  if (!hits.length) return `No results for "${query.query}"${filter}.`;
  const body = hits.map(({ n, hit }) => {
    const date = hit.publishedDate ? ` · published ${hit.publishedDate}` : "";
    return `[${n}] ${hit.title}\n${hit.url}${date}\n${hit.text}`;
  });
  return `Results for "${query.query}"${filter}:\n\n${body.join("\n\n")}`;
}

/** Source numbers an answer cites, from "[2]" and "[2, 5]" forms. */
export function citedNumbers(answer: string): number[] {
  const numbers = new Set<number>();
  for (const match of answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const n of match[1]!.split(",")) numbers.add(Number(n));
  }
  return [...numbers].sort((a, b) => a - b);
}

/** What the interface shows while the model is starting: which dates were understood and what was found. */
function recallNotes(result: RecallResult): string[] {
  const count = (n: number) => `${n} conversation${n === 1 ? "" : "s"}`;
  const notes = result.refs.map((ref) => {
    if (!ref.hits.length) return `"${ref.text}" → ${ref.empty.map((r) => r.label).join(" or ")}: nothing in memory`;
    return ref.hits.map((h) => `"${ref.text}" → ${h.range.label}: ${count(h.episodes.length)}`).join("; ");
  });
  if (result.related.length) notes.push(`${count(result.related.length)} matched by topic`);
  return notes;
}
