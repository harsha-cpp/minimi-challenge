import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FIXTURES, FROZEN_FIXTURE_VERSION, fixtureManifest } from "../eval/benchmark/fixtures.ts";
import { caseInputHash } from "../eval/benchmark/score.ts";
import { QUALITY_SEED, SEED_HASH, SEED_VERSION } from "../eval/quality/seed.ts";
import { annotationMetrics, calibration, digest, exactTextHash, pairedReport, projectGenerationInput, QUALITY_SLICES,
  releaseGates, validateAnnotation, validateDataset, validateReleaseEvidence, type Annotation, type QualityCase, type ReleaseEvidence } from "../eval/quality/protocol.ts";

const sourceText = "Fixture reference for protocol tests only; this is not a real human assessment.";
function qualityCase(index = 0): QualityCase {
  return { input: { id: `q${index}`, question: `Protocol fixture question ${index}?` }, slice: QUALITY_SLICES[index % QUALITY_SLICES.length]!,
    split: "heldout", track: "live-quality", clusterId: `fixture-group-${index}`,
    labels: { status: "adjudicated", requiredFacets: ["fixture fact"], acceptableUncertainty: "No fabricated fixture fact.",
      references: [{ url: "https://example.com/protocol-fixture", capturedAt: "2026-11-01T10:00:00Z", text: sourceText, sha256: exactTextHash(sourceText), relevance: 3 }],
      adjudicators: ["human-a", "human-b"], reconciled: true } };
}
function annotation(index = 0, override: Partial<Annotation> = {}): Annotation {
  return { caseId: `q${index}`, sampleHash: digest(`output-${index}`), engine: "candidate", scorer: "human", scorerId: "human-a", blinded: true,
    materialClaims: 1, correctClaims: 1, citedClaims: 1, supportedCitedClaims: 1, requiredFacets: 1, coveredFacets: 1,
    confidentFalseAssertions: 0, unnecessaryRefusal: false, temporalCorrect: true, adjudicated: true, ...override };
}
/** Fabricated protocol inputs exercise the validator. They are never saved as measured release evidence. */
function protocolEvidence(cases = Array.from({ length: 20 }, (_, index) => qualityCase(index))): ReleaseEvidence {
  return { datasetHash: digest(cases),
    annotations: cases.flatMap((item, index) => [annotation(index), annotation(index, { scorer: "automated", scorerId: "independent-test-judge", adjudicated: false }),
      ...(index < 5 ? [annotation(index, { scorerId: "human-b", adjudicated: false })] : [])]),
    liveRuns: cases.flatMap((item, index) => [0, 1, 2].map(repeat => ({ runId: `${item.input.id}-${repeat}`, caseId: item.input.id,
      engine: "candidate", basis: "live" as const, inputHash: caseInputHash(item.input), sampleHash: digest(`output-${index}`),
      capturedAt: `2026-11-${String(10 + repeat).padStart(2, "0")}T10:00:00Z`, cache: repeat === 0 ? "cold" as const : "warm" as const, costDollars: 0.01, succeeded: true }))),
    loads: [1, 4, 8].map(activeUsers => ({ activeUsers, basis: "live", acceptedNonCancelled: 100, durableCompleted: 100, rejected: 3, p95WithinDeclaredTarget: true, boundedProviderBudget: true })),
    drills: { regressions: true, isolation: true, duplicate: true, crashRestart: true, lostCompletion: true, restore: true, shutdown: true },
    paired: cases.map((item, index) => ({ caseId: item.input.id, clusterId: item.clusterId, slice: item.slice, baseline: 0.9, candidate: 0.95 })),
    adjudication: { doubleLabelledCaseIds: cases.slice(0, 5).map(item => item.input.id), disagreementsReconciled: true },
    campaign: { engine: "candidate", generationModel: "generation-test-model", judgeModel: "independent-test-judge", costCapDollars: 10,
      predeclaredTargets: true, primaryObjective: "protocol test", judgeIndependent: true } };
}

