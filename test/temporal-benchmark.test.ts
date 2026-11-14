import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTemporalBenchmark, TEMPORAL_CASES } from "../eval/temporal.ts";

test("frozen temporal benchmark covers eligible evidence and missing-history cases without claiming answer accuracy", async () => {
  const report = await runTemporalBenchmark();
  assert.equal(report.mode, "synthetic-temporal-retrieval-regression");
  assert.equal(report.summary.cases, TEMPORAL_CASES.length);
  assert.equal(report.summary.failedCases, 0, JSON.stringify(report.outcomes.filter(outcome => !outcome.passed)));
  assert.equal(report.summary.temporalViolations, 0);
  assert.equal(report.summary.answerAccuracy, null);
  assert.equal(report.summary.competitorComparison, null);
  assert.ok(report.summary.casesWithEvidence > 0);
  assert.ok(report.summary.expectedMissingEvidenceCases > 0);
  const late = report.outcomes.find(outcome => outcome.caseId === "relevant-passage-late-in-document")!;
  assert.match(late.sources[0]!.text, /copperquota is 17/);
  assert.ok(late.sources[0]!.text.length <= 2000);
});

test("temporal benchmark CLI saves a private report and rejects unsupported options", () => {
  const directory = mkdtempSync(join(tmpdir(), "asof-temporal-benchmark-"));
  const output = join(directory, "report.json");
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "--disable-warning=ExperimentalWarning", "eval/temporal.ts", ...args], { encoding: "utf8" });
  try {
    const result = run(["--out", output]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(report.summary.failedCases, 0);
    assert.match(report.scope, /No network, no LLM/);
    assert.equal(report.summary.answerAccuracy, null);
    assert.notEqual(run(["--live"]).status, 0);
    assert.notEqual(run(["--out"]).status, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
