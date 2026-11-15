import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AUTHORIZED_PROVIDER_CAPS, DEFAULT_SPEND_CAMPAIGN, ProviderSpendStore, SpendBudgetError } from "../src/runtime/spend-store.ts";

const error = (code: SpendBudgetError["code"]) => (value: unknown) => value instanceof SpendBudgetError && value.code === code;
function temp() { const dir = mkdtempSync(join(tmpdir(), "minimi-spend-")); return { dir, path: join(dir, "provider-spend.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) }; }

test("campaign caps apply globally across all reservations and providers remain independent", () => {
  const store = new ProviderSpendStore({ path: ":memory:" });
  try {
    assert.deepEqual(AUTHORIZED_PROVIDER_CAPS, { azure: 30, exa: 20 });
    const azure = store.reserve({ provider: "azure", maxDollars: 20 });
    store.reserve({ provider: "azure", maxDollars: 10 });
    assert.throws(() => store.reserve({ provider: "azure", maxDollars: 0.000001 }), error("budget_exhausted"));
    store.reserve({ provider: "exa", maxDollars: 20 });
    assert.throws(() => store.reserve({ provider: "exa", maxDollars: 0.000001 }), error("budget_exhausted"));
    azure.started(); azure.settle(2);
    assert.equal(store.getSummary().providers.azure.spentDollars, 2);
    assert.equal(store.getSummary().providers.azure.heldDollars, 10);
    assert.equal(store.getSummary().providers.azure.remainingDollars, 18);
    assert.equal(store.getSummary().providers.exa.remainingDollars, 0);
  } finally { store.close(); }
});

test("reservations round upward in integer microUSD and configured caps round downward", () => {
  const store = new ProviderSpendStore({ path: ":memory:", caps: { azure: 0.0000029 } });
  try {
    const one = store.reserve({ provider: "azure", maxDollars: 0.0000001 });
    store.reserve({ provider: "azure", maxDollars: 0.000001 });
    assert.throws(() => store.reserve({ provider: "azure", maxDollars: 0.0000001 }), error("budget_exhausted"));
    one.markStarted(); one.settle(0.00000001);
    const status = store.getSummary().providers.azure;
    assert.equal(status.capMicrousd, 2); assert.equal(status.spentMicrousd, 1); assert.equal(status.heldMicrousd, 1);
  } finally { store.close(); }
});

test("unknown usage consumes the bound and interrupted reservations survive reopen without release", () => {
  const fixture = temp(); let store = new ProviderSpendStore({ path: fixture.path });
  try {
    const unknown = store.reserve({ provider: "azure", maxDollars: 4 }); unknown.started(); unknown.settle(null);
    const pending = store.reserve({ provider: "azure", maxDollars: 7 }); pending.started();
    store.reserve({ provider: "exa", maxDollars: 3 });
    store.close(); store = new ProviderSpendStore({ path: fixture.path });
    const status = store.getSummary();
    assert.equal(status.campaignId, DEFAULT_SPEND_CAMPAIGN);
    assert.equal(status.providers.azure.spentDollars, 4); assert.equal(status.providers.azure.heldDollars, 7);
    assert.equal(status.providers.azure.unknownSettlements, 1); assert.equal(status.providers.azure.remainingDollars, 19);
    assert.equal(status.providers.exa.heldDollars, 3);
    assert.throws(() => store.reserve({ provider: "azure", maxDollars: 20 }), error("budget_exhausted"));
  } finally { store.close(); fixture.cleanup(); }
});

test("only unstarted attempts can cancel and duplicate provider request IDs cannot spend twice", () => {
  const store = new ProviderSpendStore({ path: ":memory:" });
  try {
    const notStarted = store.reserve({ provider: "azure", maxDollars: 4, requestId: "attempt-1" });
    assert.throws(() => store.reserve({ provider: "azure", maxDollars: 4, requestId: "attempt-1" }), error("duplicate_request"));
    notStarted.cancelBeforeStart(); notStarted.cancelBeforeStart();
    assert.equal(store.getSummary().providers.azure.heldDollars, 0);
    const started = store.reserve({ provider: "azure", maxDollars: 3 }); started.started();
    assert.throws(() => started.cancelBeforeStart(), error("reservation_state"));
    assert.throws(() => started.started(), error("reservation_state"));
    started.settle(1); started.settle(1);
    assert.equal(store.getSummary().providers.azure.spentDollars, 1);
    assert.throws(() => started.settle(0), error("settlement_conflict"));
    assert.throws(() => started.cancelBeforeStart(), error("reservation_state"));
  } finally { store.close(); }
});

test("actual billing-bound violations persist the full bill and lock the provider before throwing", () => {
  const fixture = temp(); let store = new ProviderSpendStore({ path: fixture.path });
  try {
    const attempt = store.reserve({ provider: "azure", maxDollars: 1 }); attempt.started();
    assert.throws(() => attempt.settle(31), error("reservation_bound_exceeded"));
    const status = store.getSummary().providers.azure;
    assert.equal(status.spentDollars, 31); assert.equal(status.heldDollars, 0); assert.equal(status.locked, true);
    assert.equal(status.violations, 1); assert.equal(status.lockReason, "actual_exceeded_reservation");
    store.close(); store = new ProviderSpendStore({ path: fixture.path });
    assert.equal(store.getSummary().providers.azure.spentDollars, 31);
    assert.throws(() => store.reserve({ provider: "azure", maxDollars: 0.01 }), error("provider_locked"));
    store.reserve({ provider: "exa", maxDollars: 1 });
  } finally { store.close(); fixture.cleanup(); }
});

test("late actual bills cannot refund unknown charges and higher bills remain auditable", () => {
  const store = new ProviderSpendStore({ path: ":memory:" });
  try {
    const attempt = store.reserve({ provider: "exa", maxDollars: 2 }); attempt.started(); attempt.settle(null); attempt.settle(1);
    assert.equal(store.getSummary().providers.exa.spentDollars, 2, "unknown billing is charged conservatively without automatic refunds");
    assert.throws(() => attempt.settle(3), error("reservation_bound_exceeded"));
    assert.equal(store.getSummary().providers.exa.spentDollars, 3); assert.equal(store.getSummary().providers.exa.locked, true);
  } finally { store.close(); }
});

test("campaign identities and cap increases cannot reset already committed spend", () => {
  const fixture = temp(); let store = new ProviderSpendStore({ path: fixture.path, caps: { azure: 5, exa: 4 } });
  try {
    store.reserve({ provider: "azure", maxDollars: 3 }).settle(null); store.close();
    assert.throws(() => new ProviderSpendStore({ path: fixture.path, campaignId: "a-new-campaign" }), error("campaign_conflict"));
    assert.throws(() => new ProviderSpendStore({ path: fixture.path, caps: { azure: 6 } }), error("cap_increase_denied"));
    assert.throws(() => new ProviderSpendStore({ path: fixture.path, caps: { azure: 2 } }), error("cap_below_commitment"));
    store = new ProviderSpendStore({ path: fixture.path });
    assert.equal(store.getSummary().providers.azure.capDollars, 5); assert.equal(store.getSummary().providers.azure.spentDollars, 3);
    store.close(); store = new ProviderSpendStore({ path: fixture.path, caps: { azure: 4 } });
    assert.equal(store.getSummary().providers.azure.remainingDollars, 1);
    assert.throws(() => new ProviderSpendStore({ path: ":memory:", caps: { azure: 31 } }), error("cap_increase_denied"));
  } finally { store.close(); fixture.cleanup(); }
});

test("ledger context is bounded and excludes prompts, credentials and arbitrary payloads", () => {
  const fixture = temp(), store = new ProviderSpendStore({ path: fixture.path });
  try {
    store.reserve({ provider: "azure", maxDollars: 1, stage: "research", model: "test-model", turnId: "t".repeat(10_000),
      context: { ownerId: "owner", prompt: "SECRET_PROMPT", apiKey: "SECRET_API_KEY", reasoning: "PRIVATE_REASONING" } as any });
    const db = new DatabaseSync(fixture.path);
    try {
      const raw = db.prepare("SELECT context_json FROM provider_spend_reservations").get()!.context_json as string;
      assert.ok(Buffer.byteLength(raw)<2048); assert.doesNotMatch(raw, /SECRET_PROMPT|SECRET_API_KEY|PRIVATE_REASONING/);
      assert.equal(JSON.parse(raw).turnId.length, 128);
    } finally { db.close(); }
    for (const maxDollars of [NaN, Infinity, -1, 0]) assert.throws(() => store.reserve({ provider: "azure", maxDollars }), error("invalid_reservation"));
  } finally { store.close(); fixture.cleanup(); }
});

test("independent service and CLI connections share the same cap atomically", () => {
  const fixture = temp(), service = new ProviderSpendStore({ path: fixture.path, caps: { azure: 5 } }), cli = new ProviderSpendStore({ path: fixture.path });
  try {
    const a = service.reserve({ provider: "azure", maxDollars: 3 }); a.started();
    assert.throws(() => cli.reserve({ provider: "azure", maxDollars: 3 }), error("budget_exhausted"));
    cli.reserve({ provider: "azure", maxDollars: 2 }).settle(1);
    assert.equal(service.getSummary().providers.azure.remainingDollars, 1);
    a.settle(null); assert.equal(cli.getSummary().providers.azure.spentDollars, 4);
  } finally { cli.close(); service.close(); fixture.cleanup(); }
});

test("missing campaign identity or mismatched counters fail closed instead of resetting remaining spend", () => {
  const fixture = temp(); const store = new ProviderSpendStore({ path: fixture.path });
  store.reserve({ provider: "azure", maxDollars: 3 }); store.close();
  const db = new DatabaseSync(fixture.path);
  try {
    db.exec("UPDATE provider_spend_budgets SET held_microusd=0 WHERE provider='azure'");
    assert.throws(() => new ProviderSpendStore({ path: fixture.path }), error("ledger_unavailable"));
    db.exec("UPDATE provider_spend_budgets SET held_microusd=3000000 WHERE provider='azure'; DELETE FROM provider_spend_campaign");
    assert.throws(() => new ProviderSpendStore({ path: fixture.path }), error("campaign_conflict"));
  } finally { db.close(); fixture.cleanup(); }
});

test("actual process death keeps a started reservation held after clean reopen", { timeout: 10000 }, async () => {
  const fixture = temp(), source = join(fixture.dir, "crash-spend-fixture.mts");
  writeFileSync(source, `
    import { ProviderSpendStore } from ${JSON.stringify(new URL("../src/runtime/spend-store.ts", import.meta.url).href)};
    const store=new ProviderSpendStore({path:${JSON.stringify(fixture.path)}});
    const attempt=store.reserve({provider:'azure',maxDollars:7});attempt.started();
    process.send?.({held:true});setInterval(()=>{},1000);
  `);
  const child = fork(source, { execArgv: ["--import", "tsx", "--disable-warning=ExperimentalWarning"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exited = once(child, "exit");
  try {
    await new Promise<void>((resolve,reject) => { child.once("message", () => resolve()); child.once("error",reject); child.once("exit", () => reject(new Error("Spend fixture exited before reserving"))); });
    child.kill("SIGKILL"); const [, signal] = await exited; assert.equal(signal,"SIGKILL");
    const store=new ProviderSpendStore({path:fixture.path});
    try { const summary=store.getSummary().providers.azure; assert.equal(summary.heldDollars,7);assert.equal(summary.remainingDollars,23);assert.equal(summary.pending,1); }
    finally {store.close();}
  } finally {
    if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await exited.catch(()=>{});fixture.cleanup();
  }
});

test("concurrent child processes cannot over-reserve the campaign cap", { timeout: 15000 }, async () => {
  const fixture = temp(), source = join(fixture.dir, "reserve-fixture.mts");
  const initial = new ProviderSpendStore({ path: fixture.path, caps: { azure: 1 } }); initial.close();
  writeFileSync(source, `
    import { ProviderSpendStore, SpendBudgetError } from ${JSON.stringify(new URL("../src/runtime/spend-store.ts", import.meta.url).href)};
    const store = new ProviderSpendStore({ path: ${JSON.stringify(fixture.path)} });
    let accepted = 0, rejected = 0;
    for (let i=0;i<25;i++) {
      try { store.reserve({provider:'azure',maxDollars:0.1}); accepted++; }
      catch (error) { if (!(error instanceof SpendBudgetError) || error.code!=='budget_exhausted') throw error; rejected++; }
    }
    store.close(); process.send?.({accepted,rejected}, () => process.disconnect());
  `);
  const children = Array.from({ length: 3 }, () => fork(source, { execArgv: ["--import", "tsx", "--disable-warning=ExperimentalWarning"], stdio: ["ignore", "ignore", "pipe", "ipc"] }));
  const exits = children.map(child => once(child, "exit"));
  try {
    const results = await Promise.all(children.map((child, index) => new Promise<{accepted:number;rejected:number}>((resolve, reject) => {
      let stderr = ""; child.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-1000); });
      child.once("message", value => resolve(value as {accepted:number;rejected:number})); child.once("error", reject);
      exits[index]!.then(([code]) => { if (code !== 0) reject(new Error(stderr)); }, reject);
    })));
    await Promise.all(exits); assert.equal(results.reduce((n,r) => n+r.accepted,0), 10); assert.equal(results.reduce((n,r) => n+r.rejected,0), 65);
    const store = new ProviderSpendStore({ path: fixture.path });
    try { assert.equal(store.getSummary().providers.azure.heldMicrousd, 1_000_000); assert.equal(store.getSummary().providers.azure.remainingMicrousd, 0); }
    finally { store.close(); }
  } finally {
    for (const child of children) if (child.exitCode===null && child.signalCode===null) child.kill("SIGKILL");
    await Promise.allSettled(exits); fixture.cleanup();
  }
});
