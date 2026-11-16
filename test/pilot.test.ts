import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PILOT_CASES, PILOT_REFERENCES, pilotLabelQueue } from "../eval/pilot/cases.ts";
import { searchAllowance } from "../eval/pilot/budget.ts";
import { generationInput } from "../eval/benchmark/score.ts";
import { exactTextHash, validateDataset } from "../eval/quality/protocol.ts";
import { retrievalProfile, withProfile, RETRIEVAL_POLICY_VERSION } from "../src/search/profiles.ts";

test("pilot keeps official captured excerpts and pending human checks separate from generation", () => {
  assert.equal(PILOT_CASES.length, 9);
  assert.equal(new Set(PILOT_CASES.map(item => item.input.id)).size, 9);
  const queue = pilotLabelQueue();
  validateDataset(queue);
  assert.ok(queue.every(item => item.split === "development" && item.labels.status === "pending" && !item.labels.reconciled && !item.labels.adjudicators.length));
  for (const source of PILOT_REFERENCES) assert.equal(exactTextHash(source.text), source.sha256);
  const generated = JSON.stringify(PILOT_CASES.map(item => generationInput(item.input)));
  assert.doesNotMatch(generated, /draftChecks|adjudicators|3\.54\.1|pending-human|sha256/);
  assert.ok(PILOT_CASES.some(item => item.input.asOf?.startsWith("1970")));
  assert.ok(PILOT_CASES.some(item => item.input.asOf?.startsWith("2035")));
});

test("search pilot allowance bounds a burst before provider calls and retains failed reservations", async () => {
  let calls = 0;
  const allowance = searchAllowance({ search: async () => { calls++; return []; } }, 0.5, 0.02);
  const results = await Promise.allSettled(Array.from({ length: 100 }, () => allowance.provider.search({ query: "fixture" })));
  assert.equal(calls, 12);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 12);
  assert.ok(allowance.snapshot.reservedDollars <= 0.5);
  assert.equal(allowance.snapshot.rejectedLookups, 88);
  let failures = 0;
  const failing = searchAllowance({ search: async () => { failures++; throw new Error("upstream unavailable"); } }, 0.08, 0.02);
  await assert.rejects(failing.provider.search({ query: "one" }));
  await assert.rejects(failing.provider.search({ query: "two" }));
  await assert.rejects(failing.provider.search({ query: "three" }), /allowance is exhausted/);
  assert.equal(failures, 2);
  assert.equal(failing.snapshot.reservedDollars, 0.08);
});

test("cancelled and invalid pilot search work never enters a provider", async () => {
  const cancelled = new AbortController(); cancelled.abort();
  const allowance = searchAllowance({ search: async () => assert.fail("cancelled provider call") }, 0.5, 0.02);
  await assert.rejects(allowance.provider.search({ query: "cancelled" }, cancelled.signal));
  assert.equal(allowance.snapshot.reservedDollars, 0);
  for (const [cap, bound] of [[0, 0.02], [1, 0], [Infinity, 0.02], [1, NaN]]) assert.throws(() => searchAllowance({ search: async () => [] }, cap!, bound!));
});

test("baseline and candidate default profile policies can be compared without provider calls", async () => {
  const observed: unknown[] = [];
  const provider = { search: async (query: unknown) => { observed.push(query); return []; } };
  const profile = retrievalProfile(PILOT_CASES.find(item => item.input.id === "pilot-direct-si-table")!.input.question);
  assert.equal(profile, "complete-list");
  await withProfile(provider, profile, false).search({ query: "SI base units" });
  await withProfile(provider, profile, true).search({ query: "SI base units" });
  assert.deepEqual(observed[0], { query: "SI base units" });
  assert.deepEqual(observed[1], { query: "SI base units", profile: "complete-list", policyVersion: RETRIEVAL_POLICY_VERSION });
});

test("pilot preparation starts no providers or ports and exports bounded structured run commands", () => {
  const directory = mkdtempSync(join(tmpdir(), "asof-pilot-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "eval/pilot.ts", "--out-dir", directory], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(readFileSync(join(directory, "run-plan.json"), "utf8"));
    const questions = JSON.parse(readFileSync(join(directory, "questions.json"), "utf8"));
    const initial = JSON.parse(readFileSync(join(directory, "initial-questions.json"), "utf8"));
    const labels = JSON.parse(readFileSync(join(directory, "reference-queue.json"), "utf8"));
    assert.equal(plan.preparedOnly, true);
    assert.equal(plan.providerRequestsMade, 0);
    assert.deepEqual(plan.ports, []);
    assert.equal(questions.length, 9);
    assert.equal(initial.length, 4);
    assert.equal(labels.labelStatus, "pending-human-adjudication");
    assert.ok(plan.commands.every((command: { args: string[] }) => command.args.includes("--max-search-dollars") && command.args.includes("0.50") && command.args.includes("--max-campaign-dollars")));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
