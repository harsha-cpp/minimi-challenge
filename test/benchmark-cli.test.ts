import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("private comparison imports matching recordings and rejects a different historical input", () => {
  const dir = mkdtempSync(join(tmpdir(), "asof-benchmark-cli-"));
  const reportPath = join(dir, "report.json");
  const baselinePath = join(dir, "baseline.json");
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "--disable-warning=ExperimentalWarning", "eval/benchmark.ts", "--out", reportPath, ...args], { encoding: "utf8" });
  try {
    const first = run([]);
    assert.equal(first.status, 0, first.stderr);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.ok(/^[a-f0-9]{64}$/.test(report.implementationHash));
    assert.ok(Date.parse(report.sourceSnapshotAt) <= Math.min(...report.outcomes.map((row: { sample: { trace: { receivedAt: string } } }) => Date.parse(row.sample.trace.receivedAt))));
    for (const row of report.outcomes) {
      assert.ok(Array.isArray(row.sample.rawRetrieval), "raw provider batches are retained independently");
      assert.ok(Array.isArray(row.sample.admittedEvidence), "packing observations have their own capture");
      assert.equal(row.sample.trace.outcome, "completed");
      assert.ok(row.sample.trace.stages.some((stage: { name: string }) => stage.name === "commit"));
      assert.ok(row.sample.sources.every((source: { n: number }) => row.sample.admittedEvidence.some((admitted: { n: number }) => admitted.n === source.n)));
    }

    const sample = { ...report.outcomes[0].sample, engine: "recording-parser-test-fixture", basis: "recorded" };
    writeFileSync(baselinePath, JSON.stringify([sample]));
    const compared = run(["--baseline", baselinePath]);
    assert.equal(compared.status, 0, compared.stderr);
    const comparison = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(comparison.pairedCoverage[0].sharedCases.length, 1);
    assert.equal(comparison.pairedCoverage[0].missingCases.length, 5);
    assert.equal(comparison.pairedCoverage[0].pairedSummary.length, 2);
    sample.inputHash = "mismatched-time";
    writeFileSync(baselinePath, JSON.stringify([sample]));
    const rejected = run(["--baseline", baselinePath]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /input hash does not match/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("live benchmark requires an explicit positive campaign cap before provider setup", () => {
  for (const options of [[], ["--max-campaign-dollars", "0"]]) {
    const run = spawnSync(process.execPath, ["--import", "tsx", "--disable-warning=ExperimentalWarning", "eval/benchmark.ts", "--live", ...options], { encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /explicit positive --max-campaign-dollars/);
  }
});
