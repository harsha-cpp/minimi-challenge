/**
 * Import explicitly reviewed, preserved source versions. No model or network is used.
 * `reviewed: true` is the operator's attestation of source provenance and exact-edition
 * availability, not a claim that this program verified historical truth or dates.
 *
 * npx tsx scripts/import-corpus.ts corpus.json --db data/asof.db
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { TemporalStore, validateTemporalDocument } from "../src/temporal/store.ts";

const args = process.argv.slice(2);
let file: string | undefined;
if (existsSync(".env")) process.loadEnvFile(".env");
let database = process.env.TEMPORAL_DB_PATH?.trim() || `${process.env.DB_PATH?.trim() || "data/asof.db"}.temporal.db`;
for (let i = 0; i < args.length; i++) {
  const argument = args[i]!;
  if (argument === "--db") {
    if (!args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error("--db requires a database path.");
    database = args[++i]!;
  } else if (argument.startsWith("--") || file) throw new Error("Usage: tsx scripts/import-corpus.ts <manifest.json> [--db <database>]");
  else file = argument;
}
if (!file) throw new Error("Usage: tsx scripts/import-corpus.ts <manifest.json> [--db <database>]");
if (statSync(file).size > 25_000_000) throw new Error("Historical source manifest exceeds the 25 MB limit.");
const manifest: unknown = JSON.parse(readFileSync(file, "utf8"));
const entries = Array.isArray(manifest) ? manifest : manifest && typeof manifest === "object" ? (manifest as Record<string, unknown>).documents : undefined;
if (!Array.isArray(entries) || !entries.length || entries.length > 1000) throw new Error("Expected a manifest with 1 to 1000 documents (an array or { documents: [...] }).");
// Reject the complete manifest before even opening a database file.
const documents = entries.map(validateTemporalDocument);
const store = new TemporalStore(database);
try {
  const imported = store.importDocuments(documents);
  console.log(JSON.stringify({ imported: imported.length, reviewed: imported.filter(document => document.reviewed).length,
    database: database === ":memory:" ? database : resolve(database), note: "Review status is an operator provenance attestation; historical coverage depends on the imported source versions." }));
} finally { store.close(); }
