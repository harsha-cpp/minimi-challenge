
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createExaSearch } from "../src/search.ts";
import { SEARCH_CASES, scoreRetrieval } from "./search-quality.ts";

const config = loadConfig();
if (!config.exaApiKey) {
  console.error("EXA_API_KEY is required for live retrieval evaluation. No requests were made.");
  process.exit(1);
}
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
if (outIndex !== -1 && !args[outIndex + 1]) throw new Error("--out requires a file path.");
const out = resolve(outIndex === -1 ? ".context/search-eval.json" : args[outIndex + 1]!);
const provider = createExaSearch(config.exaApiKey);
const outcomes = [];
for (const item of SEARCH_CASES) {
  const started = performance.now();
  try {
    const hits = await provider.search(item.query);
    const scores = scoreRetrieval(item, hits);
    outcomes.push({ id: item.id, query: item.query, latencyMs: Math.round(performance.now() - started), scores, hits });
    console.log(`${item.id}: ${hits.length} sources; terms ${(scores.termCoverage * 100).toFixed(0)}%; ${Math.round(performance.now() - started)}ms`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outcomes.push({ id: item.id, query: item.query, latencyMs: Math.round(performance.now() - started), error: message });
    console.log(`${item.id}: ${message}`);
  }
}
const latencies = outcomes.map(o => o.latencyMs).sort((a, b) => a - b);
const report = {
  version: 1, ranAt: new Date().toISOString(), provider: "exa", sampleSize: outcomes.length,
  limits: "Retrieval diagnostics only. Lexical coverage and URL policy checks do not measure citation entailment, historical capture accuracy, or answer correctness. No competitor comparison. Provider cost is not collected.",
  summary: {
    errors: outcomes.filter(o => "error" in o).length,
    expectedSourceRate: outcomes.filter(o => "scores" in o && o.scores?.expectedSourceFound).length / outcomes.length,
    p50Ms: latencies[Math.ceil(latencies.length * 0.5) - 1],
    p95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1],
  }, outcomes,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(`Saved retrieval report: ${out}`);
if (report.summary.errors || outcomes.some(o => "scores" in o && (!o.scores?.nonEmptyEvidence || !o.scores.domainCompliance || !o.scores.publicationCompliance || !o.scores.snapshotPolicyPresent))) process.exitCode = 1;
