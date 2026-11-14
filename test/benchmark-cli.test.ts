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
