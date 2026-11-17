import { createHmac, randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const DAY = 86_400_000;
export const VISIT_LIMITS = { retentionDays: 14, rows: 20_000, queued: 1000, batch: 100, labels: 1000 } as const;
const visitorPattern = /^v_[a-f0-9]{24}$/;
const visitorId = (salt: string, owner: string) => `v_${createHmac("sha256", salt).update(owner).digest("hex").slice(0, 24)}`;

/** Optional operational telemetry: never a reason to reject or delay an answer. */
export class VisitStore {
  private db: DatabaseSync;
  private salt: string;
  private queue: Array<{ at: number; visitor: string }> = [];
  private scheduled?: ReturnType<typeof setImmediate>;
  private lastPruned = 0;
  private cleanup?: ReturnType<typeof setInterval>;
  private closed = false;
  readonly stats = { written: 0, dropped: 0 };

  constructor(path: string, private now: () => number = Date.now) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA busy_timeout=0;
        CREATE TABLE IF NOT EXISTS activity_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS page_visits (id INTEGER PRIMARY KEY, visited_at INTEGER NOT NULL, visitor_id TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS page_visits_time ON page_visits(visited_at);
        CREATE TABLE IF NOT EXISTS activity_test_labels (visitor_id TEXT PRIMARY KEY, label TEXT NOT NULL, marked_at INTEGER NOT NULL);`);
      this.db.prepare("INSERT OR IGNORE INTO activity_metadata(key,value) VALUES ('salt',?)").run(randomBytes(32).toString("hex"));
      this.db.prepare("INSERT OR IGNORE INTO activity_metadata(key,value) VALUES ('started_at',?)").run(String(this.now()));
      this.salt = (this.db.prepare("SELECT value FROM activity_metadata WHERE key='salt'").get() as {value: string}).value;
      this.prune();
      this.cleanup = setInterval(() => { try { this.prune(); } catch {} }, 3_600_000);
      this.cleanup.unref();
    } catch (error) { this.db.close(); throw error; }
  }

  /** Called only after a successful HTML response finishes; caller passes no request headers or URL. */
  record(owner: string): void {
    if (this.closed || !owner || owner.length > 1024 || this.queue.length >= VISIT_LIMITS.queued) { this.stats.dropped++; return; }
    this.queue.push({ at: this.now(), visitor: visitorId(this.salt, owner) });
    this.scheduled ??= setImmediate(() => { this.scheduled = undefined; this.flush(); });
    this.scheduled.unref();
  }

  private prune(): void {
    const now = this.now();
    this.db.prepare("DELETE FROM page_visits WHERE visited_at < ?").run(now - VISIT_LIMITS.retentionDays * DAY);
    this.db.prepare("DELETE FROM activity_test_labels WHERE marked_at < ?").run(now - VISIT_LIMITS.retentionDays * DAY);
    this.lastPruned = now;
  }

  private flush(): void {
    const batch = this.queue.splice(0, VISIT_LIMITS.batch);
    if (!batch.length) return;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const insert = this.db.prepare("INSERT INTO page_visits(visited_at,visitor_id) VALUES (?,?)");
      for (const visit of batch) insert.run(visit.at, visit.visitor);
      // Monotonic insertion IDs cap retained rows without scanning the table per page load.
      this.db.prepare("DELETE FROM page_visits WHERE id <= (SELECT max(id) FROM page_visits)-?").run(VISIT_LIMITS.rows);
      if (this.now() - this.lastPruned >= 3_600_000) this.prune();
      this.db.exec("COMMIT");
      this.stats.written += batch.length;
    } catch {
      try { this.db.exec("ROLLBACK"); } catch {}
      this.stats.dropped += batch.length;
    }
    if (this.queue.length && !this.closed) {
      this.scheduled = setImmediate(() => { this.scheduled = undefined; this.flush(); });
      this.scheduled.unref();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.scheduled) clearImmediate(this.scheduled);
    if (this.cleanup) clearInterval(this.cleanup);
    // At most ten bounded, zero-busy-wait batches. Logging cannot hold shutdown open.
    while (this.queue.length) this.flush();
    this.db.close();
  }
}

export function optionalVisitStore(path: string): VisitStore | undefined {
  try { return new VisitStore(path); }
  catch { return undefined; }
}

interface ActivityOptions { since: number; until?: number; timeZone?: string; limit?: number; now?: number }
interface ChatRow { owner_id: string; created_at: number; status: string; quality: string | null; error_code: string | null }
const tableExists = (db: DatabaseSync, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

/** Read-only operator report; no prompts, raw identities, tokens or browser fingerprinting. */
export function activityReport(path: string, options: ActivityOptions) {
  const now = options.now ?? Date.now(), until = options.until ?? now, limit = options.limit ?? 200;
  const timeZone = options.timeZone ?? "UTC";
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "medium", timeStyle: "medium", hourCycle: "h23" });
  if (!Number.isSafeInteger(options.since) || !Number.isSafeInteger(until) || until < options.since
    || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid activity interval or row limit.");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const available = tableExists(db, "page_visits") && tableExists(db, "activity_metadata");
    const metadata = available ? new Map((db.prepare("SELECT key,value FROM activity_metadata").all() as Array<{key:string;value:string}>).map(row => [row.key,row.value])) : new Map<string,string>();
    const salt = metadata.get("salt");
    const retainedSince = Math.max(options.since, now - VISIT_LIMITS.retentionDays * DAY);
    const labels = tableExists(db, "activity_test_labels") ? new Map((db.prepare("SELECT visitor_id,label FROM activity_test_labels WHERE marked_at>=? ORDER BY marked_at DESC LIMIT ?").all(now - VISIT_LIMITS.retentionDays * DAY,VISIT_LIMITS.labels) as Array<{visitor_id:string;label:string}>).map(row => [row.visitor_id,row.label])) : new Map<string,string>();
    const attributed = (id: string | null) => id && labels.has(id) ? "operator_labelled_test" : "unknown_visitor";
    // Functions are scoped to this read-only connection. Aggregation stays in SQLite instead of
    // materializing an arbitrarily long conversation history in the reporting process.
    db.function("activity_attribution", value => attributed(typeof value === "string" ? value : null));
    db.function("chat_attribution", value => attributed(salt && typeof value === "string" ? visitorId(salt,value) : null));
    const grouped = (sql: string, start: number) => Object.fromEntries((db.prepare(sql).all(start,until) as Array<{key:string|null;total:number}>).map(row => [row.key ?? "unknown",row.total]));
    const scalar = (sql: string, start: number) => (db.prepare(sql).get(start,until) as {total:number}).total;
    const visitTotal = available ? scalar("SELECT count(*) AS total FROM page_visits WHERE visited_at>=? AND visited_at<=?",retainedSince) : 0;
    const browserCredentials = available ? scalar("SELECT count(DISTINCT visitor_id) AS total FROM page_visits WHERE visited_at>=? AND visited_at<=?",retainedSince) : 0;
    const visitAttribution = available ? grouped("SELECT activity_attribution(visitor_id) AS key,count(*) AS total FROM page_visits WHERE visited_at>=? AND visited_at<=? GROUP BY key",retainedSince) : {};
    const visits = available ? db.prepare("SELECT visited_at,visitor_id FROM page_visits WHERE visited_at>=? AND visited_at<=? ORDER BY visited_at DESC,id DESC LIMIT ?").all(retainedSince,until,limit).reverse() as Array<{visited_at:number;visitor_id:string}> : [];
    const chatsAvailable = tableExists(db,"turns");
    const chatTotal = chatsAvailable ? scalar("SELECT count(*) AS total FROM turns WHERE created_at>=? AND created_at<=?",options.since) : 0;
    const byStatus = chatsAvailable ? grouped("SELECT status AS key,count(*) AS total FROM turns WHERE created_at>=? AND created_at<=? GROUP BY status",options.since) : {};
    const byQuality = chatsAvailable ? grouped("SELECT quality AS key,count(*) AS total FROM turns WHERE created_at>=? AND created_at<=? GROUP BY quality",options.since) : {};
    const chatAttribution = chatsAvailable ? grouped("SELECT chat_attribution(owner_id) AS key,count(*) AS total FROM turns WHERE created_at>=? AND created_at<=? GROUP BY key",options.since) : {};
    const chats = chatsAvailable ? db.prepare("SELECT owner_id,created_at,status,quality,error_code FROM turns WHERE created_at>=? AND created_at<=? ORDER BY created_at DESC,rowid DESC LIMIT ?").all(options.since,until,limit).reverse() as unknown as ChatRow[] : [];
    const timestamp = (at: number) => ({ at: new Date(at).toISOString(), localTime: formatter.format(at) });
    const visitRows = visits.map(row => ({ ...timestamp(row.visited_at), visitor: row.visitor_id, attribution: attributed(row.visitor_id) }));
    const chatRows = chats.map(row => { const visitor = salt ? visitorId(salt,row.owner_id) : null;
      return { ...timestamp(row.created_at), visitor, attribution: attributed(visitor), status: row.status, quality: row.quality, errorCode: row.error_code }; });
    const recentStart = Math.max(options.since,until - 15 * 60_000);
    const recentFailures = chatsAvailable ? scalar("SELECT count(*) AS total FROM turns WHERE created_at>=? AND created_at<=? AND status IN ('failed','interrupted')",recentStart) : 0;
    const recentUnconfirmed = chatsAvailable ? scalar("SELECT count(*) AS total FROM turns WHERE created_at>=? AND created_at<=? AND status='completed' AND quality='explicitly_unverified'",recentStart) : 0;

    return {
      checkedAt: new Date(now).toISOString(), since: new Date(options.since).toISOString(), until: new Date(until).toISOString(), timeZone,
      pageLogging: { available, startedAt: metadata.get("started_at") ? new Date(Number(metadata.get("started_at"))).toISOString() : null,
        retentionDays: VISIT_LIMITS.retentionDays, maximumRows: VISIT_LIMITS.rows, retainedSince: new Date(retainedSince).toISOString() },
      interpretation: "Page requests include reloads and bots; pseudonyms identify browser credentials, not people. Test labels are operator assertions. Unknown visitors are not identified reviewers. Logging is best-effort and may drop requests under contention; no page visits before instrumentation can be inferred.",
      pageRequests: { total: visitTotal, browserCredentials, byAttribution: visitAttribution, rows: visitRows, omittedRows: Math.max(0,visitTotal-limit) },
      chatRequests: { total: chatTotal, byStatus, byQuality, byAttribution: chatAttribution, rows: chatRows, omittedRows: Math.max(0,chatTotal-limit) },
      alerts: [...(recentFailures >= 3 ? [{ code: "recent_turn_failures", count: recentFailures, windowMinutes: 15 }] : []),
        ...(recentUnconfirmed >= 3 ? [{ code: "recent_unconfirmed_answers", count: recentUnconfirmed, windowMinutes: 15 }] : [])],
    };
  } finally { db.close(); }
}

/** Only the operator CLI calls this. Request headers cannot classify traffic as tests. */
export function markTestVisitor(path: string, visitor: string, label: string, now = Date.now()): void {
  if (!visitorPattern.test(visitor) || !/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,79}$/.test(label)) throw new Error("Use a reported visitor ID and a short test label.");
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error("Database does not exist or is not a regular file.");
  const db = new DatabaseSync(path);
  try {
    if (!tableExists(db,"activity_test_labels")) throw new Error("Page logging has not been initialized.");
    db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    db.prepare("INSERT INTO activity_test_labels(visitor_id,label,marked_at) VALUES (?,?,?) ON CONFLICT(visitor_id) DO UPDATE SET label=excluded.label,marked_at=excluded.marked_at").run(visitor,label,now);
    db.prepare("DELETE FROM activity_test_labels WHERE visitor_id IN (SELECT visitor_id FROM activity_test_labels ORDER BY marked_at DESC,visitor_id LIMIT -1 OFFSET ?)").run(VISIT_LIMITS.labels);
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  finally { db.close(); }
}
