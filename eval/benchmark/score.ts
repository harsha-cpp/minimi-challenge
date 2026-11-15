import { createHash } from "node:crypto";
import { citedNumbers } from "../../src/agent/run.ts";
import type { Source } from "../../src/memory/store.ts";
import type { SearchHit } from "../../src/search.ts";
import type { TurnTrace } from "../../src/runtime/telemetry.ts";

export interface BenchmarkCase {
  id: string;
  question: string;
  asOf?: string;
  tz?: string;
  sourceGrades?: Record<string, number>;
  requiredFacts?: string[];
  forbiddenFacts?: string[];
  expectedAbstention?: boolean;
  history?: Array<{ at: string; question: string; answer: string }>;
}
export interface RawRetrievalBatch { queryId: string; hits: SearchHit[] }
export interface BenchmarkSample {
  caseId: string;
  engine: string;
  basis: "synthetic-replay" | "live" | "recorded";
  capturedAt: string;
  inputHash: string;
  answer: string;
  /** Exact passages actually cited by the final answer. This is not a provider ranking. */
  sources: Source[];
  /** Each batch retains the provider's original order before evidence selection. Absent means unmeasured. */
  rawRetrieval?: RawRetrievalBatch[];
  admittedEvidence?: Source[];
  quality?: string;
  spend?: { dollars: number | null; isEstimated: boolean; priceVersion: string | null; missingModelUsage: number; missingSearchUsage: number };
  trace?: TurnTrace;
  review?: Record<string, unknown>;
  latencyMs: number | null;
  firstTokenMs?: number | null;
  serverFirstEmissionMs?: number | null;
  clientFirstRenderMs?: number | null;
  searches?: number;
  modelCalls?: number;
  error?: string;
}
/** Deliberately project only generation inputs. Evaluation labels never enter the prompt. */
export const generationInput = (item: BenchmarkCase) => ({ id: item.id, question: item.question,
  ...(item.asOf === undefined ? {} : { asOf: item.asOf }), ...(item.tz === undefined ? {} : { tz: item.tz }),
  ...(item.history === undefined ? {} : { history: item.history.map(({ at, question, answer }) => ({ at, question, answer })) }) });
export const caseInputHash = (item: BenchmarkCase) => createHash("sha256").update(JSON.stringify([item.question, item.asOf ?? null, item.tz ?? "UTC", generationInput(item).history ?? []])).digest("hex");
const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
const canonical = (url: string) => { const value = new URL(url); value.hash = ""; return value.href; };
const dcg = (values: number[]) => values.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);

