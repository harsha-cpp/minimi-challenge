import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export type SpendProvider = "azure" | "exa";
export const DEFAULT_SPEND_PATH = "data/provider-spend.db";
export const DEFAULT_SPEND_ABSOLUTE_PATH = fileURLToPath(new URL("../../data/provider-spend.db", import.meta.url));
export const DEFAULT_SPEND_CAMPAIGN = "minimi-product-completion-v1";
export const AUTHORIZED_PROVIDER_CAPS = Object.freeze({ azure: 30, exa: 20 });
const MICRO_USD = 1_000_000;

export type SpendErrorCode = "invalid_reservation" | "budget_exhausted" | "provider_locked" | "duplicate_request"
  | "reservation_state" | "reservation_bound_exceeded" | "settlement_conflict" | "cap_increase_denied"
  | "cap_below_commitment" | "campaign_conflict" | "ledger_unavailable";

export class SpendBudgetError extends Error {
  constructor(readonly code: SpendErrorCode, message: string, readonly provider?: SpendProvider) {
    super(message); this.name = "SpendBudgetError";
  }
}

export interface SpendContext {
  stage?: string;
  model?: string;
  turnId?: string;
  ownerId?: string;
  policyVersion?: string;
}
export interface SpendReservationInput extends SpendContext {
  provider: SpendProvider;
  /** A verified upper bound for this attempt, including any billable failure. */
  maxDollars: number;
  requestId?: string;
  context?: SpendContext;
}
export interface SpendReservation {
  id: string;
  started(): void;
  markStarted(): void;
  /** Unknown billing consumes the full reservation. Settled charges are never automatically refunded. */
  settle(actualDollars: number | null): void;
  /** Releases capacity only when no provider attempt has started. */
  cancelBeforeStart(): void;
}
export interface ProviderSpendSummary {
  capMicrousd: number;
  spentMicrousd: number;
  heldMicrousd: number;
  remainingMicrousd: number;
  capDollars: number;
  spentDollars: number;
  heldDollars: number;
  remainingDollars: number;
  locked: boolean;
  lockReason: string | null;
  reservations: number;
  pending: number;
  unknownSettlements: number;
  violations: number;
}
export interface SpendSummary {
  campaignId: string;
  path: string;
  providers: Record<SpendProvider, ProviderSpendSummary>;
}
export interface SpendStoreOptions {
  path?: string;
  campaignId?: string;
  /** Initial or reduced campaign caps. Increasing an established cap is forbidden. */
  caps?: Partial<Record<SpendProvider, number>>;
  /** Operator-created child identity; not a provider credential or a replacement campaign. */
  delegationIdentity?: string;
}
interface BudgetRow {
  provider: SpendProvider;
  cap_microusd: number;
  spent_microusd: number;
  held_microusd: number;
  locked: number;
  lock_reason: string | null;
  violations: number;
}
interface ReservationRow {
  id: string;
  provider: SpendProvider;
  reserved_microusd: number;
  charged_microusd: number;
  reported_microusd: number | null;
  usage_known: number | null;
  state: "held" | "settled" | "cancelled";
  started_at: number | null;
}

function micros(value: number, rounding: "ceil" | "floor", allowZero: boolean): number {
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new SpendBudgetError("invalid_reservation", "Provider amounts must be finite nonnegative dollars, with a positive reservation.");
  }
  const result = Math[rounding](value * MICRO_USD);
  if (!Number.isSafeInteger(result) || (!allowZero && result < 1)) throw new SpendBudgetError("invalid_reservation", "Provider amount exceeds its supported range.");
  return result;
}
function providerName(value: unknown): asserts value is SpendProvider {
  if (value !== "azure" && value !== "exa") throw new SpendBudgetError("invalid_reservation", "Unknown budget provider.");
}
function safeContext(input: SpendReservationInput): string {
  const result: Record<string, string> = {};
  for (const field of ["stage", "model", "turnId", "ownerId", "policyVersion"] as const) {
    const value = input[field] ?? input.context?.[field];
    if (typeof value === "string") result[field] = value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 128);
  }
  return JSON.stringify(result);
}

