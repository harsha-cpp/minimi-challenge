import { createHash } from "node:crypto";
import { citedNumbers } from "../../src/agent/run.ts";
import type { Source } from "../../src/memory/store.ts";

export interface BenchmarkCase {
  id: string;
  question: string;
  asOf?: string;
  sourceGrades?: Record<string, number>;
  requiredFacts?: string[];
  forbiddenFacts?: string[];
  expectedAbstention?: boolean;
  history?: Array<{ at: string; question: string; answer: string }>;
}
export interface BenchmarkSample {
  caseId: string;
  engine: string;
  basis: "synthetic-replay" | "live" | "recorded";
  capturedAt: string;
  inputHash: string;
  answer: string;
  sources: Source[];
  latencyMs: number | null;
  firstTokenMs?: number | null;
  searches?: number;
  modelCalls?: number;
  error?: string;
}
export const caseInputHash = (item: BenchmarkCase) => createHash("sha256").update(JSON.stringify([item.question, item.asOf ?? null, item.history ?? []])).digest("hex");
const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
const canonical = (url: string) => { const value = new URL(url); value.hash = ""; return value.href; };

/** Human labels are inputs. These diagnostics do not perform semantic fact checking. */
export function scoreSample(item: BenchmarkCase, sample: BenchmarkSample) {
  const grades = new Map(Object.entries(item.sourceGrades ?? {}).map(([url, grade]) => [canonical(url), grade]));
  const ranked = [...new Set(sample.sources.map(s => canonical(s.url)))].slice(0, 5);
  const relevance = ranked.map(url => grades.get(url) ?? 0);
  const dcg = (values: number[]) => values.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
  const ideal = dcg([...grades.values()].sort((a, b) => b - a).slice(0, 5));
  const relevant = [...grades.values()].filter(grade => grade > 0).length;
  const firstRelevant = relevance.findIndex(grade => grade > 0);
  const answer = normalize(sample.answer);
  const citations = citedNumbers(sample.answer);
  const numbers = new Set(sample.sources.map(s => s.n));
  const abstained = /could not verify|couldn't verify|cannot verify|insufficient evidence|no (?:cited )?historical evidence/i.test(sample.answer);
  const forbiddenFactMatches = (item.forbiddenFacts ?? []).filter(f => answer.includes(normalize(f)));
  return {
    ndcgAt5: ideal ? dcg(relevance) / ideal : null,
    reciprocalRank: relevant ? (firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1)) : null,
    sourceRecallAt5: relevant ? relevance.filter(g => g > 0).length / relevant : null,
    requiredFactMatchRate: item.requiredFacts?.length ? item.requiredFacts.filter(f => answer.includes(normalize(f))).length / item.requiredFacts.length : null,
    forbiddenFactPresent: forbiddenFactMatches.length > 0,
    citationReferencesValid: citations.every(n => numbers.has(n)),
    citedSources: citations.length,
    // Era simulation admits live retrospective sources. Only explicitly labeled answer
    // strings can be checked here; this is not semantic temporal-leakage detection.
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
    const mean = (key: "ndcgAt5" | "reciprocalRank" | "sourceRecallAt5" | "requiredFactMatchRate") => {
      const values = rows.map(row => row.scores[key]).filter((n): n is number => n !== null);
      return { value: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, labeledCases: values.length };
    };
    return {
      engine, cases: rows.length, basis: [...new Set(rows.map(row => row.sample.basis))],
      errors: rows.filter(row => !row.scores.succeeded).length,
      p50Ms: latencies.length ? latencies[Math.ceil(latencies.length * 0.5) - 1] : null,
      p95Ms: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null,
      ndcgAt5: mean("ndcgAt5"), reciprocalRank: mean("reciprocalRank"), sourceRecallAt5: mean("sourceRecallAt5"), requiredFactMatchRate: mean("requiredFactMatchRate"),
      forbiddenFactCases: rows.filter(row => row.scores.forbiddenFactPresent).length,
      temporalPolicyViolations: rows.reduce((n, row) => n + row.scores.temporalPolicyViolations, 0),
      apiCostDollars: null,
    };
  });
}
