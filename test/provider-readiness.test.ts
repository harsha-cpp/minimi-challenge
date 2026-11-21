import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import { providerConfigurationIssues } from "../src/runtime/provider-readiness.ts";
import type { ProviderSpendingPolicy } from "../src/runtime/provider-spending.ts";

const config = (): Config => ({
  port: 3000, host: "127.0.0.1", dbPath: ":memory:", temporalDbPath: ":memory:",
  llm: { apiKey: "private-model-credential", model: "main", fastModel: "fast", apiMode: "responses" },
  exaApiKey: "private-search-credential", startAt: null, missing: [], retrievalProfiles: false,
  access: { mode: "local", allowedOrigins: [], ownerTokens: {} },
  limits: { activeTurns: 4, queuedTurns: 16, activeModels: 4, queuedModels: 24, modelRequestsPerMinute: 120,
    modelTokensPerMinute: 1_000_000, turnTimeoutMs: 120_000, turnTokens: 100_000, turnModelCalls: 10,
    maxOutputTokens: 4096, shutdownMs: 10_000, traceRetentionDays: 14, maxTurnDollars: 1,
    inputDollarsPerMillion: 6, outputDollarsPerMillion: 20, searchAttemptDollars: 0.02 },
});
const policy = (): ProviderSpendingPolicy => ({
  store: { reserve() { throw new Error("Readiness must not reserve paid work."); }, getSummary() { throw new Error("Readiness must not open or inspect a wallet."); } },
  priceVersion: "operator-envelope-v1", exaAttemptMaxDollars: 0.02,
  modelPrices: { main: { inputPerMillionUsd: 6, outputPerMillionUsd: 20 }, fast: { inputPerMillionUsd: 0.3, outputPerMillionUsd: 1, cachedInputPerMillionUsd: 0 } },
});

test("complete real-provider configuration is ready without provider or ledger work and without mutation", () => {
  const settings = config(), prices = policy();
  const original = structuredClone(settings), originalPrices = structuredClone(prices.modelPrices);
  Object.freeze(settings.limits); Object.freeze(settings); Object.freeze(prices.modelPrices); Object.freeze(prices);
  assert.deepEqual(providerConfigurationIssues(settings, prices), []);
  assert.deepEqual(settings, original); assert.deepEqual(prices.modelPrices, originalPrices);
});

test("both shared turn-admission rates must be explicit finite positive numbers", () => {
  for (const value of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const settings = config(); settings.limits.inputDollarsPerMillion = value; settings.limits.outputDollarsPerMillion = value;
    assert.deepEqual(providerConfigurationIssues(settings, policy()), ["INPUT_DOLLARS_PER_MILLION", "OUTPUT_DOLLARS_PER_MILLION"]);
  }
});

test("the configured Exa bound and provider-policy bound must both be finite and positive", () => {
  for (const value of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const settings = config(); settings.limits.searchAttemptDollars = value;
    assert.deepEqual(providerConfigurationIssues(settings, policy()), ["SEARCH_MAX_ATTEMPT_DOLLARS"]);
  }
  for (const value of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const prices = policy(); prices.exaAttemptMaxDollars = value;
    assert.deepEqual(providerConfigurationIssues(config(), prices), ["SEARCH_MAX_ATTEMPT_DOLLARS"]);
  }
});

test("generation and enrichment deployments each require an authorized envelope", () => {
  for (const model of ["main", "fast"]) {
    const prices = policy(); delete prices.modelPrices[model];
    assert.deepEqual(providerConfigurationIssues(config(), prices), ["MODEL_DEPLOYMENT_PRICES_JSON"]);
  }
  const settings = config(), prices = policy(); settings.llm!.fastModel = undefined; delete prices.modelPrices.fast;
  assert.deepEqual(providerConfigurationIssues(settings, prices), [], "fast-model omission uses the main deployment");
  prices.modelPrices = Object.create({ main: prices.modelPrices.main });
  assert.deepEqual(providerConfigurationIssues(settings, prices), ["MODEL_DEPLOYMENT_PRICES_JSON"], "inherited properties cannot authorize a deployment");
});

test("invalid main or fast envelopes are unready even when supplied directly rather than parsed from env", () => {
  for (const model of ["main", "fast"]) {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const prices = policy(); prices.modelPrices[model]!.outputPerMillionUsd = value;
      assert.deepEqual(providerConfigurationIssues(config(), prices), ["MODEL_DEPLOYMENT_PRICES_JSON"]);
    }
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const prices = policy(); prices.modelPrices[model]!.cachedInputPerMillionUsd = value;
      assert.deepEqual(providerConfigurationIssues(config(), prices), ["MODEL_DEPLOYMENT_PRICES_JSON"]);
    }
  }
});

test("an explicit bounded price-table version is required", () => {
  for (const version of ["", "unconfigured", " ", "x".repeat(129), "private\ncredential"]) {
    const prices = policy(); prices.priceVersion = version;
    assert.deepEqual(providerConfigurationIssues(config(), prices), ["MODEL_PRICE_VERSION"]);
  }
});

test("missing credentials and model identity return configuration names only", () => {
  const settings = config(); settings.llm = null; settings.exaApiKey = null;
  assert.deepEqual(providerConfigurationIssues(settings, policy()), ["LLM_API_KEY", "LLM_MODEL", "EXA_API_KEY"]);
  settings.llm = { apiKey: " ", model: " " };
  assert.deepEqual(providerConfigurationIssues(settings, policy()), ["LLM_API_KEY", "LLM_MODEL", "EXA_API_KEY"]);
});

test("diagnostics stay bounded and never contain credentials, deployment strings or error bodies", () => {
  const settings = config(), prices = policy();
  settings.llm!.model = "secret-deployment-value".repeat(100);
  settings.llm!.fastModel = settings.llm!.apiKey;
  settings.limits.inputDollarsPerMillion = 0; settings.limits.outputDollarsPerMillion = null;
  settings.limits.searchAttemptDollars = null; prices.exaAttemptMaxDollars = null;
  prices.priceVersion = "unconfigured";
  const issues = providerConfigurationIssues(settings, prices);
  assert.ok(issues.length <= 8); assert.equal(new Set(issues).size, issues.length);
  assert.ok(issues.every(value => /^[A-Z_]+$/.test(value)));
  assert.doesNotMatch(JSON.stringify(issues), /private|secret-deployment-value|Readiness must not/);
});
