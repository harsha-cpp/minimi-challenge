import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generationInput, caseInputHash } from "./benchmark/score.ts";
import { digest, validateDataset } from "./quality/protocol.ts";
import { PILOT_CASES, PILOT_REFERENCES, PILOT_VERSION, REFERENCE_CAPTURED_AT, pilotLabelQueue } from "./pilot/cases.ts";

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  if (!["--out-dir", "--cases"].includes(args[index]!) || !args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error("Pilot preparation accepts --out-dir and --cases only. It never runs providers.");
}
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const ids = option("--cases")?.split(",");
if (ids && (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !PILOT_CASES.some(item => item.input.id === id)))) throw new Error("Unknown or duplicate pilot case ID.");
const cases = ids ? PILOT_CASES.filter(item => ids.includes(item.input.id)) : PILOT_CASES;
const directory = resolve(option("--out-dir") ?? ".context/live-pilot");
const labels = pilotLabelQueue(cases);
validateDataset(labels);
mkdirSync(directory, { recursive: true });
const write = (name: string, value: unknown) => { const path = resolve(directory, name); writeFileSync(path, JSON.stringify(value, null, 2) + "\n"); return path; };
const dataPath = write("questions.json", cases.map(item => generationInput(item.input)));
const initialIds = ["pilot-conversation-recall", "pilot-transform-only", "pilot-simple-tungsten", "pilot-current-sqlite-release"];
const initial = cases.filter(item => initialIds.includes(item.input.id));
const initialPath = write("initial-questions.json", initial.length ? initial.map(item => generationInput(item.input)) : cases.map(item => generationInput(item.input)));
write("reference-queue.json", { version: PILOT_VERSION, capturedAt: REFERENCE_CAPTURED_AT, labelStatus: "pending-human-adjudication", purpose: "development-pilot",
  notice: "Machine-captured official factual excerpts and proposed checks only. These are not independent held-out human judgments. Never pass this file to answer generation.",
  cases: labels, references: PILOT_REFERENCES.filter(source => cases.some(item => item.referenceIds.includes(source.id))) });
const runArgs = (policy: string, subset: string, name: string) => ["--import", "tsx", "--disable-warning=ExperimentalWarning", "eval/benchmark.ts", "--live", "--dataset", subset,
  "--policy", policy, "--max-campaign-dollars", "2", "--max-search-dollars", "0.50", "--out", resolve(directory, name)];
write("run-plan.json", { version: PILOT_VERSION, createdAt: new Date().toISOString(), preparedOnly: true, providerRequestsMade: 0, ports: [],
  cases: cases.map(item => ({ id: item.input.id, inputHash: caseInputHash(item.input), category: item.category, track: item.track })),
  inputHash: digest(cases.map(item => generationInput(item.input))), purpose: "Small development diagnostic before larger held-out evaluation",
  requiredEnvironment: ["LLM_API_KEY", "LLM_MODEL", "LLM_API_MODE", "EXA_API_KEY", "INPUT_DOLLARS_PER_MILLION", "OUTPUT_DOLLARS_PER_MILLION", "MODEL_PRICE_VERSION", "SEARCH_MAX_ATTEMPT_DOLLARS", "durable global spend ledger settings"],
  allowance: { combinedDollars: 2, azureUpperBoundDollars: 2, exaUpperBoundDollars: 0.50,
    note: "Local pilot allowances complement the user-total durable Azure/Exa caps. Unknown usage retains reservations; global caps must persist across runs/restarts." },
  commands: [
    { phase: "initial-small-subset", executable: process.execPath, args: runArgs("baseline", initialPath, "initial-baseline.json") },
    { phase: "after-initial-result-review-and-budget-check", executable: process.execPath, args: runArgs("profiles-v1", dataPath, "candidate-repeat-1.json") },
    { phase: "optional-matched-baseline-with-remaining-budget", executable: process.execPath, args: runArgs("baseline", dataPath, "baseline-repeat-1.json") },
  ],
  repeatProtocol: "Repeat matched baseline/candidate inputs only after reviewing retained failures and remaining shared ledger balances. Use distinct output filenames and declared cold/warm caches; future live release needs separate cross-day repetitions and human adjudication.",
});
console.log(`Prepared ${cases.length} pilot questions and pending reference queue: ${directory}. No providers or servers were started.`);