/** One durable campaign ledger shared by the service, evaluation CLIs and every provider attempt. */
export class ProviderSpendStore {
  readonly path: string;
  readonly campaignId: string;
  private db: DatabaseSync;
  private closed = false;

  constructor(options: SpendStoreOptions = {}) {
    this.path = options.path === ":memory:" ? ":memory:" : resolve(options.path ?? DEFAULT_SPEND_ABSOLUTE_PATH);
    this.campaignId = options.campaignId ?? DEFAULT_SPEND_CAMPAIGN;
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(this.campaignId)) throw new SpendBudgetError("campaign_conflict", "Invalid provider budget campaign identity.");
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path);
    try {
      this.db.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS provider_spend_campaign (
            id INTEGER PRIMARY KEY CHECK(id=1), campaign_id TEXT NOT NULL,
            schema_version INTEGER NOT NULL, created_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS provider_spend_delegation (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS provider_spend_budgets (
            provider TEXT PRIMARY KEY CHECK(provider IN ('azure','exa')),
            cap_microusd INTEGER NOT NULL CHECK(cap_microusd>=0),
            spent_microusd INTEGER NOT NULL DEFAULT 0 CHECK(spent_microusd>=0),
            held_microusd INTEGER NOT NULL DEFAULT 0 CHECK(held_microusd>=0),
            locked INTEGER NOT NULL DEFAULT 0, lock_reason TEXT, violations INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE IF NOT EXISTS provider_spend_reservations (
            id TEXT PRIMARY KEY, provider TEXT NOT NULL REFERENCES provider_spend_budgets(provider),
            request_id TEXT NOT NULL, reserved_microusd INTEGER NOT NULL CHECK(reserved_microusd>0),
            charged_microusd INTEGER NOT NULL DEFAULT 0 CHECK(charged_microusd>=0), reported_microusd INTEGER,
            state TEXT NOT NULL CHECK(state IN ('held','settled','cancelled')),
            usage_known INTEGER, started_at INTEGER, created_at INTEGER NOT NULL, settled_at INTEGER,
            context_json TEXT NOT NULL CHECK(length(context_json)<=2048), UNIQUE(provider,request_id)
          );
          CREATE INDEX IF NOT EXISTS provider_spend_reservations_state ON provider_spend_reservations(provider,state);
          CREATE TABLE IF NOT EXISTS provider_spend_violations (
            id INTEGER PRIMARY KEY, provider TEXT NOT NULL REFERENCES provider_spend_budgets(provider),
            reservation_id TEXT NOT NULL REFERENCES provider_spend_reservations(id),
            reason TEXT NOT NULL, reserved_microusd INTEGER NOT NULL, actual_microusd INTEGER NOT NULL,
            created_at INTEGER NOT NULL
          );
        `);
        const campaign = this.db.prepare("SELECT campaign_id,schema_version FROM provider_spend_campaign WHERE id=1").get();
        if (campaign && (campaign.campaign_id !== this.campaignId || campaign.schema_version !== 1)) {
          throw new SpendBudgetError("campaign_conflict", "The ledger already belongs to a different or incompatible budget campaign.");
        }
        if (!campaign && this.db.prepare("SELECT provider FROM provider_spend_budgets LIMIT 1").get()) {
          throw new SpendBudgetError("campaign_conflict", "An existing provider ledger cannot acquire a replacement campaign identity.");
        }
        if (!campaign) this.db.prepare("INSERT INTO provider_spend_campaign VALUES (1,?,1,?)").run(this.campaignId, Date.now());
        if (options.delegationIdentity !== undefined) {
          if (!/^[a-f0-9-]{36}$/.test(options.delegationIdentity)) throw new SpendBudgetError("campaign_conflict", "Invalid delegated ledger identity.");
          const identity = this.db.prepare("SELECT identity FROM provider_spend_delegation WHERE id=1").get();
          if (campaign && identity?.identity !== options.delegationIdentity) throw new SpendBudgetError("campaign_conflict", "The delegated ledger identity does not match its parent allocation.");
          if (!campaign) this.db.prepare("INSERT INTO provider_spend_delegation VALUES (1,?)").run(options.delegationIdentity);
        }
        for (const provider of ["azure", "exa"] as const) {
          const existing = this.budget(provider);
          if (campaign && !existing) throw new SpendBudgetError("ledger_unavailable", "An established provider budget is missing; paid work must remain stopped.", provider);
          if (existing) {
            const totals = this.db.prepare(`SELECT coalesce(sum(CASE WHEN state='held' THEN reserved_microusd ELSE 0 END),0) AS held,
              coalesce(sum(CASE WHEN state='settled' THEN charged_microusd ELSE 0 END),0) AS spent
              FROM provider_spend_reservations WHERE provider=?`).get(provider)!;
            if (totals.held !== existing.held_microusd || totals.spent !== existing.spent_microusd) {
              throw new SpendBudgetError("ledger_unavailable", "Provider budget counters do not match their durable reservations.", provider);
            }
          }
          const requested = options.caps?.[provider];
          const cap = requested === undefined && existing ? existing.cap_microusd
            : micros(requested ?? AUTHORIZED_PROVIDER_CAPS[provider], "floor", true);
          if (cap > AUTHORIZED_PROVIDER_CAPS[provider] * MICRO_USD || existing && cap > existing.cap_microusd) {
            throw new SpendBudgetError("cap_increase_denied", "Provider campaign caps cannot be increased or reset.", provider);
          }
          if (existing && cap < existing.cap_microusd && cap < existing.spent_microusd + existing.held_microusd) {
            throw new SpendBudgetError("cap_below_commitment", "The requested cap is below money already charged or reserved.", provider);
          }
          if (existing) this.db.prepare("UPDATE provider_spend_budgets SET cap_microusd=? WHERE provider=?").run(cap, provider);
          else this.db.prepare("INSERT INTO provider_spend_budgets(provider,cap_microusd) VALUES (?,?)").run(provider, cap);
        }
      });
    } catch (error) { this.db.close(); this.closed = true; throw error; }
  }

  reserve(input: SpendReservationInput): SpendReservation {
    return this.reserveGuarded(input);
  }
  /** The allocation state and parent hold are checked under the same SQLite write lock. */
  reserveDelegation(allocationId: string, provider: SpendProvider, maxDollars: number): SpendReservation {
    return this.reserveGuarded({ provider, maxDollars, requestId: `allocation:${allocationId}:${provider}`, stage: "delegated_allowance" }, () => {
      const allocation = this.db.prepare("SELECT state,caps_json FROM provider_budget_allocations WHERE id=?").get(allocationId);
      if (!allocation || allocation.state !== "preparing" || JSON.parse(String(allocation.caps_json))[provider] !== maxDollars) {
        throw new SpendBudgetError("reservation_state", "A closing or issued allocation cannot acquire a new parent hold.", provider);
      }
    });
  }
  private reserveGuarded(input: SpendReservationInput, guard?: () => void): SpendReservation {
    providerName(input.provider);
    const amount = micros(input.maxDollars, "ceil", false), id = randomUUID();
    const requestId = input.requestId ?? id;
    if (!/^[a-zA-Z0-9_.:/-]{1,160}$/.test(requestId)) throw new SpendBudgetError("invalid_reservation", "Invalid provider request identity.", input.provider);
    const context = safeContext(input);
    this.transaction(() => {
      guard?.();
      const budget = this.budget(input.provider)!;
      if (budget.locked) throw new SpendBudgetError("provider_locked", "Provider spending is locked after a billing-bound violation.", input.provider);
      if (this.db.prepare("SELECT id FROM provider_spend_reservations WHERE provider=? AND request_id=?").get(input.provider, requestId)) {
        throw new SpendBudgetError("duplicate_request", "This provider attempt already has a budget reservation.", input.provider);
      }
      if (amount > budget.cap_microusd - budget.spent_microusd - budget.held_microusd) {
        throw new SpendBudgetError("budget_exhausted", "The provider campaign's remaining budget is exhausted.", input.provider);
      }
      this.db.prepare(`INSERT INTO provider_spend_reservations(id,provider,request_id,reserved_microusd,state,created_at,context_json)
        VALUES (?,?,?,?,'held',?,?)`).run(id, input.provider, requestId, amount, Date.now(), context);
      this.db.prepare("UPDATE provider_spend_budgets SET held_microusd=held_microusd+? WHERE provider=?").run(amount, input.provider);
    });
    return { id, started: () => this.started(id), markStarted: () => this.started(id),
      settle: actual => this.settle(id, actual), cancelBeforeStart: () => this.cancelBeforeStart(id) };
  }

  private started(id: string): void {
    this.transaction(() => {
      const row = this.reservation(id);
      if (row.state !== "held" || row.started_at !== null) throw new SpendBudgetError("reservation_state", "This reservation cannot start another provider attempt.", row.provider);
      this.db.prepare("UPDATE provider_spend_reservations SET started_at=? WHERE id=?").run(Date.now(), id);
    });
  }

  private settle(id: string, actualDollars: number | null): void {
    const actual = actualDollars === null ? null : micros(actualDollars, "ceil", true);
    const violated = this.transaction(() => {
      const row = this.reservation(id);
      if (row.state === "settled" && actual === null) return false;
      if (row.state === "cancelled" && actual === null) throw new SpendBudgetError("reservation_state", "A cancelled provider attempt cannot have unknown billing.", row.provider);
      if (row.state === "settled" && row.usage_known === 1 && row.reported_microusd === actual) return false;
      if (row.state === "settled" && row.usage_known === 1 && actual !== null && actual < row.charged_microusd) {
        throw new SpendBudgetError("settlement_conflict", "A settled provider charge cannot be reduced automatically.", row.provider);
      }
      const charge = actual === null ? row.reserved_microusd : row.state === "held" ? actual : Math.max(actual, row.charged_microusd);
      const reason = actual !== null && actual > row.reserved_microusd ? "actual_exceeded_reservation"
        : row.state === "cancelled" && charge > 0 ? "bill_after_cancellation"
        : row.state === "settled" && charge > row.charged_microusd ? "reported_bill_changed" : null;
      const heldRelease = row.state === "held" ? row.reserved_microusd : 0;
      const increment = charge - row.charged_microusd;
      this.db.prepare(`UPDATE provider_spend_budgets SET held_microusd=held_microusd-?,spent_microusd=spent_microusd+? WHERE provider=?`)
        .run(heldRelease, increment, row.provider);
      this.db.prepare(`UPDATE provider_spend_reservations SET state='settled',charged_microusd=?,reported_microusd=?,usage_known=?,started_at=coalesce(started_at,?),settled_at=? WHERE id=?`)
        .run(charge, actual, actual === null ? 0 : 1, Date.now(), Date.now(), id);
      if (reason) {
        this.db.prepare("UPDATE provider_spend_budgets SET locked=1,lock_reason=?,violations=violations+1 WHERE provider=?").run(reason, row.provider);
        this.db.prepare(`INSERT INTO provider_spend_violations(provider,reservation_id,reason,reserved_microusd,actual_microusd,created_at)
          VALUES (?,?,?,?,?,?)`).run(row.provider, id, reason, row.reserved_microusd, charge, Date.now());
      }
      return Boolean(reason);
    });
    // Throw only after committing the actual charge and lock; an exception must never roll that evidence back.
    if (violated) throw new SpendBudgetError("reservation_bound_exceeded", "Provider billing exceeded its reserved bound; further spending is locked.");
  }

  private cancelBeforeStart(id: string): void {
    this.transaction(() => {
      const row = this.reservation(id);
      if (row.state === "cancelled") return;
      if (row.state !== "held" || row.started_at !== null) throw new SpendBudgetError("reservation_state", "A started provider attempt cannot release its reserved budget.", row.provider);
      this.db.prepare("UPDATE provider_spend_reservations SET state='cancelled',settled_at=? WHERE id=?").run(Date.now(), id);
      this.db.prepare("UPDATE provider_spend_budgets SET held_microusd=held_microusd-? WHERE provider=?").run(row.reserved_microusd, row.provider);
    });
  }

  getSummary(): SpendSummary {
    try {
      const rows = this.db.prepare(`SELECT b.*,
        (SELECT count(*) FROM provider_spend_reservations r WHERE r.provider=b.provider) AS reservations,
        (SELECT count(*) FROM provider_spend_reservations r WHERE r.provider=b.provider AND r.state='held') AS pending,
        (SELECT count(*) FROM provider_spend_reservations r WHERE r.provider=b.provider AND r.state='settled' AND r.usage_known=0) AS unknown_settlements
        FROM provider_spend_budgets b ORDER BY provider`).all() as unknown as Array<BudgetRow & { reservations: number; pending: number; unknown_settlements: number }>;
      const providers = {} as SpendSummary["providers"];
      for (const row of rows) {
        const remaining = Math.max(0, row.cap_microusd - row.spent_microusd - row.held_microusd);
        providers[row.provider] = { capMicrousd: row.cap_microusd, spentMicrousd: row.spent_microusd, heldMicrousd: row.held_microusd,
          remainingMicrousd: remaining, capDollars: row.cap_microusd / MICRO_USD, spentDollars: row.spent_microusd / MICRO_USD,
          heldDollars: row.held_microusd / MICRO_USD, remainingDollars: remaining / MICRO_USD, locked: Boolean(row.locked),
          lockReason: row.lock_reason, reservations: row.reservations, pending: row.pending,
          unknownSettlements: row.unknown_settlements, violations: row.violations };
      }
      return { path: this.path, campaignId: this.campaignId, providers };
    } catch { throw new SpendBudgetError("ledger_unavailable", "Provider budget status is unavailable; paid work must remain stopped."); }
  }
  get snapshot(): SpendSummary { return this.getSummary(); }

  /** Operator-side recovery of durable holds; never expose reservation handles to public clients. */
  findReservation(provider: SpendProvider, requestId: string): { id: string; maxDollars: number; state: string; started: boolean } | null {
    const row = this.db.prepare("SELECT * FROM provider_spend_reservations WHERE provider=? AND request_id=?").get(provider, requestId) as ReservationRow | undefined;
    return row ? { id: row.id, maxDollars: row.reserved_microusd / MICRO_USD, state: row.state, started: row.started_at !== null } : null;
  }
  resumeReservation(id: string): SpendReservation {
    this.reservation(id);
    return { id, started: () => this.started(id), markStarted: () => this.started(id),
      settle: actual => this.settle(id, actual), cancelBeforeStart: () => this.cancelBeforeStart(id) };
  }
  /** Permanently stop new reservations before reconciling a delegated allowance. Existing bills still settle. */
  seal(reason: string): SpendSummary {
    if (!reason.trim()) throw new SpendBudgetError("invalid_reservation", "A sealing reason is required.");
    this.transaction(() => this.db.prepare("UPDATE provider_spend_budgets SET locked=1,lock_reason=coalesce(lock_reason,?)").run(reason.slice(0, 128)));
    return this.getSummary();
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }

  private budget(provider: SpendProvider): BudgetRow | undefined {
    return this.db.prepare("SELECT * FROM provider_spend_budgets WHERE provider=?").get(provider) as BudgetRow | undefined;
  }
  private reservation(id: string): ReservationRow {
    const row = this.db.prepare("SELECT * FROM provider_spend_reservations WHERE id=?").get(id) as ReservationRow | undefined;
    if (!row) throw new SpendBudgetError("reservation_state", "Provider reservation is unavailable.");
    return row;
  }
  private transaction<T>(fn: () => T): T {
    let active = false;
    try { this.db.exec("BEGIN IMMEDIATE"); active = true; const result = fn(); this.db.exec("COMMIT"); active = false; return result; }
    catch (error) {
      if (active) { try { this.db.exec("ROLLBACK"); } catch { /* Preserve a fail-closed budget error. */ } }
      if (error instanceof SpendBudgetError) throw error;
      throw new SpendBudgetError("ledger_unavailable", "Provider budget admission is unavailable; no paid attempt may start.");
    }
  }
}

export type SpendStore = Pick<ProviderSpendStore, "reserve" | "getSummary">;
