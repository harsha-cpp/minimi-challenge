import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  parseWorkloadArgs,
  workloadPlan,
  preflightWorkload,
  observeHttpTurn,
  summarizeObservations,
  runHttpWorkload,
} from "../eval/workload.ts";
import { ProviderSpendStore, type SpendStore } from "../src/runtime/spend-store.ts";
import { ScopedSpendStore } from "../src/runtime/spend-scope.ts";
import type { ProviderSpendingPolicy } from "../src/runtime/provider-spending.ts";
import type { Config } from "../src/config.ts";
import { existsSync, mkdirSync } from "node:fs";

function wallets() {
  const global = new ProviderSpendStore({ path: ":memory:", caps: { azure: 1, exa: 1 } }),
    child = new ProviderSpendStore({ path: ":memory:", campaignId: "test-workload", caps: { azure: 0.1, exa: 0.1 } });
  return {
    global,
    child,
    scoped: new ScopedSpendStore(global, child),
    close() {
      global.close();
      child.close();
    },
  };
}
const config = (): Config => ({
  port: 0,
  host: "127.0.0.1",
  dbPath: ":memory:",
  temporalDbPath: ":memory:",
  startAt: null,
  missing: [],
  access: { mode: "local", allowedOrigins: [], ownerTokens: {} },
  retrievalProfiles: false,
  llm: {
    apiKey: "FAKE_PRIVATE_PROVIDER_SECRET",
    baseUrl: "https://workload-azure.example.com/openai/v1",
    model: "sol",
    fastModel: "luna",
    maxOutputTokens: 256,
    maxJsonOutputTokens: 256,
  },
  exaApiKey: "FAKE_PRIVATE_SEARCH_SECRET",
  limits: {
    activeTurns: 4,
    queuedTurns: 16,
    activeModels: 2,
    queuedModels: 32,
    modelRequestsPerMinute: 1000,
    modelTokensPerMinute: 10_000_000,
    modelCompletionRequests: 8,
    modelCompletionTokens: 50_000,
    turnTimeoutMs: 3000,
    turnTokens: 100_000,
    turnModelCalls: 10,
    maxOutputTokens: 256,
    shutdownMs: 100,
    traceRetentionDays: 14,
    maxTurnDollars: 0.1,
    searchAttemptDollars: 0.02,
    inputDollarsPerMillion: 1,
    outputDollarsPerMillion: 2,
  },
});
function policy(store: ProviderSpendStore): ProviderSpendingPolicy {
  return {
    store,
    priceVersion: "test-prices",
    modelPrices: {
      sol: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
      luna: { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.2 },
    },
    exaAttemptMaxDollars: 0.02,
  };
}
function outputPath() {
  mkdirSync(resolve(".context"), { recursive: true });
  const parent = mkdtempSync(join(resolve(".context"), "workload-test-"));
  return {
    parent,
    path: join(parent, "run"),
    close() {
      rmSync(parent, { recursive: true, force: true });
    },
  };
}

test("composite scope rejects before provider work and cancels the unstarted global hold", () => {
  const w = wallets();
  let http = 0;
  try {
    assert.throws(() => {
      const hold = w.scoped.reserve({ provider: "azure", maxDollars: 0.2 });
      hold.started();
      http++;
    });
    assert.equal(http, 0);
    assert.equal(w.global.getSummary().providers.azure.spentMicrousd, 0);
    assert.equal(w.global.getSummary().providers.azure.heldMicrousd, 0);
    assert.equal(w.child.getSummary().providers.azure.reservations, 0);
  } finally {
    w.close();
  }
});

test("composite global exhaustion never reserves child money and started cancellation cannot refund either wallet", () => {
  const w = wallets();
  try {
    const global = w.global.reserve({ provider: "azure", maxDollars: 1 });
    assert.throws(() => w.scoped.reserve({ provider: "azure", maxDollars: 0.01 }));
    assert.equal(w.child.getSummary().providers.azure.reservations, 0);
    global.cancelBeforeStart();
    const hold = w.scoped.reserve({ provider: "azure", maxDollars: 0.05 });
    hold.started();
    assert.throws(() => hold.cancelBeforeStart());
    assert.equal(w.global.getSummary().providers.azure.heldDollars, 0.05);
    assert.equal(w.child.getSummary().providers.azure.heldDollars, 0.05);
    hold.settle(null);
    assert.equal(w.global.getSummary().providers.azure.spentDollars, 0.05);
    assert.equal(w.child.getSummary().providers.azure.spentDollars, 0.05);
  } finally {
    w.close();
  }
});

