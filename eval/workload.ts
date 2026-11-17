import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../src/config.ts";
import { createApplication } from "../src/server.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { defaultProviderSpending, envelopeFor, type ProviderSpendingPolicy } from "../src/runtime/provider-spending.ts";
import { ProviderSpendStore } from "../src/runtime/spend-store.ts";
import { ScopedSpendStore } from "../src/runtime/spend-scope.ts";
import type { TurnTrace } from "../src/runtime/telemetry.ts";

export const WORKLOAD_VERSION = "http-closed-loop-v1";
export const WORKLOAD_CASES = [
  { id: "greeting", kind: "conversation", message: "Hello.", mode: "live" },
  {
    id: "rewrite",
    kind: "transform",
    message: "Rewrite this sentence more clearly: The deployment was done after the tests were done.",
    mode: "live",
  },
  { id: "memory", kind: "recall", message: "What database did we choose for Project Cedar?", mode: "live" },
  {
    id: "wal-writers",
    kind: "lookup",
    message:
      "According to SQLite's official WAL documentation, can two writers write to the same WAL database at the same time? Read https://www.sqlite.org/wal.html.",
    mode: "live",
  },
  { id: "thanks", kind: "conversation", message: "Thanks.", mode: "live" },
  { id: "translation", kind: "transform", message: "Translate into Spanish: The backup is ready.", mode: "live" },
  {
    id: "wal-host",
    kind: "verification",
    message: "Verify from https://www.sqlite.org/wal.html whether WAL requires all processes to be on the same host.",
    mode: "live",
  },
  {
    id: "era-capital",
    kind: "historical",
    message: "From this 1950 viewpoint, which country is Washington, D.C. the capital of?",
    mode: "era",
    asOf: "1950-01-01T12:00:00Z",
  },
] as const;
export interface WorkloadOptions {
  live: boolean;
  preflight: boolean;
  loads: number[];
  turnsPerLoad: number;
  thinkMs: number;
  cache: "cold" | "warm";
  warmupTurns: number;
  workerDrainMs: number;
  seedEpisodes: number;
  maxAzureDollars: number | null;
  maxExaDollars: number | null;
  outputDir: string;
  azureRegion: string;
}
export function parseWorkloadArgs(args: string[]): WorkloadOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const keys = [
    "--loads",
    "--turns-per-load",
    "--think-ms",
    "--cache",
    "--warmup-turns",
    "--worker-drain-ms",
    "--seed-episodes",
    "--max-azure-dollars",
    "--max-exa-dollars",
    "--out",
    "--azure-region",
  ];
  for (let i = 0; i < args.length; i++) {
    const name = args[i]!;
    if (name === "--live" || name === "--preflight") {
      if (flags.has(name)) throw new Error("Duplicate workload flag.");
      flags.add(name);
      continue;
    }
    if (!keys.includes(name) || values.has(name) || !args[i + 1] || args[i + 1]!.startsWith("--"))
      throw new Error("Unknown, duplicate or incomplete workload option.");
    values.set(name, args[++i]!);
  }
  if (flags.has("--live") && flags.has("--preflight")) throw new Error("Choose --live or --preflight.");
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const n = Number(values.get(name) ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} is outside its integer range.`);
    return n;
  };
  const cap = (name: string, max: number) => {
    if (!values.has(name)) return null;
    const n = Number(values.get(name));
    if (!Number.isFinite(n) || n <= 0 || n > max)
      throw new Error(`${name} must be positive and within the project allowance.`);
    return n;
  };
  const loads = (values.get("--loads") ?? "1,4,8").split(",").map(Number);
  if (!loads.length || new Set(loads).size !== loads.length || loads.some((n) => ![1, 4, 5, 8].includes(n)))
    throw new Error("--loads must select distinct values from 1,4,5,8.");
  const cache = values.get("--cache") ?? "cold";
  if (cache !== "cold" && cache !== "warm") throw new Error("--cache must be cold or warm.");
  const warmupTurns = integer("--warmup-turns", cache === "warm" ? 8 : 0, 0, 1000);
  if ((cache === "cold" && warmupTurns !== 0) || (cache === "warm" && warmupTurns === 0))
    throw new Error("Warm cache requires declared warmup turns; cold starts have no warmup.");
  const maxAzureDollars = cap("--max-azure-dollars", 30),
    maxExaDollars = cap("--max-exa-dollars", 20);
  if (flags.size > 0 && (maxAzureDollars === null || maxExaDollars === null))
    throw new Error("Preflight/live workloads require explicit Azure and Exa campaign caps.");
  const outputDir = resolve(
    values.get("--out") ?? `.context/workload-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  if (!outputDir.startsWith(resolve(".context") + sep)) throw new Error("Workload artifacts must be under .context/.");
  return {
    live: flags.has("--live"),
    preflight: flags.has("--preflight"),
    loads,
    turnsPerLoad: integer("--turns-per-load", 8, 1, 1000),
    thinkMs: integer("--think-ms", 100, 0, 10_000),
    cache,
    warmupTurns,
    workerDrainMs: integer("--worker-drain-ms", 5000, 0, 30_000),
    seedEpisodes: integer("--seed-episodes", 100, 1, 100_000),
    maxAzureDollars,
    maxExaDollars,
    outputDir,
    azureRegion: (values.get("--azure-region") ?? "unknown").replace(/[\x00-\x1f]/g, "").slice(0, 100),
  };
}
export function workloadPlan(options: WorkloadOptions) {
  return {
    version: WORKLOAD_VERSION,
    mode: options.live ? "live-http" : options.preflight ? "preflight-no-http" : "dry-run-no-http",
    options,
    offeredTurns: options.loads.length * options.turnsPerLoad,
    warmupTurns: options.loads.length * options.warmupTurns,
    arrivalModel:
      "Closed loop: each virtual user waits for its prior turn and declared think time. This does not establish sustainable open-loop RPS.",
    cases: WORKLOAD_CASES.map(({ id, kind, message, mode, ...rest }) => ({ id, kind, message, mode, ...rest })),
    labelsSuppliedToGeneration: false,
    browserFirstRenderMs: null,
    backgroundEnrichment: true,
    accounting:
      "Every model/search/enrichment attempt reserves both the canonical product wallet and a durable workload wallet. Unknown billing and unfinished work retain their bounds.",
  };
}
export function workloadSourceSnapshot() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
      else if (entry.isSymbolicLink()) throw new Error("Workload source snapshots require concrete source files.");
    }
  };
  visit(resolve(root, "src"));
  files.push(resolve(root, "eval/workload.ts"));
  files.sort();
  const sourceSnapshotAt = new Date().toISOString();
  const manifest = files.map((path) => {
    const content = readFileSync(path);
    return {
      path: relative(root, path).split(sep).join("/"),
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
  return {
    sourceSnapshotAt,
    implementationHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    sourceFiles: manifest,
    dependencyLockHash: createHash("sha256")
      .update(readFileSync(resolve(root, "package-lock.json")))
      .digest("hex"),
  };
}

export function preflightWorkload(options: WorkloadOptions, config: Config, policy: ProviderSpendingPolicy) {
  if (!config.llm || !config.exaApiKey)
    throw new Error("Workload preflight requires configured model/search credentials; none are printed.");
  if (
    config.limits.inputDollarsPerMillion === null ||
    config.limits.outputDollarsPerMillion === null ||
    config.limits.searchAttemptDollars == null ||
    policy.exaAttemptMaxDollars === null
  )
    throw new Error(
      "Workload preflight requires configured conservative model price envelopes and an Exa attempt bound.",
    );
  envelopeFor(policy, config.llm.model);
  envelopeFor(policy, config.llm.fastModel ?? config.llm.model);
  if (options.maxAzureDollars === null || options.maxExaDollars === null)
    throw new Error("Workload campaign caps are required.");
  const global = policy.store.getSummary();
  for (const provider of ["azure", "exa"] as const) {
    const requested = provider === "azure" ? options.maxAzureDollars : options.maxExaDollars;
    if (global.providers[provider].locked || requested > global.providers[provider].remainingDollars)
      throw new Error("Requested workload caps cannot be funded from the remaining project allowance.");
  }
  return {
    ...workloadPlan(options),
    ...workloadSourceSnapshot(),
    configured: {
      model: config.llm.model,
      fastModel: config.llm.fastModel ?? config.llm.model,
      apiMode: config.llm.apiMode ?? "chat_completions",
      priceVersion: policy.priceVersion,
      deploymentPriceEnvelopeHash: createHash("sha256").update(JSON.stringify(policy.modelPrices)).digest("hex"),
      deploymentPriceEnvelopes: Object.fromEntries(
        [...new Set([config.llm.model, config.llm.fastModel ?? config.llm.model])].map((deployment) => {
          const price = envelopeFor(policy, deployment);
          const rates = {
            inputPerMillionUsd: price.inputPerMillionUsd,
            outputPerMillionUsd: price.outputPerMillionUsd,
            cachedInputPerMillionUsd: price.cachedInputPerMillionUsd ?? price.inputPerMillionUsd,
          };
          return [
            deployment,
            { ...rates, envelopeHash: createHash("sha256").update(JSON.stringify(rates)).digest("hex") },
          ];
        }),
      ),
      exaAttemptMaxDollars: policy.exaAttemptMaxDollars,
      limits: config.limits,
      azureRegion: options.azureRegion,
    },
    global,
  };
}

export interface HttpObservation {
  clientStartedAt: string;
  clientFinishedAt: string | null;
  httpStatus: number | null;
  accepted: boolean;
  doneReceived: boolean;
  durableCompleted: boolean;
  turnId: string | null;
  outcome: "completed" | "clarification" | "rejected" | "error" | "cancelled";
  errorCode: string | null;
  quality: string | null;
  clientFirstTextMs: number | null;
  clientFirstFinalTextMs: number | null;
  clientFirstRenderMs: null;
  serverFirstEmissionMs: number | null;
  elapsedMs: number;
  searches: number;
  modelCalls: number;
  trace: TurnTrace | null;
}
export async function observeHttpTurn(
  base: string,
  body: Record<string, unknown>,
  key: string,
  timeoutMs: number,
  fetchHttp: typeof fetch = fetch,
): Promise<HttpObservation> {
  const began = performance.now(),
    signal = AbortSignal.timeout(timeoutMs);
  let bytes = 0;
  const row: HttpObservation = {
    clientStartedAt: new Date().toISOString(),
    clientFinishedAt: null,
    httpStatus: null,
    accepted: false,
    doneReceived: false,
    durableCompleted: false,
    turnId: null,
    outcome: "error",
    errorCode: null,
    quality: null,
    clientFirstTextMs: null,
    clientFirstFinalTextMs: null,
    clientFirstRenderMs: null,
    serverFirstEmissionMs: null,
    elapsedMs: 0,
    searches: 0,
    modelCalls: 0,
    trace: null,
  };
  try {
    const response = await fetchHttp(base + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(body),
      signal,
    });
    row.httpStatus = response.status;
    row.turnId = response.headers.get("x-turn-id");
    if (response.status !== 200 || !response.headers.get("content-type")?.includes("text/event-stream")) {
      const data = (await response.json()) as Record<string, unknown>;
      row.outcome = [429, 503].includes(response.status) ? "rejected" : "error";
      row.errorCode = typeof data.code === "string" ? data.code : "http_error";
    } else {
      row.accepted = true;
      const reader = response.body!.getReader(),
        decoder = new TextDecoder();
      let pending = "";
      const consume = (frame: string) => {
        if (!frame.startsWith("data: ")) return;
        const event = JSON.parse(frame.slice(6)) as Record<string, any>;
        if (event.type === "turn" && typeof event.turnId === "string") row.turnId = event.turnId;
        if (event.type === "text" && event.delta) {
          row.clientFirstTextMs ??= Math.round(performance.now() - began);
          row.clientFirstFinalTextMs ??= Math.round(performance.now() - began);
        }
        if (event.type === "retract") row.clientFirstFinalTextMs = null;
        if (event.type === "done") {
          row.doneReceived = true;
          row.durableCompleted = true;
          row.outcome = "completed";
          row.quality = event.quality ?? null;
          row.serverFirstEmissionMs = event.timings?.firstTokenMs ?? null;
          row.searches = event.timings?.searches ?? 0;
          row.modelCalls = event.timings?.modelCalls ?? 0;
        }
        if (event.type === "clarification") row.outcome = "clarification";
        if (event.type === "error") {
          row.outcome = "error";
          row.errorCode = typeof event.code === "string" ? event.code : "generation_error";
        }
      };
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 4_000_000) throw new Error("stream_limit");
          pending += decoder.decode(chunk.value, { stream: true });
          if (pending.length > 262_144) throw new Error("frame_limit");
          let boundary: number;
          while ((boundary = pending.indexOf("\n\n")) >= 0) {
            consume(pending.slice(0, boundary));
            pending = pending.slice(boundary + 2);
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (!row.doneReceived && row.outcome !== "clarification") {
        row.outcome = "error";
        row.errorCode ??= "stream_without_done";
      }
    }
  } catch {
    row.outcome = signal.aborted ? "cancelled" : "error";
    row.errorCode = signal.aborted ? "client_deadline" : "client_transport";
  }
  row.elapsedMs = Math.round(performance.now() - began);
  row.clientFinishedAt = new Date().toISOString();
  // Status lookup recovers durability, but absence of done remains a delivery/protocol failure in this measurement.
  try {
    const path = row.turnId ? `/api/turns/${row.turnId}` : `/api/turns/by-key/${encodeURIComponent(key)}`;
    const recovered = await fetchHttp(base + path, { signal: AbortSignal.timeout(2000) });
    if (recovered.ok) {
      const data = (await recovered.json()) as any;
      row.turnId ??= data.turn?.id ?? null;
      row.durableCompleted ||= data.turn?.status === "completed";
    }
    if (row.turnId) {
      const response = await fetchHttp(`${base}/api/turns/${row.turnId}/trace`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        const data = (await response.json()) as any;
        row.trace = data.trace ?? null;
        row.serverFirstEmissionMs = row.trace?.serverFirstEmissionMs ?? row.serverFirstEmissionMs;
      }
    }
  } catch {
    /* Recovery failures remain visible in the original protocol outcome. */
  }
  return row;
}
function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}
export function summarizeObservations(rows: HttpObservation[]) {
  const accepted = rows.filter((r) => r.accepted),
    completed = rows.filter((r) => r.outcome === "completed" && r.doneReceived),
    cancelled = rows.filter((r) => r.outcome === "cancelled");
  const timing = (values: Array<number | null>) => {
    const known = values.filter((v): v is number => v !== null && Number.isFinite(v));
    return {
      samples: known.length,
      p50Ms: percentile(known, 0.5),
      p95Ms: known.length >= 20 ? percentile(known, 0.95) : null,
      p99Ms: known.length >= 1000 ? percentile(known, 0.99) : null,
    };
  };
  return {
    offered: rows.length,
    accepted: accepted.length,
    completed: completed.length,
    durableCompleted: accepted.filter((r) => r.durableCompleted).length,
    rejected: rows.filter((r) => r.outcome === "rejected").length,
    errors: rows.filter((r) => r.outcome === "error").length,
    cancelled: cancelled.length,
    userCancelled: 0,
    clientDeadlineCancelled: cancelled.length,
    clarifications: rows.filter((r) => r.outcome === "clarification").length,
    durableCompletionRate: accepted.length ? accepted.filter((r) => r.durableCompleted).length / accepted.length : null,
    qualityCounts: Object.fromEntries(
      [...new Set(completed.map((r) => r.quality ?? "unknown"))].map((quality) => [
        quality,
        completed.filter((r) => (r.quality ?? "unknown") === quality).length,
      ]),
    ),
    latency: {
      allTerminal: timing(rows.map((r) => r.elapsedMs)),
      completed: timing(completed.map((r) => r.elapsedMs)),
      failed: timing(rows.filter((r) => r.outcome !== "completed").map((r) => r.elapsedMs)),
      serverFirstEmission: timing(completed.map((r) => r.serverFirstEmissionMs)),
      clientFirstFinalText: timing(completed.map((r) => r.clientFirstFinalTextMs)),
      browserRender: { samples: 0, p50Ms: null, p95Ms: null, p99Ms: null },
    },
    cache: {
      hits: rows.flatMap((r) => r.trace?.stages ?? []).filter((s) => s.name === "search_cache" && s.data?.hit === true)
        .length,
      misses: rows
        .flatMap((r) => r.trace?.stages ?? [])
        .filter((s) => s.name === "search_cache" && s.data?.hit === false).length,
    },
    interpretation:
      rows.length < 100
        ? "Small-sample diagnostic; no stable tail or release claim."
        : "Closed-loop workload evidence; quality and browser rendering require separate evaluation.",
  };
}
function seedMemory(store: MemoryStore, count: number) {
  const at = Date.now() - 86_400_000;
  for (let i = 0; i < count; i++) {
    const cedar = i === 0;
    const id = store.saveEpisode({
      sessionId: "seed",
      askedAt: at + i,
      tz: "UTC",
      question: cedar ? "What database did we choose for Project Cedar?" : `Archived planning note ${i}`,
      answer: cedar
        ? "For Project Cedar, we chose SQLite for the first single-host release."
        : `Synthetic conversation seed ${i}.`,
      sources: [],
      execution: { intent: "conversation" },
    });
    store.enrich(id, {
      summary: cedar ? "Project Cedar chose SQLite." : `Planning note ${i}`,
      topics: cedar ? ["project cedar", "database"] : [],
      claims: [],
    });
  }
}
function savedBackground(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const jobs = db.prepare("SELECT state,count(*) AS n FROM memory_jobs GROUP BY state").all();
    const rows = db
      .prepare("SELECT trace_json FROM turn_traces WHERE turn_id LIKE 'job-%' ORDER BY updated_at LIMIT 5000")
      .all();
    return { jobs, traces: rows.map((r) => JSON.parse(r.trace_json as string) as TurnTrace), traceLimit: 5000 };
  } finally {
    db.close();
  }
}
function csvCell(value: unknown) {
  const text =
    value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}
