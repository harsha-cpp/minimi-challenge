/** Private live-web era-simulation benchmark. No APIs are called without --live. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runTurn, type AgentEvent } from "../src/agent/run.ts";
import { loadConfig } from "../src/config.ts";
import { createLlm, type LlmUsage } from "../src/llm.ts";
import { MemoryStore, type Source } from "../src/memory/store.ts";
import { createExaSearch, withConcurrency, type SearchProvider } from "../src/search.ts";
import { SIMULATION_CASES, type SimulationCase } from "./simulation/cases.ts";
import { deterministicChecks, judgeAnswer, percentile, type Judgment } from "./simulation/score.ts";

const args = process.argv.slice(2);
let live = false, output = ".context/simulation-benchmark.json", concurrency = 3, limit = SIMULATION_CASES.length, currentBaseline = true;
let selected: string[] | undefined;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--live") { live = true; continue; }
  if (arg === "--no-current-baseline") { currentBaseline = false; continue; }
  if (arg === "--help") {
    console.log("Usage: npm run eval:simulation -- [--live] [--out path.json] [--concurrency 1-3] [--limit N] [--case id[,id]] [--no-current-baseline]");
    process.exit(0);
  }
  const value = args[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`Unknown or incomplete simulation benchmark option: ${arg}`);
  if (arg === "--out") output = value;
  else if (arg === "--case") selected = value.split(",");
  else if (arg === "--concurrency") {
    concurrency = Number(value);
    if (!/^\d+$/.test(value) || concurrency < 1 || concurrency > 3) throw new Error("Concurrency must be an integer from 1 to 3.");
  } else if (arg === "--limit") {
    limit = Number(value);
    if (!/^\d+$/.test(value) || limit < 1 || limit > SIMULATION_CASES.length) throw new Error(`Limit must be an integer from 1 to ${SIMULATION_CASES.length}.`);
  } else throw new Error(`Unknown simulation benchmark option: ${arg}`);
  i++;
}
if (selected?.some(id => !SIMULATION_CASES.some(task => task.id === id))) throw new Error("Unknown simulation benchmark case ID.");
const tasks = SIMULATION_CASES.filter(task => !selected || selected.includes(task.id)).slice(0, limit);
if (!tasks.length) throw new Error("No simulation cases selected.");
const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const implementationFiles = ["src/agent/run.ts", "src/agent/prompt.ts", "src/agent/prepare.ts", "src/agent/evidence.ts", "src/agent/simulation.ts", "src/search/exa.ts", "src/search/validate.ts", "src/llm.ts", "src/llm/responses.ts", "eval/simulation.ts", "eval/simulation/cases.ts", "eval/simulation/score.ts", "package-lock.json"];
const implementationHash = () => hash(implementationFiles.map(file => `${file}\n${readFileSync(file, "utf8")}`).join("\n"));
const initialHash = implementationHash();
const out = resolve(output);
const startedAt = new Date().toISOString();
const config = live ? loadConfig() : null;
if (live && (!config?.llm || !config.exaApiKey)) throw new Error("Live simulation benchmark requires configured LLM_API_KEY, LLM_MODEL and EXA_API_KEY.");

interface NetworkObservation { endpoint: string; snapshotRequested: boolean; archiveRequested: boolean }
interface SearchObservation { cutoff: string | null; elapsedMs: number; results: number; failed: boolean }
interface Trial {
  id: string;
  caseId: string;
  track: "era-simulation" | "present-date-baseline";
  split: SimulationCase["split"];
  category: string;
  viewpoint: string;
  question: string;
  inputHash: string;
  completed: boolean;
  passed: boolean;
  deterministicPassed: boolean;
  checks: Record<string, boolean>;
  judgment: Judgment;
  answer: string;
  answerHash: string;
  sources: Source[];
  execution: Record<string, unknown> | null;
  engineMs: number;
  firstWordMs: number | null;
  judgeMs: number;
  totalCaseMs: number;
  searches: SearchObservation[];
  network: NetworkObservation[];
  usage: Array<LlmUsage & { phase: "generation" | "review" | "evaluation" }>;
  precedingTurn?: { answer: string; completed: boolean; timings: unknown };
  implementationHash: string;
  implementationEndHash: string;
  error?: string;
}
const trials: Trial[] = [];
const requestContext = new AsyncLocalStorage<NetworkObservation[]>();
const hasSnapshot = (value: unknown): boolean => Boolean(value && typeof value === "object" && Object.entries(value).some(([key, item]) => key === "snapshotAsOf" || hasSnapshot(item)));
const http: typeof fetch = async (input, init) => {
  const address = input instanceof Request ? input.url : String(input);
  let payload: unknown;
  try { payload = typeof init?.body === "string" ? JSON.parse(init.body) : undefined; } catch {}
  const observation: NetworkObservation = { endpoint: new URL(address).origin + new URL(address).pathname,
    snapshotRequested: hasSnapshot(payload), archiveRequested: /web\.archive\.org/.test(address) || Boolean(payload && typeof payload === "object" && "ids" in payload && /web\.archive\.org/.test(JSON.stringify(payload.ids))) };
  requestContext.getStore()?.push(observation);
  // This benchmark must never accidentally reintroduce paid Snapshot/URL-archive dependency.
  if (observation.snapshotRequested || observation.archiveRequested) throw new Error("Simulation attempted a forbidden historical capture request.");
  return fetch(input, init);
};
const exa = live ? withConcurrency(createExaSearch(config!.exaApiKey!, { fetch: http }), 4) : null;

function aggregate(rows: Trial[]) {
  const complete = rows.filter(row => row.completed);
  const usage = rows.flatMap(row => row.usage);
  return {
    trials: rows.length, completed: complete.length, passed: rows.filter(row => row.passed).length,
    deterministicPassed: rows.filter(row => row.deterministicPassed).length,
    judgedPassed: rows.filter(row => row.judgment.available && row.judgment.checks.every(check => check.passed)).length,
    judgeUnavailable: rows.filter(row => !row.judgment.available).length,
    errors: rows.filter(row => row.error).length,
    engineP50Ms: percentile(complete.map(row => row.engineMs), .5), engineP95Ms: percentile(complete.map(row => row.engineMs), .95),
    firstWordP50Ms: percentile(complete.flatMap(row => row.firstWordMs === null ? [] : [row.firstWordMs]), .5),
    searchRequests: rows.reduce((sum, row) => sum + row.searches.length, 0),
    snapshotRequests: rows.flatMap(row => row.network).filter(item => item.snapshotRequested).length,
    archiveRequests: rows.flatMap(row => row.network).filter(item => item.archiveRequested).length,
    inputTokens: usage.reduce((sum, item) => sum + item.inputTokens, 0), outputTokens: usage.reduce((sum, item) => sum + item.outputTokens, 0),
    reasoningTokens: usage.reduce((sum, item) => sum + item.reasoningTokens, 0),
    evaluationInputTokens: usage.filter(item => item.phase === "evaluation").reduce((sum, item) => sum + item.inputTokens, 0),
    evaluationOutputTokens: usage.filter(item => item.phase === "evaluation").reduce((sum, item) => sum + item.outputTokens, 0),
  };
}

function save(complete: boolean) {
  const report = {
    version: 1, mode: live ? "live-web-era-simulation" : "preflight-no-api-calls", complete,
    startedAt, updatedAt: new Date().toISOString(), datasetHash: hash(tasks), implementationHash: initialHash, implementationEndHash: implementationHash(),
    scope: "16 developer-authored simulation cases (3 prior bug regressions, 13 new probes) plus up to 3 matched present-date stable-fact baselines. No curated corpus, seeded evidence, supplied source URLs or stored captures. Preflight validates case definitions only. Live scores combine explicit software checks and a separate model assessment against evaluator-only criteria; they are not a universal factual-accuracy estimate, independent human review, hindsight-free backtest or competitor comparison. Single sample per case; failures are retained. Exact reference labels are evaluator-only and never sent to answer generation. API cost is not measured.",
    settings: { concurrency, live, localSearchCache: false, exaInternalCache: "normal production default", backgroundEnrichment: false,
      mainModel: config?.llm?.model ?? null, reviewModel: config?.llm?.model ?? null, evaluationModel: config?.llm?.model ?? null, currentDateBaseline: currentBaseline,
      baselineMeaning: "Same stable historical-fact question and live search stack, with present rather than simulated clock. Measures simulation overhead, not competitors or old Snapshot performance.",
      timingMeaning: "engineMs covers the scored final turn including research/review; judgeMs is separate. Context-followup preceding turn is recorded separately. p95 is nearest-rank on a small, concurrently run sample and can be load-sensitive." },
    plannedSimulationCases: tasks.length, plannedCurrentBaselines: currentBaseline ? tasks.filter(task => task.pairedCurrent).length : 0,
    cases: tasks,
    summary: live ? { simulation: aggregate(trials.filter(row => row.track === "era-simulation")), currentBaseline: aggregate(trials.filter(row => row.track === "present-date-baseline")),
      bySplit: Object.fromEntries(["regression", "probe"].map(split => [split, aggregate(trials.filter(row => row.track === "era-simulation" && row.split === split))])),
      paired: tasks.filter(task => task.pairedCurrent).flatMap(task => {
        const era = trials.find(row => row.caseId === task.id && row.track === "era-simulation"), now = trials.find(row => row.caseId === task.id && row.track === "present-date-baseline");
        return era && now ? [{ caseId: task.id, simulationPassed: era.passed, currentPassed: now.passed, simulationEngineMs: era.engineMs, currentEngineMs: now.engineMs, simulationOverheadMs: era.engineMs - now.engineMs }] : [];
      }),
    } : null,
    trials,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.tmp`, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${out}.tmp`, out);
}

async function trial(task: SimulationCase, present: boolean): Promise<Trial> {
  const wall = performance.now(), sourceHash = implementationHash();
  const network: NetworkObservation[] = [], searches: SearchObservation[] = [];
  const usage: Trial["usage"] = [];
  const store = new MemoryStore(":memory:");
  const view = present ? new Date() : new Date(task.asOf);
  const id = `${task.id}:${present ? "present" : "era"}`;
  let error: string | undefined, answer = "", sources: Source[] = [], execution: Record<string, unknown> | null = null;
  let precedingTurn: Trial["precedingTurn"], engineMs = 0, firstWordMs: number | null = null, completed = false;
  let judgment: Judgment = { available: false, checks: [], reason: "engine_not_completed" }, judgeMs = 0;
  const search: SearchProvider = { search: async (query, signal) => {
    const start = performance.now();
    const log: SearchObservation = { cutoff: query.asOf?.toISOString() ?? null, elapsedMs: 0, results: 0, failed: false };
    searches.push(log);
    try { const hits = await exa!.search(query, signal); log.results = hits.length; return hits; }
    catch (failure) { log.failed = true; throw failure; }
    finally { log.elapsedMs = Math.round(performance.now() - start); }
  } };
  try {
    const llm = createLlm(config!.llm!, { onUsage: item => usage.push({ ...item, phase: "generation" }) });
    const reviewer = createLlm({ ...config!.llm!, fastModel: config!.llm!.model }, { onUsage: item => usage.push({ ...item, phase: "review" }) });
    const deps = { llm, verifier: reviewer, search, store, clock: { now: () => view, simulated: !present }, enricher: { schedule() {} } };
    if (task.precedingQuestion) {
      const priorEvents: AgentEvent[] = [];
      await requestContext.run(network, () => runTurn(deps, { sessionId: id, message: task.precedingQuestion!, tz: "UTC", ...(!present ? { asOf: view } : {}) }, event => priorEvents.push(event)));
      const prior = priorEvents.findLast(event => event.type === "done");
      precedingTurn = { answer: prior ? store.episode(prior.episodeId)?.answer ?? "" : "", completed: Boolean(prior), timings: prior?.timings ?? null };
    }
    const events: AgentEvent[] = [], engineStart = performance.now();
    await requestContext.run(network, () => runTurn(deps, { sessionId: id, message: task.question, tz: "UTC", ...(!present ? { asOf: view } : {}) }, event => events.push(event)));
    const done = events.findLast(event => event.type === "done"), failed = events.findLast(event => event.type === "error");
    completed = Boolean(done);
    engineMs = done?.timings.totalMs ?? Math.round(performance.now() - engineStart);
    firstWordMs = done?.timings.firstTokenMs ?? null;
    if (done) { const episode = store.episode(done.episodeId); answer = episode?.answer ?? ""; execution = episode?.execution ?? null; sources = store.sourcesFor(done.episodeId); }
    if (failed) error = redact(failed.message);
    if (completed) {
      const judge = createLlm({ ...config!.llm!, fastModel: config!.llm!.model }, { onUsage: item => usage.push({ ...item, phase: "evaluation" }) });
      const start = performance.now(); judgment = await judgeAnswer(judge, task, answer, sources, present); judgeMs = Math.round(performance.now() - start);
    }
  } catch (failure) { error = redact(failure instanceof Error ? failure.message : String(failure)); }
  finally { store.close(); }
  const checks = { completed, ...deterministicChecks(task, answer, sources, searches.length),
    noSnapshotQueries: searches.every(query => query.cutoff === null), noSnapshotRequests: network.every(item => !item.snapshotRequested), noArchiveRequests: network.every(item => !item.archiveRequested),
    ...(task.precedingQuestion ? { precedingTurnCompleted: precedingTurn?.completed === true } : {}) };
  const deterministicPassed = Object.values(checks).every(Boolean);
  return { id, caseId: task.id, track: present ? "present-date-baseline" : "era-simulation", split: task.split, category: task.category, viewpoint: view.toISOString(),
    question: task.question, inputHash: hash({ task, present }), completed, passed: deterministicPassed && judgment.available && judgment.checks.every(check => check.passed),
    deterministicPassed, checks, judgment, answer, answerHash: hash(answer), sources, execution, engineMs, firstWordMs, judgeMs, totalCaseMs: Math.round(performance.now() - wall), searches, network, usage,
    ...(precedingTurn ? { precedingTurn } : {}), implementationHash: sourceHash, implementationEndHash: implementationHash(), ...(error ? { error } : {}) };
}

function redact(value: string) { let text = value; for (const key of [config?.llm?.apiKey, config?.exaApiKey]) if (key) text = text.replaceAll(key, "[redacted]"); return text.slice(0, 1000); }

// Every preflight case is checked even when a caller selects just one live trial.
const ids = new Set<string>();
for (const task of SIMULATION_CASES) {
  if (ids.has(task.id) || !task.question.trim() || !task.expectations.length || !Number.isFinite(Date.parse(task.asOf))
    || new Set(task.expectations.map(check => check.id)).size !== task.expectations.length) throw new Error(`Invalid simulation case: ${task.id}`);
  ids.add(task.id);
}
save(false);
if (live) {
  const jobs = tasks.flatMap(task => [() => trial(task, false), ...(currentBaseline && task.pairedCurrent ? [() => trial(task, true)] : [])]);
  const planned = jobs.length;
  console.log(`Running ${planned} live trials at concurrency ${concurrency}; private evaluator criteria are not sent to the answering model.`);
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    for (;;) { const job = jobs.shift(); if (!job) return; const result = await job(); trials.push(result); save(false); console.log(`${trials.length}/${planned} ${result.id}: ${result.passed ? "PASS" : "FAIL"} (${result.engineMs}ms engine)`); }
  }));
}
save(true);
console.log(live ? `Live benchmark: ${trials.filter(row => row.passed).length}/${trials.length} matched all explicit checks.` : `Preflight passed: ${SIMULATION_CASES.length} case definitions; no model or Exa requests.`);
console.log(`Private report saved: ${out}`);
if (live && trials.some(row => !row.passed)) process.exitCode = 1;