test("both wallet settlements run even when the first records a bound violation", () => {
  const w = wallets();
  try {
    const hold = w.scoped.reserve({ provider: "exa", maxDollars: 0.01 });
    hold.started();
    assert.throws(() => hold.settle(0.02));
    for (const store of [w.global, w.child]) {
      assert.equal(store.getSummary().providers.exa.spentDollars, 0.02);
      assert.equal(store.getSummary().providers.exa.locked, true);
      assert.equal(store.getSummary().providers.exa.heldMicrousd, 0);
    }
  } finally {
    w.close();
  }
});

test("a partial start failure stays fail-closed even when a store throws undefined", () => {
  const w = wallets();
  let http = 0;
  const broken: SpendStore = {
    getSummary: () => w.child.getSummary(),
    reserve: (input) => {
      const hold = w.child.reserve(input);
      return {
        ...hold,
        markStarted() {
          throw undefined;
        },
      };
    },
  };
  try {
    const scope = new ScopedSpendStore(w.global, broken),
      hold = scope.reserve({ provider: "azure", maxDollars: 0.01 });
    let failed = false;
    try {
      hold.started();
      http++;
    } catch {
      failed = true;
    }
    assert.equal(failed, true);
    assert.equal(http, 0);
    assert.throws(() => hold.cancelBeforeStart());
    assert.equal(w.global.getSummary().providers.azure.heldDollars, 0.01);
    assert.equal(w.child.getSummary().providers.azure.heldDollars, 0);
  } finally {
    w.close();
  }
});

test("workload CLI is dry by default and live/preflight requires both absolute caps", () => {
  const options = parseWorkloadArgs([]),
    plan = workloadPlan(options);
  assert.equal(options.live, false);
  assert.equal(options.preflight, false);
  assert.deepEqual(options.loads, [1, 4, 8]);
  assert.deepEqual(parseWorkloadArgs(["--loads", "5"]).loads, [5]);
  assert.throws(() => parseWorkloadArgs(["--loads", "5,5"]));
  assert.equal(options.turnsPerLoad, 8);
  assert.equal(plan.offeredTurns, 24);
  assert.equal(plan.labelsSuppliedToGeneration, false);
  assert.throws(() => parseWorkloadArgs(["--live"]));
  assert.throws(() => parseWorkloadArgs(["--live", "--max-azure-dollars", "31", "--max-exa-dollars", "1"]));
  assert.throws(() => parseWorkloadArgs(["--loads", "16"]));
  assert.throws(() => parseWorkloadArgs(["--cache", "cold", "--warmup-turns", "1"]));
});

test("preflight reports limits without starting a model, search or HTTP server", () => {
  const store = new ProviderSpendStore({ path: ":memory:", caps: { azure: 1, exa: 1 } });
  try {
    const options = parseWorkloadArgs(["--preflight", "--max-azure-dollars", ".5", "--max-exa-dollars", ".1"]);
    const result = preflightWorkload(options, config(), policy(store));
    assert.equal(result.mode, "preflight-no-http");
    assert.ok(result.sourceSnapshotAt);
    assert.match(result.implementationHash, /^[a-f0-9]{64}$/);
    for (const path of [
      "src/agent/run.ts",
      "src/agent/prepare.ts",
      "src/agent/simulation.ts",
      "src/memory/enrich.ts",
      "src/llm/gateway.ts",
      "src/search/cache.ts",
      "eval/workload.ts",
    ])
      assert.ok(result.sourceFiles.some((file) => file.path === path));
    assert.equal(
      result.sourceFiles.some((file) => file.path.includes(".env")),
      false,
    );
    assert.equal(result.configured.azureRegion, "unknown");
    assert.equal(result.configured.deploymentPriceEnvelopes.sol!.outputPerMillionUsd, 2);
    assert.equal(result.configured.deploymentPriceEnvelopes.luna!.outputPerMillionUsd, 0.2);
    assert.match(result.configured.deploymentPriceEnvelopes.luna!.envelopeHash, /^[a-f0-9]{64}$/);
    assert.equal(store.getSummary().providers.azure.reservations, 0);
    assert.doesNotMatch(JSON.stringify(result), /FAKE_PRIVATE_PROVIDER_SECRET|FAKE_PRIVATE_SEARCH_SECRET/);
    store.reserve({ provider: "azure", maxDollars: 0.8 });
    assert.throws(() => preflightWorkload(options, config(), policy(store)));
  } finally {
    store.close();
  }
});

