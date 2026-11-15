import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { QUALITY_SEED, SEED_HASH, SEED_VERSION } from "./quality/seed.ts";
import { digest, projectGenerationInput, QUALITY_PROTOCOL_VERSION, QUALITY_SLICES, releaseGates, validateDataset, type QualityCase, type ReleaseEvidence } from "./quality/protocol.ts";

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  if (["--require-release", "--validate-seed"].includes(args[index]!)) continue;
  if (!["--out", "--evidence", "--annotation-template", "--dataset"].includes(args[index]!)) throw new Error(`Unknown quality option ${args[index]}`);
  if (!args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error(`${args[index]} requires a path`);
  index++;
}
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const out = resolve(option("--out") ?? ".context/quality-release.json");
const evidencePath = option("--evidence");
const evidence = evidencePath ? JSON.parse(readFileSync(evidencePath, "utf8")) as ReleaseEvidence : undefined;
const datasetPath = option("--dataset");
const supplied = datasetPath ? JSON.parse(readFileSync(datasetPath, "utf8")) : undefined;
if (supplied && !Array.isArray(supplied) && supplied.version !== QUALITY_PROTOCOL_VERSION) throw new Error("Unsupported quality dataset version.");
const dataset: QualityCase[] = supplied ? Array.isArray(supplied) ? supplied : supplied.cases : QUALITY_SEED;
validateDataset(dataset);
if (!datasetPath) {
  const manifest = JSON.parse(readFileSync(new URL("./quality/seed-manifest.json", import.meta.url), "utf8"));
  if (manifest.version !== SEED_VERSION || manifest.sha256 !== SEED_HASH || manifest.cases !== dataset.length) throw new Error("Frozen seed manifest mismatch; version and review the changed dataset.");
}
const report = {
  version: QUALITY_PROTOCOL_VERSION, datasetVersion: datasetPath ? "supplied-adjudicated-dataset" : SEED_VERSION, datasetHash: digest(dataset), createdAt: new Date().toISOString(),
  scope: "Evaluation protocol only. The bundled seed has 200 authored questions, 20 per slice, with all reference captures and human labels pending. Supplied datasets are validated separately. Entity/time groups stay in one split. Generation inputs exclude reference labels. Injected failure, frozen conversation and live-quality tracks are distinct. This command makes no live requests or paid provider calls.",
  cases: dataset.length, slices: Object.fromEntries(QUALITY_SLICES.map(slice => [slice, dataset.filter(item => item.slice === slice).length])),
  splits: Object.fromEntries(["development", "heldout"].map(split => [split, dataset.filter(item => item.split === split).length])),
  pendingLabels: dataset.filter(item => item.labels.status === "pending").length,
  release: releaseGates(dataset, evidence),
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
if (option("--annotation-template")) {
  const path = resolve(option("--annotation-template")!);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: QUALITY_PROTOCOL_VERSION, instructions: "Human adjudication required. Do not feed this labels file to generation. Capture dated exact references, hash them, and reconcile a double-labelled subset.",
    datasetHash: digest(dataset), cases: dataset.map(item => ({ ...item, input: projectGenerationInput(item) })) }, null, 2) + "\n");
}
console.log(`Quality protocol report saved: ${out}; release ${report.release.ready ? "ready" : "blocked by unmet evidence gates"}.`);
if (args.includes("--require-release") && !report.release.ready) process.exitCode = 1;
