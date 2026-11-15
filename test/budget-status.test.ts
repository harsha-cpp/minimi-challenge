import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { budgetStatus } from "../scripts/budget-status.ts";
import { ProviderSpendStore } from "../src/runtime/spend-store.ts";

test("budget status reads configuration and reports both total allowances without provider HTTP or private configuration", () => {
  const store = new ProviderSpendStore({ path: ":memory:" });
  const order: string[] = [];
  try {
    const attempt = store.reserve({ provider: "azure", maxDollars: 2 }); attempt.started(); attempt.settle(1);
    store.reserve({ provider: "exa", maxDollars: 3 });
    const status = budgetStatus({
      loadConfiguration: () => { order.push("configuration"); return { apiKey: "SECRET_API_KEY", prompt: "PRIVATE_PROMPT" }; },
      spending: () => { order.push("ledger"); return { store }; },
    });
    assert.deepEqual(order, ["configuration", "ledger"]);
    assert.deepEqual(status.authorizedCapsDollars, { azure: 30, exa: 20 });
    assert.equal(status.providers.azure.remainingDollars, 29);
    assert.equal(status.providers.exa.remainingDollars, 17);
    assert.doesNotMatch(JSON.stringify(status), /SECRET_API_KEY|PRIVATE_PROMPT/);
    assert.equal(store.getSummary().providers.azure.reservations, 1, "reading status creates no provider reservation");
  } finally { store.close(); }
});

test("invalid budget configuration stops status before opening a replacement ledger", () => {
  let opened = false;
  assert.throws(() => budgetStatus({ loadConfiguration: () => { throw new Error("invalid configuration"); },
    spending: () => { opened = true; throw new Error("must not open"); } }), /invalid configuration/);
  assert.equal(opened, false);
});

test("CLI configuration failures do not echo invalid credential JSON", () => {
  const secret = "UNIQUE_PRIVATE_OWNER_TOKEN";
  const result = spawnSync(process.execPath, ["--import", "tsx", "--disable-warning=ExperimentalWarning", "scripts/budget-status.ts"], {
    encoding: "utf8", env: { ...process.env, DEPLOYMENT_MODE: "local", OWNER_TOKENS: secret }, timeout: 5000,
  });
  assert.equal(result.status, 1); assert.match(result.stderr, /status is unavailable/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
});
