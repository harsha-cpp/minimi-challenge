import type { Config } from "../config.ts";
import { envelopeFor, type DeploymentPriceEnvelope, type ProviderSpendingPolicy } from "./provider-spending.ts";

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const validEnvelope = (value: DeploymentPriceEnvelope) => positive(value.inputPerMillionUsd) && positive(value.outputPerMillionUsd)
  && (value.cachedInputPerMillionUsd === undefined || typeof value.cachedInputPerMillionUsd === "number"
    && Number.isFinite(value.cachedInputPerMillionUsd) && value.cachedInputPerMillionUsd >= 0);

/** Pure preflight for real clients. It never contacts a provider or reads/reserves the wallet. */
export function providerConfigurationIssues(config: Config, policy: ProviderSpendingPolicy): string[] {
  const issues = new Set<string>();
  if (!config.llm?.apiKey.trim()) issues.add("LLM_API_KEY");
  if (!config.llm?.model.trim()) issues.add("LLM_MODEL");
  if (!config.exaApiKey?.trim()) issues.add("EXA_API_KEY");
  if (!positive(config.limits.inputDollarsPerMillion)) issues.add("INPUT_DOLLARS_PER_MILLION");
  if (!positive(config.limits.outputDollarsPerMillion)) issues.add("OUTPUT_DOLLARS_PER_MILLION");
  if (!positive(config.limits.searchAttemptDollars) || !positive(policy.exaAttemptMaxDollars)) issues.add("SEARCH_MAX_ATTEMPT_DOLLARS");
  const versioned = typeof policy.priceVersion === "string" && /^[a-z\d][a-z\d_.:-]{0,127}$/i.test(policy.priceVersion)
    && policy.priceVersion.toLowerCase() !== "unconfigured";
  if (!versioned) issues.add("MODEL_PRICE_VERSION");
  for (const model of new Set([config.llm?.model, config.llm?.fastModel || config.llm?.model])) {
    if (!model?.trim()) continue;
    if (!Object.hasOwn(policy.modelPrices, model)) {
      issues.add("MODEL_DEPLOYMENT_PRICES_JSON");
      continue;
    }
    try {
      // envelopeFor supplies the same deployment authorization used immediately before HTTP.
      if (versioned && !validEnvelope(envelopeFor(policy, model))) issues.add("MODEL_DEPLOYMENT_PRICES_JSON");
    } catch {
      // Diagnostics contain configuration names only; never forward model/provider error text.
      issues.add("MODEL_DEPLOYMENT_PRICES_JSON");
    }
  }
  return [...issues];
}
