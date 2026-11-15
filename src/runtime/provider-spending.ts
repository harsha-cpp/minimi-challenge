import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { LlmUsage } from "../llm.ts";
import { ProviderSpendStore, type SpendStore } from "./spend-store.ts";

export interface DeploymentPriceEnvelope {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cachedInputPerMillionUsd?: number;
}
export interface ProviderSpendingPolicy {
  store: SpendStore;
  priceVersion: string;
  modelPrices: Record<string, DeploymentPriceEnvelope>;
  exaAttemptMaxDollars: number | null;
}
export class ProviderBudgetError extends Error {
  readonly code = "provider_budget";
  readonly providerStarted = false;
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "ProviderBudgetError"; }
}
const DEFAULT_CAMPAIGN = "minimi-product-completion-v1";
const stores = new Map<string, ProviderSpendStore>();
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export function deploymentPrices(value: unknown): Record<string, DeploymentPriceEnvelope> {
  const raw = record(value);
  if (!raw) throw new ProviderBudgetError("MODEL_DEPLOYMENT_PRICES_JSON must be an object of verified deployment price envelopes.");
  const prices: Record<string, DeploymentPriceEnvelope> = {};
  for (const [model, item] of Object.entries(raw)) {
    const price = record(item);
    if (!/^[a-zA-Z0-9_.-]{1,200}$/.test(model) || !price || Object.keys(price).some(key => !["inputPerMillionUsd", "outputPerMillionUsd", "cachedInputPerMillionUsd"].includes(key))
      || typeof price.inputPerMillionUsd !== "number" || !Number.isFinite(price.inputPerMillionUsd) || price.inputPerMillionUsd <= 0
      || typeof price.outputPerMillionUsd !== "number" || !Number.isFinite(price.outputPerMillionUsd) || price.outputPerMillionUsd <= 0
      || (price.cachedInputPerMillionUsd !== undefined && (typeof price.cachedInputPerMillionUsd !== "number" || !Number.isFinite(price.cachedInputPerMillionUsd) || price.cachedInputPerMillionUsd < 0))) throw new ProviderBudgetError("Invalid deployment price envelope.");
    prices[model] = { inputPerMillionUsd: price.inputPerMillionUsd, outputPerMillionUsd: price.outputPerMillionUsd,
      ...(typeof price.cachedInputPerMillionUsd === "number" ? { cachedInputPerMillionUsd: price.cachedInputPerMillionUsd } : {}) };
  }
  return prices;
}
function bound(name: string, fallback: number, maximum?: number): number {
  const value = process.env[name]?.trim() ? Number(process.env[name]) : fallback;
  if (!Number.isFinite(value) || value <= 0 || (maximum !== undefined && value > maximum)) throw new ProviderBudgetError(`${name} must be positive and within the authorized remaining allowance.`);
  return value;
}
/** Every process uses one durable campaign. No hourly/monthly or process-start reset exists. */
export function defaultProviderSpending(): ProviderSpendingPolicy {
  if (process.env.PROVIDER_SPEND_CAMPAIGN_ID && process.env.PROVIDER_SPEND_CAMPAIGN_ID !== DEFAULT_CAMPAIGN) throw new ProviderBudgetError("The authorized provider-spend campaign cannot be reset by changing its identity.");
  const path = resolve(fileURLToPath(new URL("../../data/provider-spend.db", import.meta.url)));
  if (process.env.PROVIDER_SPEND_DB_PATH?.trim() && resolve(process.env.PROVIDER_SPEND_DB_PATH.trim()) !== path) throw new ProviderBudgetError("The total provider allowance must use its original canonical ledger path.");
  const caps = { azure: bound("AZURE_TOTAL_BUDGET_DOLLARS", 30, 30), exa: bound("EXA_TOTAL_BUDGET_DOLLARS", 20, 20) };
  const key = JSON.stringify([path, caps]);
  let store = stores.get(key);
  if (!store) { store = new ProviderSpendStore({ path, campaignId: DEFAULT_CAMPAIGN, caps }); stores.set(key, store); }
  const established = store.getSummary().providers;
  if (caps.azure > established.azure.capDollars || caps.exa > established.exa.capDollars) throw new ProviderBudgetError("An established total provider allowance cannot be increased.");
  let raw: unknown = {};
  try { raw = JSON.parse(process.env.MODEL_DEPLOYMENT_PRICES_JSON || "{}"); }
  catch { throw new ProviderBudgetError("MODEL_DEPLOYMENT_PRICES_JSON must contain valid JSON."); }
  const exaAttemptMaxDollars = process.env.SEARCH_MAX_ATTEMPT_DOLLARS?.trim() ? bound("SEARCH_MAX_ATTEMPT_DOLLARS", 0) : null;
  return { store, priceVersion: process.env.MODEL_PRICE_VERSION?.trim() || "unconfigured", modelPrices: deploymentPrices(raw), exaAttemptMaxDollars };
}
export function envelopeFor(policy: ProviderSpendingPolicy, deployment: string): DeploymentPriceEnvelope {
  const rates = policy.modelPrices[deployment];
  if (!Object.hasOwn(policy.modelPrices, deployment) || !rates || policy.priceVersion === "unconfigured") throw new ProviderBudgetError("No verified price envelope is configured for this model deployment; no provider request was sent.");
  return rates;
}
export function reservedModelDollars(rates: DeploymentPriceEnvelope, inputTokens: number, outputTokens: number): number {
  return (inputTokens * Math.max(rates.inputPerMillionUsd, rates.cachedInputPerMillionUsd ?? 0) + outputTokens * rates.outputPerMillionUsd) / 1_000_000;
}
export function reportedModelDollars(rates: DeploymentPriceEnvelope, usage: LlmUsage | null): number | null {
  if (!usage || ![usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.reasoningTokens].every(value => Number.isInteger(value) && value >= 0)
    || usage.cachedInputTokens > usage.inputTokens || usage.reasoningTokens > usage.outputTokens) return null;
  return ((usage.inputTokens - usage.cachedInputTokens) * rates.inputPerMillionUsd + usage.cachedInputTokens * (rates.cachedInputPerMillionUsd ?? rates.inputPerMillionUsd) + usage.outputTokens * rates.outputPerMillionUsd) / 1_000_000;
}