test("quality seed is versioned, balanced by slice, pending human work and grouped across splits", () => {
  validateDataset(QUALITY_SEED);
  assert.equal(QUALITY_SEED.length, 200);
  for (const slice of QUALITY_SLICES) {
    assert.equal(QUALITY_SEED.filter(item => item.slice === slice).length, 20);
    assert.ok(QUALITY_SEED.filter(item => item.slice === slice && item.split === "heldout").length >= 2);
  }
  assert.ok(QUALITY_SEED.every(item => item.labels.status === "pending" && item.labels.adjudicators.length === 0));
  const expected = JSON.parse(readFileSync(new URL("../eval/quality/seed-manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(expected, { version: SEED_VERSION, sha256: SEED_HASH, cases: 200 });
  assert.equal(digest(QUALITY_SEED), SEED_HASH);
  const fixtureExpected = JSON.parse(readFileSync(new URL("../eval/benchmark/frozen-manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(fixtureExpected, { version: FROZEN_FIXTURE_VERSION, fixtures: fixtureManifest(FIXTURES) });
});

test("generation input projection hides all labels and cannot mutate retained history", () => {
  const item = qualityCase();
  item.input.sourceGrades = { "https://example.com/secret-human-label": 3 };
  item.input.requiredFacts = ["SECRET_REFERENCE_ANSWER"];
  item.input.forbiddenFacts = ["SECRET_FORBIDDEN_LABEL"];
  item.input.expectedAbstention = false;
  item.input.history = [{ at: "2026-11-01T00:00:00Z", question: "earlier preference", answer: "selected blue" }];
  const projected = projectGenerationInput(item);
  assert.deepEqual(Object.keys(projected).sort(), ["history", "id", "question"]);
  assert.doesNotMatch(JSON.stringify(projected), /SECRET_|"sourceGrades"|"requiredFacts"|"adjudicators"|"references"|"labels"|"relevance"/);
  projected.history![0]!.answer = "mutated";
  assert.equal(item.input.history[0]!.answer, "selected blue");
});

test("split leakage, duplicate inputs and mismatched reference hashes fail validation", () => {
  const first = qualityCase(), second = qualityCase(1);
  assert.throws(() => validateDataset([first, { ...second, split: "development", clusterId: first.clusterId }]), /Split leakage/);
  assert.throws(() => validateDataset([first, { ...second, split: "development", input: { ...second.input, question: first.input.question } }]), /Split leakage/);
  assert.throws(() => validateDataset([first, { ...second, input: { ...second.input, question: first.input.question } }]), /Duplicate generation/);
  const altered = structuredClone(first); altered.labels.references[0]!.text += "tampered";
  assert.throws(() => validateDataset([altered]), /Invalid frozen reference/);
  const noPeople = structuredClone(first); noPeople.labels.adjudicators = [];
  assert.throws(() => validateDataset([noPeople]), /Adjudicated labels/);
  const noFacets = structuredClone(first); noFacets.labels.requiredFacets = [];
  assert.throws(() => validateDataset([noFacets]), /Adjudicated labels/);
});

test("annotation metrics use claim and facet denominators while zero observations stay unknown", () => {
  const scores = annotationMetrics([annotation(0, { materialClaims: 4, correctClaims: 3, citedClaims: 2, supportedCitedClaims: 1, requiredFacets: 5, coveredFacets: 3 })]);
  assert.equal(scores.materialClaimCorrectness, 0.75);
  assert.equal(scores.citationSupport, 0.5);
  assert.equal(scores.materialClaimCitationCoverage, 0.25);
  assert.equal(scores.requiredFacetCoverage, 0.6);
  assert.equal(annotationMetrics([]).citationSupport, null);
  assert.equal(annotationMetrics([]).requiredFacetCoverage, null);
  for (const bad of [{ correctClaims: 2 }, { citedClaims: 2 }, { supportedCitedClaims: 2 }, { coveredFacets: 2 }, { materialClaims: -1 }, { blinded: "yes" }, { sampleHash: "not-a-hash" }]) {
    assert.throws(() => validateAnnotation({ ...annotation(), ...bad } as Annotation));
  }
});

test("calibration matches exact outputs and reconciled blind humans without counting duplicates", () => {
  const human = annotation();
  const automated = annotation(0, { scorer: "automated", scorerId: "judge", supportedCitedClaims: 0, adjudicated: false });
  const result = calibration([human, human], [automated]);
  assert.equal(result.pairedSamples, 1);
  assert.equal(result.pairedCases, 1);
  assert.equal(result.errors.citationSupport!.meanAbsoluteError, 1);
  assert.equal(calibration([{ ...human, blinded: false }], [automated]).pairedSamples, 0);
  assert.equal(calibration([{ ...human, adjudicated: false }], [automated]).pairedSamples, 0);
  assert.equal(calibration([human], [{ ...automated, sampleHash: digest("different output") }]).pairedSamples, 0);
});

test("paired uncertainty averages repeats per question and resamples question clusters", () => {
  const first = { caseId: "a", clusterId: "group-a", slice: "simple-fact" as const, baseline: 0, candidate: 1 };
  const second = { caseId: "b", clusterId: "group-a", slice: "simple-fact" as const, baseline: 1, candidate: 0 };
  const third = { caseId: "c", clusterId: "group-b", slice: "simple-fact" as const, baseline: 0.5, candidate: 0.5 };
  const report = pairedReport([first, second, third]);
  assert.equal(report.overall.questions, 3);
  assert.equal(report.overall.clusters, 2);
  assert.equal(report.overall.absoluteChange, 0);
  const repeated = pairedReport([...Array.from({ length: 50 }, () => first), second, third]);
  assert.equal(repeated.overall.observations, 52);
  assert.equal(repeated.overall.questions, 3);
  assert.equal(repeated.overall.absoluteChange, 0);
  assert.deepEqual(repeated.overall.interval95, report.overall.interval95);
  assert.equal(pairedReport([first, first, first]).overall.interval95, null);
  assert.throws(() => pairedReport([first, { ...first, clusterId: "different" }]), /cannot change/);
});

test("the bundled pending seed cannot satisfy release gates even without any explicit failures", () => {
  const report = releaseGates(QUALITY_SEED);
  assert.equal(report.ready, false);
  assert.ok(report.gates.every(gate => !gate.passed));
  assert.equal(report.humanMetrics.citationSupport, null);
  assert.equal(report.costPerSupportedCompletedAnswer, null);
});

test("complete protocol fixtures can pass gate validation without being recorded as real measurements", () => {
  const cases = Array.from({ length: 20 }, (_, index) => qualityCase(index));
  const evidence = protocolEvidence(cases);
  validateReleaseEvidence(cases, evidence);
  const report = releaseGates(cases, evidence);
  assert.equal(report.ready, true, JSON.stringify(report.gates));
  assert.equal(report.supportedCompletedAnswers, 60);
  assert.ok(Math.abs(report.costPerSupportedCompletedAnswer! - 0.01) < 1e-10);
});

for (const corrupt of [
  (e: ReleaseEvidence) => { e.datasetHash = digest("another dataset"); },
  (e: ReleaseEvidence) => { e.annotations.push(e.annotations[0]!); },
  (e: ReleaseEvidence) => { e.liveRuns.push(e.liveRuns[0]!); },
  (e: ReleaseEvidence) => { e.liveRuns[0]!.inputHash = digest("another question"); },
  (e: ReleaseEvidence) => { e.liveRuns[0]!.caseId = "foreign"; },
  (e: ReleaseEvidence) => { e.annotations[0]!.caseId = "foreign"; },
  (e: ReleaseEvidence) => { e.annotations[0]!.sampleHash = digest("unrecorded output"); },
  (e: ReleaseEvidence) => { e.annotations[0]!.requiredFacets = 0; e.annotations[0]!.coveredFacets = 0; },
  (e: ReleaseEvidence) => { e.loads.push(e.loads[0]!); },
  (e: ReleaseEvidence) => { e.adjudication.doubleLabelledCaseIds.push(e.adjudication.doubleLabelledCaseIds[0]!); },
  (e: ReleaseEvidence) => { e.annotations = e.annotations.filter(item => item.scorerId !== "human-b"); },
  (e: ReleaseEvidence) => { e.paired![0]!.clusterId = "foreign"; },
]) {
  test(`release integrity rejects corruption: ${corrupt.toString()}`, () => {
    const cases = Array.from({ length: 20 }, (_, index) => qualityCase(index));
    const evidence = protocolEvidence(cases); corrupt(evidence);
    const result = releaseGates(cases, evidence);
    assert.equal(result.ready, false);
    assert.equal(result.gates.find(gate => gate.id === "evidence-integrity")!.passed, false);
  });
}

test("missing empirical tracks, same-model judging, mock loads and unknown costs cannot pass release", () => {
  const cases = Array.from({ length: 20 }, (_, index) => qualityCase(index));
  for (const mutate of [
    (e: ReleaseEvidence) => { e.liveRuns = []; },
    (e: ReleaseEvidence) => { e.campaign.generationModel = e.campaign.judgeModel; },
    (e: ReleaseEvidence) => { e.loads[1]!.basis = "mock"; },
    (e: ReleaseEvidence) => { e.liveRuns[0]!.costDollars = null; },
    (e: ReleaseEvidence) => { e.drills.restore = false; },
    (e: ReleaseEvidence) => { e.campaign.predeclaredTargets = false; },
    (e: ReleaseEvidence) => { e.paired = []; },
  ]) {
    const evidence = protocolEvidence(cases); mutate(evidence);
    assert.equal(releaseGates(cases, evidence).ready, false);
  }
});

test("frozen conversation outputs stay separate and cannot supply live repeat evidence", () => {
  const cases = Array.from({ length: 20 }, (_, index) => qualityCase(index));
  const evidence = protocolEvidence(cases);
  evidence.liveRuns = [];
  evidence.frozenRuns = cases.map((item, index) => ({ runId: `frozen-${index}`, caseId: item.input.id, engine: "candidate",
    basis: "frozen-evidence", inputHash: caseInputHash(item.input), sampleHash: digest(`output-${index}`), capturedAt: "2026-11-01T10:00:00Z" }));
  const result = releaseGates(cases, evidence);
  assert.equal(result.gates.find(gate => gate.id === "evidence-integrity")!.passed, true);
  assert.equal(result.gates.find(gate => gate.id === "live-repeat-track")!.passed, false);
  assert.equal(result.ready, false);
});

test("quality CLI validates seed without providers and required-release mode exits nonzero", () => {
  const directory = mkdtempSync(join(tmpdir(), "asof-quality-cli-"));
  const path = join(directory, "quality.json");
  const run = (extra: string[]) => spawnSync(process.execPath, ["--import", "tsx", "--disable-warning=ExperimentalWarning", "eval/quality.ts", "--out", path, ...extra], { encoding: "utf8" });
  try {
    const ordinary = run(["--validate-seed"]);
    assert.equal(ordinary.status, 0, ordinary.stderr);
    const report = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(report.cases, 200);
    assert.equal(report.pendingLabels, 200);
    assert.equal(report.release.ready, false);
    const release = run(["--require-release"]);
    assert.equal(release.status, 1, release.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
