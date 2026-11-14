

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SearchHit, TemporalProvenance } from "../search/types.ts";

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

export class MemoryStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);

    const columns = this.db.prepare("PRAGMA table_info(sources)").all() as Array<{ name: string }>;
    if (!columns.some(c => c.name === "evidence_json")) this.db.exec("ALTER TABLE sources ADD COLUMN evidence_json TEXT");
    const episodeColumns = this.db.prepare("PRAGMA table_info(episodes)").all() as Array<{ name: string }>;
    if (!episodeColumns.some(c => c.name === "execution_json")) this.db.exec("ALTER TABLE episodes ADD COLUMN execution_json TEXT");
  }

  close(): void {
    this.db.close();
  }

  saveEpisode(e: Omit<Episode, "id" | "summary" | "topics"> & { sources: Source[]; verifiedStatements?: NewVerifiedStatement[] }): number {
    const verifiedStatements = validateStatements(e.verifiedStatements, e.sources, e.askedAt);
    this.db.exec("BEGIN");
    try {
      const result = this.db
        .prepare("INSERT INTO episodes (session_id, asked_at, tz, question, answer, execution_json) VALUES (?, ?, ?, ?, ?, ?)")
        .run(e.sessionId, e.askedAt, e.tz, e.question, e.answer, e.execution ? JSON.stringify(e.execution) : null);
      const id = Number(result.lastInsertRowid);
      const insertSource = this.db.prepare(
        "INSERT INTO sources (episode_id, n, url, title, published_date, evidence_json) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const s of e.sources) {
        const { n, url, title, publishedDate, ...evidence } = s;
        insertSource.run(id, n, url, title, publishedDate ?? null, JSON.stringify(evidence));
      }
      if (verifiedStatements.length) {

        let statementId = Number((this.db.prepare("SELECT coalesce(max(id), 0) AS id FROM verified_statements").get() as { id: number }).id);
        const verifiedAt = Date.now();
        const insertLink = this.db.prepare("INSERT INTO verified_statement_sources (statement_id, episode_id, source_n) VALUES (?, ?, ?)");
        const insertStatement = this.db.prepare("INSERT INTO verified_statements (id, episode_id, text, viewpoint_at, verified_at) VALUES (?, ?, ?, ?, ?)");
        for (const statement of verifiedStatements) {
          statementId++;
          for (const n of statement.sourceNumbers) insertLink.run(statementId, id, n);
          insertStatement.run(statementId, id, statement.text, e.askedAt, verifiedAt);
        }
      }
      this.db.prepare("INSERT INTO episodes_fts (rowid, question, entities) VALUES (?, ?, ?)")
        .run(id, e.question, verifiedStatements.map(statement => statement.text).join("\n") || null);
      this.db.exec("COMMIT");
      return id;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  enrich(episodeId: number, enrichment: Enrichment): void {
    const episode = this.episode(episodeId);
    if (!episode) return;
    const topics = enrichment.topics.join(", ");

    const audited = this.verifiedStatementsFor(episodeId).map(statement => statement.text).join("\n");
    const entities = [audited, [...new Set(enrichment.claims.map((c) => c.entity))].join(", ")].filter(Boolean).join("\n");

    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE episodes SET summary = ?, topics = ? WHERE id = ?").run(enrichment.summary, topics, episodeId);
      this.db.prepare("DELETE FROM claims WHERE episode_id = ?").run(episodeId);
      const insertClaim = this.db.prepare(
        `INSERT INTO claims (episode_id, entity, attribute, value, kind, source_url, observed_at, prior_claim_id, verdict)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const c of enrichment.claims) {
        insertClaim.run(episodeId, c.entity, c.attribute, c.value, c.kind, c.sourceUrl, episode.askedAt, c.priorClaimId, c.verdict);
      }
      this.db.prepare("DELETE FROM episodes_fts WHERE rowid = ?").run(episodeId);
      this.db
        .prepare("INSERT INTO episodes_fts (rowid, question, summary, topics, entities) VALUES (?, ?, ?, ?, ?)")
        .run(episodeId, episode.question, enrichment.summary, topics, entities);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  episode(id: number): Episode | null {
    const row = this.db.prepare("SELECT * FROM episodes WHERE id = ?").get(id) as Row | undefined;
    return row ? toEpisode(row) : null;
  }

  episodesBetween(startMs: number, endMs: number, knownAt = Number.MAX_SAFE_INTEGER): Episode[] {
    const rows = this.db
      .prepare("SELECT * FROM episodes WHERE asked_at >= ? AND asked_at < ? AND asked_at <= ? ORDER BY asked_at")
      .all(startMs, endMs, knownAt) as Row[];
    return rows.map(toEpisode);
  }

  neighbours(beforeMs: number, afterMs: number, knownAt = Number.MAX_SAFE_INTEGER): Episode[] {
    const before = this.db.prepare("SELECT * FROM episodes WHERE asked_at < ? AND asked_at <= ? ORDER BY asked_at DESC LIMIT 1").get(beforeMs, knownAt);
    const after = this.db.prepare("SELECT * FROM episodes WHERE asked_at >= ? AND asked_at <= ? ORDER BY asked_at LIMIT 1").get(afterMs, knownAt);
    return [before, after].filter((r) => r !== undefined).map((r) => toEpisode(r as Row));
  }

  sessionHistory(sessionId: string, limit: number, knownAt = Number.MAX_SAFE_INTEGER): Episode[] {
    const rows = this.db
      .prepare("SELECT * FROM episodes WHERE session_id = ? AND asked_at <= ? ORDER BY asked_at DESC, id DESC LIMIT ?")
      .all(sessionId, knownAt, limit) as Row[];
    return rows.map(toEpisode).reverse();
  }

  termCoverage(terms: string[]): Map<number, number> {
    const coverage = new Map<number, number>();
    const match = this.db.prepare("SELECT rowid FROM episodes_fts WHERE episodes_fts MATCH ?");
    for (const term of terms) {
      const rows = match.all(`"${term.replaceAll('"', '""')}"`) as Array<{ rowid: number }>;
      for (const { rowid } of rows) coverage.set(rowid, (coverage.get(rowid) ?? 0) + 1);
    }
    return coverage;
  }

  episodesById(ids: number[], knownAt = Number.MAX_SAFE_INTEGER): Episode[] {
    if (!ids.length) return [];
    const rows = this.db
      .prepare(`SELECT * FROM episodes WHERE id IN (${ids.map(() => "?").join(",")}) AND asked_at <= ?`)
      .all(...ids, knownAt) as Row[];
    return rows.map(toEpisode);
  }

  claimsFor(episodeId: number): Claim[] {
    const rows = this.db.prepare("SELECT * FROM claims WHERE episode_id = ? ORDER BY id").all(episodeId) as Row[];
    return rows.map(toClaim);
  }

  verifiedStatementsFor(episodeId: number): VerifiedStatement[] {
    const rows = this.db.prepare(`SELECT v.id, v.text, v.viewpoint_at, v.verified_at, s.source_n
      FROM verified_statements v JOIN verified_statement_sources s ON s.statement_id = v.id AND s.episode_id = v.episode_id
      WHERE v.episode_id = ? ORDER BY v.id, s.source_n`).all(episodeId) as Row[];
    const statements = new Map<number, VerifiedStatement>();
    for (const row of rows) {
      const id = row.id as number;
      let statement = statements.get(id);
      if (!statement) {
        statement = { id, text: row.text as string, sourceNumbers: [], viewpointAt: row.viewpoint_at as number, verifiedAt: row.verified_at as number };
        statements.set(id, statement);
      }
      statement.sourceNumbers.push(row.source_n as number);
    }
    return [...statements.values()];
  }

  sourcesFor(episodeId: number): Source[] {
    const rows = this.db.prepare("SELECT * FROM sources WHERE episode_id = ? ORDER BY n").all(episodeId) as Row[];
    return rows.map((r) => ({
      ...(r.evidence_json ? JSON.parse(r.evidence_json as string) : {}),
      n: r.n as number,
      url: r.url as string,
      title: r.title as string,
      publishedDate: (r.published_date as string | null) ?? undefined,
    }));
  }

  recent(limit: number, knownAt = Number.MAX_SAFE_INTEGER): Episode[] {
    const rows = this.db.prepare("SELECT * FROM episodes WHERE asked_at <= ? ORDER BY asked_at DESC, id DESC LIMIT ?").all(knownAt, limit) as Row[];
    return rows.map(toEpisode);
  }

  count(knownAt = Number.MAX_SAFE_INTEGER): number {
    return (this.db.prepare("SELECT count(*) AS n FROM episodes WHERE asked_at <= ?").get(knownAt) as { n: number }).n;
  }
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
