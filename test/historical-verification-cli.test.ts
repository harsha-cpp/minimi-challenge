import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("historical verifier evaluation defaults to private scripted plumbing and requires explicit live configuration", () => {
  const directory = mkdtempSync(join(tmpdir(), "asof-verifier-cli-"));
  const path = join(directory, "private report.json");
  const run = (args: string[]) => spawnSync(process.execPath,
    ["--import", "tsx", "--disable-warning=ExperimentalWarning", "eval/historical-verification.ts", ...args],
    { encoding: "utf8", env: { ...process.env, LLM_API_KEY: "", LLM_MODEL: "", EXA_API_KEY: "" } });
  try {
    const result = run(["--out", path]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(report.complete, true);
    assert.equal(report.mode, "scripted-plumbing-only");
    assert.equal(report.runtime.model, null);
    assert.equal(report.summary.modelDecisionMetrics, null);
    assert.deepEqual(report.summary.expectedPipelineOutcomes, { matched: 14, total: 14 });
    assert.equal(report.summary.operationalFailures.length, 0);
    assert.equal(report.outcomes.length, 14);
    assert.match(report.scope, /do not measure model quality/);
    assert.match(report.datasetHash, /^[a-f0-9]{64}$/);
    assert.match(report.implementationHash, /^[a-f0-9]{64}$/);
    for (const outcome of report.outcomes) {
      assert.match(outcome.inputHash, /^[a-f0-9]{64}$/);
      assert.match(outcome.answerHash, /^[a-f0-9]{64}$/);
      assert.equal(outcome.usage.length, 0);
      for (const source of outcome.sources) assert.match(source.contentHash, /^[a-f0-9]{64}$/);
    }
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const absent = join(directory, "not-created.json");
    const missingLive = run(["--live", "--out", absent]);
    assert.notEqual(missingLive.status, 0);
    assert.match(missingLive.stderr, /requires a configured LLM_API_KEY and LLM_MODEL/);
    assert.equal(existsSync(absent), false);
    for (const args of [["--out"], ["--live", "--out", "--live"], ["--unknown"]]) {
      const invalid = run(args);
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stderr, /Unknown or incomplete historical-verification option/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
