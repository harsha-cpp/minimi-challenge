import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { defaultProviderSpending, ProviderBudgetError, type ProviderSpendingPolicy } from "../src/runtime/provider-spending.ts";
import { AUTHORIZED_PROVIDER_CAPS, SpendBudgetError } from "../src/runtime/spend-store.ts";

/** Reads configuration and the local ledger; it never creates a provider client or sends HTTP. */
export function budgetStatus(options: { loadConfiguration?: () => unknown; spending?: () => Pick<ProviderSpendingPolicy, "store"> } = {}) {
  (options.loadConfiguration ?? loadConfig)();
  const policy = (options.spending ?? defaultProviderSpending)();
  return { scope: "Total remaining allowance through product completion; no per-run reset.",
    authorizedCapsDollars: { ...AUTHORIZED_PROVIDER_CAPS }, ...policy.store.getSummary() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error("Usage: npm run budget:status");
    process.stdout.write(`${JSON.stringify(budgetStatus(), null, 2)}\n`);
  } catch (error) {
    const message = error instanceof SpendBudgetError || error instanceof ProviderBudgetError
      ? `${error.code}: ${error.message}` : "Provider budget status is unavailable; check configuration and ledger integrity.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
