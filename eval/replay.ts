/**
 * Replays the three questions from the brief against a history built on the
 * right days, by moving the clock instead of waiting a week.
 *
 *   Tue 3 Nov   ask about Postgres hosting
 *   Mon 9 Nov   ask for a CRM shortlist
 *   Wed 11 Nov  ask the three follow-ups from the brief
 *
 * It uses the real model and real search (so it needs the keys in .env), a
 * throwaway database, and prints each answer with its trace and timings. The
 * checks at the end are about recall, which is deterministic; the answers are
 * for a person to read.
 *
 *   npm run eval
 */
import { rmSync } from "node:fs";
import { type AgentEvent, type Timings, runTurn } from "../src/agent/run.ts";
import { SystemClock } from "../src/clock.ts";
import { loadConfig } from "../src/config.ts";
import { createLlm } from "../src/llm.ts";
import { Enricher } from "../src/memory/enrich.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { createExaSearch, withCache, withConcurrency } from "../src/search.ts";

const TZ = "Asia/Kolkata";
const DB = "data/eval.db";

const config = loadConfig();
if (!config.llm || !config.exaApiKey) {
  console.error(`Missing configuration: ${config.missing.join(", ")} (see .env.example)`);
  process.exit(1);
}

rmSync(DB, { force: true });
const store = new MemoryStore(DB);
const clock = new SystemClock();
const llm = createLlm(config.llm);
const enricher = new Enricher(llm, store);
const deps = { llm, store, clock, enricher, search: withCache(withConcurrency(createExaSearch(config.exaApiKey))) };

interface Outcome {
  notes: string[];
  searches: string[];
  answer: string;
  timings: Timings | null;
  error: string | null;
}

async function ask(at: string, message: string): Promise<Outcome> {
  clock.travelTo(new Date(at));
  const outcome: Outcome = { notes: [], searches: [], answer: "", timings: null, error: null };
  const onEvent = (e: AgentEvent) => {
    if (e.type === "recall") outcome.notes = e.notes;
    else if (e.type === "search" && e.state === "running") outcome.searches.push(e.publishedAfter ? `${e.query} (after ${e.publishedAfter})` : e.query);
    else if (e.type === "text") outcome.answer += e.delta;
    else if (e.type === "retract") outcome.answer = "";
    else if (e.type === "done") outcome.timings = e.timings;
    else if (e.type === "error") outcome.error = e.message;
  };
  // Each question is its own chat, so anything remembered comes from memory, not from chat history.
  await runTurn(deps, { sessionId: crypto.randomUUID(), message, tz: TZ }, onEvent);
  await enricher.idle();

  console.log(`\n${"─".repeat(100)}\n[${at}] ${message}\n`);
  for (const note of outcome.notes) console.log(`  memory  ${note}`);
  for (const query of outcome.searches) console.log(`  search  ${query}`);
  if (outcome.error) console.log(`\n  ERROR: ${outcome.error}`);
  else console.log(`\n${outcome.answer}\n`);
  const t = outcome.timings;
  if (t) console.log(`  recall ${t.recallMs} ms · ${t.searches} searches · ${t.modelCalls} model calls · first word ${t.firstTokenMs} ms · total ${t.totalMs} ms`);
  return outcome;
}

await ask("2026-11-03T14:05:00+05:30", "Compare managed Postgres hosting for a small SaaS: Neon, Supabase and one more. What does each cost?");
await ask("2026-11-09T11:00:00+05:30", "Shortlist 5 CRM tools for a 20-person sales team, with current per-seat pricing.");

const present = "2026-11-11T12:00:00+05:30";
const crm = await ask(present, "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?");
const third = await ask(present, "What did I ask you on 3 November? Is your answer still correct today?");
const tuesday = await ask(present, "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
const nothing = await ask(present, "What did we decide about the office move on 1 November?");

const checks: Array<[string, boolean]> = [
  ['"On Monday" recalls the 9 Nov shortlist', crm.notes.some((n) => n.includes("Mon 9 Nov 2026: 1 conversation"))],
  ['"3 November" recalls the Postgres conversation', third.notes.some((n) => n.includes("Tue 3 Nov 2026: 1 conversation"))],
  ['"Last Tuesday" resolves to 3 Nov, not 10 Nov', tuesday.notes.some((n) => n.includes("Tue 3 Nov 2026: 1 conversation"))],
  ["re-check questions search the web", crm.searches.length > 0 && third.searches.length > 0 && tuesday.searches.length > 0],
  ["a date with no conversation is reported as empty", nothing.notes.some((n) => n.includes("nothing in memory"))],
  ["no turn failed", [crm, third, tuesday, nothing].every((o) => !o.error)],
];

console.log(`\n${"─".repeat(100)}`);
for (const [name, passed] of checks) console.log(`${passed ? "PASS" : "FAIL"}  ${name}`);
store.close();
process.exit(checks.every(([, passed]) => passed) ? 0 : 1);
