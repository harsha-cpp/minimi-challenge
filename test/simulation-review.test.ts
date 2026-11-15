import assert from "node:assert/strict";
import { test } from "node:test";
import type { Llm } from "../src/llm.ts";
import type { Source } from "../src/memory/store.ts";
import { reviewSimulationAnswer, type SimulationReviewInput } from "../src/agent/simulation.ts";

const viewpoint = new Date("1948-01-14T08:17:10.442Z");
const researchedAt = new Date("2026-11-14T12:00:00.000Z");
const source: Source = { n: 1, url: "https://example.com/history", title: "India's history",
  text: "India became independent on 15 August 1947.", publishedDate: "2025-08-15" };
const answer = "India is already independent, having gained independence on 15 August 1947 [1].";
type Request = Parameters<Llm["json"]>[0];

function checker(result: unknown | ((request: Request) => unknown)) {
  const requests: Request[] = [];
  return { requests, llm: { json: async (request: Request) => {
    requests.push(request); return typeof result === "function" ? result(request) : result;
  } } };
}

const ask = (llm: Pick<Llm, "json">, overrides: Partial<SimulationReviewInput> = {}) =>
  reviewSimulationAnswer({ llm, question: "Will India get independence?", answer, sources: [source], viewpoint, researchedAt, tz: "Asia/Kolkata", ...overrides });

test("live retrospective evidence is admitted without capture or publication-date gates", async () => {
  const check = checker({ status: "approved", issues: [], safeAnswer: null });
  const result = await ask(check.llm);
  assert.equal(result.status, "approved");
  assert.equal(result.modelCalls, 1);
  const payload = JSON.parse(check.requests[0]!.user);
  assert.equal(payload.viewpoint, viewpoint.toISOString());
  assert.equal(payload.actualResearchTime, researchedAt.toISOString());
  assert.equal(payload.sources[0].publishedDate, "2025-08-15");
  assert.equal(payload.sources[0].text, source.text);
  assert.doesNotMatch(check.requests[0]!.user, /snapshotAsOf|availableAt|capturedAt/);
  assert.match(check.requests[0]!.system, /NEVER reject evidence because a source was published/);
});

test("a material issue returns actionable correction and a valid cited safe answer", async () => {
  const check = checker({ status: "needs_revision", issues: [{ code: "wrong_perspective", detail: "Independence has already happened by the selected date." }], safeAnswer: answer });
  const result = await ask(check.llm, { answer: "India may get independence soon [1]." });
  assert.equal(result.status, "needs_revision");
  assert.equal(result.issues[0]!.code, "wrong_perspective");
  assert.equal(result.safeAnswer, answer);
});

test("unavailable citations cannot be approved by a compliant reviewer", async () => {
  const check = checker({ status: "approved", issues: [] });
  const result = await ask(check.llm, { answer: "India is independent [99]." });
  assert.equal(result.status, "needs_revision");
  assert.equal(result.issues[0]!.code, "missing_citation");
  assert.equal(result.modelCalls, 0);
  assert.equal(check.requests.length, 0);
});

test("a fabricated correction citation cannot erase the negative verdict", async () => {
  const check = checker({ status: "needs_revision", issues: [{ code: "missing_citation", detail: "Use the provided history source." }], safeAnswer: "India became independent [99]." });
  const result = await ask(check.llm);
  assert.equal(result.status, "needs_revision");
  assert.equal(result.reason, "invalid_review_output");
  assert.equal(result.safeAnswer, undefined);
});

test("future scenarios, uncertain forecasts and modern products are distinguished in the audit", async () => {
  const check = checker({ status: "approved", issues: [] });
  await ask(check.llm, { viewpoint: new Date("2030-01-01T00:00:00Z"), question: "What might transport look like today?", answer: "A hypothetical scenario could include more electric buses; this is an assumption." });
  const system = check.requests[0]!.system;
  assert.match(system, /uncertain hypothetical forecast is allowed/);
  assert.match(system, /beyond actual research time are assumptions/);
  assert.match(system, /product or technology unavailable at the viewpoint cannot be recommended/);
  assert.match(system, /A modern office-holder list with term dates/);
  assert.match(system, /Date-only histories/);
});

test("the reviewer receives the selected local calendar across a midnight boundary", async () => {
  const check = checker({ status: "approved", issues: [] });
  await ask(check.llm, { viewpoint: new Date("1947-08-14T18:45:00.000Z") });
  const payload = JSON.parse(check.requests[0]!.user);
  assert.equal(payload.viewpoint, "1947-08-14T18:45:00.000Z");
  assert.equal(payload.viewpointTimeZone, "Asia/Kolkata");
  assert.match(payload.calendarViewpoint, /15 August 1947/);
});

test("malformed or internally inconsistent review output remains a soft review failure", async () => {
  for (const raw of [null, [], {}, { status: true, issues: [] }, { status: "approved", issues: [{ code: "wrong_perspective", detail: "Not approved" }] },
    { status: "needs_revision", issues: [] }, { status: "needs_revision", issues: [{ code: "invented", detail: "Unknown issue" }] },
    { status: "needs_revision", issues: [{ code: "unsupported_claim", detail: "" }] }]) {
    const result = await ask(checker(raw).llm);
    assert.equal(result.status, raw && !Array.isArray(raw) && raw.status === "needs_revision" ? "needs_revision" : "unavailable");
    assert.equal(result.reason, "invalid_review_output");
    if (result.status === "unavailable") assert.deepEqual(result.issues, []);
    else assert.ok(result.issues.length > 0);
  }
});

test("a negative verdict survives an absent, empty or oversized correction", async () => {
  for (const safeAnswer of [undefined, null, "", "a".repeat(6001), "a".repeat(20_000)]) {
    const result = await ask(checker({ status: "needs_revision", issues: [{ code: "wrong_perspective", detail: "Correct the date." }], safeAnswer }).llm);
    assert.equal(result.status, "needs_revision");
    assert.equal(result.reason, "invalid_review_output");
    assert.equal(result.safeAnswer, undefined);
  }
});

test("a reviewer outage does not manufacture a refusal or source access error", async () => {
  const result = await ask({ json: async () => { throw new Error("internal outage"); } });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "review_unavailable");
  assert.equal(result.safeAnswer, undefined);
  assert.deepEqual(result.issues, []);
  assert.doesNotMatch(JSON.stringify(result), /internal outage|could not verify|Snapshot|HTTP/);
});

test("review deadline is enforced even when the model ignores its signal", async () => {
  const keepAlive = setTimeout(() => {}, 100);
  try {
    const result = await ask({ json: async () => new Promise(() => {}) }, { timeoutMs: 5 });
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "review_timeout");
  } finally { clearTimeout(keepAlive); }
});

test("caller cancellation prevents returning any review verdict", async () => {
  const abort = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = ask({ json: async () => { entered(); return new Promise(() => {}); } }, { signal: abort.signal });
  await started;
  abort.abort(new Error("user cancelled"));
  await assert.rejects(pending, /user cancelled/);
});