test("HTTP observer requires done, separates client text from browser rendering, and retains lost-done recovery as a protocol failure", async () => {
  const fake = (async (url: any) => {
    if (String(url).endsWith("/api/chat"))
      return new Response('data: {"type":"turn","turnId":"t"}\n\ndata: {"type":"text","delta":"answer"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    if (String(url).endsWith("/trace")) return Response.json({ trace: null });
    return Response.json({ turn: { id: "t", status: "completed" } });
  }) as typeof fetch;
  const result = await observeHttpTurn("http://127.0.0.1", {}, "key", 100, fake);
  assert.equal(result.accepted, true);
  assert.equal(result.doneReceived, false);
  assert.equal(result.durableCompleted, true);
  assert.equal(result.outcome, "error");
  assert.equal(result.errorCode, "stream_without_done");
  assert.equal(result.clientFirstRenderMs, null);
  assert.notEqual(result.clientFirstTextMs, null);
  const summary = summarizeObservations([result]);
  assert.equal(summary.offered, 1);
  assert.equal(summary.completed, 0);
  assert.equal(summary.errors, 1);
  assert.equal(summary.durableCompleted, 1);
  assert.equal(summary.latency.completed.p99Ms, null);
});

test("HTTP observer counts client deadline cancellation separately", async () => {
  const fake = (async (url: any, init?: RequestInit) => {
    if (String(url).endsWith("/api/chat")) {
      await delay(5);
      init?.signal?.throwIfAborted();
      throw new Error("unreachable");
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const row = await observeHttpTurn("http://127.0.0.1", {}, "key", 1, fake);
  assert.equal(row.outcome, "cancelled");
  assert.equal(row.errorCode, "client_deadline");
  assert.equal(summarizeObservations([row]).cancelled, 1);
});

test("accepted client deadlines remain in the durable completion denominator", async () => {
  const fake = (async (url: any) =>
    String(url).endsWith("/api/chat")
      ? new Response('data: {"type":"done","episodeId":1,"quality":"non_factual","timings":{}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        })
      : new Response("", { status: 404 })) as typeof fetch;
  const completed = await observeHttpTurn("http://127.0.0.1", {}, "key", 100, fake);
  const deadline = {
    ...completed,
    outcome: "cancelled" as const,
    doneReceived: false,
    durableCompleted: false,
    errorCode: "client_deadline",
  };
  const summary = summarizeObservations([completed, deadline]);
  assert.equal(summary.accepted, 2);
  assert.equal(summary.durableCompleted, 1);
  assert.equal(summary.cancelled, 1);
  assert.equal(summary.userCancelled, 0);
  assert.equal(summary.durableCompletionRate, 0.5);
});

function mockProviders() {
  const original = globalThis.fetch;
  let modelCalls = 0,
    searchCalls = 0,
    active = 0,
    peak = 0;
  const body = (text: string) =>
    new Response(
      `data: ${JSON.stringify({ model: "mock-wire", choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ model: "mock-wire", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("http://127.0.0.1:")) return original(input, init);
    if (url.startsWith("https://workload-azure.example.com/")) {
      modelCalls++;
      active++;
      peak = Math.max(peak, active);
      await delay(2);
      active--;
      const request = JSON.parse(String(init?.body));
      if (request.stream) return body("Mock conversation content. ".repeat(24));
      const system = String(request.messages?.[0]?.content ?? "");
      const data = system.includes("CURRENT-FACT")
        ? { status: "approved", issues: [], safeAnswer: null, quality: "explicitly_unverified", claimChecks: [] }
        : system.includes("Review a researched")
          ? { status: "approved", issues: [], safeAnswer: null }
          : { summary: "Mock memory", topics: [], claims: [] };
      return Response.json({
        model: "mock-wire",
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(data) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      });
    }
    if (url.startsWith("https://api.exa.ai/")) {
      searchCalls++;
      return Response.json({ results: [], costDollars: { total: 0.001 } });
    }
    throw new Error("Unexpected external destination in deterministic workload test");
  }) as typeof fetch;
  return {
    get modelCalls() {
      return modelCalls;
    },
    get searchCalls() {
      return searchCalls;
    },
    get peak() {
      return peak;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

test(
  "mock-provider HTTP workload exercises 1/4/8 users, durable SSE completion and shared worker wallet",
  { timeout: 15000 },
  async () => {
    const fixture = outputPath(),
      store = new ProviderSpendStore({ path: ":memory:", caps: { azure: 1, exa: 1 } }),
      transport = mockProviders();
    try {
      const options = parseWorkloadArgs([
        "--live",
        "--loads",
        "1,4,8",
        "--turns-per-load",
        "8",
        "--think-ms",
        "0",
        "--worker-drain-ms",
        "1000",
        "--seed-episodes",
        "1",
        "--max-azure-dollars",
        ".5",
        "--max-exa-dollars",
        ".1",
        "--out",
        fixture.path,
      ]);
      const report = await runHttpWorkload(options, config(), policy(store), "mocked-http");
      assert.equal(report.summary.offered, 24);
      assert.equal(report.summary.completed, 24);
      assert.equal(report.summary.errors, 0);
      assert.equal(report.summary.rejected, 0);
      assert.equal(report.runtime.backgroundEnrichment, true);
      assert.ok(transport.modelCalls > 24, "genuine worker/review calls must share the scoped wallet");
      assert.ok(transport.peak <= 2);
      assert.equal(report.scope.final.providers.azure.spentMicrousd, store.getSummary().providers.azure.spentMicrousd);
      assert.ok(report.scope.final.providers.azure.spentDollars <= 0.5);
      assert.equal(report.scope.final.providers.azure.heldMicrousd, 0);
      for (const load of report.loads) {
        assert.equal(load.summary.offered, 8);
        assert.ok(load.turns.every((row: any) => row.doneReceived && row.clientFirstRenderMs === null));
        assert.ok(load.background.traces.length > 0);
        assert.ok(load.turns.every((row: any) => row.trace?.stages?.length));
      }
      assert.equal(report.releaseClaimAllowed, false);
      assert.ok(existsSync(join(fixture.path, "turns.csv")));
      assert.ok(existsSync(join(fixture.path, "stages.csv")));
      assert.match(readFileSync(join(fixture.path, "stages.csv"), "utf8"), /""purpose""/);
      assert.doesNotMatch(
        readFileSync(join(fixture.path, "report.json"), "utf8"),
        /FAKE_PRIVATE_PROVIDER_SECRET|FAKE_PRIVATE_SEARCH_SECRET/,
      );
    } finally {
      transport.restore();
      store.close();
      fixture.close();
    }
  },
);

test(
  "an exhausted workload campaign makes no provider HTTP calls and leaves global money unchanged",
  { timeout: 10000 },
  async () => {
    const fixture = outputPath(),
      store = new ProviderSpendStore({ path: ":memory:", caps: { azure: 1, exa: 1 } }),
      transport = mockProviders();
    try {
      const options = parseWorkloadArgs([
        "--live",
        "--loads",
        "4",
        "--turns-per-load",
        "4",
        "--think-ms",
        "0",
        "--worker-drain-ms",
        "0",
        "--seed-episodes",
        "1",
        "--max-azure-dollars",
        ".000001",
        "--max-exa-dollars",
        ".1",
        "--out",
        fixture.path,
      ]);
      const report = await runHttpWorkload(options, config(), policy(store), "mocked-http");
      assert.equal(transport.modelCalls, 0);
      assert.equal(transport.searchCalls, 0);
      assert.equal(report.summary.completed, 0);
      assert.equal(report.summary.errors, 4);
      assert.equal(store.getSummary().providers.azure.spentMicrousd, 0);
      assert.equal(store.getSummary().providers.azure.heldMicrousd, 0);
    } finally {
      transport.restore();
      store.close();
      fixture.close();
    }
  },
);
