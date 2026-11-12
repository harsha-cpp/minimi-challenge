/**
 * Loads past conversations into memory, for testing date questions against a
 * history you already have.
 *
 *   npm run import -- history.json
 *
 * The file is a JSON array of { "at": ISO date-time, "question": string, "answer": string }.
 * Each entry is stored at its own timestamp and then enriched exactly like a
 * live answer, so its claims can be re-checked later.
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { createLlm } from "../src/llm.ts";
import { Enricher } from "../src/memory/enrich.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { validTimeZone } from "../src/time/zone.ts";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run import -- <history.json>");
  process.exit(1);
}

const config = loadConfig();
if (!config.llm) {
  console.error("LLM_API_KEY and LLM_MODEL are needed to extract claims from the imported answers (see .env.example).");
  process.exit(1);
}

const entries: unknown = JSON.parse(readFileSync(file, "utf8"));
if (!Array.isArray(entries)) throw new Error("Expected a JSON array.");

const store = new MemoryStore(config.dbPath);
const enricher = new Enricher(createLlm(config.llm), store);
const tz = validTimeZone(undefined);

for (const [i, entry] of entries.entries()) {
  const { at, question, answer } = (entry ?? {}) as Record<string, unknown>;
  const askedAt = typeof at === "string" ? Date.parse(at) : NaN;
  if (Number.isNaN(askedAt) || typeof question !== "string" || typeof answer !== "string") {
    throw new Error(`Entry ${i}: expected { at, question, answer } with an ISO date-time in "at".`);
  }
  const id = store.saveEpisode({ sessionId: "import", askedAt, tz, question, answer, sources: [] });
  enricher.schedule(id, { question, answer, sources: [], priorClaims: [] });
}

await enricher.idle();
console.log(`Imported ${entries.length} conversation${entries.length === 1 ? "" : "s"} into ${config.dbPath}.`);
store.close();
