import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SIMULATION_CASES } from "../eval/simulation/cases.ts";
import { deterministicChecks, judgeAnswer, percentile } from "../eval/simulation/score.ts";

const task = SIMULATION_CASES.find(task => task.id === "india-after-independence")!;
const sources = [{ n: 1, url: "https://example.com/history", title: "History", text: "India became independent on 15 August 1947.", publishedDate: "2026-01-01" }];

test("simulation benchmark permits modern retrospective evidence and detects the removed technical refusal", () => {
  const checks = deterministicChecks(task, "India is already independent, since 15 August 1947 [1].", sources, 1);
  assert.ok(Object.values(checks).every(Boolean));
  assert.equal(deterministicChecks(task, "Exa Snapshot was unavailable (HTTP 403); check the key's access.", [], 1).noSnapshotInstructions, false);
  assert.equal(deterministicChecks(task, "India became independent [9].", sources, 1).citationsResolve, false);
  assert.equal(deterministicChecks(task, "India became independent [1].", [{ ...sources[0]!, snapshotAsOf: task.asOf }], 1).liveSourcesOnly, false);
});

test("simulation benchmark does not reject supplied future text or valid negative answers by year keyword", () => {
  const transformation = SIMULATION_CASES.find(task => task.id === "supplied-text-future-year")!;
  assert.ok(Object.values(deterministicChecks(transformation, "Le vaisseau spatial sera lancé en 2030.", [], 0)).every(Boolean));
  const future = SIMULATION_CASES.find(task => task.id === "future-viewpoint-2031")!;
  assert.ok(Object.values(deterministicChecks(future, "The 2030 winner is not known. France winning would be hypothetical [1].", sources, 1)).every(Boolean));
});

test("simulation benchmark counts the complete IPL mapping and fails a missing or mismatched season", () => {
  const ipl = SIMULATION_CASES.find(task => task.id === "ipl-each-year-2024")!;
  const winners = ["Rajasthan Royals", "Deccan Chargers", "Chennai Super Kings", "Chennai Super Kings", "Kolkata Knight Riders", "Mumbai Indians", "Kolkata Knight Riders", "Mumbai Indians", "Sunrisers Hyderabad", "Mumbai Indians", "Chennai Super Kings", "Mumbai Indians", "Mumbai Indians", "Chennai Super Kings", "Gujarat Titans", "Chennai Super Kings", "Kolkata Knight Riders"];
  const answer = winners.map((winner, i) => `| ${2008 + i} | ${winner} [1] |`).join("\n");
  assert.equal(deterministicChecks(ipl, answer, sources, 1).allSeventeenWinners, true);
  assert.equal(deterministicChecks(ipl, answer.replace("| 2019 | Mumbai Indians [1] |\n", ""), sources, 1).allSeventeenWinners, false);
  assert.equal(deterministicChecks(ipl, answer.replace("| 2022 | Gujarat Titans", "| 2022 | Rajasthan Royals"), sources, 1).allSeventeenWinners, false);
});

test("model evaluation requires every rubric criterion exactly once and never treats a missing judge as a pass", async () => {
  const checks = task.expectations.map(({ id }) => ({ id, passed: true, reason: "The answer matches this criterion." }));
  const valid = await judgeAnswer({ json: async () => ({ checks }) }, task, "Answer [1]", sources, false);
  assert.equal(valid.available, true);
  for (const payload of [{ checks: checks.slice(1) }, { checks: checks.map(() => checks[0]) }, { checks: checks.map(check => ({ ...check, passed: "true" })) }]) {
    const result = await judgeAnswer({ json: async () => payload }, task, "Answer [1]", sources, false);
    assert.equal(result.available, false);
    assert.equal(result.checks.length, 0);
  }
  const unavailable = await judgeAnswer({ json: async () => { throw new Error("offline"); } }, task, "Answer [1]", sources, false);
  assert.equal(unavailable.available, false);
});

test("benchmark preflight makes no service calls and records its exact scope", () => {
  const directory = mkdtempSync(join(tmpdir(), "asof-simulation-preflight-"));
  const output = join(directory, "preflight.json");
  const result = spawnSync(process.execPath, ["--import", "tsx", "--disable-warning=ExperimentalWarning", "eval/simulation.ts", "--out", output], {
    encoding: "utf8", env: { ...process.env, LLM_API_KEY: "", LLM_MODEL: "", EXA_API_KEY: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(report.mode, "preflight-no-api-calls");
  assert.equal(report.plannedSimulationCases, 16);
  assert.equal(report.plannedCurrentBaselines, 3);
  assert.equal(report.trials.length, 0);
  assert.equal(report.summary, null);
  assert.match(report.scope, /not a universal factual-accuracy estimate/);
});

test("nearest-rank latency percentiles keep an empty group distinct from zero latency", () => {
  assert.equal(percentile([], .95), null);
  assert.equal(percentile([100, 30, 50, 70], .5), 50);
  assert.equal(percentile([100, 30, 50, 70], .95), 100);
});
