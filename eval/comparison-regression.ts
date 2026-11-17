import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createApplication } from "../src/server.ts";
import { MemoryStore, type Source } from "../src/memory/store.ts";
import { makeReviewedClaim, type CanonicalClaim } from "../src/agent/claims.ts";
import type { Config } from "../src/config.ts";
import type { Llm } from "../src/llm.ts";
import { observeHttpTurn, summarizeObservations, workloadSourceSnapshot, type HttpObservation } from "./workload.ts";

export const COMPARISON_DIAGNOSTIC_VERSION = "comparison-http-v1";
export const COMPARISON_SCENARIOS = ["unchanged", "changed", "hosting-billing-gap", "invalid-quote", "missing-item", "full-answer", "empty-source", "provider-failure"] as const;
type Scenario = typeof COMPARISON_SCENARIOS[number];
const priorAt = Date.parse("2026-11-01T12:00:00Z");
const price = "Acme costs $25 per user per month.";
const seats = "Acme requires five seats.";
const operations = "Acme manages operating-system patches.";
const freshSource = (scenario: Scenario, part: string, text: string, n: number): Source & {text: string} => ({ n,
  url: `https://comparison-fixture.example/${scenario}/${part}`, title: `Synthetic ${part} fixture`, text,
  retrievedAt: new Date().toISOString(), freshness: { requested: "fresh", acquisition: "live", ageStatus: "known", contentFetchedAt: new Date().toISOString() } });
const facts = (scenario: Scenario) => scenario === "hosting-billing-gap"
  ? ["The virtual server starts at $5 per month.", "The virtual server is billed at a fixed monthly price."] : [price, seats];
const currentSources = (scenario: Scenario): Array<Source & {text: string}> => scenario === "empty-source" ? [] : scenario === "hosting-billing-gap"
  ? [freshSource(scenario, "billing", "The virtual server is metered hourly up to a monthly maximum. This excerpt does not state the starting price.", 1)]
  : [freshSource(scenario, "price", scenario === "changed" ? "Acme costs $30 per user per month." : price, 1),
    freshSource(scenario, "seats", seats, 2), ...(scenario === "full-answer" ? [freshSource(scenario, "operations", operations, 3)] : [])];

interface Seed { id: number; sessionId: string; scenario: Scenario; originals: CanonicalClaim[]; }
function seed(store: MemoryStore, scenario: Scenario, index: number): Seed {
  const originalFacts = facts(scenario), sessionId = `comparison-${scenario}-${index}`;
  const sources = originalFacts.map((text, i) => freshSource(scenario, i ? "seats" : "price", text, i + 1));
  const originals = originalFacts.map((claim, index) => makeReviewedClaim({ claim, sourceNumbers: [index + 1] },
    new Map(sources.map(source => [source.n, source])), { viewpointAt: new Date(priorAt).toISOString(), tz: "UTC", kind: "verification", referenceAnswerHash: null }));
  const id = store.saveEpisode({ sessionId, askedAt: priorAt, tz: "UTC", question: scenario === "hosting-billing-gap" ? "Compare virtual-server billing and starting price." : "What are Acme's price and minimum seats?",
    answer: originalFacts.map((text, i) => `${text} [${i + 1}]`).join("\n\n") + (scenario === "full-answer" ? `\n\n${operations}` : ""),
    sources, reviewedClaims: originals, quality: "supported", execution: { intent: "lookup" } });
  return { id, sessionId, scenario, originals };
}
const configuration = (): Config => ({ port: 0, host: "127.0.0.1", dbPath: ":memory:", temporalDbPath: ":memory:", llm: null, exaApiKey: null,
  missing: [], startAt: null, retrievalProfiles: false, access: { mode: "local", allowedOrigins: [], ownerTokens: {} },
  limits: { activeTurns: 4, queuedTurns: 16, activeModels: 2, queuedModels: 24, modelRequestsPerMinute: 10_000, modelTokensPerMinute: 10_000_000,
    turnTimeoutMs: 5000, turnTokens: 100_000, turnModelCalls: 8, maxOutputTokens: 4096, shutdownMs: 100, traceRetentionDays: 14,
    maxTurnDollars: 1, inputDollarsPerMillion: null, outputDollarsPerMillion: null } });

export interface ComparisonObservation extends HttpObservation {
  caseId: string; expectedCoverage: string[]; actualCoverage: string[]; expectedConfirmedItems: number; confirmedItems: number;
  comparisonUnavailable: boolean; behaviorPassed: boolean; unnecessaryRefusal: boolean; unexpectedConfirmation: boolean; originalAnswerPreserved: boolean;
}
export function summarizeComparison(rows: ComparisonObservation[]) {
  return { ...summarizeObservations(rows), behavior: { offered: rows.length, passed: rows.filter(row => row.behaviorPassed).length,
    passRate: rows.length ? rows.filter(row => row.behaviorPassed).length / rows.length : null,
    comparisonUnavailable: rows.filter(row => row.comparisonUnavailable).length,
    unnecessaryRefusals: rows.filter(row => row.unnecessaryRefusal).length,
    unexpectedConfirmations: rows.filter(row => row.unexpectedConfirmation).length,
    casesWithExpectedConfirmedItems: rows.filter(row => row.expectedConfirmedItems > 0).length,
    confirmedItemsExpected: rows.reduce((n, row) => n + row.expectedConfirmedItems, 0), confirmedItemsReturned: rows.reduce((n, row) => n + row.confirmedItems, 0),
    factualAccuracy: null, independentHumanLabels: 0 } };
}

