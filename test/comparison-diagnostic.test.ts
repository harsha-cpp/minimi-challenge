import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPARISON_SCENARIOS, runComparisonDiagnostic, summarizeComparison } from "../eval/comparison-regression.ts";
import { summarizeObservations, type HttpObservation } from "../eval/workload.ts";

const observation = (elapsedMs: number): HttpObservation => ({ clientStartedAt: "2026-11-17T00:00:00Z", clientFinishedAt: "2026-11-17T00:00:01Z",
  httpStatus: 200, accepted: true, doneReceived: true, durableCompleted: true, turnId: "fixture", outcome: "completed", errorCode: null,
  quality: "supported", clientFirstTextMs: elapsedMs, clientFirstFinalTextMs: elapsedMs, clientFirstRenderMs: null,
  serverFirstEmissionMs: elapsedMs, elapsedMs, searches: 2, modelCalls: 1, trace: null });

test("workload tail latency requires twenty samples within each denominator", () => {
  const nineteen = Array.from({length: 19}, (_, index) => observation(index + 1));
  assert.equal(summarizeObservations(nineteen).latency.completed.p50Ms, 10);
  assert.equal(summarizeObservations(nineteen).latency.completed.p95Ms, null);
  const twenty = [...nineteen, observation(20)];
  assert.equal(summarizeObservations(twenty).latency.completed.p95Ms, 19);
  const failed = {...observation(9000), outcome: "cancelled" as const, doneReceived: false, durableCompleted: false, errorCode: "client_deadline"};
  const mixed = summarizeObservations([...nineteen, failed]);
  assert.equal(mixed.latency.allTerminal.samples, 20); assert.equal(mixed.latency.completed.samples, 19);
  assert.equal(mixed.latency.completed.p95Ms, null); assert.equal(mixed.latency.failed.p95Ms, null);
  assert.equal(mixed.accepted, 20); assert.equal(mixed.durableCompletionRate, 19 / 20);
  assert.equal(mixed.clientDeadlineCancelled, 1);
});

test("five-user diagnostic exercises current comparison HTTP without real providers or hidden failures", async () => {
  const originalFetch = globalThis.fetch;
  let chats = 0;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\//, "diagnostic must never contact an external provider");
    if (url.endsWith("/api/chat")) chats++;
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    const report = await runComparisonDiagnostic({users: 5, turns: 25, mockDelayMs: 3});
    assert.equal(chats, COMPARISON_SCENARIOS.length + 25);
    assert.equal(report.externalProviderRequests, 0); assert.equal(report.providerWalletsOpened, 0);
    assert.equal(report.releaseClaimAllowed, false); assert.equal(report.basis, "scripted-provider-real-http");
    assert.equal(report.regressions.summary.behavior.passed, COMPARISON_SCENARIOS.length);
    assert.equal(report.regressions.summary.behavior.comparisonUnavailable, 1, "injected provider failure remains visible despite durable explanatory response");
    assert.equal(report.regressions.summary.behavior.unexpectedConfirmations, 0);
    assert.equal(report.regressions.summary.latency.completed.p95Ms, null);
    assert.equal(report.regressions.summary.behavior.independentHumanLabels, 0);
    assert.equal(report.regressions.summary.behavior.factualAccuracy, null);
    assert.equal(report.providers.forbiddenModelCalls, 0);
    assert.ok(report.providers.peakComparisons > 1 && report.providers.peakComparisons <= 2);
    assert.equal(report.workload.users, 5); assert.equal(report.workload.summary.completed, 25);
    assert.equal(report.workload.summary.behavior.passed, 25);
    assert.equal(report.workload.summary.latency.completed.samples, 25);
    assert.equal(typeof report.workload.summary.latency.completed.p95Ms, "number");
    assert.ok(report.workload.turns.every(row => row.modelCalls === 1 && row.originalAnswerPreserved && row.trace?.stages.some(stage => stage.name === "comparison")));
    assert.ok(report.workload.turns.every(row => row.clientFirstRenderMs === null));
    assert.ok(report.sourceFiles.some(file => file.path === "src/agent/comparison.ts"));
    assert.match(report.harnessHash, /^[a-f\d]{64}$/); assert.match(report.fixtureHash, /^[a-f\d]{64}$/);
    const missing = report.regressions.cases.find(row => row.caseId === "missing-item")!;
    assert.deepEqual(missing.actualCoverage, ["supported", "unresolved"]);
    assert.equal(summarizeComparison([{...missing, outcome: "error", doneReceived: false, durableCompleted: false, behaviorPassed: false, confirmedItems: 0, unnecessaryRefusal: true}]).behavior.passRate, 0);
  } finally { globalThis.fetch = originalFetch; }
});
