import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { ProviderSpendStore, type SpendProvider } from "./spend-store.ts";

const providers = ["azure", "exa"] as const;
type Caps = Record<SpendProvider, number>;
interface AllocationRow { id: string; child_path: string; child_identity: string | null; caps_json: string; state: "preparing" | "active" | "closing" | "closed"; receipt_json: string | null }
export interface AllocationReceipt { allocationId: string; unissued?: true; providers: Record<SpendProvider, { spentDollars: number; pendingDollars: number; unknownSettlements: number }> }

/** Trusted operator API. A delegated ledger can spend only money already held by its parent.
 * Both files must be available to this process; this is not a cross-host SQLite protocol.
 * Remote operators can invoke the same lifecycle on the host owning both ledgers.
 */
export class BudgetAllocations {
  private parent: ProviderSpendStore;
  private journal: DatabaseSync;
  constructor(readonly parentPath: string) {
    if (!existsSync(parentPath) || parentPath === ":memory:") throw new Error("An existing durable parent ledger is required.");
    this.parent = new ProviderSpendStore({ path: parentPath });
    this.journal = new DatabaseSync(parentPath);
    this.journal.exec(`PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS provider_budget_allocations (
        id TEXT PRIMARY KEY, child_path TEXT NOT NULL UNIQUE, caps_json TEXT NOT NULL,
        state TEXT NOT NULL, receipt_json TEXT, created_at INTEGER NOT NULL
      );`);
    this.transaction(() => {
      if (!(this.journal.prepare("PRAGMA table_info(provider_budget_allocations)").all()).some(row => row.name === "child_identity")) {
        this.journal.exec("ALTER TABLE provider_budget_allocations ADD COLUMN child_identity TEXT");
      }
    });
  }
  private row(id: string): AllocationRow | undefined {
    return this.journal.prepare("SELECT * FROM provider_budget_allocations WHERE id=?").get(id) as AllocationRow | undefined;
  }
  private transaction<T>(fn: () => T): T {
    this.journal.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.journal.exec("COMMIT"); return value; }
    catch (error) { this.journal.exec("ROLLBACK"); throw error; }
  }
  private validate(id: string, childPath: string, caps: Caps) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || childPath === ":memory:" || resolve(childPath) === resolve(this.parentPath)) throw new Error("Invalid allocation identity or child path.");
    for (const provider of providers) {
      const micros = caps[provider] * 1e6;
      if (!Number.isFinite(micros) || micros < 1 || !Number.isSafeInteger(Math.round(micros)) || Math.abs(micros - Math.round(micros)) > 1e-7) throw new Error("Allocation caps must be positive whole microdollars.");
    }
  }
  private verifyChild(row: AllocationRow): void {
    if (!row.child_identity || !existsSync(row.child_path)) throw new Error("An intact identified child ledger is required; reinitialization is forbidden.");
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(row.child_path, { readOnly: true });
      if (db.prepare("SELECT identity FROM provider_spend_delegation WHERE id=1").get()?.identity !== row.child_identity) throw new Error("Child identity mismatch.");
    } catch { throw new Error("The child ledger identity is missing or changed; its allowance cannot be reset or refunded."); }
    finally { db?.close(); }
  }
  provision(id: string, childPath: string, caps: Caps): ProviderSpendStore {
    this.validate(id, childPath, caps);
    childPath = resolve(childPath);
    const capsJson = JSON.stringify({ azure: caps.azure, exa: caps.exa });
    this.transaction(() => {
      const row = this.row(id);
      if (row) {
        if (row.child_path !== childPath || row.caps_json !== capsJson || !["preparing", "active"].includes(row.state)) throw new Error("An allocation cannot change identity, limits or a closed state.");
        if (row.state === "active" && !existsSync(childPath)) throw new Error("Active child ledger is missing; restoring an empty allowance is forbidden.");
        if (existsSync(childPath)) this.verifyChild(row);
      } else {
        if (existsSync(childPath)) throw new Error("A new allocation requires a new child ledger.");
        this.journal.prepare("INSERT INTO provider_budget_allocations(id,child_path,caps_json,state,receipt_json,created_at,child_identity) VALUES (?,?,?,'preparing',NULL,?,?)").run(id, childPath, capsJson, Date.now(), randomUUID());
      }
    });
    for (const provider of providers) {
      const requestId = `allocation:${id}:${provider}`;
      const found = this.parent.findReservation(provider, requestId);
      if (found && (found.maxDollars !== caps[provider] || found.state !== "held")) throw new Error("Parent hold requires reconciliation.");
      const hold = found ? this.parent.resumeReservation(found.id) : this.parent.reserveDelegation(id, provider, caps[provider]);
      if (!found?.started) hold.markStarted();
    }
    return this.transaction(() => {
      const row = this.row(id)!;
      if (!["preparing", "active"].includes(row.state) || !row.child_identity) throw new Error("Allocation was closed or lacks its durable identity before activation.");
      if (existsSync(childPath)) this.verifyChild(row);
      const child = new ProviderSpendStore({ path: childPath, campaignId: `allocation-${id}`, caps, delegationIdentity: row.child_identity });
      this.journal.prepare("UPDATE provider_budget_allocations SET state='active' WHERE id=? AND state='preparing'").run(id);
      return child;
    });
  }
  reconcile(id: string): AllocationReceipt {
    const row = this.row(id);
    if (!row) throw new Error("Allocation is unavailable.");
    if (row.state === "closed") return JSON.parse(row.receipt_json!) as AllocationReceipt;
    let receipt: AllocationReceipt;
    if (row.receipt_json) receipt = JSON.parse(row.receipt_json) as AllocationReceipt;
    else {
      if (row.state !== "active" || !existsSync(row.child_path)) throw new Error("An active intact child ledger is required before reconciliation.");
      this.verifyChild(row);
      const child = new ProviderSpendStore({ path: row.child_path, campaignId: `allocation-${id}`, caps: JSON.parse(row.caps_json), delegationIdentity: row.child_identity! });
      try {
        const sealed = child.seal(`allocation-${id}-closed`);
        receipt = { allocationId: id, providers: Object.fromEntries(providers.map(provider => [provider, {
          spentDollars: sealed.providers[provider].spentDollars, pendingDollars: sealed.providers[provider].heldDollars,
          unknownSettlements: sealed.providers[provider].unknownSettlements,
        }])) as AllocationReceipt["providers"] };
      } finally { child.close(); }
      // The child is already fenced even if this process dies before the receipt is written.
      receipt = this.transaction(() => {
        const current = this.row(id)!;
        // A concurrent closer may have already chosen a receipt. Every participant settles that
        // canonical receipt, never a losing local snapshot taken before/after a late child bill.
        if (current.receipt_json) return JSON.parse(current.receipt_json) as AllocationReceipt;
        if (current.state !== "active") throw new Error("Allocation cannot enter reconciliation.");
        this.journal.prepare("UPDATE provider_budget_allocations SET state='closing',receipt_json=? WHERE id=? AND state='active'").run(JSON.stringify(receipt), id);
        return receipt;
      });
    }
    for (const provider of providers) {
      const hold = this.parent.findReservation(provider, `allocation:${id}:${provider}`);
      if (!hold) { if (receipt.unissued) continue; throw new Error("Missing parent reservation; reconciliation stopped."); }
      // Unresolved attempts consume the full delegated hold; never refund money on a missing bill.
      const cost = receipt.providers[provider];
      this.parent.resumeReservation(hold.id).settle(cost.pendingDollars > 0 ? null : cost.spentDollars);
    }
    this.journal.prepare("UPDATE provider_budget_allocations SET state='closed' WHERE id=? AND state='closing'").run(id);
    return receipt;
  }
  abandonPreparation(id: string): void {
    this.transaction(() => {
      const row = this.row(id);
      if (row?.receipt_json && (JSON.parse(row.receipt_json) as AllocationReceipt).unissued && ["closing", "closed"].includes(row.state)) return;
      if (!row || row.state !== "preparing" || existsSync(row.child_path)) throw new Error("Only an unissued allocation without a child ledger can be abandoned.");
      // Serialize with child activation; a racing provision must not issue a refunded allowance.
      this.journal.prepare("UPDATE provider_budget_allocations SET state='closing',receipt_json=? WHERE id=? AND state='preparing'")
        .run(JSON.stringify({ allocationId: id, unissued: true, providers: { azure: { spentDollars: 0, pendingDollars: 0, unknownSettlements: 0 }, exa: { spentDollars: 0, pendingDollars: 0, unknownSettlements: 0 } } }), id);
    });
    this.reconcile(id);
  }
  status(id: string) {
    const row = this.row(id);
    return row ? { id, state: row.state, caps: JSON.parse(row.caps_json) as Caps,
      receipt: row.receipt_json ? JSON.parse(row.receipt_json) as AllocationReceipt : null } : null;
  }
  close() { this.journal.close(); this.parent.close(); }
}
