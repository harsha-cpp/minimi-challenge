/** Offline temporal retrieval regression. Fixture entities and statements are fictional. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SearchHit, SearchQuery } from "../src/search.ts";
import { isHistoricalEvidenceEligible } from "../src/temporal/eligibility.ts";
import { withHistoricalCorpus } from "../src/temporal/retrieve.ts";
import { TemporalStore } from "../src/temporal/store.ts";
import type { TemporalDocumentInput } from "../src/temporal/types.ts";

const pricingUrl = "https://atlas.example.com/pricing";
const document = (input: Partial<TemporalDocumentInput> & Pick<TemporalDocumentInput, "sourceId" | "title" | "text">): TemporalDocumentInput => ({
  url: `https://atlas.example.com/${input.sourceId}`,
  availableAt: "2020-03-01T00:00:00.000Z", publishedAt: "2020-03-01T00:00:00.000Z",
  capturedAt: "2020-03-02T00:00:00.000Z", provenanceKind: "archive",
  provenanceUrl: `https://archive.example.com/20200302/${input.sourceId}`, reviewed: true,
  ...input,
});

export const TEMPORAL_FIXTURES: readonly TemporalDocumentInput[] = [
  document({ sourceId: "atlas-pricing", url: pricingUrl, title: "Atlas Pro pricing", text: "Fictional Atlas Pro pricing: $19 per month. The plan includes five seats." }),
  document({ sourceId: "atlas-pricing", url: pricingUrl, title: "Atlas Pro pricing", text: "Fictional Atlas Pro pricing: $49 per month. The plan includes ten seats.", availableAt: "2025-02-01T00:00:00.000Z", publishedAt: "2025-02-01T00:00:00.000Z", capturedAt: "2025-02-01T00:00:00.000Z", provenanceUrl: "https://archive.example.com/20250201/pricing" }),
  document({ sourceId: "retrospective", title: "Retrospective research", text: "Fictional retrospective: the founder departed in 2019. This was disclosed only in the 2025 analysis.", availableAt: "2025-06-01T00:00:00.000Z", publishedAt: "2025-06-01T00:00:00.000Z", capturedAt: "2025-06-01T00:00:00.000Z" }),
  document({ sourceId: "unreviewed-pricing", title: "Atlas Pro pricing rumor", text: "Unreviewed pricing rumor: the plan is free forever.", reviewed: false }),
  document({ sourceId: "late-capture", title: "Revised manual", text: "Fictional revisedmanual: this version includes a later outcome.", capturedAt: "2026-01-01T00:00:00.000Z" }),
  document({ sourceId: "charter-edition", title: "Fictional Harbor Charter, original edition", text: "Fictional harborcharter: the council consists of seven members.", availableAt: "1850-06-01T00:00:00.000Z", publishedAt: "1850-06-01T00:00:00.000Z", capturedAt: "2026-01-01T00:00:00.000Z", provenanceKind: "primary-source", provenanceUrl: "https://editions.example.com/harbor-charter-1850" }),
  document({ sourceId: "instant-boundary", title: "Clock boundary announcement", text: "Fictional boundarytoken announcement: the vote passed.", availableAt: "2025-01-13T18:05:11.994Z", publishedAt: "2025-01-13T18:05:11.994Z", capturedAt: "2025-01-13T18:05:11.994Z" }),
  document({ sourceId: "competitor", url: "https://news.example.com/competitor", title: "Competitor bulletin", text: "Fictional competitor bulletin: a separate service exists." }),
  document({ sourceId: "long-manual", title: "Long operations manual", text: "Unrelated administrative preface. ".repeat(300) + "\nFictional copperquota is 17 units per day.\n" + "Unrelated appendix. ".repeat(300) }),
];

interface RetrievalCase {
  id: string;
  query: Omit<SearchQuery, "asOf">;
  asOf: string;
  expectedCount: number;
  requiredText?: string[];
  forbiddenText?: string[];
  withdrawPricingReview?: boolean;
}

export const TEMPORAL_CASES: readonly RetrievalCase[] = [
  { id: "eligible-earlier-version", query: { query: "pricing" }, asOf: "2021-01-01T00:00:00.000Z", expectedCount: 1, requiredText: ["$19"], forbiddenText: ["$49", "free forever"] },
  { id: "latest-version-after-change", query: { query: "pricing" }, asOf: "2025-03-01T00:00:00.000Z", expectedCount: 1, requiredText: ["$49"], forbiddenText: ["$19", "free forever"] },
  { id: "backdated-event-not-yet-disclosed", query: { query: "retrospective" }, asOf: "2021-01-01T00:00:00.000Z", expectedCount: 0, forbiddenText: ["founder departed"] },
  { id: "disclosure-now-eligible", query: { query: "retrospective" }, asOf: "2025-07-01T00:00:00.000Z", expectedCount: 1, requiredText: ["founder departed"] },
  { id: "later-archive-capture-excluded", query: { query: "revisedmanual" }, asOf: "2021-01-01T00:00:00.000Z", expectedCount: 0 },
  { id: "original-edition-modern-digitization", query: { query: "harborcharter" }, asOf: "1851-01-01T00:00:00.000Z", expectedCount: 1, requiredText: ["seven members"] },
  { id: "edition-not-published-yet", query: { query: "harborcharter" }, asOf: "1850-05-31T23:59:59.999Z", expectedCount: 0 },
  { id: "one-millisecond-before-availability", query: { query: "boundarytoken" }, asOf: "2025-01-13T18:05:11.993Z", expectedCount: 0 },
  { id: "exact-availability-is-eligible", query: { query: "boundarytoken" }, asOf: "2025-01-13T18:05:11.994Z", expectedCount: 1, requiredText: ["vote passed"] },
  { id: "domain-filter-excludes", query: { query: "competitor", domains: ["atlas.example.com"] }, asOf: "2021-01-01T00:00:00.000Z", expectedCount: 0 },
  { id: "domain-filter-includes", query: { query: "competitor", domains: ["news.example.com"] }, asOf: "2021-01-01T00:00:00.000Z", expectedCount: 1, requiredText: ["separate service"] },
  { id: "known-url-filter", query: { query: "pricing", urls: [pricingUrl] }, asOf: "2021-01-01T00:00:00.000Z", expectedCount: 1, requiredText: ["$19"] },
  { id: "publication-lower-bound", query: { query: "pricing", publishedAfter: "2024-01-01" }, asOf: "2024-12-31T23:59:59.999Z", expectedCount: 0 },
  { id: "unknown-question-has-no-evidence", query: { query: "nonexistentzebratoken" }, asOf: "2021-01-01T00:00:00.000Z", expectedCount: 0 },
  { id: "withdrawn-review-excludes-source", query: { query: "pricing" }, asOf: "2021-01-01T00:00:00.000Z", expectedCount: 0, withdrawPricingReview: true },
  { id: "relevant-passage-late-in-document", query: { query: "copperquota" }, asOf: "2021-01-01T00:00:00.000Z", expectedCount: 1, requiredText: ["copperquota is 17"] },
];

export async function runTemporalBenchmark() {
  const outcomes = [];
  for (const task of TEMPORAL_CASES) {
    const store = new TemporalStore(":memory:");
    try {
      const imported = TEMPORAL_FIXTURES.map(input => store.importDocument(input));
      if (task.withdrawPricingReview) {
        for (const source of imported.filter(input => input.sourceId === "atlas-pricing")) store.review(source.id, false, "Benchmark review withdrawal");
      }
      let snapshotRequests = 0;
      const engine = withHistoricalCorpus({ search: async query => {
        if (!query.asOf) throw new Error("Benchmark attempted an unexpected live lookup.");
        snapshotRequests++;
        throw new Error("Exa responded 403.");
      } }, store);
      const began = performance.now();
      let hits: SearchHit[] = [];
      let error: string | undefined;
      try { hits = await engine.search({ ...task.query, asOf: new Date(task.asOf) }); }
      catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
      const latencyMs = performance.now() - began;
      const text = hits.map(hit => hit.text).join("\n");
      const temporalViolations = hits.filter(hit => !isHistoricalEvidenceEligible(hit, new Date(task.asOf))).length;
      const missingLabels = (task.requiredText ?? []).filter(label => !text.includes(label));
      const leakedLabels = (task.forbiddenText ?? []).filter(label => text.includes(label));
      const approvedError = error === undefined || (task.expectedCount === 0 && error === "Exa responded 403.");
      const passed = approvedError && hits.length === task.expectedCount && temporalViolations === 0 && !missingLabels.length && !leakedLabels.length && hits.every(hit => hit.text.length <= 2000);
      outcomes.push({ caseId: task.id, asOf: task.asOf, passed, expectedCount: task.expectedCount,
        returnedCount: hits.length, temporalViolations, missingLabels, leakedLabels, latencyMs, snapshotRequests,
        evidenceUnavailable: hits.length === 0, ...(error ? { error } : {}),
        sources: hits.map(hit => ({ url: hit.url, text: hit.text, temporal: hit.temporal })),
      });
    } finally { store.close(); }
  }
  const latencies = outcomes.map(outcome => outcome.latencyMs).sort((a, b) => a - b);
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  return {
    version: 1,
    mode: "synthetic-temporal-retrieval-regression",
    scope: "Offline fictional fixtures with explicit expected outcomes. Tests temporal evidence eligibility, version selection, retrieval filters, bounded exact passages and missing-evidence behavior. No network, no LLM, no factual-answer accuracy or competitor comparison. Timings measure local fixture execution only.",
    createdAt: new Date().toISOString(),
    datasetHash: hash(JSON.stringify({ documents: TEMPORAL_FIXTURES, cases: TEMPORAL_CASES })),
    implementationHash: hash(["src/temporal/store.ts", "src/temporal/retrieve.ts", "src/temporal/eligibility.ts", "src/temporal/types.ts"].map(path => path + "\n" + readFileSync(new URL(`../${path}`, import.meta.url), "utf8")).join("\n")),
    summary: {
      cases: outcomes.length, passedCases: outcomes.filter(outcome => outcome.passed).length,
      failedCases: outcomes.filter(outcome => !outcome.passed).length,
      temporalViolations: outcomes.reduce((sum, outcome) => sum + outcome.temporalViolations, 0),
      casesWithEvidence: outcomes.filter(outcome => !outcome.evidenceUnavailable).length,
      expectedMissingEvidenceCases: TEMPORAL_CASES.filter(task => task.expectedCount === 0).length,
      p50Ms: latencies[Math.ceil(latencies.length * 0.5) - 1]!, p95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1]!,
      answerAccuracy: null, competitorComparison: null, apiCostDollars: 0,
    },
    outcomes,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--out" || !args[1] || args[1].startsWith("--"))) throw new Error("Usage: eval/temporal.ts [--out report.json]");
  const report = await runTemporalBenchmark();
  const output = resolve(args[1] ?? ".context/temporal-benchmark.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`Private temporal retrieval report saved: ${output}`);
  if (report.summary.failedCases) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
