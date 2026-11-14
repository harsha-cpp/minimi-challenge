/** Private end-to-end samples and recorded-baseline comparison; no web UI integration. */
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
import { FIXTURES, type Fixture } from "./benchmark/fixtures.ts";
import { caseInputHash, scoreSample, summarize, type BenchmarkCase, type BenchmarkSample } from "./benchmark/score.ts";

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--live") continue;
  if (!["--out", "--dataset", "--baseline"].includes(args[i]!)) throw new Error(`Unknown benchmark option: ${args[i]}`);
  i++;
}
const option = (name: string) => { const i = args.indexOf(name); if (i < 0) return undefined; if (!args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error(`${name} requires a path`); return args[i + 1]!; };
const live = args.includes("--live");
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
  for (const grade of Object.values(item.sourceGrades ?? {})) if (!Number.isInteger(grade) || grade < 0 || grade > 3) throw new Error("Source grades must be 0 to 3.");
  for (const terms of [item.requiredFacts, item.forbiddenFacts]) if (terms !== undefined && (!Array.isArray(terms) || terms.some(t => typeof t !== "string"))) throw new Error("Fact labels must be arrays of strings.");
  ids.add(item.id);
}
if (datasetPath && !live) throw new Error("Custom datasets require --live; synthetic replay uses its versioned fixtures.");

let model: Llm | undefined;
let reviewer: Llm | undefined;
let search: SearchProvider | undefined;
let modelName: string | null = null;
if (live) {
  const config = loadConfig();
  if (!config.llm || !config.exaApiKey) {
    console.error(`Live benchmark was not run. Missing configuration: ${config.missing.join(", ")}.`);
    process.exit(1);
  }
  model = createLlm(config.llm);
  reviewer = createLlm({ ...config.llm, fastModel: config.llm.model });
  modelName = config.llm.model;
  search = withCache(withConcurrency(createExaSearch(config.exaApiKey)));
}
const samples: BenchmarkSample[] = [];
for (const task of dataset) {
  const fixture = FIXTURES.find(f => f.task.id === task.id);
  const deps = live ? { llm: model!, verifier: reviewer!, search: search! } : fixtureDeps(fixture!);
  const store = new MemoryStore(":memory:");
  try {
    for (const past of task.history ?? []) {
      const at = parseInstant(past.at);
      if (!at) throw new Error(`Invalid history timestamp for ${task.id}`);
      store.saveEpisode({ sessionId: "benchmark", askedAt: at.getTime(), tz: "UTC", question: past.question, answer: past.answer, sources: [] });
    }
    const now = task.asOf ? new Date(task.asOf) : new Date();
    const events: AgentEvent[] = [];
    await runTurn({ ...deps, store, clock: { now: () => now, simulated: Boolean(task.asOf) }, enricher: { schedule() {} } },
      { sessionId: "benchmark", message: task.question, tz: "UTC", asOf: task.asOf ? now : undefined }, event => events.push(structuredClone(event)));
    const done = events.findLast(e => e.type === "done");
    const failure = events.findLast(e => e.type === "error");
    const episode = done ? store.episode(done.episodeId) : null;
    samples.push({ caseId: task.id, engine: "asof-exa", basis: live ? "live" : "synthetic-replay", capturedAt: new Date().toISOString(), inputHash: caseInputHash(task),
      answer: episode?.answer ?? "", sources: done ? store.sourcesFor(done.episodeId) : [], latencyMs: done?.timings.totalMs ?? null,
      firstTokenMs: done?.timings.firstTokenMs, searches: done?.timings.searches, modelCalls: done?.timings.modelCalls,
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
  version: 2, createdAt: new Date().toISOString(), datasetHash: createHash("sha256").update(JSON.stringify(dataset)).digest("hex"),
  runtime: { node: process.version, model: modelName, backgroundEnrichment: false },
  implementationHash: createHash("sha256").update(["src/agent/run.ts", "src/agent/citations.ts", "src/agent/simulation.ts", "public/citations.js", "package-lock.json", "src/agent/prompt.ts", "src/agent/prepare.ts", "src/agent/evidence.ts", "src/clock.ts", "src/memory/store.ts", "src/memory/recall.ts", "src/search/exa.ts", "src/search/cache.ts", "src/search/validate.ts", "eval/benchmark.ts", "eval/benchmark/fixtures.ts", "eval/benchmark/score.ts"].map(file => file + "\n" + readFileSync(file, "utf8")).join("\n")).digest("hex"),
  mode: live ? "live-foreground" : "synthetic-pipeline-regression", comparisonStatus: comparisonEngines.length ? "recorded-baselines-supplied" : "no-competitor-recordings",
  scope: "Foreground answer pipeline with live-web era simulation. Background enrichment disabled. Exa is the only application web tool. Modern retrospective sources are valid; temporal-policy violations count only explicit forbidden-answer label matches, not source publication/capture dates. Synthetic review verdicts and rewrites are scripted plumbing fixtures and do not measure model quality or commercial search engines. Labeled exact-string/source metrics are not semantic entailment; unlabeled metrics are null. Cost not measured.",
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
if (rows.filter(r => r.sample.engine === "asof-exa").some(row => !row.scores.succeeded || row.scores.forbiddenFactPresent || !row.scores.citationReferencesValid || row.scores.temporalPolicyViolations || row.scores.abstentionCorrect === false
  || (!live && row.scores.requiredFactMatchRate !== null && row.scores.requiredFactMatchRate < 1))) process.exitCode = 1;

function fixtureDeps(fixture: Fixture): { llm: Llm; search: SearchProvider } {
  let step = 0;
  return {
    llm: {
      // Scripted positive checker for fixed, labeled plumbing fixtures. This is not a quality score.
      json: async ({ user }) => {
        const payload = JSON.parse(user) as { draft: string };
        return fixture.correction && payload.draft === fixture.answer
          ? { status: "needs_revision", issues: [{ code: "temporal_leakage", detail: fixture.correction.issue }], safeAnswer: fixture.correction.answer }
          : { status: "approved", issues: [], safeAnswer: null };
      },
      stream: async request => {
        if (request.messages.some(m => typeof m.content === "string" && m.content.includes("FUTURE_SENTINEL"))) {
          request.onText("FUTURE_SENTINEL"); return { text: "FUTURE_SENTINEL", toolCalls: [] };
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
