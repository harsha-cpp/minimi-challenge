
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runTurn, type AgentEvent } from "../src/agent/run.ts";
import { loadConfig } from "../src/config.ts";
import { createLlm, type Llm } from "../src/llm.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { createExaSearch, withCache, withConcurrency, type SearchProvider } from "../src/search.ts";
import { parseInstant } from "../src/time/instant.ts";
import { SEARCH_CASES } from "./search-quality.ts";
import { FIXTURES, FROZEN_FIXTURE_VERSION, fixtureManifest, type Fixture } from "./benchmark/fixtures.ts";
import { caseInputHash, generationInput, scoreSample, summarize, type BenchmarkCase, type BenchmarkSample, type RawRetrievalBatch } from "./benchmark/score.ts";
import type { Source } from "../src/memory/store.ts";
import { AdmissionPool, ModelBudget, ModelQuota, createModelGateway, runWithModelContext, type ModelCallTrace } from "../src/llm/gateway.ts";
import { searchAllowance } from "./pilot/budget.ts";
import { retrievalProfile, withProfile } from "../src/search/profiles.ts";
import { turnPolicy } from "../src/agent/prepare.ts";
import { finishTrace, newTrace, recordStage, recordUsage, serverEmission, withTrace } from "../src/runtime/telemetry.ts";

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--live") continue;
  if (!["--out", "--dataset", "--baseline", "--max-campaign-dollars", "--max-search-dollars", "--policy"].includes(args[i]!)) throw new Error(`Unknown benchmark option: ${args[i]}`);
  i++;
}
const option = (name: string) => { const i = args.indexOf(name); if (i < 0) return undefined; if (!args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error(`${name} requires a path`); return args[i + 1]!; };
const live = args.includes("--live");
const maxCampaignDollars = option("--max-campaign-dollars") === undefined ? null : Number(option("--max-campaign-dollars"));
if (live && (maxCampaignDollars === null || !Number.isFinite(maxCampaignDollars) || maxCampaignDollars <= 0)) throw new Error("Live benchmarking requires an explicit positive --max-campaign-dollars cap before any provider calls.");
const maxSearchDollars = option("--max-search-dollars") === undefined ? null : Number(option("--max-search-dollars"));
if (maxSearchDollars !== null && (!Number.isFinite(maxSearchDollars) || maxSearchDollars <= 0)) throw new Error("--max-search-dollars must be positive.");
const retrievalPolicy = option("--policy") ?? "baseline";
if (!["baseline", "profiles-v1"].includes(retrievalPolicy)) throw new Error("--policy must be baseline or profiles-v1.");
if (!live) {
  const expected = JSON.parse(readFileSync(new URL("./benchmark/frozen-manifest.json", import.meta.url), "utf8"));
  if (expected.version !== FROZEN_FIXTURE_VERSION || JSON.stringify(expected.fixtures) !== JSON.stringify(fixtureManifest(FIXTURES))) {
    throw new Error("Frozen fixture manifest mismatch; version and review the changed fixtures.");
  }
}
const out = resolve(option("--out") ?? ".context/benchmark.json");
const datasetPath = option("--dataset");
const baselinePath = option("--baseline");
const dataset: BenchmarkCase[] = datasetPath ? JSON.parse(readFileSync(datasetPath, "utf8")) as BenchmarkCase[] : live
  ? SEARCH_CASES.map(item => ({ id: item.id, question: item.query.urls ? `${item.query.query}. Read ${item.query.urls.join(", ")}.` : item.query.query, asOf: item.query.asOf?.toISOString() }))
  : FIXTURES.map(f => f.task);
if (!Array.isArray(dataset) || !dataset.length || dataset.length > 500) throw new Error("Expected 1 to 500 benchmark cases.");
const ids = new Set<string>();
for (const item of dataset) {
  if (!item || typeof item.id !== "string" || ids.has(item.id) || typeof item.question !== "string" || item.question.length > 8000 || !item.question.trim()) throw new Error("Invalid or duplicate benchmark case.");
  if (item.asOf !== undefined && !parseInstant(item.asOf)) throw new Error(`Invalid asOf for ${item.id}`);
  if (item.tz !== undefined) { try { new Intl.DateTimeFormat("en", { timeZone: item.tz }); } catch { throw new Error(`Invalid timezone for ${item.id}`); } }
  for (const grade of Object.values(item.sourceGrades ?? {})) if (!Number.isInteger(grade) || grade < 0 || grade > 3) throw new Error("Source grades must be 0 to 3.");
  for (const terms of [item.requiredFacts, item.forbiddenFacts]) if (terms !== undefined && (!Array.isArray(terms) || terms.some(t => typeof t !== "string"))) throw new Error("Fact labels must be arrays of strings.");
  if (item.history !== undefined && (!Array.isArray(item.history) || item.history.some(past => !past
    || past.scope !== undefined && !["conversation", "memory"].includes(past.scope)))) throw new Error("Invalid history scope.");
  ids.add(item.id);
}
if (datasetPath && !live) throw new Error("Custom datasets require --live; synthetic replay uses its versioned fixtures.");

// Capture the code identity before constructing or invoking any paid provider adapter.
const sourceSnapshotAt = new Date().toISOString();
const implementationHash = createHash("sha256").update([
    "src/agent/run.ts", "src/agent/citations.ts", "src/agent/simulation.ts", "src/agent/prompt.ts", "src/agent/prepare.ts", "src/agent/context.ts", "src/agent/evidence.ts", "src/agent/clarification.ts",
    "src/llm.ts", "src/llm/responses.ts", "src/llm/gateway.ts", "src/config.ts", "src/clock.ts", "src/server.ts",
    "src/runtime/spend-store.ts", "src/runtime/provider-spending.ts", "src/runtime/provider-readiness.ts", "src/runtime/spend-scope.ts", "src/runtime/telemetry.ts", "src/runtime/access.ts", "src/runtime/sse.ts",
    "src/memory/store.ts", "src/memory/recall.ts", "src/memory/enrich.ts", "src/memory/questions.ts",
    "src/search/exa.ts", "src/search/cache.ts", "src/search/validate.ts", "src/search/limit.ts", "src/search/profiles.ts", "src/search/types.ts",
    "public/citations.js", "package-lock.json", "eval/benchmark.ts", "eval/benchmark/fixtures.ts", "eval/benchmark/score.ts", "eval/pilot/budget.ts",
  ].map(file => file + "\n" + readFileSync(file, "utf8")).join("\n")).digest("hex");

let model: Llm | undefined;
let reviewer: Llm | undefined;
let search: SearchProvider | undefined;
let modelName: string | null = null;
let createBudget: ((remainingDollars: number) => ModelBudget) | undefined;
let timeoutMs = 120_000;
let campaignReservedDollars = 0;
let searchCampaign: ReturnType<typeof searchAllowance> | undefined;
let runtimeModel: { deployment: string; reviewDeployment: string; apiMode: string; reasoningEffort: string | null } | null = null;
let priceIdentity: { version: string; inputDollarsPerMillion: number; outputDollarsPerMillion: number; deploymentEnvelopeHash: string; meaning: string } | null = null;
const modelTrace = (call: ModelCallTrace) => {
  recordStage("model_queue", call.queueMs, { purpose: call.purpose, priority: call.priority });
  recordStage("model_call", call.durationMs, { purpose: call.purpose, outcome: call.outcome, providerStarted: call.providerStarted, firstDeltaMs: call.firstDeltaMs,
    spendEstimateUsd: call.budget.spendUsd, priceVersion: call.budget.priceVersion });
  if (call.providerStarted) recordUsage(call.usage ?? undefined);
};
if (live) {
  const config = loadConfig();
  if (!config.llm || !config.exaApiKey) {
    console.error(`Live benchmark was not run. Missing configuration: ${config.missing.join(", ")}.`);
    process.exit(1);
  }
  if (config.limits.inputDollarsPerMillion === null || config.limits.outputDollarsPerMillion === null || config.limits.searchAttemptDollars == null) {
    throw new Error("Cost-capped live evaluation requires INPUT_DOLLARS_PER_MILLION, OUTPUT_DOLLARS_PER_MILLION and SEARCH_MAX_ATTEMPT_DOLLARS. No provider calls were made.");
  }
  const pool = new AdmissionPool({ maxActive: config.limits.activeModels, maxQueued: config.limits.queuedModels });
  const quota = new ModelQuota({ requestsPerMinute: config.limits.modelRequestsPerMinute, tokensPerMinute: config.limits.modelTokensPerMinute });
  createBudget = remainingDollars => new ModelBudget({ maxCalls: config.limits.turnModelCalls, maxTokens: config.limits.turnTokens,
    maxSpendUsd: Math.min(config.limits.maxTurnDollars, remainingDollars), prices: { version: process.env.MODEL_PRICE_VERSION ?? "operator-v1",
      inputPerMillionUsd: config.limits.inputDollarsPerMillion!, outputPerMillionUsd: config.limits.outputDollarsPerMillion! } });
  timeoutMs = config.limits.turnTimeoutMs;
  runtimeModel = { deployment: config.llm.model, reviewDeployment: config.llm.model, apiMode: config.llm.apiMode ?? "chat_completions", reasoningEffort: config.llm.reasoningEffort ?? null };
  priceIdentity = { version: process.env.MODEL_PRICE_VERSION ?? "operator-v1", inputDollarsPerMillion: config.limits.inputDollarsPerMillion,
    outputDollarsPerMillion: config.limits.outputDollarsPerMillion,
    deploymentEnvelopeHash: createHash("sha256").update(process.env.MODEL_DEPLOYMENT_PRICES_JSON ?? "").digest("hex"),
    meaning: "Operator price envelopes used for admission and priced-usage estimates, not an invoice or a verified deployment SKU price." };
  model = createModelGateway(createLlm(config.llm), { pool, quota, outputTokens: config.limits.maxOutputTokens, onCall: modelTrace });
  reviewer = createModelGateway(createLlm({ ...config.llm, fastModel: config.llm.model }), { pool, quota, onCall: modelTrace });
  modelName = config.llm.model;
  search = withCache(withConcurrency(createExaSearch(config.exaApiKey, { maxAttemptCostDollars: config.limits.searchAttemptDollars })));
  if (maxSearchDollars !== null) {
    searchCampaign = searchAllowance(search, maxSearchDollars, config.limits.searchAttemptDollars);
    search = searchCampaign.provider;
  }
}
const samples: BenchmarkSample[] = [];
for (const task of dataset) {
  const input = generationInput(task);
  const fixture = FIXTURES.find(f => f.task.id === task.id);
  const deps = live ? { llm: model!, verifier: reviewer!, search: search! } : fixtureDeps(fixture!);
  const store = new MemoryStore(":memory:");
  try {
    for (const past of input.history ?? []) {
      const at = parseInstant(past.at);
      if (!at) throw new Error(`Invalid history timestamp for ${task.id}`);
      store.saveEpisode({ sessionId: past.scope === "memory" ? "other-benchmark-conversation" : "benchmark",
        askedAt: at.getTime(), tz: "UTC", question: past.question, answer: past.answer, sources: [] });
    }
    const now = task.asOf ? new Date(task.asOf) : new Date();
    const events: AgentEvent[] = [];
    const rawRetrieval: RawRetrievalBatch[] = [];
    let admittedEvidence: Source[] = [];
    const observedSearch: SearchProvider = { search: async (query, signal) => {
      const hits = await deps.search.search(query, signal);
      rawRetrieval.push({ queryId: `query-${rawRetrieval.length + 1}`, hits: structuredClone(hits) });
      return hits;
    } };
    const started = performance.now();
    const deadlineAt = Date.now() + timeoutMs;
    const remainingDollars = live ? Math.max(0, maxCampaignDollars! - campaignReservedDollars) : null;
    const budget = remainingDollars !== null && remainingDollars > 0 ? createBudget!(remainingDollars) : undefined;
    const trace = newTrace(`benchmark-${task.id}`, modelName, input.asOf ? "era" : "live");
    const policy = turnPolicy(input.question, Boolean(input.asOf));
    const profiledSearch = withProfile(observedSearch, retrievalProfile(input.question, { simulated: Boolean(input.asOf), verify: policy.requireVerificationEvidence }), retrievalPolicy === "profiles-v1");
    const invoke = () => runTurn({ ...deps, search: profiledSearch, store, clock: { now: () => now, simulated: Boolean(input.asOf) }, enricher: { schedule() {} },
      onEvidence: sources => { admittedEvidence = sources; } },
      { sessionId: "benchmark", message: input.question, tz: input.tz ?? "UTC", asOf: input.asOf ? now : undefined, deadlineAt }, event => {
        if (event.type === "text") serverEmission();
        events.push(structuredClone(event));
      });
    await withTrace(trace, async () => {
      if (live && !budget) events.push({ type: "error", code: "campaign_budget", message: "Campaign budget exhausted; no provider work started." });
      else if (budget) await runWithModelContext({ ownerId: "benchmark", turnId: task.id, deadlineAt,
        deadlineReserveMs: Math.min(12_000, Math.floor(timeoutMs / 3)), budget }, invoke);
      else await invoke();
      const terminal = events.findLast(event => event.type === "done" || event.type === "error");
      finishTrace(terminal?.type === "done" ? "completed" : terminal?.type === "error" ? terminal.code ?? "failed" : "failed");
    });
    const spent = budget?.snapshot;
    // Unknown cannot release campaign capacity. With explicit prices/attempt bounds this is normally
    // a numeric conservative charge; an unaccountable result closes the rest of the campaign.
    if (budget) campaignReservedDollars = spent?.spendUsd == null ? maxCampaignDollars! : campaignReservedDollars + spent.spendUsd;
    const done = events.findLast(e => e.type === "done");
    const failure = events.findLast(e => e.type === "error");
    const episode = done ? store.episode(done.episodeId) : null;
    samples.push({ caseId: task.id, engine: "asof-exa", basis: live ? "live" : "synthetic-replay", capturedAt: new Date().toISOString(), inputHash: caseInputHash(task),
      answer: episode?.answer ?? "", sources: done ? store.sourcesFor(done.episodeId) : [], rawRetrieval, admittedEvidence, quality: done?.quality,
      trace, review: episode?.execution?.review as Record<string, unknown> | undefined,
      latencyMs: done?.timings.totalMs ?? Math.round(performance.now() - started),
      firstTokenMs: done?.timings.firstTokenMs, searches: done?.timings.searches, modelCalls: done?.timings.modelCalls,
      serverFirstEmissionMs: done?.timings.firstTokenMs ?? null, clientFirstRenderMs: null,
      ...(spent ? { spend: { dollars: spent.spendUsd, isEstimated: true, priceVersion: spent.priceVersion,
        missingModelUsage: spent.missingUsageCalls, missingSearchUsage: spent.unknownExternalUsage } } : {}),
      ...(failure ? { error: failure.message } : {}),
    });
  } finally { store.close(); }
}
if (baselinePath) {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as BenchmarkSample[];
  if (!Array.isArray(baseline)) throw new Error("Baseline must be an array of recorded samples.");
  for (const sample of baseline) {
    if (!sample || !ids.has(sample.caseId) || typeof sample.engine !== "string" || sample.engine === "asof-exa" || sample.basis !== "recorded" || !parseInstant(sample.capturedAt) || typeof sample.answer !== "string" || !Array.isArray(sample.sources)) throw new Error("Invalid recorded baseline sample.");
    if (sample.inputHash !== caseInputHash(dataset.find(item => item.id === sample.caseId)!)) throw new Error("Baseline input hash does not match the question, time and history.");
    if (samples.some(s => s.caseId === sample.caseId && s.engine === sample.engine)) throw new Error("Duplicate baseline sample.");
    if (sample.latencyMs !== null && (typeof sample.latencyMs !== "number" || !Number.isFinite(sample.latencyMs) || sample.latencyMs < 0)) throw new Error("Invalid baseline latency.");
    for (const source of sample.sources) if (typeof source.url !== "string" || !/^https?:$/.test(new URL(source.url).protocol) || !Number.isInteger(source.n) || source.n < 1) throw new Error("Invalid baseline source.");
    samples.push(sample);
  }
}
const rows = samples.map(sample => ({ sample, scores: scoreSample(dataset.find(task => task.id === sample.caseId)!, sample) }));
const comparisonEngines = [...new Set(samples.filter(s => s.engine !== "asof-exa").map(s => s.engine))];
const report = {
  version: 4, createdAt: new Date().toISOString(), datasetHash: createHash("sha256").update(JSON.stringify(dataset)).digest("hex"),
  frozenFixtures: live ? null : { version: FROZEN_FIXTURE_VERSION, manifest: fixtureManifest(FIXTURES) },
  runtime: { node: process.version, model: modelName, sourceModel: runtimeModel, prices: priceIdentity, backgroundEnrichment: false, retrievalPolicy },
  campaign: { maxDollars: maxCampaignDollars, chargedOrReservedDollars: live ? campaignReservedDollars : null,
    searchAllowance: searchCampaign?.snapshot ?? null,
    accounting: "One shared per-turn model/search budget; unknown usage retains conservative reservations. Search retries are charged per physical attempt, never per returned hit." },
  implementationHash, sourceSnapshotAt,
  mode: live ? "live-foreground" : "synthetic-pipeline-regression", comparisonStatus: comparisonEngines.length ? "recorded-baselines-supplied" : "no-competitor-recordings",
  scope: "Foreground pipeline; enrichment disabled. Raw provider rankings, admitted passages and final cited evidence are distinct. Retrieval nDCG/MRR/recall are the mean of per-query raw batches with unjudged URLs counted as zero and reported; absent raw candidates leave retrieval metrics null. Selected-source metrics describe citation selection only. Scripted synthetic review verdicts test plumbing, not model quality. Exact-string metrics do not establish correctness or citation entailment. Human calibration and live release gates are separate; neither is asserted by this report. Live cost accounting includes failed attempts and retains conservative bounds for unknown usage; it excludes enrichment and evaluator/human costs.",
  cases: dataset, summary: summarize(rows), outcomes: rows,
  pairedCoverage: comparisonEngines.map(engine => {
    const sharedCases = dataset.filter(task => samples.some(s => s.engine === engine && s.caseId === task.id)).map(task => task.id);
    return { engine, sharedCases, missingCases: dataset.filter(task => !sharedCases.includes(task.id)).map(task => task.id),
      pairedSummary: summarize(rows.filter(row => [engine, "asof-exa"].includes(row.sample.engine) && sharedCases.includes(row.sample.caseId))) };
  }),
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(`Private benchmark report saved: ${out}`);
if (rows.filter(r => r.sample.engine === "asof-exa").some(row => !row.scores.succeeded || row.scores.forbiddenFactPresent || row.scores.invalidCitationReferences > 0 || row.scores.temporalPolicyViolations || row.scores.abstentionCorrect === false
  || (!live && row.scores.requiredFactMatchRate !== null && row.scores.requiredFactMatchRate < 1))) process.exitCode = 1;

function fixtureDeps(fixture: Fixture): { llm: Llm; search: SearchProvider } {
  let step = 0;
  return {
    llm: {

      json: async ({ user }) => {
        const payload = JSON.parse(user) as { draft: string };
        return fixture.correction && payload.draft === fixture.answer
          ? { status: "needs_revision", issues: [{ code: "temporal_leakage", detail: fixture.correction.issue }], safeAnswer: fixture.correction.answer }
          : fixture.task.id === "present-verification" ? { status: "approved", issues: [], safeAnswer: null, quality: "supported", claimChecks: [
            { claim: fixture.answer, sourceNumbers: [1], supported: true, applicable: true },
          ] } : { status: "approved", issues: [], safeAnswer: null };
      },
      stream: async request => {
        if (request.messages.some(m => typeof m.content === "string" && m.content.includes("FUTURE_SENTINEL"))) {
          request.onText("FUTURE_SENTINEL"); return { text: "FUTURE_SENTINEL", toolCalls: [] };
        }
        if (fixture.task.id === "memory-visibility" && !request.messages.some(message => typeof message.content === "string"
          && message.content.includes("VISIBLE_CONTEXT_SENTINEL"))) {
          const text = "The visible conversation context is missing.";
          request.onText(text); return { text, toolCalls: [] };
        }
        if (!fixture.noSearch && step++ === 0) return { text: "", toolCalls: [{ id: "fixture-search", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: fixture.task.question }) } }] };
        const answer = fixture.correction && request.messages.some(message => message.role === "system" && message.content.startsWith("Revise the draft"))
          ? fixture.correction.answer : fixture.answer;
        request.onText(answer); return { text: answer, toolCalls: [] };
      },
    },
    search: { search: async query => {
      if (query.asOf) throw new Error("Era simulation must research live pages without a snapshot cutoff.");
      return structuredClone(fixture.hits);
    } },
  };
}
