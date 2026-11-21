import { DatabaseSync } from "node:sqlite";
import { summarizeTraces } from "../src/runtime/latency-report.ts";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--db") throw new Error("Usage: node --import tsx scripts/latency-report.ts --db PATH_TO_MEMORY_DB");
const db = new DatabaseSync(args[1]!, { readOnly: true });
try {
  const rows = db.prepare("SELECT trace_json FROM turn_traces ORDER BY updated_at DESC LIMIT 1000").all();
  const traces = rows.flatMap(row => { try { return [JSON.parse(String(row.trace_json))]; } catch { return []; } });
  console.log(JSON.stringify(summarizeTraces(traces), null, 2));
} finally { db.close(); }