/** Real loopback HTTP, admission, SSE and persistence with deterministic provider substitutes. No external requests. */
export async function runComparisonDiagnostic(options: { users?: number; turns?: number; mockDelayMs?: number } = {}) {
  const users = options.users ?? 5, turns = options.turns ?? 25, mockDelayMs = options.mockDelayMs ?? 5;
  if (!Number.isInteger(users) || users < 1 || users > 8 || !Number.isInteger(turns) || turns < users || turns > 1000
    || !Number.isInteger(mockDelayMs) || mockDelayMs < 0 || mockDelayMs > 100) throw new Error("Invalid comparison diagnostic size.");
  const store = new MemoryStore(":memory:");
  const seeds = new Map<number, Seed>();
  const register = (scenario: Scenario, index: number) => { const item = seed(store, scenario, index); seeds.set(item.id, item); return item; };
  let forbiddenModelCalls = 0, comparisonCalls = 0, activeComparisons = 0, peakComparisons = 0, searchCalls = 0;
  const forbidden = async (): Promise<never> => { forbiddenModelCalls++; throw new Error("Live comparison unexpectedly used the legacy generation loop"); };
  const llm: Llm = { stream: forbidden, json: forbidden };
  const comparator: Pick<Llm, "json"> = { json: async request => {
    comparisonCalls++; activeComparisons++; peakComparisons = Math.max(peakComparisons, activeComparisons);
    try {
      await delay(mockDelayMs, undefined, { signal: request.signal });
      const payload = JSON.parse(request.user), item = seeds.get(payload.reference.episodeId);
      if (!item) throw new Error("Comparison target escaped the fixture");
      if (item.scenario === "provider-failure") throw new Error("Injected provider outage");
      const sourceFor = (text: string) => payload.sources.find((source: { text?: string; numberedText?: string }) => (source.numberedText ?? source.text)?.includes(text));
      const rows = payload.originalClaims.map((claim: CanonicalClaim, index: number) => {
        const unresolved = item.scenario === "hosting-billing-gap" && index === 0;
        const changed = item.scenario === "changed" && index === 0 || item.scenario === "hosting-billing-gap" && index === 1;
        const statement = item.scenario === "hosting-billing-gap" ? index ? "The virtual server is metered hourly up to a monthly maximum." : claim.text
          : item.scenario === "changed" && index === 0 ? "Acme costs $30 per user per month." : claim.text;
        const source = sourceFor(statement);
        return { referenceClaimId: claim.id, original: claim.text, statement, status: unresolved ? "unresolved" : changed ? "changed" : "supported",
          sourceNumbers: unresolved ? [] : [source?.n ?? 999], support: unresolved ? [] : [{ n: source?.n ?? 999,
            quote: item.scenario === "invalid-quote" && index === 0 ? "This sentence does not exist in the source." : statement }] };
      });
      if (item.scenario === "missing-item") rows.pop();
      if (item.scenario === "full-answer") {
        const source = sourceFor(operations);
        rows.push({ referenceClaimId: null, original: operations, statement: operations, status: "supported", sourceNumbers: [source.n], support: [{ n: source.n, quote: operations }] });
      }
      return { referenceCheck: { episodeId: item.id, answerHash: payload.reference.answerHash, addressesTarget: true,
        coverage: item.scenario === "hosting-billing-gap" ? "partial" : "complete" }, items: rows };
    } finally { activeComparisons--; }
  } };
  const app = createApplication({ config: configuration(), store, deps: { store, llm, comparisonVerifier: comparator,
    clock: { now: () => new Date(), simulated: false }, enricher: { schedule() {} }, search: { search: async (query, signal) => {
      searchCalls++;
      await delay(mockDelayMs, undefined, { signal });
      // A source URL or the current saved target identifies the scripted dataset. The lookup is still admitted by runTurn.
      const scenario = query.urls?.map(url => new URL(url).pathname.split("/")[1]).find(value => COMPARISON_SCENARIOS.includes(value as Scenario)) as Scenario | undefined;
      if (scenario) return currentSources(scenario);
      // Discovery intentionally returns no extra facts. Only the selected target's cited URLs supply these frozen passages.
      return [];
    } } } });
  const invoke = async (base: string, item: Seed): Promise<ComparisonObservation> => {
    const original = store.episode(item.id)!.answer;
    const observation = await observeHttpTurn(base, { sessionId: item.sessionId, message: "Is that answer still correct?", recheckEpisodeId: item.id, mode: "live", tz: "UTC" }, randomUUID(), 7000);
    const turn = observation.turnId ? store.getTurn(observation.turnId) : null;
    const coverage = turn?.episodeId ? store.claimCoverageFor(turn.episodeId) : [];
    const confirmed = turn?.episodeId ? store.reviewedClaimsFor(turn.episodeId).length : 0;
    const saved = turn?.episodeId ? store.episode(turn.episodeId) : null;
    const failure = saved?.execution?.reviewFailure as {reason?: string} | undefined;
    const expected = item.scenario === "hosting-billing-gap" || item.scenario === "invalid-quote" ? ["unresolved", item.scenario === "hosting-billing-gap" ? "changed" : "supported"]
      : item.scenario === "missing-item" ? ["supported", "unresolved"] : ["empty-source", "provider-failure"].includes(item.scenario) ? ["unresolved", "unresolved"]
      : [item.scenario === "changed" ? "changed" : "supported", "supported"];
    const expectedConfirmed = expected.filter(status => status !== "unresolved").length + Number(item.scenario === "full-answer");
    const actual = item.originals.map(claim => coverage.find(row => row.claimId === claim.id)?.status ?? "missing");
    const originalAnswerPreserved = store.episode(item.id)!.answer === original;
    return { ...observation, caseId: item.scenario, expectedCoverage: expected, actualCoverage: actual, expectedConfirmedItems: expectedConfirmed, confirmedItems: confirmed,
      comparisonUnavailable: Boolean(failure && failure.reason !== "insufficient_evidence"),
      behaviorPassed: observation.outcome === "completed" && observation.doneReceived && originalAnswerPreserved && JSON.stringify(actual) === JSON.stringify(expected) && confirmed === expectedConfirmed,
      unnecessaryRefusal: expectedConfirmed > 0 && confirmed === 0,
      unexpectedConfirmation: actual.some((status, index) => expected[index] === "unresolved" && ["supported", "changed"].includes(status)), originalAnswerPreserved };
  };
  try {
    app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
    const address = app.server.address(); if (!address || typeof address === "string") throw new Error("No diagnostic loopback port");
    const base = `http://127.0.0.1:${address.port}`;
    const regressionRows: ComparisonObservation[] = [];
    for (const [index, scenario] of COMPARISON_SCENARIOS.entries()) regressionRows.push(await invoke(base, register(scenario, index)));
    const workloadSeeds = Array.from({ length: turns }, (_, index) => register("unchanged", 1000 + index));
    const workloadRows: Array<ComparisonObservation & { index: number; user: number }> = [];
    await Promise.all(Array.from({ length: users }, (_, user) => (async () => {
      for (let index = user; index < turns; index += users) workloadRows.push({ ...await invoke(base, workloadSeeds[index]!), index, user });
    })()));
    workloadRows.sort((a, b) => a.index - b.index);
    return { version: COMPARISON_DIAGNOSTIC_VERSION, createdAt: new Date().toISOString(), basis: "scripted-provider-real-http", ...workloadSourceSnapshot(),
      fixtureHash: createHash("sha256").update(JSON.stringify({ COMPARISON_SCENARIOS, price, seats, operations, sources: COMPARISON_SCENARIOS.map(scenario => currentSources(scenario).map(({url,title,text}) => ({url,title,text}))) })).digest("hex"),
      harnessHash: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
      externalProviderRequests: 0, providerWalletsOpened: 0, releaseClaimAllowed: false,
      limitations: ["Scripted provider results test orchestration and validation, not model factual accuracy or retrieval relevance.",
        "The homogeneous five-user workload measures local HTTP/admission/storage overhead with injected provider delay, not production latency.",
        "P95 is withheld below 20 samples in each reported group. Failures stay in all-terminal timing and offered-request denominators.",
        "Browser rendering, actual provider latency and background enrichment are not measured; independent human labels remain pending."],
      providers: { comparisonCalls, forbiddenModelCalls, searchCalls, peakComparisons, mockDelayMs },
      regressions: { summary: summarizeComparison(regressionRows), cases: regressionRows },
      workload: { users, caseId: "unchanged", requestType: "live-pinned-comparison", arrivalModel: "closed-loop", summary: summarizeComparison(workloadRows), turns: workloadRows },
    };
  } finally { await app.shutdown(); }
}

async function main(args: string[]) {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    if (!["--users", "--turns", "--mock-delay-ms", "--out"].includes(args[index]!) || options.has(args[index]!) || !args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error("Use --users, --turns, --mock-delay-ms and --out only; this command never enables live providers.");
    options.set(args[index]!, args[index + 1]!);
  }
  const path = resolve(options.get("--out") ?? ".context/comparison-diagnostic.json");
  if (!path.startsWith(resolve(".context") + sep)) throw new Error("Diagnostic output must be under .context/.");
  const report = await runComparisonDiagnostic({ users: Number(options.get("--users") ?? 5), turns: Number(options.get("--turns") ?? 25), mockDelayMs: Number(options.get("--mock-delay-ms") ?? 5) });
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ report: path, regression: report.regressions.summary.behavior, workload: report.workload.summary, basis: report.basis }, null, 2));
  if (report.providers.forbiddenModelCalls || report.regressions.summary.behavior.passed !== report.regressions.summary.offered || report.workload.summary.behavior.passed !== report.workload.summary.offered) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : "Comparison diagnostic failed."); process.exitCode = 1; });
