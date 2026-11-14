/** Real-source pilot; --live opts into real generation, historical retrieval and verification. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runTurn, type AgentEvent } from "../src/agent/run.ts";
import { loadConfig } from "../src/config.ts";
import { createLlm, type LlmUsage } from "../src/llm.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { createExaSearch, withCache, withConcurrency, type SearchProvider } from "../src/search.ts";
import { isHistoricalEvidenceEligible } from "../src/temporal/eligibility.ts";
import { withHistoricalCorpus } from "../src/temporal/retrieve.ts";
import { TemporalStore } from "../src/temporal/store.ts";

const args = process.argv.slice(2);
let live = false;
let output = ".context/historical-pilot.json";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--live") { live = true; continue; }
  if (args[i] === "--out" && args[i + 1] && !args[i + 1]!.startsWith("--")) { output = args[++i]!; continue; }
  throw new Error(`Unknown or incomplete historical-pilot option: ${args[i]}`);
}
const out = resolve(output);
const manifestPath = "corpus/us-founding-pilot.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { documents: unknown[] };
const corpus = new TemporalStore(":memory:");
const imported = corpus.importDocuments(manifest.documents);
const bySource = new Map(imported.map(document => [document.sourceId, document]));
const config = live ? loadConfig() : undefined;
if (live && (!config?.llm || !config.exaApiKey)) {
  corpus.close();
  throw new Error("Live historical pilot requires configured LLM_API_KEY, LLM_MODEL and EXA_API_KEY.");
}
const cases = [
  {
    id: "original-term-in-1862", asOf: "1862-09-22T12:00:00.000Z", sourceId: "constitution-article-ii-term", expectedAbstention: false,
    question: "Use web_search to read the original U.S. Constitution, Article II, at https://www.archives.gov/founding-docs/constitution-transcript. What term of office does its original text prescribe for the President? Answer only with the term and an inline citation. This asks about the original text, not a claim about present law.",
  },
  {
    id: "thirteenth-enforcement-unavailable-in-1862", asOf: "1862-09-22T12:00:00.000Z", sourceId: "thirteenth-enforcement", expectedAbstention: true,
    question: "Use web_search to read Section 2 of the Thirteenth Amendment at https://www.archives.gov/founding-docs/amendments-11-27. Which body does the original provision empower to enforce the article, and by what means? Answer only if historical evidence available at the selected date supports it. Otherwise say you could not verify; do not supply later facts from memory.",
  },
  {
    id: "thirteenth-enforcement-in-1870", asOf: "1870-01-13T12:00:00.000Z", sourceId: "thirteenth-enforcement", expectedAbstention: false,
    question: "Use web_search to read Section 2 of the Thirteenth Amendment at https://www.archives.gov/founding-docs/amendments-11-27. Which body does its original text empower to enforce the article, and by what means? Answer in one sentence with an inline citation, describing only the original provision.",
  },
];
const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const outcomes: unknown[] = [];
const startedAt = new Date().toISOString();
let passed = 0;

function save(complete: boolean) {
  const report = {
    version: 1, startedAt, updatedAt: new Date().toISOString(), complete,
    mode: live ? "live-real-source-production-pipeline-pilot" : "corpus-preflight-only",
    scope: "Three short, explicitly curated original-document excerpts from the U.S. National Archives; three developer-authored historical questions. Tests production generation, reviewed-corpus retrieval, strict verification and pre-admission abstention. This is not a general historical-accuracy estimate, source-authentication proof, continuing-law determination, broad corpus, or competitor comparison. Corpus availability values are conservative admission bounds, not first-publication timestamps. No production ledger or corpus database is opened. Exa is the only web-search provider. API usage may incur cost; cost not measured.",
    runtime: { node: process.version, model: live ? config!.llm!.model : null, verifierModel: live ? config!.llm!.model : null, backgroundEnrichment: false },
    manifestHash: hash(readFileSync(manifestPath, "utf8")), datasetHash: hash(cases),
    implementationHash: hash(["src/agent/run.ts", "src/agent/prompt.ts", "src/agent/verify.ts", "src/agent/evidence.ts", "src/agent/prepare.ts", "src/temporal/retrieve.ts", "src/temporal/store.ts", "src/temporal/eligibility.ts", "src/llm.ts", "src/llm/responses.ts", "package-lock.json", "eval/historical-pilot.ts"].map(path => `${path}\n${readFileSync(path, "utf8")}`).join("\n")),
    corpus: { documents: imported.map(document => ({ sourceId: document.sourceId, id: document.id, contentHash: document.contentHash, availableAt: document.availableAt, capturedAt: document.capturedAt })), coverage: corpus.coverage() },
    plannedCases: cases.length, completedCases: outcomes.length,
    summary: live ? { matchedExpected: passed, total: outcomes.length } : null,
    cases, outcomes,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.tmp`, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${out}.tmp`, out);
}

try {
  save(false);
  if (!live) {
    for (const task of cases) {
      const date = new Date(task.asOf);
      const expectedDocument = bySource.get(task.sourceId)!;
      outcomes.push({ caseId: task.id, inputHash: hash(task), corpusCoverage: corpus.coverage(date),
        requestedSourceEligible: Date.parse(expectedDocument.availableAt) <= date.getTime(),
        expectedRequestedSourceEligible: !task.expectedAbstention, generationRun: false });
    }
  } else {
    const inner = withCache(withConcurrency(createExaSearch(config!.exaApiKey!)));
    for (const task of cases) {
      const store = new MemoryStore(":memory:");
      const usage: Array<LlmUsage & { phase: "generation" | "verification" }> = [];
      const llm = createLlm(config!.llm!, { onUsage: event => usage.push({ ...event, phase: "generation" }) });
      const verifier = createLlm({ ...config!.llm!, fastModel: config!.llm!.model }, { onUsage: event => usage.push({ ...event, phase: "verification" }) });
      const events: AgentEvent[] = [];
      const exa: Array<{ cutoff?: string; elapsedMs: number; state: "done" | "failed"; results?: number }> = [];
      const observed: SearchProvider = { search: async (query, signal) => {
        const start = performance.now();
        try {
          const results = await inner.search(query, signal);
          exa.push({ cutoff: query.asOf?.toISOString(), elapsedMs: Math.round(performance.now() - start), state: "done", results: results.length });
          return results;
        } catch (error) {
          exa.push({ cutoff: query.asOf?.toISOString(), elapsedMs: Math.round(performance.now() - start), state: "failed" });
          throw error;
        }
      } };
      const asOf = new Date(task.asOf);
      const start = performance.now();
      try {
        await runTurn({ llm, verifier, store, search: withHistoricalCorpus(observed, corpus),
          clock: { now: () => asOf, simulated: true }, enricher: { schedule() {} } },
        { sessionId: `historical-pilot-${task.id}`, message: task.question, tz: "UTC", asOf }, event => events.push(structuredClone(event)));
        const done = events.findLast(event => event.type === "done");
        const episode = done ? store.episode(done.episodeId) : null;
        const sources = done ? store.sourcesFor(done.episodeId) : [];
        const answer = episode?.answer ?? "";
        const verification = episode?.execution?.verification as { approved?: boolean; reason?: string } | undefined;
        const expectedDocument = bySource.get(task.sourceId)!;
        const abstained = /could not verify|cannot verify|couldn't verify|insufficient evidence/i.test(answer);
        const matches = task.expectedAbstention ? {
          completed: Boolean(done), abstained, noSources: sources.length === 0,
          notApproved: verification?.approved === false,
          noLaterFact: !/\b(?:1865|1866|Congress|legislation|slavery|involuntary)\b/i.test(answer),
        } : {
          completed: Boolean(done), notAbstained: !abstained, verified: verification?.approved === true,
          expectedContent: task.id === "original-term-in-1862" ? /\b(?:four|4)[ -]+years?\b/i.test(answer) : /\bCongress\b/i.test(answer) && /\blegislation\b/i.test(answer),
          exactSource: sources.some(source => source.temporal?.documentId === expectedDocument.id),
          eligibleSources: sources.length > 0 && sources.every(source => isHistoricalEvidenceEligible(source, asOf)),
        };
        const ok = Object.values(matches).every(Boolean);
        if (ok) passed++;
        outcomes.push({ caseId: task.id, inputHash: hash(task), passed: ok, checks: matches, answer, answerHash: hash(answer), sources,
          verification: verification ?? null, verifiedStatements: done ? store.verifiedStatementsFor(done.episodeId) : [],
          elapsedMs: Math.round(performance.now() - start), timings: done?.timings ?? null, usage, exa,
          corpusCoverage: corpus.coverage(asOf),
          events: events.map(event => event.type === "error" ? { type: "error", message: "Turn failed; no raw provider error is recorded." } : event),
        });
      } finally { store.close(); }
      save(false);
    }
  }
  save(true);
  console.log(live ? `Real-source historical pilot: ${passed}/${cases.length} expected outcomes.` : `Historical corpus preflight: ${imported.length} curated excerpts; no model or Exa calls.`);
  console.log(`Private report saved: ${out}`);
  if (live && passed !== cases.length) process.exitCode = 1;
} finally { corpus.close(); }