function writeReport(path: string, report: Record<string, any>) {
  writeFileSync(resolve(path, "report.json"), JSON.stringify(report, null, 2) + "\n");
  const fields = [
    "load",
    "user",
    "index",
    "caseId",
    "kind",
    "clientStartedAt",
    "clientFinishedAt",
    "httpStatus",
    "accepted",
    "outcome",
    "doneReceived",
    "durableCompleted",
    "errorCode",
    "quality",
    "elapsedMs",
    "serverFirstEmissionMs",
    "clientFirstTextMs",
    "clientFirstFinalTextMs",
    "clientFirstRenderMs",
    "modelCalls",
    "searches",
  ];
  writeFileSync(
    resolve(path, "turns.csv"),
    fields.join(",") +
      "\n" +
      report.loads
        .flatMap((load: any) => load.turns.map((row: any) => fields.map((field) => csvCell(row[field])).join(",")))
        .join("\n") +
      "\n",
  );
  const stages = report.loads.flatMap((load: any) => [
    ...load.turns.flatMap((row: any) =>
      (row.trace?.stages ?? []).map((stage: any) => [
        load.load,
        "foreground",
        row.turnId,
        row.caseId,
        stage.name,
        stage.ms,
        stage.atMs,
        stage.data ?? null,
      ]),
    ),
    ...(load.background?.traces ?? []).flatMap((trace: TurnTrace) =>
      trace.stages.map((stage) => [
        load.load,
        "background",
        trace.turnId,
        null,
        stage.name,
        stage.ms,
        stage.atMs,
        stage.data ?? null,
      ]),
    ),
  ]);
  writeFileSync(
    resolve(path, "stages.csv"),
    "load,origin,turnId,caseId,name,ms,atMs,data\n" +
      stages.map((row: unknown[]) => row.map(csvCell).join(",")).join("\n") +
      "\n",
  );
}

