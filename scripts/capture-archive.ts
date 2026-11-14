/** Build a review candidate from an exact Wayback capture; no source is approved or imported. */
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { captureArchive } from "../src/temporal/archive.ts";
import { parseInstant } from "../src/time/instant.ts";

const usage = "Usage: tsx scripts/capture-archive.ts <url> --as-of <ISO instant> --selector <CSS selector> --out <new manifest.json>";
const args = process.argv.slice(2);
let url: string | undefined;
const values = new Map<string, string>();
for (let i = 0; i < args.length; i++) {
  const item = args[i]!;
  if (["--as-of", "--selector", "--out", "--title"].includes(item)) {
    if (values.has(item) || !args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error(usage);
    values.set(item, args[++i]!);
  } else if (item.startsWith("--") || url) throw new Error(usage);
  else url = item;
}
const asOf = parseInstant(values.get("--as-of"));
const selector = values.get("--selector");
const path = values.get("--out");
if (!url || !asOf || !selector || !path) throw new Error(usage);
const out = resolve(path);
const result = await captureArchive({ url, asOf, selector, title: values.get("--title") });
mkdirSync(dirname(out), { recursive: true });
// Refuse to overwrite a reviewed source file. New candidates are private and require explicit review.
const file = openSync(out, "wx", 0o600);
try { writeFileSync(file, JSON.stringify({ documents: [result.document], archiveEvidence: { captureUrl: result.captureUrl, rawHash: result.rawHash } }, null, 2) + "\n"); }
finally { closeSync(file); }
console.log(JSON.stringify({ out, captureUrl: result.captureUrl, rawHash: result.rawHash, reviewed: false,
  note: "Historical source candidate only. Review the extracted edition and provenance before importing; this command does not approve sources or modify a database." }));
