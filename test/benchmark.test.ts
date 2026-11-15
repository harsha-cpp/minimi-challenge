import assert from "node:assert/strict";
import { test } from "node:test";
import { caseInputHash, scoreSample, summarize, type BenchmarkCase, type BenchmarkSample } from "../eval/benchmark/score.ts";

const task: BenchmarkCase = { id: "task", question: "Price?", asOf: "2020-11-03T10:00:00Z", sourceGrades: { "https://example.com/official": 3, "https://example.com/secondary": 1 }, requiredFacts: ["$19"], forbiddenFacts: ["$99"] };
const sample: BenchmarkSample = { caseId: "task", engine: "fixture", basis: "synthetic-replay", inputHash: caseInputHash(task), capturedAt: "2026-11-12T10:00:00Z", answer: "$19 [1]", latencyMs: 10, sources: [{ n: 1, url: "https://example.com/official", title: "Official", text: "$19", snapshotAsOf: new Date(task.asOf!).toISOString() }] };

test("benchmark grading distinguishes relevance, citation integrity and explicit temporal labels", () => {
  const good = scoreSample(task, { ...sample, rawRetrieval: [{ queryId: "query-1", hits: [{ url: "https://example.com/official", title: "Official", text: "$19" }] }] });
  const bad = scoreSample(task, { ...sample, answer: "$99 [99]", sources: [{ n: 1, url: "https://example.com/unrelated", title: "Unrelated" }], rawRetrieval: [{ queryId: "query-1", hits: [{ url: "https://example.com/unrelated", title: "Unrelated", text: "$99" }] }] });
  assert.ok(good.ndcgAt5! > bad.ndcgAt5!);
  assert.equal(good.sourceRecallAt5, 0.5);
  assert.equal(good.requiredFactMatchRate, 1);
  assert.equal(good.temporalPolicyViolations, 0);
  assert.equal(bad.temporalPolicyViolations, 1);
  assert.equal(bad.citationReferencesValid, false);
  assert.equal(bad.forbiddenFactPresent, true);
});

test("unlabeled semantic metrics remain null rather than invented scores", () => {
  const result = scoreSample({ id: "unlabeled", question: "q" }, sample);
  assert.equal(result.ndcgAt5, null);
  assert.equal(result.requiredFactMatchRate, null);
  const report = summarize([{ sample, scores: result }]);
  assert.deepEqual(report[0]!.ndcgAt5, { value: null, labeledCases: 0 });
  assert.equal(report[0]!.apiCostDollars, null);
});

test("input identity includes the effective time and seed history", () => {
  assert.notEqual(caseInputHash(task), caseInputHash({ ...task, asOf: "2020-11-04T10:00:00Z" }));
  assert.notEqual(caseInputHash(task), caseInputHash({ ...task, history: [{ at: "2020-11-02T10:00:00Z", question: "q", answer: "a" }] }));
  assert.notEqual(caseInputHash(task), caseInputHash({ ...task, tz: "Asia/Kolkata" }));
});

test("separate raw query rankings are scored per query and never flattened", () => {
  const official = { url: "https://example.com/official", title: "Official", text: "$19" };
  const secondary = { url: "https://example.com/secondary", title: "Secondary", text: "$19" };
  const rawRetrieval = [{ queryId: "q1", hits: [official, secondary] }, { queryId: "q2", hits: [secondary, official] }];
  const result = scoreSample(task, { ...sample, rawRetrieval });
  const q1 = scoreSample(task, { ...sample, rawRetrieval: [rawRetrieval[0]!] });
  const q2 = scoreSample(task, { ...sample, rawRetrieval: [rawRetrieval[1]!] });
  assert.equal(result.retrievalBatches, 2);
  assert.equal(result.ndcgAt5, (q1.ndcgAt5! + q2.ndcgAt5!) / 2);
  assert.ok(result.ndcgAt5! < 1);
});

test("era benchmark admits live retrospective evidence regardless of publication or review flags", () => {
  const local = { ...sample.sources[0]!, snapshotAsOf: undefined, temporal: {
    documentId: "original-version", availableAt: "1900-01-01T00:00:00.000Z", recordedAt: "2026-11-13T18:00:00.000Z",
    provenanceKind: "primary-source" as const, provenanceUrl: "https://example.com/original", reviewed: true,
  } };
  assert.equal(scoreSample(task, { ...sample, sources: [local] }).temporalPolicyViolations, 0);
  assert.equal(scoreSample(task, { ...sample, sources: [{ ...local, temporal: { ...local.temporal, reviewed: false } }] }).temporalPolicyViolations, 0);
  assert.equal(scoreSample(task, { ...sample, sources: [{ ...sample.sources[0]!, snapshotAsOf: undefined, publishedDate: "2026-11-14" }] }).temporalPolicyViolations, 0);
  assert.equal(scoreSample({ id: "unlabeled", question: "q", asOf: task.asOf }, { ...sample, answer: "An unlabeled statement" }).temporalPolicyViolations, 0);
});

test("saved citations cannot masquerade as a raw retrieval ranking", () => {
  const selected = scoreSample(task, sample);
  assert.equal(selected.ndcgAt5, null);
  assert.equal(selected.reciprocalRank, null);
  assert.equal(selected.sourceRecallAt5, null);
  assert.equal(selected.selectedSourceRecallAt5, 0.5);
  assert.equal(selected.retrievalMeasured, false);
  assert.equal(selected.retrievalInstrumented, false);
  const ranked = scoreSample(task, { ...sample, rawRetrieval: [{ queryId: "q1", hits: [
    { url: "https://example.com/unjudged", title: "Unjudged", text: "unjudged" },
    { url: "https://example.com/secondary", title: "Secondary", text: "price" },
    { url: "https://example.com/official", title: "Official", text: "price" },
  ] }] });
  assert.equal(ranked.reciprocalRank, 0.5);
  assert.equal(ranked.unjudgedCandidatesAt5, 1);
  assert.equal(ranked.sourceRecallAt5, 1);
  assert.equal(ranked.selectedSourceRecallAt5, 0.5);
});

test("instrumented no-search turns are distinct from an observed empty retrieval", () => {
  const noQuery = scoreSample(task, { ...sample, rawRetrieval: [] });
  assert.equal(noQuery.retrievalInstrumented, true);
  assert.equal(noQuery.retrievalMeasured, false);
  assert.equal(noQuery.ndcgAt5, null);
  const emptyQuery = scoreSample(task, { ...sample, rawRetrieval: [{ queryId: "q1", hits: [] }] });
  assert.equal(emptyQuery.retrievalInstrumented, true);
  assert.equal(emptyQuery.retrievalMeasured, true);
  assert.equal(emptyQuery.ndcgAt5, 0);
  assert.equal(emptyQuery.sourceRecallAt5, 0);
});

test("no citations are not vacuous evidence support and IDs without passages do not count", () => {
  for (const candidate of [{ ...sample, answer: "A confident fact." }, { ...sample, sources: sample.sources.map(({ text, ...source }) => source) }]) {
    const result = scoreSample(task, candidate);
    assert.equal(result.citationEvidencePresent, false);
    assert.equal(result.citationReferencesValid, false);
    assert.equal(result.citationSupportRate, null);
    assert.equal(result.materialClaimCorrectness, null);
  }
});
