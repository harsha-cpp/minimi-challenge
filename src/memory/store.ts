/**
 * The conversation log and the claim ledger, in one SQLite file.
 *
 * An episode is one question and its answer, stamped with when it was asked.
 * A claim is one checkable fact that answer stated ("Neon Launch plan: $19 a
 * month"), with the source it came from and the moment it was observed. Claims
 * are what make "is that still correct?" answerable: there is a list of exact
 * things to re-check instead of a paragraph to re-read.
 *
 * node:sqlite ships with Node, so there is no native module to compile and
 * `npm install` cannot fail on it.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Source {
  n: number;
  url: string;
  title: string;
  publishedDate?: string;
}

export interface Episode {
  id: number;
  sessionId: string;
  /** UTC milliseconds, taken from the injected clock. */
  askedAt: number;
  tz: string;
  question: string;
  answer: string;
  summary: string | null;
  topics: string | null;
}

export type Verdict = "new" | "unchanged" | "changed";

export interface Claim {
  id: number;
  episodeId: number;
  entity: string;
  attribute: string;
  value: string;
  kind: string;
  sourceUrl: string | null;
  observedAt: number;
  /** The earlier claim this one re-checks, if any. Following it back gives the value's history. */
  priorClaimId: number | null;
  verdict: Verdict;
}

export type NewClaim = Omit<Claim, "id" | "episodeId" | "observedAt">;

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
  topics     TEXT
);
CREATE INDEX IF NOT EXISTS episodes_by_time ON episodes (asked_at);
CREATE INDEX IF NOT EXISTS episodes_by_session ON episodes (session_id, asked_at);

CREATE TABLE IF NOT EXISTS sources (
  episode_id     INTEGER NOT NULL REFERENCES episodes (id),
  n              INTEGER NOT NULL,
  url            TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  published_date TEXT,
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
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Written synchronously as soon as an answer finishes, so the very next
   * message can already recall it. The summary, topics and claims arrive later
   * through `enrich`.
   */
  saveEpisode(e: Omit<Episode, "id" | "summary" | "topics"> & { sources: Source[] }): number {
    const result = this.db
      .prepare("INSERT INTO episodes (session_id, asked_at, tz, question, answer) VALUES (?, ?, ?, ?, ?)")
      .run(e.sessionId, e.askedAt, e.tz, e.question, e.answer);
    const id = Number(result.lastInsertRowid);
    const insertSource = this.db.prepare(
      "INSERT INTO sources (episode_id, n, url, title, published_date) VALUES (?, ?, ?, ?, ?)",
    );
    for (const s of e.sources) insertSource.run(id, s.n, s.url, s.title, s.publishedDate ?? null);
    this.db.prepare("INSERT INTO episodes_fts (rowid, question) VALUES (?, ?)").run(id, e.question);
    return id;
  }

  enrich(episodeId: number, enrichment: Enrichment): void {
    const episode = this.episode(episodeId);
    if (!episode) return;
    const topics = enrichment.topics.join(", ");
    const entities = [...new Set(enrichment.claims.map((c) => c.entity))].join(", ");

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

  /** Episodes asked in [startMs, endMs), oldest first. */
  episodesBetween(startMs: number, endMs: number): Episode[] {
    const rows = this.db
      .prepare("SELECT * FROM episodes WHERE asked_at >= ? AND asked_at < ? ORDER BY asked_at")
      .all(startMs, endMs) as Row[];
    return rows.map(toEpisode);
  }

  /** The last conversation before a moment and the first one at or after another: what to offer when a date is empty. */
  neighbours(beforeMs: number, afterMs: number): Episode[] {
    const before = this.db.prepare("SELECT * FROM episodes WHERE asked_at < ? ORDER BY asked_at DESC LIMIT 1").get(beforeMs);
    const after = this.db.prepare("SELECT * FROM episodes WHERE asked_at >= ? ORDER BY asked_at LIMIT 1").get(afterMs);
    return [before, after].filter((r) => r !== undefined).map((r) => toEpisode(r as Row));
  }

  /** The most recent turns of one chat, oldest first. */
  sessionHistory(sessionId: string, limit: number): Episode[] {
    const rows = this.db
      .prepare("SELECT * FROM episodes WHERE session_id = ? ORDER BY asked_at DESC, id DESC LIMIT ?")
      .all(sessionId, limit) as Row[];
    return rows.map(toEpisode).reverse();
  }

  /**
   * For each episode, how many of `terms` it mentions. Counting distinct terms
   * (rather than using a relevance score) keeps one common word from pulling
   * in an unrelated conversation, and is easy to reason about.
   */
  termCoverage(terms: string[]): Map<number, number> {
    const coverage = new Map<number, number>();
    const match = this.db.prepare("SELECT rowid FROM episodes_fts WHERE episodes_fts MATCH ?");
    for (const term of terms) {
      const rows = match.all(`"${term.replaceAll('"', '""')}"`) as Array<{ rowid: number }>;
      for (const { rowid } of rows) coverage.set(rowid, (coverage.get(rowid) ?? 0) + 1);
    }
    return coverage;
  }

  episodesById(ids: number[]): Episode[] {
    if (!ids.length) return [];
    const rows = this.db
      .prepare(`SELECT * FROM episodes WHERE id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids) as Row[];
    return rows.map(toEpisode);
  }

  claimsFor(episodeId: number): Claim[] {
    const rows = this.db.prepare("SELECT * FROM claims WHERE episode_id = ? ORDER BY id").all(episodeId) as Row[];
    return rows.map(toClaim);
  }

  sourcesFor(episodeId: number): Source[] {
    const rows = this.db.prepare("SELECT * FROM sources WHERE episode_id = ? ORDER BY n").all(episodeId) as Row[];
    return rows.map((r) => ({
      n: r.n as number,
      url: r.url as string,
      title: r.title as string,
      publishedDate: (r.published_date as string | null) ?? undefined,
    }));
  }

  /** Newest first, for the memory panel. */
  recent(limit: number): Episode[] {
    const rows = this.db.prepare("SELECT * FROM episodes ORDER BY asked_at DESC, id DESC LIMIT ?").all(limit) as Row[];
    return rows.map(toEpisode);
  }

  count(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM episodes").get() as { n: number }).n;
  }
}
