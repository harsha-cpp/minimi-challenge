import assert from "node:assert/strict";
import { test } from "node:test";
import { caseInputHash, scoreSample, summarize, type BenchmarkCase, type BenchmarkSample } from "../eval/benchmark/score.ts";

const task: BenchmarkCase = { id: "task", question: "Price?", asOf: "2020-11-03T10:00:00Z", sourceGrades: { "https://example.com/official": 3, "https://example.com/secondary": 1 }, requiredFacts: ["$19"], forbiddenFacts: ["$99"] };
const sample: BenchmarkSample = { caseId: "task", engine: "fixture", basis: "synthetic-replay", inputHash: caseInputHash(task), capturedAt: "2026-11-12T10:00:00Z", answer: "$19 [1]", latencyMs: 10, sources: [{ n: 1, url: "https://example.com/official", title: "Official", snapshotAsOf: new Date(task.asOf!).toISOString() }] };

test("benchmark grading distinguishes relevance, citation integrity and explicit temporal labels", () => {
  const good = scoreSample(task, sample);
  const bad = scoreSample(task, { ...sample, answer: "$99 [99]", sources: [{ n: 1, url: "https://example.com/unrelated", title: "Unrelated" }] });
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