function rankingMetrics(urls: string[], grades: Map<string, number>) {
  const ranked = [...new Set(urls.map(canonical))].slice(0, 5);
  const judged = ranked.filter(url => grades.has(url));
  const relevance = ranked.map(url => grades.get(url) ?? 0);
  const ideal = dcg([...grades.values()].sort((a, b) => b - a).slice(0, 5));
  const relevant = [...grades.values()].filter(grade => grade > 0).length;
  const firstRelevant = relevance.findIndex(grade => grade > 0);
  return {
    ndcgAt5: ideal ? dcg(relevance) / ideal : null,
    reciprocalRank: relevant ? (firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1)) : null,
    sourceRecallAt5: relevant ? relevance.filter(g => g > 0).length / relevant : null,
    judgedAt5: judged.length, unjudgedAt5: ranked.length - judged.length,
  };
}
export function scoreSample(item: BenchmarkCase, sample: BenchmarkSample) {
  const citations = citedNumbers(sample.answer);
  const grades = new Map(Object.entries(item.sourceGrades ?? {}).map(([url, grade]) => [canonical(url), grade]));
  const selected = rankingMetrics(sample.sources.filter(source => citations.includes(source.n)).map(s => s.url), grades);
  const raw = sample.rawRetrieval?.map(batch => rankingMetrics(batch.hits.map(hit => hit.url), grades));
  const measured = (key: "ndcgAt5" | "reciprocalRank" | "sourceRecallAt5") => {
    if (!raw) return null;
    // An observed no-search sample has empty retrieval, not an invented provider score.
    const values = raw.map(batch => batch[key]).filter((value): value is number => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  const answer = normalize(sample.answer);
  const numbers = new Set(sample.sources.filter(s => s.text?.trim()).map(s => s.n));
  const invalidCitationReferences = citations.filter(n => !numbers.has(n)).length;
  const abstained = /could not verify|couldn't verify|cannot verify|insufficient evidence|no (?:cited )?historical evidence/i.test(sample.answer);
  const forbiddenFactMatches = (item.forbiddenFacts ?? []).filter(f => answer.includes(normalize(f)));
  return {
    // Mean of per-query raw rankings; multi-query results are never flattened into a fictional rank list.
    ndcgAt5: measured("ndcgAt5"), reciprocalRank: measured("reciprocalRank"), sourceRecallAt5: measured("sourceRecallAt5"),
    retrievalInstrumented: sample.rawRetrieval !== undefined,
    retrievalMeasured: (sample.rawRetrieval?.length ?? 0) > 0, retrievalBatches: raw?.length ?? 0,
    unjudgedCandidatesAt5: raw?.reduce((sum, batch) => sum + batch.unjudgedAt5, 0) ?? null,
    unjudgedPolicy: "count-as-zero-and-report" as const,
    selectedSourceNdcgAt5: selected.ndcgAt5, selectedSourceRecallAt5: selected.sourceRecallAt5,
    requiredFactMatchRate: item.requiredFacts?.length ? item.requiredFacts.filter(f => answer.includes(normalize(f))).length / item.requiredFacts.length : null,
    forbiddenFactPresent: forbiddenFactMatches.length > 0,
    citationReferencesValid: citations.length > 0 && invalidCitationReferences === 0,
    invalidCitationReferences,
    citationEvidencePresent: citations.length > 0 && invalidCitationReferences === 0,
    // Existence and exact-string checks cannot establish semantic entailment or factual correctness.
    citationSupportRate: null as number | null,
    materialClaimCorrectness: null as number | null,
    citedSources: citations.length,
    temporalPolicyViolations: item.asOf ? forbiddenFactMatches.length : 0,
    abstained,
    abstentionCorrect: item.expectedAbstention === undefined ? null : abstained === item.expectedAbstention,
    succeeded: !sample.error && Boolean(sample.answer.trim()),
  };
}

export function summarize(samples: Array<{ sample: BenchmarkSample; scores: ReturnType<typeof scoreSample> }>) {
  const engines = [...new Set(samples.map(row => row.sample.engine))];
  return engines.map(engine => {
    const rows = samples.filter(row => row.sample.engine === engine);
    const latencies = rows.map(row => row.sample.latencyMs).filter((n): n is number => n !== null).sort((a, b) => a - b);
    const failures = rows.filter(row => !row.scores.succeeded).map(row => row.sample.latencyMs).filter((n): n is number => n !== null).sort((a, b) => a - b);
    const costs = rows.map(row => row.sample.spend);
    const costsKnown = costs.length > 0 && costs.every(item => item && item.dollars !== null && !item.isEstimated);
    const apiCostDollars = costsKnown ? costs.reduce((sum, item) => sum + item!.dollars!, 0) : null;
    const mean = (key: "ndcgAt5" | "reciprocalRank" | "sourceRecallAt5" | "requiredFactMatchRate" | "selectedSourceNdcgAt5" | "selectedSourceRecallAt5") => {
      const values = rows.map(row => row.scores[key]).filter((n): n is number => n !== null);
      return { value: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, labeledCases: values.length };
    };
    return {
      engine, cases: rows.length, basis: [...new Set(rows.map(row => row.sample.basis))],
      errors: rows.filter(row => !row.scores.succeeded).length,
      p50Ms: latencies.length ? latencies[Math.ceil(latencies.length * 0.5) - 1] : null,
      p95Ms: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null,
      p99Ms: latencies.length >= 100 ? latencies[Math.ceil(latencies.length * 0.99) - 1] : null,
      latencySamples: latencies.length,
      failureDurationSamples: failures.length,
      failureP95Ms: failures.length ? failures[Math.ceil(failures.length * 0.95) - 1] : null,
      ndcgAt5: mean("ndcgAt5"), reciprocalRank: mean("reciprocalRank"), sourceRecallAt5: mean("sourceRecallAt5"), requiredFactMatchRate: mean("requiredFactMatchRate"),
      selectedSourceNdcgAt5: mean("selectedSourceNdcgAt5"), selectedSourceRecallAt5: mean("selectedSourceRecallAt5"),
      forbiddenFactCases: rows.filter(row => row.scores.forbiddenFactPresent).length,
      temporalPolicyViolations: rows.reduce((n, row) => n + row.scores.temporalPolicyViolations, 0),
      apiCostDollars, knownCostSamples: costs.filter(item => item && item.dollars !== null && !item.isEstimated).length,
      reservedOrMeasuredDollars: costs.length && costs.every(item => item && item.dollars !== null) ? costs.reduce((sum, item) => sum + item!.dollars!, 0) : null,
    };
  });
}
