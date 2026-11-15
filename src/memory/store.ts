

import { mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { SearchHit, TemporalProvenance } from "../search/types.ts";
import { POLICY_VERSION } from "../runtime/telemetry.ts";

export interface Source {
  n: number;
  url: string;
  title: string;
  publishedDate?: string;

  text?: string;
  contentHash?: string;
  provider?: string;
  method?: "search" | "contents";
  retrievedAt?: string;
  snapshotAsOf?: string;
  requestId?: string;
  temporal?: TemporalProvenance;
  archive?: SearchHit["archive"];
  freshness?: SearchHit["freshness"];
  retrieval?: SearchHit["retrieval"];
  rank?: number;
}

export interface Episode {
  id: number;
  sessionId: string;

  askedAt: number;
  tz: string;
  question: string;
  answer: string;
  summary: string | null;
  topics: string | null;
  execution?: Record<string, unknown>;
  ownerId?: string;
  createdAt?: number | null;
  sequence?: number;
  quality?: string | null;
  turnId?: string | null;
}

export interface DurableTurn {
  id: string;
  ownerId: string;
  sessionId: string;
  status: "running" | "completed" | "failed" | "interrupted";
  episodeId: number | null;
  quality: string | null;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
  viewpointAt: number | null;
  mode: string;
  sequence: number;
}

export interface Conversation {
  sessionId: string;
  ownerId: string;
  mode: string;
  viewpointAt: number | null;
  nextSequence: number;
}

export interface MemoryJob {
  id: number;
  episodeId: number;
  ownerId: string;
  leaseToken: string;
  attempts: number;
  payload: unknown;
}

export class StoreConflictError extends Error {
  constructor(readonly code: "idempotency_conflict" | "conversation_busy" | "turn_state_conflict", message: string) { super(message); }
}

export type Verdict = "new" | "unchanged" | "changed" | "unverified";

export interface Claim {
  id: number;
  episodeId: number;
  entity: string;
  attribute: string;
  value: string;
  kind: string;
  sourceUrl: string | null;
  observedAt: number;

  priorClaimId: number | null;
  verdict: Verdict;
}

export type NewClaim = Omit<Claim, "id" | "episodeId" | "observedAt">;

export interface NewVerifiedStatement {
  text: string;
  sourceNumbers: number[];
}

export interface VerifiedStatement extends NewVerifiedStatement {
  id: number;

  viewpointAt: number;

  verifiedAt: number;
}

export interface Enrichment {
  summary: string;
  topics: string[];
  claims: NewClaim[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS episodes (
  id         INTEGER PRIMARY KEY,
  session_id TEXT    NOT NULL,
  asked_at   INTEGER NOT NULL,
  tz         TEXT    NOT NULL,
  question   TEXT    NOT NULL,
  answer     TEXT    NOT NULL,
  summary    TEXT,
  topics     TEXT,
  execution_json TEXT
);
CREATE INDEX IF NOT EXISTS episodes_by_time ON episodes (asked_at);
CREATE INDEX IF NOT EXISTS episodes_by_session ON episodes (session_id, asked_at);

CREATE TABLE IF NOT EXISTS sources (
  episode_id     INTEGER NOT NULL REFERENCES episodes (id),
  n              INTEGER NOT NULL,
  url            TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  published_date TEXT,
  evidence_json  TEXT,
  PRIMARY KEY (episode_id, n)
);

CREATE TABLE IF NOT EXISTS claims (
  id             INTEGER PRIMARY KEY,
  episode_id     INTEGER NOT NULL REFERENCES episodes (id),
  entity         TEXT    NOT NULL,
  attribute      TEXT    NOT NULL,
  value          TEXT    NOT NULL,
  kind           TEXT    NOT NULL,
  source_url     TEXT,
  observed_at    INTEGER NOT NULL,
  prior_claim_id INTEGER REFERENCES claims (id),
  verdict        TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS claims_by_episode ON claims (episode_id);

CREATE TABLE IF NOT EXISTS verified_statements (
  id INTEGER PRIMARY KEY,
  episode_id INTEGER NOT NULL REFERENCES episodes(id),
  text TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 20000),
  viewpoint_at INTEGER NOT NULL,
  verified_at INTEGER NOT NULL,
  UNIQUE (id, episode_id)
);
CREATE INDEX IF NOT EXISTS verified_statements_by_episode ON verified_statements (episode_id, id);
CREATE TABLE IF NOT EXISTS verified_statement_sources (
  statement_id INTEGER NOT NULL,
  episode_id INTEGER NOT NULL,
  source_n INTEGER NOT NULL CHECK (source_n >= 1),
  PRIMARY KEY (statement_id, source_n),
  FOREIGN KEY (statement_id, episode_id) REFERENCES verified_statements(id, episode_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (episode_id, source_n) REFERENCES sources(episode_id, n)
);
CREATE INDEX IF NOT EXISTS verified_statement_sources_by_source ON verified_statement_sources (episode_id, source_n);
CREATE TRIGGER IF NOT EXISTS verified_statements_require_sources BEFORE INSERT ON verified_statements
WHEN NOT EXISTS (SELECT 1 FROM verified_statement_sources s WHERE s.statement_id = new.id AND s.episode_id = new.episode_id) BEGIN
  SELECT RAISE(ABORT, 'A verified statement requires evidence links.');
END;
CREATE TRIGGER IF NOT EXISTS verified_statements_no_update BEFORE UPDATE ON verified_statements BEGIN
  SELECT RAISE(ABORT, 'Verified statements are immutable.');
END;
CREATE TRIGGER IF NOT EXISTS verified_statements_no_delete BEFORE DELETE ON verified_statements BEGIN
  SELECT RAISE(ABORT, 'Verified statements are immutable.');
END;
-- Links are inserted first in the same transaction. Inserting the statement seals its evidence set.
CREATE TRIGGER IF NOT EXISTS verified_statement_sources_no_late_insert BEFORE INSERT ON verified_statement_sources
WHEN EXISTS (SELECT 1 FROM verified_statements s WHERE s.id = new.statement_id) BEGIN
  SELECT RAISE(ABORT, 'Verified statement evidence links are immutable.');
END;
CREATE TRIGGER IF NOT EXISTS verified_statement_sources_no_update BEFORE UPDATE ON verified_statement_sources BEGIN
  SELECT RAISE(ABORT, 'Verified statement evidence links are immutable.');
END;
CREATE TRIGGER IF NOT EXISTS verified_statement_sources_no_delete BEFORE DELETE ON verified_statement_sources BEGIN
  SELECT RAISE(ABORT, 'Verified statement evidence links are immutable.');
END;
CREATE TRIGGER IF NOT EXISTS verified_sources_no_update BEFORE UPDATE ON sources
WHEN EXISTS (SELECT 1 FROM verified_statement_sources s WHERE s.episode_id = old.episode_id AND s.source_n = old.n) BEGIN
  SELECT RAISE(ABORT, 'Evidence linked to verified statements is immutable.');
END;
CREATE TRIGGER IF NOT EXISTS verified_sources_no_delete BEFORE DELETE ON sources
WHEN EXISTS (SELECT 1 FROM verified_statement_sources s WHERE s.episode_id = old.episode_id AND s.source_n = old.n) BEGIN
  SELECT RAISE(ABORT, 'Evidence linked to verified statements is immutable.');
END;

-- Topic lookup. rowid is the episode id. Porter stemming lets "hosting" find "hosted".
CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5 (
  question, summary, topics, entities, tokenize = 'porter unicode61'
);
`;

type Row = Record<string, unknown>;

const toEpisode = (r: Row): Episode => ({
  id: r.id as number,
  sessionId: r.session_id as string,
  askedAt: r.asked_at as number,
  tz: r.tz as string,
  question: r.question as string,
  answer: r.answer as string,
  summary: r.summary as string | null,
  topics: r.topics as string | null,
  ownerId: (r.owner_id as string | undefined) ?? "local",
  createdAt: (r.created_at as number | null | undefined) ?? null,
  sequence: (r.sequence as number | undefined) ?? r.id as number,
  quality: (r.quality as string | null | undefined) ?? null,
  turnId: (r.turn_id as string | null | undefined) ?? null,
  ...(r.execution_json ? { execution: JSON.parse(r.execution_json as string) } : {}),
});

const toClaim = (r: Row): Claim => ({
  id: r.id as number,
  episodeId: r.episode_id as number,
  entity: r.entity as string,
  attribute: r.attribute as string,
  value: r.value as string,
  kind: r.kind as string,
  sourceUrl: r.source_url as string | null,
  observedAt: r.observed_at as number,
  priorClaimId: r.prior_claim_id as number | null,
  verdict: r.verdict as Verdict,
});

export const MEMORY_SCHEMA_VERSION = 1;
const ANSWER_INDEX_CHARS = 12_000;
const MAX_CANDIDATES = 256;
const MAX_DATE_EPISODES = 100;
const boundedLimit = (n: number, max = MAX_DATE_EPISODES) => Math.max(1, Math.min(max, Number.isFinite(n) ? Math.floor(n) : max));
const owner = (value?: string) => value ?? "local";
const toTurn = (r: Row): DurableTurn => ({ id: r.id as string, ownerId: r.owner_id as string,
  sessionId: r.session_id as string, status: r.status as DurableTurn["status"], episodeId: r.episode_id as number | null,
  quality: r.quality as string | null, errorCode: r.error_code as string | null,
  createdAt: r.created_at as number, updatedAt: r.updated_at as number, viewpointAt: r.viewpoint_at as number | null,
  mode: r.mode as string, sequence: r.sequence as number });
const toSource = (r: Row): Source => ({ ...(r.evidence_json ? JSON.parse(r.evidence_json as string) : {}),
  n: r.n as number, url: r.url as string, title: r.title as string,
  publishedDate: (r.published_date as string | null) ?? undefined });

export class MemoryStore {
  private db: DatabaseSync;
  private lastMemoryOwner = "";
  private busyEvents = 0;

  get metrics() { return { sqliteBusyEvents: this.busyEvents }; }
  private beginWrite(): void {
    try { this.db.exec("BEGIN IMMEDIATE"); } catch (error) {
      if (error && typeof error === "object" && "errcode" in error && [5, 6].includes(Number(error.errcode))) this.busyEvents++;
      throw error;
    }
  }

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      const ledger = this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='schema_migrations'").get();
      if (ledger && this.db.prepare("SELECT version FROM schema_migrations WHERE version>? LIMIT 1").get(MEMORY_SCHEMA_VERSION)) {
        throw new Error("This database requires a newer application schema. Restore a compatible backup to roll back.");
      }
      // A short busy timeout bounds synchronous stalls on the HTTP event loop.
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 100; PRAGMA foreign_keys = ON;");
      this.migrate();
    } catch (error) { this.db.close(); throw error; }
  }

  private migrate(): void {
    const columns = (table: string) => new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name));
    this.beginWrite();
    try {
      this.db.exec(SCHEMA);
      this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
      if (!columns("sources").has("evidence_json")) this.db.exec("ALTER TABLE sources ADD COLUMN evidence_json TEXT");
      const ec = columns("episodes");
      for (const [name, type] of [["execution_json", "TEXT"], ["owner_id", "TEXT NOT NULL DEFAULT 'local'"],
        ["created_at", "INTEGER"], ["sequence", "INTEGER"], ["quality", "TEXT"], ["turn_id", "TEXT"]]) {
        if (!ec.has(name!)) this.db.exec(`ALTER TABLE episodes ADD COLUMN ${name} ${type}`);
      }
      if (!columns("claims").has("active")) this.db.exec("ALTER TABLE claims ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS episodes_by_owner_time ON episodes(owner_id, asked_at, id);
        CREATE INDEX IF NOT EXISTS episodes_by_owner_session ON episodes(owner_id, session_id, sequence, id);
        CREATE UNIQUE INDEX IF NOT EXISTS episodes_by_turn ON episodes(turn_id) WHERE turn_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS conversations (
          owner_id TEXT NOT NULL, session_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'live',
          viewpoint_at INTEGER, next_sequence INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY(owner_id, session_id)
        );
        CREATE TABLE IF NOT EXISTS turns (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, session_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL,
          episode_id INTEGER REFERENCES episodes(id), quality TEXT, error_code TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, viewpoint_at INTEGER,
          mode TEXT NOT NULL, sequence INTEGER NOT NULL, UNIQUE(owner_id, idempotency_key)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS turns_one_running_conversation ON turns(owner_id, session_id) WHERE status = 'running';
        CREATE TABLE IF NOT EXISTS memory_jobs (
          id INTEGER PRIMARY KEY, episode_id INTEGER NOT NULL UNIQUE REFERENCES episodes(id), owner_id TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, lease_until INTEGER,
          lease_token TEXT, payload_json TEXT, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS memory_jobs_ready ON memory_jobs(state, available_at, lease_until, id);
        CREATE TABLE IF NOT EXISTS turn_traces (
          turn_id TEXT NOT NULL, owner_id TEXT NOT NULL, trace_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY(turn_id, owner_id)
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(answer, tokenize = 'porter unicode61');
      `);
      const applied = this.db.prepare("SELECT version FROM schema_migrations WHERE version = 1").get();
      if (!applied) {
        // Preserve unknown wall time. ID ordering is an explicit legacy sequence fallback.
        this.db.exec(`UPDATE episodes SET sequence = id WHERE sequence IS NULL;
          UPDATE episodes SET created_at = CAST(json_extract(execution_json, '$.time.receivedAt') AS INTEGER)
            WHERE created_at IS NULL AND json_valid(execution_json) AND typeof(json_extract(execution_json, '$.time.receivedAt')) = 'integer';
          INSERT INTO conversations(owner_id,session_id,next_sequence)
            SELECT owner_id,session_id,max(sequence)+1 FROM episodes GROUP BY owner_id,session_id
            ON CONFLICT(owner_id,session_id) DO UPDATE SET next_sequence = max(next_sequence,excluded.next_sequence);
          INSERT INTO episodes_fts(rowid,question,summary,topics)
            SELECT e.id,e.question,e.summary,e.topics FROM episodes e WHERE NOT EXISTS(SELECT 1 FROM episodes_fts f WHERE f.rowid=e.id);
          INSERT INTO conversation_fts(rowid, answer) SELECT id, substr(answer, 1, ${ANSWER_INDEX_CHARS}) FROM episodes;
          INSERT INTO memory_jobs(episode_id,owner_id,available_at,created_at,updated_at)
            SELECT id,owner_id,0,coalesce(created_at,0),0 FROM episodes WHERE summary IS NULL;
        `);
        // ISO timestamps are parsed in JavaScript instead of inventing creation times.
        const legacy = this.db.prepare("SELECT id,execution_json FROM episodes WHERE id>? AND created_at IS NULL AND execution_json IS NOT NULL ORDER BY id LIMIT 500");
        const update = this.db.prepare("UPDATE episodes SET created_at=? WHERE id=?");
        let after = 0;
        for (;;) {
          const rows = legacy.all(after) as Row[]; if (!rows.length) break;
          for (const r of rows) {
            try { const stamp = JSON.parse(r.execution_json as string)?.time?.receivedAt;
              const at = typeof stamp === "string" ? Date.parse(stamp) : NaN;
              if (Number.isFinite(at)) update.run(at,r.id as number);
            } catch { /* A malformed legacy diagnostic must not prevent opening the data. */ }
          }
          after = rows.at(-1)!.id as number;
        }
        this.db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (1,?)").run(Date.now());
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  close(): void { this.db.close(); }
  checkpoint(): void { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
  async backupTo(path: string): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    await backup(this.db, path);
  }
  integrityCheck(): { ok: boolean; issues: string[]; episodes: number; sources: number; pendingJobs: number } {
    const issues = (this.db.prepare("PRAGMA integrity_check").all() as Row[]).flatMap(r => Object.values(r).map(String)).filter(v => v !== "ok");
    if (this.db.prepare("PRAGMA foreign_key_check").all().length) issues.push("foreign_key_check failed");
    const missing = (this.db.prepare("SELECT count(*) AS n FROM episodes e LEFT JOIN conversation_fts f ON f.rowid = e.id WHERE f.rowid IS NULL").get() as { n: number }).n;
    if (missing) issues.push(`${missing} conversation index rows missing`);
    const orphans = (this.db.prepare("SELECT count(*) AS n FROM sources s LEFT JOIN episodes e ON e.id=s.episode_id WHERE e.id IS NULL").get() as { n: number }).n;
    if (orphans) issues.push(`${orphans} orphan evidence rows`);
    const evidence = this.db.prepare("SELECT rowid,evidence_json FROM sources WHERE rowid>? AND evidence_json IS NOT NULL ORDER BY rowid LIMIT 500");
    let after = 0, invalid = false;
    while (!invalid) {
      const rows = evidence.all(after) as Row[]; if (!rows.length) break;
      for (const r of rows) { try {
        const e = JSON.parse(r.evidence_json as string);
        if (typeof e.text === "string" && typeof e.contentHash === "string"
          && createHash("sha256").update(e.text).digest("hex") !== e.contentHash) { issues.push("cited evidence hash mismatch"); invalid = true; break; }
      } catch { issues.push("invalid evidence payload"); invalid = true; break; } }
      after = rows.at(-1)!.rowid as number;
    }
    const count = (table: string) => (this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { ok: !issues.length, issues, episodes: count("episodes"), sources: count("sources"),
      pendingJobs: (this.db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE state IN ('pending','leased')").get() as { n: number }).n };
  }

  conversation(sessionId: string, ownerId = "local"): Conversation | null {
    const r = this.db.prepare("SELECT * FROM conversations WHERE owner_id = ? AND session_id = ?").get(ownerId, sessionId) as Row | undefined;
    return r ? { sessionId, ownerId, mode: r.mode as string, viewpointAt: r.viewpoint_at as number | null, nextSequence: r.next_sequence as number } : null;
  }
  updateConversation(input: { sessionId: string; ownerId?: string; mode: string; viewpointAt?: number | null }): Conversation {
    const ownerId = owner(input.ownerId);
    this.db.prepare(`INSERT INTO conversations(owner_id,session_id,mode,viewpoint_at) VALUES (?,?,?,?)
      ON CONFLICT(owner_id,session_id) DO UPDATE SET mode=excluded.mode,viewpoint_at=excluded.viewpoint_at`)
      .run(ownerId,input.sessionId,input.mode,input.viewpointAt ?? null);
    return this.conversation(input.sessionId,ownerId)!;
  }
  beginTurn(input: { id?: string; ownerId?: string; idempotencyKey: string; requestHash: string; sessionId: string;
    viewpointAt?: number | null; mode?: string }): { turn: DurableTurn; created: boolean } {
    const ownerId = owner(input.ownerId), now = Date.now();
    this.beginWrite();
    try {
      const existing = this.db.prepare("SELECT * FROM turns WHERE owner_id = ? AND idempotency_key = ?").get(ownerId, input.idempotencyKey) as Row | undefined;
      if (existing) {
        if (existing.request_hash !== input.requestHash) throw new StoreConflictError("idempotency_conflict", "This request key was already used for different input.");
        this.db.exec("COMMIT"); return { turn: toTurn(existing), created: false };
      }
      if (this.db.prepare("SELECT id FROM turns WHERE owner_id = ? AND session_id = ? AND status = 'running'").get(ownerId,input.sessionId)) {
        throw new StoreConflictError("conversation_busy", "A turn is already running in this conversation.");
      }
      const conversation = this.conversation(input.sessionId,ownerId);
      const mode = input.mode ?? conversation?.mode ?? "live";
      const viewpoint = input.viewpointAt === undefined ? conversation?.viewpointAt ?? null : input.viewpointAt;
      this.db.prepare(`INSERT INTO conversations(owner_id,session_id,mode,viewpoint_at) VALUES (?,?,?,?)
        ON CONFLICT(owner_id,session_id) DO UPDATE SET mode=excluded.mode,viewpoint_at=excluded.viewpoint_at`)
        .run(ownerId,input.sessionId,mode,viewpoint);
      const sequence = this.conversation(input.sessionId,ownerId)!.nextSequence;
      this.db.prepare("UPDATE conversations SET next_sequence = next_sequence + 1 WHERE owner_id = ? AND session_id = ?").run(ownerId,input.sessionId);
      const id = input.id ?? randomUUID();
      this.db.prepare(`INSERT INTO turns(id,owner_id,session_id,idempotency_key,request_hash,status,created_at,updated_at,viewpoint_at,mode,sequence)
        VALUES (?,?,?,?,?,'running',?,?,?,?,?)`).run(id,ownerId,input.sessionId,input.idempotencyKey,input.requestHash,now,now,viewpoint,mode,sequence);
      const turn = this.getTurn(id,ownerId)!;
      this.db.exec("COMMIT"); return { turn, created: true };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  getTurn(id: string, ownerId = "local"): DurableTurn | null {
    const row = this.db.prepare("SELECT * FROM turns WHERE id = ? AND owner_id = ?").get(id,ownerId) as Row | undefined;
    return row ? toTurn(row) : null;
  }
  turnForKey(idempotencyKey: string, ownerId = "local"): DurableTurn | null {
    const row = this.db.prepare("SELECT * FROM turns WHERE idempotency_key=? AND owner_id=?").get(idempotencyKey,ownerId) as Row | undefined;
    return row ? toTurn(row) : null;
  }
  failTurn(id: string, code: string, ownerId = "local"): void {
    this.db.prepare("UPDATE turns SET status='failed', error_code=?, updated_at=? WHERE id=? AND owner_id=? AND status='running'").run(code.slice(0,100),Date.now(),id,ownerId);
  }
  recoverInterruptedTurns(): number {
    this.beginWrite();
    try {
      const now = Date.now();
      // Persist crash outcomes without claiming usage/cost that died before it could be recorded.
      this.db.prepare(`INSERT INTO turn_traces(turn_id,owner_id,trace_json,updated_at)
        SELECT id,owner_id,json_object('version',1,'turnId',id,'policyVersion',?,'model',NULL,'mode',mode,
          'receivedAt',strftime('%Y-%m-%dT%H:%M:%fZ',created_at/1000.0,'unixepoch'),'outcome','interrupted',
          'stages',json('[]'),'droppedStages',0,'usage',json('[]'),'missingUsage',0,'droppedUsage',0,
          'usageStatus','unknown_after_restart','serverFirstEmissionMs',NULL,'clientFirstRenderMs',NULL,'totalMs',max(0,?-created_at)),?
        FROM turns WHERE status='running'
        ON CONFLICT(turn_id,owner_id) DO UPDATE SET trace_json=excluded.trace_json,updated_at=excluded.updated_at`)
        .run(POLICY_VERSION,now,now);
      const changed = Number(this.db.prepare("UPDATE turns SET status='interrupted',error_code='process_interrupted',updated_at=? WHERE status='running'").run(now).changes);
      // Startup recovery is explicit: only the single service instance may release its abandoned leases.
      this.db.prepare("UPDATE memory_jobs SET state=CASE WHEN attempts>=5 THEN 'dead' ELSE 'pending' END,lease_until=NULL,lease_token=NULL,available_at=?,updated_at=? WHERE state='leased'").run(now,now);
      this.db.exec("COMMIT"); return changed;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  saveTrace(turnId: string, ownerId: string, trace: Record<string, unknown>): void {
    const json = JSON.stringify(trace);
    if (Buffer.byteLength(json) > 64_000) throw new Error("Trace exceeds its retention bound.");
    this.db.prepare(`INSERT INTO turn_traces(turn_id,owner_id,trace_json,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(turn_id,owner_id) DO UPDATE SET trace_json=excluded.trace_json,updated_at=excluded.updated_at`).run(turnId,ownerId,json,Date.now());
  }
  traceFor(turnId: string, ownerId = "local"): Record<string, unknown> | null {
    const r = this.db.prepare("SELECT trace_json FROM turn_traces WHERE turn_id=? AND owner_id=?").get(turnId,ownerId) as Row | undefined;
    return r ? JSON.parse(r.trace_json as string) : null;
  }
  purgeOperational(beforeTime: number): { traces: number; jobs: number } {
    const traces = Number(this.db.prepare("DELETE FROM turn_traces WHERE updated_at < ?").run(beforeTime).changes);
    const jobs = Number(this.db.prepare("DELETE FROM memory_jobs WHERE state = 'completed' AND updated_at < ?").run(beforeTime).changes);
    return { traces, jobs };
  }

  saveEpisode(e: Omit<Episode, "id" | "summary" | "topics"> & { sources: Source[]; verifiedStatements?: NewVerifiedStatement[] }): number {
    const verifiedStatements = validateStatements(e.verifiedStatements, e.sources, e.askedAt);
    const ownerId = owner(e.ownerId);
    this.beginWrite();
    try {
      const turn = e.turnId ? this.getTurn(e.turnId,ownerId) : null;
      if (e.turnId && (!turn || turn.sessionId !== e.sessionId || turn.status !== "running")) {
        throw new StoreConflictError("turn_state_conflict", "The durable turn cannot accept this answer.");
      }
      let sequence = turn?.sequence;
      if (sequence === undefined) {
        this.db.prepare("INSERT OR IGNORE INTO conversations(owner_id,session_id) VALUES (?,?)").run(ownerId,e.sessionId);
        sequence = this.conversation(e.sessionId,ownerId)!.nextSequence;
        this.db.prepare("UPDATE conversations SET next_sequence=next_sequence+1 WHERE owner_id=? AND session_id=?").run(ownerId,e.sessionId);
      }
      const result = this.db.prepare(`INSERT INTO episodes(session_id,asked_at,tz,question,answer,execution_json,owner_id,created_at,sequence,quality,turn_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(e.sessionId,e.askedAt,e.tz,e.question,e.answer,e.execution ? JSON.stringify(e.execution) : null,
          ownerId,e.createdAt ?? Date.now(),sequence,e.quality ?? null,e.turnId ?? null);
      const id = Number(result.lastInsertRowid);
      const insertSource = this.db.prepare("INSERT INTO sources(episode_id,n,url,title,published_date,evidence_json) VALUES (?,?,?,?,?,?)");
      for (const s of e.sources) { const { n,url,title,publishedDate,...evidence } = s; insertSource.run(id,n,url,title,publishedDate ?? null,JSON.stringify(evidence)); }
      if (verifiedStatements.length) {
        let statementId = Number((this.db.prepare("SELECT coalesce(max(id),0) AS id FROM verified_statements").get() as { id: number }).id);
        const insertLink = this.db.prepare("INSERT INTO verified_statement_sources(statement_id,episode_id,source_n) VALUES (?,?,?)");
        const insertStatement = this.db.prepare("INSERT INTO verified_statements(id,episode_id,text,viewpoint_at,verified_at) VALUES (?,?,?,?,?)");
        for (const statement of verifiedStatements) {
          statementId++; for (const n of statement.sourceNumbers) insertLink.run(statementId,id,n);
          insertStatement.run(statementId,id,statement.text,e.askedAt,Date.now());
        }
      }
      this.db.prepare("INSERT INTO episodes_fts(rowid,question,entities) VALUES (?,?,?)").run(id,e.question,verifiedStatements.map(s => s.text).join("\n") || null);
      this.db.prepare("INSERT INTO conversation_fts(rowid,answer) VALUES (?,?)").run(id,e.answer.slice(0,ANSWER_INDEX_CHARS));
      const now = Date.now();
      this.db.prepare("INSERT INTO memory_jobs(episode_id,owner_id,available_at,created_at,updated_at) VALUES (?,?,?,?,?)").run(id,ownerId,now,now,now);
      if (turn) this.db.prepare("UPDATE turns SET status='completed',episode_id=?,quality=?,updated_at=? WHERE id=? AND owner_id=?").run(id,e.quality ?? null,now,turn.id,ownerId);
      this.db.exec("COMMIT"); return id;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  enrich(episodeId: number, enrichment: Enrichment, ownerId = "local"): void {
    this.beginWrite();
    try {
      this.applyEnrichment(episodeId,enrichment,ownerId);
      this.db.prepare("UPDATE memory_jobs SET state='completed',lease_until=NULL,lease_token=NULL,payload_json=NULL,last_error=NULL,updated_at=? WHERE episode_id=? AND owner_id=?").run(Date.now(),episodeId,ownerId);
      this.db.exec("COMMIT");
    }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private applyEnrichment(episodeId: number, input: Enrichment, ownerId: string): void {
    const episode = this.episode(episodeId,ownerId); if (!episode) return;
    const enrichment = boundEnrichment(input), topics = enrichment.topics.join(", ");
    const audited = this.verifiedStatementsFor(episodeId,ownerId).map(s => s.text).join("\n");
    const entities = [audited,[...new Set(enrichment.claims.map(c => c.entity))].join(", ")].filter(Boolean).join("\n");
    this.db.prepare("UPDATE episodes SET summary=?,topics=? WHERE id=? AND owner_id=?").run(enrichment.summary,topics,episodeId,ownerId);
    // Keep claim identities and referenced rows stable across retries and revised extraction.
    this.db.prepare("UPDATE claims SET active=0 WHERE episode_id=?").run(episodeId);
    const existing = this.db.prepare("SELECT * FROM claims WHERE episode_id=? ORDER BY id").all(episodeId) as Row[];
    const byKey = new Map(existing.map(r => [claimKey(toClaim(r)),r.id as number]));
    const insert = this.db.prepare(`INSERT INTO claims(episode_id,entity,attribute,value,kind,source_url,observed_at,prior_claim_id,verdict,active)
      VALUES (?,?,?,?,?,?,?,?,?,1)`);
    for (const c of enrichment.claims) {
      if (c.priorClaimId !== null && !this.db.prepare(`SELECT c.id FROM claims c JOIN episodes e ON e.id=c.episode_id WHERE c.id=? AND e.owner_id=? AND e.id<? AND e.asked_at<=?`).get(c.priorClaimId,ownerId,episodeId,episode.askedAt)) {
        c.priorClaimId = null; c.verdict = "new";
      }
      const key = claimKey(c), previous = byKey.get(key);
      if (previous) this.db.prepare("UPDATE claims SET active=1,kind=?,verdict=? WHERE id=?").run(c.kind,c.verdict,previous);
      else { const result = insert.run(episodeId,c.entity,c.attribute,c.value,c.kind,c.sourceUrl,episode.askedAt,c.priorClaimId,c.verdict); byKey.set(key,Number(result.lastInsertRowid)); }
    }
    this.db.prepare("DELETE FROM episodes_fts WHERE rowid=?").run(episodeId);
    this.db.prepare("INSERT INTO episodes_fts(rowid,question,summary,topics,entities) VALUES (?,?,?,?,?)").run(episodeId,episode.question,enrichment.summary,topics,entities);
  }

  enqueueMemoryJob(episodeId: number, payload?: unknown, ownerId = "local"): void {
    if (!this.episode(episodeId,ownerId)) return;
    const json = payload === undefined ? null : JSON.stringify(payload);
    if (json && Buffer.byteLength(json) > 80_000) throw new Error("Memory job payload exceeds its bound.");
    const now = Date.now();
    this.db.prepare(`INSERT INTO memory_jobs(episode_id,owner_id,available_at,payload_json,created_at,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(episode_id) DO UPDATE SET payload_json=coalesce(excluded.payload_json,memory_jobs.payload_json) WHERE memory_jobs.state='pending'`)
      .run(episodeId,ownerId,now,json,now,now);
  }
  leaseMemoryJob(now = Date.now(), leaseMs = 45_000): MemoryJob | null {
    this.beginWrite();
    try {
      this.db.prepare("UPDATE memory_jobs SET state='dead',lease_token=NULL,lease_until=NULL,last_error='lease_attempts_exhausted',updated_at=? WHERE state='leased' AND lease_until<=? AND attempts>=5").run(now,now);
      const r = this.db.prepare(`SELECT * FROM memory_jobs WHERE attempts<5 AND ((state='pending' AND available_at<=?) OR (state='leased' AND lease_until<=?)) ORDER BY CASE WHEN owner_id=? THEN 1 ELSE 0 END,id LIMIT 1`).get(now,now,this.lastMemoryOwner) as Row | undefined;
      if (!r) { this.db.exec("COMMIT"); return null; }
      this.lastMemoryOwner = r.owner_id as string;
      const leaseToken = randomUUID();
      this.db.prepare("UPDATE memory_jobs SET state='leased',attempts=attempts+1,lease_until=?,lease_token=?,updated_at=? WHERE id=?").run(now+leaseMs,leaseToken,now,r.id as number);
      this.db.exec("COMMIT");
      return { id: r.id as number,episodeId: r.episode_id as number,ownerId: r.owner_id as string,attempts: (r.attempts as number)+1,leaseToken,payload:r.payload_json ? JSON.parse(r.payload_json as string) : null };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  completeMemoryJob(job: MemoryJob, enrichment: Enrichment): boolean {
    this.beginWrite();
    try {
      const valid = this.db.prepare("SELECT id FROM memory_jobs WHERE id=? AND owner_id=? AND state='leased' AND lease_token=? AND lease_until>?").get(job.id,job.ownerId,job.leaseToken,Date.now());
      if (!valid) { this.db.exec("COMMIT"); return false; }
      this.applyEnrichment(job.episodeId,enrichment,job.ownerId);
      this.db.prepare("UPDATE memory_jobs SET state='completed',lease_until=NULL,lease_token=NULL,payload_json=NULL,last_error=NULL,updated_at=? WHERE id=?").run(Date.now(),job.id);
      this.db.exec("COMMIT"); return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  retryMemoryJob(job: MemoryJob, errorCode = "enrichment_failed", now = Date.now()): void {
    const terminal = job.attempts >= 5;
    this.db.prepare(`UPDATE memory_jobs SET state=?,available_at=?,lease_until=NULL,lease_token=NULL,last_error=?,updated_at=? WHERE id=? AND lease_token=?`)
      .run(terminal ? "dead" : "pending",now+Math.min(60_000,1000 * 2**Math.min(job.attempts,6)),errorCode.slice(0,100),now,job.id,job.leaseToken);
  }
  releaseMemoryJob(job: MemoryJob): void {
    this.db.prepare("UPDATE memory_jobs SET state=CASE WHEN attempts>=5 THEN 'dead' ELSE 'pending' END,lease_until=NULL,lease_token=NULL,available_at=?,updated_at=? WHERE id=? AND lease_token=?").run(Date.now(),Date.now(),job.id,job.leaseToken);
  }
  memoryJobCounts(): Record<string,number> {
    return Object.fromEntries((this.db.prepare("SELECT state,count(*) AS n FROM memory_jobs GROUP BY state").all() as Row[]).map(r => [r.state as string,r.n as number]));
  }

  episode(id: number, ownerId = "local"): Episode | null {
    const row = this.db.prepare("SELECT * FROM episodes WHERE id=? AND owner_id=?").get(id,ownerId) as Row | undefined;
    return row ? toEpisode(row) : null;
  }
  episodesBetween(startMs: number, endMs: number, knownAt = Number.MAX_SAFE_INTEGER, ownerId = "local", limit = MAX_DATE_EPISODES, sessionId?: string): Episode[] {
    return (this.db.prepare(`SELECT * FROM episodes WHERE owner_id=? AND asked_at>=? AND asked_at<? AND asked_at<=? ${sessionId === undefined ? "" : "AND session_id=?"} ORDER BY asked_at,id LIMIT ?`)
      .all(ownerId,startMs,endMs,knownAt,...(sessionId === undefined ? [] : [sessionId]),boundedLimit(limit)) as Row[]).map(toEpisode);
  }
  neighbours(beforeMs: number, afterMs: number, knownAt = Number.MAX_SAFE_INTEGER, ownerId = "local", sessionId?: string): Episode[] {
    const scope = sessionId === undefined ? "" : "AND session_id=?", params = sessionId === undefined ? [] : [sessionId];
    const before = this.db.prepare(`SELECT * FROM episodes WHERE owner_id=? AND asked_at<? AND asked_at<=? ${scope} ORDER BY asked_at DESC,id DESC LIMIT 1`).get(ownerId,beforeMs,knownAt,...params);
    const after = this.db.prepare(`SELECT * FROM episodes WHERE owner_id=? AND asked_at>=? AND asked_at<=? ${scope} ORDER BY asked_at,id LIMIT 1`).get(ownerId,afterMs,knownAt,...params);
    return [before,after].filter(r => r !== undefined).map(r => toEpisode(r as Row));
  }
  /** Visible transcript order is independent of the selected research viewpoint. These are previous statements, not as-of evidence. */
  currentConversationHistory(sessionId: string, limit: number, ownerId = "local", beforeSequence = Number.MAX_SAFE_INTEGER): Episode[] {
    if (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1) return [];
    return (this.db.prepare("SELECT * FROM episodes WHERE owner_id=? AND session_id=? AND sequence<? ORDER BY sequence DESC,id DESC LIMIT ?")
      .all(ownerId,sessionId,beforeSequence,boundedLimit(limit,100)) as Row[]).map(toEpisode).reverse();
  }
  sessionHistory(sessionId: string, limit: number, knownAt = Number.MAX_SAFE_INTEGER, ownerId = "local"): Episode[] {
    return (this.db.prepare("SELECT * FROM episodes WHERE owner_id=? AND session_id=? AND asked_at<=? ORDER BY sequence DESC,id DESC LIMIT ?")
      .all(ownerId,sessionId,knownAt,boundedLimit(limit,100)) as Row[]).map(toEpisode).reverse();
  }

  // Legacy/audited lexical coverage excludes untrusted conversational answer indexing.
  termCoverage(terms: string[], knownAt = Number.MAX_SAFE_INTEGER, ownerId = "local"): Map<number,number> {
    return this.coverage(terms,knownAt,ownerId,false);
  }
  topicCoverage(terms: string[], knownAt = Number.MAX_SAFE_INTEGER, ownerId = "local", sessionId?: string): Map<number,number> {
    return this.coverage(terms,knownAt,ownerId,true,sessionId);
  }
  private coverage(terms: string[], knownAt: number, ownerId: string, includeAnswers: boolean, sessionId?: string): Map<number,number> {
    const clean = [...new Set(terms)].slice(0,12).filter(t => t.trim() && t.length <= 100);
    if (!clean.length) return new Map();
    const selects: string[] = [], params: Array<string|number> = [];
    // Keep FTS as the scan driver: the owner/time index otherwise induces one FTS lookup per eligible episode.
    clean.forEach((term,index) => {
      const match = `"${term.replaceAll('"','""')}"`;
      const scope = sessionId === undefined ? "" : "AND e.session_id=?", sessionParams = sessionId === undefined ? [] : [sessionId];
      selects.push(`SELECT e.id,${index} AS term FROM episodes_fts f CROSS JOIN episodes e ON e.id=f.rowid WHERE episodes_fts MATCH ? AND e.owner_id=? AND e.asked_at<=? ${scope}`);
      params.push(match,ownerId,knownAt,...sessionParams);
      if (includeAnswers) { selects.push(`SELECT e.id,${index} AS term FROM conversation_fts f CROSS JOIN episodes e ON e.id=f.rowid WHERE conversation_fts MATCH ? AND e.owner_id=? AND e.asked_at<=? ${scope}`); params.push(match,ownerId,knownAt,...sessionParams); }
    });
    const rows = this.db.prepare(`WITH matches AS (${selects.join(" UNION ALL ")})
      SELECT m.id,count(DISTINCT m.term) AS n FROM matches m JOIN episodes e ON e.id=m.id GROUP BY m.id ORDER BY n DESC,e.asked_at DESC,m.id DESC LIMIT ${MAX_CANDIDATES}`).all(...params) as Row[];
    return new Map(rows.map(r => [r.id as number,r.n as number]));
  }
  episodesById(ids: number[], knownAt = Number.MAX_SAFE_INTEGER, ownerId = "local", sessionId?: string): Episode[] {
    const selected = [...new Set(ids)].slice(0,MAX_CANDIDATES); if (!selected.length) return [];
    return (this.db.prepare(`SELECT * FROM episodes WHERE id IN (${selected.map(() => "?").join(",")}) AND owner_id=? AND asked_at<=? ${sessionId === undefined ? "" : "AND session_id=?"}`)
      .all(...selected,ownerId,knownAt,...(sessionId === undefined ? [] : [sessionId])) as Row[]).map(toEpisode);
  }
  claimsFor(episodeId: number, ownerId = "local"): Claim[] {
    return (this.db.prepare("SELECT c.* FROM claims c JOIN episodes e ON e.id=c.episode_id WHERE c.episode_id=? AND e.owner_id=? AND c.active=1 ORDER BY c.id").all(episodeId,ownerId) as Row[]).map(toClaim);
  }
  priorClaimsForEpisode(episodeId: number, ownerId = "local", limit = 20, claimIds?: number[]): Claim[] {
    const episode = this.episode(episodeId,ownerId); if (!episode) return [];
    const ids = claimIds && [...new Set(claimIds.filter(id => Number.isSafeInteger(id) && id>0))].slice(0,40);
    if (ids && !ids.length) return [];
    // ID is durable receipt order even when a viewpoint moves backward. Later-created memories cannot rewrite this job's past.
    // Explicitly saved IDs may refer to inactive rows, whose identities and historical values remain immutable.
    const filter = ids ? `AND c.id IN (${ids.map(() => "?").join(",")})` : "AND c.active=1";
    return (this.db.prepare(`SELECT c.* FROM claims c JOIN episodes e ON e.id=c.episode_id
      WHERE e.owner_id=? AND e.id<? AND e.asked_at<=? ${filter}
      ORDER BY e.id DESC,c.id DESC LIMIT ?`).all(ownerId,episodeId,episode.askedAt,...(ids ?? []),boundedLimit(limit,40)) as Row[]).map(toClaim);
  }
  verifiedStatementsFor(episodeId: number, ownerId = "local"): VerifiedStatement[] {
    if (!this.episode(episodeId,ownerId)) return [];
    const rows = this.db.prepare(`SELECT v.id,v.text,v.viewpoint_at,v.verified_at,s.source_n FROM verified_statements v
      JOIN verified_statement_sources s ON s.statement_id=v.id AND s.episode_id=v.episode_id WHERE v.episode_id=? ORDER BY v.id,s.source_n`).all(episodeId) as Row[];
    return groupStatements(rows);
  }
  sourcesFor(episodeId: number, ownerId = "local"): Source[] {
    return (this.db.prepare("SELECT s.* FROM sources s JOIN episodes e ON e.id=s.episode_id WHERE s.episode_id=? AND e.owner_id=? ORDER BY s.n").all(episodeId,ownerId) as Row[]).map(toSource);
  }
  recent(limit: number, knownAt = Number.MAX_SAFE_INTEGER, ownerId = "local"): Episode[] {
    return (this.db.prepare("SELECT * FROM episodes WHERE owner_id=? AND asked_at<=? ORDER BY id DESC LIMIT ?").all(ownerId,knownAt,boundedLimit(limit)) as Row[]).map(toEpisode);
  }
  ledgerPage(input: { limit?: number; beforeId?: number; knownAt?: number; ownerId?: string } = {}): {
    items: Array<{ episode: Episode; claims: Claim[]; sources: Source[]; verifiedStatements: VerifiedStatement[] }>; nextCursor: number | null;
  } {
    const ownerId = owner(input.ownerId), limit = boundedLimit(input.limit ?? 50);
    const episodes = (this.db.prepare("SELECT * FROM episodes WHERE owner_id=? AND id<? AND asked_at<=? ORDER BY id DESC LIMIT ?")
      .all(ownerId,input.beforeId ?? Number.MAX_SAFE_INTEGER,input.knownAt ?? Number.MAX_SAFE_INTEGER,limit+1) as Row[]).map(toEpisode);
    const more = episodes.length > limit; const page = episodes.slice(0,limit);
    if (!page.length) return { items:[],nextCursor:null };
    const ids = page.map(e => e.id), bindings = ids.map(() => "?").join(",");
    const claims = this.db.prepare(`SELECT * FROM claims WHERE episode_id IN (${bindings}) AND active=1 ORDER BY id`).all(...ids) as Row[];
    const sources = this.db.prepare(`SELECT * FROM sources WHERE episode_id IN (${bindings}) ORDER BY episode_id,n`).all(...ids) as Row[];
    const statements = this.db.prepare(`SELECT v.episode_id,v.id,v.text,v.viewpoint_at,v.verified_at,s.source_n FROM verified_statements v
      JOIN verified_statement_sources s ON s.statement_id=v.id AND s.episode_id=v.episode_id WHERE v.episode_id IN (${bindings}) ORDER BY v.id,s.source_n`).all(...ids) as Row[];
    return { items:page.map(episode => ({ episode,claims:claims.filter(c => c.episode_id===episode.id).map(toClaim),
      sources:sources.filter(s => s.episode_id===episode.id).map(toSource),verifiedStatements:groupStatements(statements.filter(s => s.episode_id===episode.id)) })),
      nextCursor:more ? page.at(-1)!.id : null };
  }
  count(knownAt = Number.MAX_SAFE_INTEGER, ownerId = "local"): number {
    return (this.db.prepare("SELECT count(*) AS n FROM episodes WHERE owner_id=? AND asked_at<=?").get(ownerId,knownAt) as { n:number }).n;
  }
}

function groupStatements(rows: Row[]): VerifiedStatement[] {
  const result = new Map<number,VerifiedStatement>();
  for (const r of rows) { const id = r.id as number;
    if (!result.has(id)) result.set(id,{ id,text:r.text as string,viewpointAt:r.viewpoint_at as number,verifiedAt:r.verified_at as number,sourceNumbers:[] });
    result.get(id)!.sourceNumbers.push(r.source_n as number);
  }
  return [...result.values()];
}
function claimKey(c: Pick<NewClaim,"entity"|"attribute"|"value"|"sourceUrl"|"priorClaimId">): string {
  return JSON.stringify([c.entity,c.attribute,c.value,c.sourceUrl,c.priorClaimId]);
}
function boundEnrichment(input: Enrichment): Enrichment {
  const text = (s: unknown,max: number) => typeof s === "string" ? s.replaceAll("\0","").trim().slice(0,max) : "";
  return { summary:text(input.summary,1000),topics:input.topics.slice(0,8).map(s => text(s,100)).filter(Boolean),
    claims:input.claims.slice(0,20).map(c => ({ ...c,entity:text(c.entity,200),attribute:text(c.attribute,200),value:text(c.value,1000),kind:text(c.kind,30),sourceUrl:c.sourceUrl ? text(c.sourceUrl,2048) : null })).filter(c => c.entity && c.attribute && c.value) };
}

function validateStatements(input: NewVerifiedStatement[] | undefined, sources: Source[], askedAt: number): NewVerifiedStatement[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 100) throw new Error("Expected at most 100 verified statements.");
  if (!input.length) return [];
  if (!Number.isSafeInteger(askedAt) || !Number.isFinite(new Date(askedAt).getTime())) throw new Error("Verified statements require a valid episode viewpoint.");
  const available = new Set(sources.map(source => source.n));
  const statements = input.map(statement => {
    if (!statement || typeof statement.text !== "string" || !statement.text.trim() || statement.text.length > 20_000 || statement.text.includes("\0")) throw new Error("Verified statement text must contain 1 to 20000 characters.");
    if (!Array.isArray(statement.sourceNumbers) || !statement.sourceNumbers.length || statement.sourceNumbers.length > 64
      || statement.sourceNumbers.some(n => !Number.isSafeInteger(n) || n < 1 || !available.has(n))) throw new Error("Verified statements must cite source numbers present in the same episode.");
    return { text: statement.text, sourceNumbers: [...new Set(statement.sourceNumbers)].sort((a, b) => a - b) };
  });
  if (statements.reduce((total, statement) => total + statement.text.length, 0) > 20_000) throw new Error("Verified statement text exceeds the 20000-character episode budget.");
  return statements;
}