export async function runHttpWorkload(
  options: WorkloadOptions,
  configuration: Config,
  globalPolicy: ProviderSpendingPolicy,
  basis: "live-http" | "mocked-http" = "live-http",
) {
  if (!options.live)
    throw new Error(
      "Running HTTP workloads requires explicit --live; dry-run and preflight never send provider requests.",
    );
  const preflight = preflightWorkload(options, configuration, globalPolicy);
  if (!resolve(options.outputDir).startsWith(resolve(".context") + sep))
    throw new Error("Workload artifacts must be under .context/.");
  mkdirSync(dirname(options.outputDir), { recursive: true });
  mkdirSync(options.outputDir, { recursive: false });
  const campaignId = `workload-${randomUUID()}`;
  const child = new ProviderSpendStore({
    path: resolve(options.outputDir, "campaign-spend.db"),
    campaignId,
    caps: { azure: options.maxAzureDollars!, exa: options.maxExaDollars! },
  });
  const scope = new ScopedSpendStore(globalPolicy.store, child),
    policy = { ...globalPolicy, store: scope };
  const report: Record<string, any> = {
    version: WORKLOAD_VERSION,
    basis,
    createdAt: new Date().toISOString(),
    preflight,
    implementationHash: preflight.implementationHash,
    sourceSnapshotAt: preflight.sourceSnapshotAt,
    sourceFiles: preflight.sourceFiles,
    dependencyLockHash: preflight.dependencyLockHash,
    scope: { campaignId, initial: child.getSummary(), final: null },
    global: { initial: preflight.global, final: null },
    runtime: {
      node: process.version,
      azureRegion: options.azureRegion,
      model: configuration.llm!.model,
      fastModel: configuration.llm!.fastModel ?? configuration.llm!.model,
      apiMode: configuration.llm!.apiMode ?? "chat_completions",
      priceVersion: policy.priceVersion,
      deploymentPriceEnvelopes: preflight.configured.deploymentPriceEnvelopes,
      backgroundEnrichment: true,
      cacheStart: options.cache,
      applicationFreshPerLoad: true,
      providerQuotaWindow:
        "The local quota window starts with each fresh load instance; upstream and unrelated account state is not reset.",
      labelsSuppliedToGeneration: false,
      instrumentation:
        "Each offered turn adds bounded status and trace GETs after its stream; these are local reads with no provider HTTP.",
    },
    caseMix: WORKLOAD_CASES.map(({ id, kind }) => ({ id, kind })),
    loads: [],
    releaseClaimAllowed: false,
    limitations: [
      "Closed-loop concurrency is not an open-loop sustainable rate.",
      "Node HTTP text observation is distinct from browser rendering; all browser render timings are null.",
      "This workload measures completion and protocol behavior; it does not judge correctness or passage support.",
      "All provider charges are conservative price-envelope bookings including worker work and unknown/pending holds, not provider invoices.",
    ],
  };
  try {
    for (const load of options.loads) {
      const dir = resolve(options.outputDir, `load-${load}`);
      mkdirSync(dir);
      const dbPath = resolve(dir, "app.db"),
        store = new MemoryStore(dbPath);
      seedMemory(store, options.seedEpisodes);
      const config: Config = {
        ...configuration,
        port: 0,
        host: "127.0.0.1",
        dbPath,
        startAt: null,
        access: { mode: "local", allowedOrigins: [], ownerTokens: {} },
      };
      let app: ReturnType<typeof createApplication> | undefined;
      const sample: any = {
        load,
        dbPath,
        cache: options.cache,
        warmupTurns: [],
        turns: [],
        summary: null,
        before: child.getSummary(),
        after: null,
        metrics: null,
        background: null,
      };
      report.loads.push(sample);
      try {
        app = createApplication({ config, store, spendingPolicy: policy });
        app.server.listen(0, "127.0.0.1");
        await once(app.server, "listening");
        const address = app.server.address();
        if (!address || typeof address === "string")
          throw new Error("Loopback workload server did not receive an ephemeral port.");
        const base = `http://127.0.0.1:${address.port}`;
        const invoke = async (index: number, user: number, warmup = false) => {
          const task = WORKLOAD_CASES[index % WORKLOAD_CASES.length]!;
          const response = await observeHttpTurn(
            base,
            {
              sessionId: `load-${load}-${warmup ? "warmup" : "user"}-${user}`,
              message: task.message,
              tz: "UTC",
              mode: task.mode,
              ...("asOf" in task ? { asOf: task.asOf } : {}),
            },
            randomUUID(),
            config.limits.turnTimeoutMs + 15_000,
          );
          return { load, user, index, caseId: task.id, kind: task.kind, ...response };
        };
        for (let i = 0; i < options.warmupTurns; i++) sample.warmupTurns.push(await invoke(i, 0, true));
        sample.startedAt = new Date().toISOString();
        const began = performance.now();
        await Promise.all(
          Array.from({ length: load }, (_, user) =>
            (async () => {
              for (let index = user; index < options.turnsPerLoad; index += load) {
                sample.turns.push(await invoke(index, user));
                if (options.thinkMs && index + load < options.turnsPerLoad) await delay(options.thinkMs);
              }
            })(),
          ),
        );
        sample.measuredElapsedMs = Math.round(performance.now() - began);
        sample.turns.sort((a: any, b: any) => a.index - b.index);
        const drainUntil = Date.now() + options.workerDrainMs;
        while (Date.now() < drainUntil) {
          const jobs = store.memoryJobCounts();
          if (!(jobs.pending ?? 0) && !(jobs.leased ?? 0)) break;
          await delay(Math.min(50, Math.max(1, drainUntil - Date.now())));
        }
        const metrics = await fetch(base + "/api/metrics", { signal: AbortSignal.timeout(2000) });
        if (metrics.ok) sample.metrics = await metrics.json();
      } finally {
        if (app) await app.shutdown();
        else store.close();
      }
      sample.after = child.getSummary();
      sample.background = savedBackground(dbPath);
      sample.summary = summarizeObservations(sample.turns);
      sample.stageTotals = Object.fromEntries(
        [
          ...new Set(
            sample.turns.flatMap((row: HttpObservation) => (row.trace?.stages ?? []).map((stage) => stage.name)),
          ),
        ].map((name) => {
          const stages = sample.turns.flatMap((row: HttpObservation) =>
            (row.trace?.stages ?? []).filter((stage) => stage.name === name),
          );
          return [String(name), { count: stages.length, totalMs: stages.reduce((n: number, s: any) => n + s.ms, 0) }];
        }),
      );
      writeReport(options.outputDir, report);
      if (["azure", "exa"].some((provider) => sample.after.providers[provider].pending > 0)) {
        report.notRunLoads = options.loads
          .slice(options.loads.indexOf(load) + 1)
          .map((load) => ({ load, reason: "campaign_has_unsettled_provider_holds" }));
        break;
      }
    }
  } catch {
    report.failure = "workload_infrastructure_failure";
    throw new Error("Workload stopped; inspect its bounded report and retained wallets before another attempt.");
  } finally {
    report.finishedAt = new Date().toISOString();
    report.scope.final = child.getSummary();
    report.global.final = globalPolicy.store.getSummary();
    const rows = report.loads.flatMap((load: any) => load.turns);
    report.summary = summarizeObservations(rows);
    const supported = rows.filter(
      (row: HttpObservation) => row.doneReceived && ["supported", "supported_partial"].includes(row.quality ?? ""),
    ).length;
    const totalCost = ["azure", "exa"].reduce(
      (sum, provider) =>
        sum + report.scope.final.providers[provider].spentDollars + report.scope.final.providers[provider].heldDollars,
      0,
    );
    report.efficiency = {
      chargedOrHeldDollars: totalCost,
      engineReportedSupportedDurableCompletions: supported,
      costPerEngineReportedSupportedDurableCompletion: supported ? totalCost / supported : null,
      supportAssessment: "Engine-reported quality states, not independent claim adjudication.",
      includesBackgroundEnrichment: true,
    };
    report.scope.chargedOrHeldDollars = Object.fromEntries(
      ["azure", "exa"].map((provider) => [
        provider,
        report.scope.final.providers[provider].spentDollars + report.scope.final.providers[provider].heldDollars,
      ]),
    );
    writeReport(options.outputDir, report);
    child.close();
  }
  return report;
}
async function main(args: string[]) {
  const options = parseWorkloadArgs(args);
  if (!options.live && !options.preflight) {
    console.log(JSON.stringify(workloadPlan(options), null, 2));
    return;
  }
  const config = loadConfig(),
    policy = defaultProviderSpending();
  if (options.preflight) {
    console.log(JSON.stringify(preflightWorkload(options, config, policy), null, 2));
    return;
  }
  const report = await runHttpWorkload(options, config, policy);
  console.log(
    JSON.stringify(
      {
        path: resolve(options.outputDir, "report.json"),
        summary: report.summary,
        scope: report.scope.final,
        global: report.global.final,
      },
      null,
      2,
    ),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(() => {
    console.error(
      "Workload command failed; no automatic retries or budget resets were performed. Check options, preflight and any retained report.",
    );
    process.exitCode = 1;
  });
