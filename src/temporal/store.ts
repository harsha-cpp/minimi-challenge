import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalUrl, normalizeQuery } from "../search/validate.ts";
import { parseInstant } from "../time/instant.ts";
import type { TemporalCoverage, TemporalDocumentInput, TemporalPassage, TemporalReview, TemporalSearchInput } from "./types.ts";
export type { TemporalCoverage, TemporalDocumentInput, TemporalPassage, TemporalReview, TemporalSearchInput } from "./types.ts";

const MAX_TEXT = 200_000;
const MAX_BATCH = 1000;
const HASH = (value: string) => createHash("sha256").update(value).digest("hex");
const STOP_WORDS = new Set("a all an and are as at be been by complete did do does each every for from full had has have how i in is it its list me of on or season seasons that the their then there these they this to was were what when where which who why will with year years yearly you your".split(" "));
type Row = Record<string, unknown>;

function boundedString(value: unknown, name: string, max: number, trim = true): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error(`${name} must be a nonempty string of at most ${max} characters.`);
  return trim ? value.trim() : value;
}

function instant(value: unknown, name: string): string {
  const parsed = parseInstant(value);
  if (!parsed) throw new Error(`${name} must be a real ISO timestamp with a timezone.`);
  return parsed.toISOString();
}

/** Pure validation is shared by the CLI, batch writes, and callers importing individual documents. */
export function validateTemporalDocument(value: unknown): TemporalDocumentInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a historical source document object.");
  const input = value as Record<string, unknown>;
  const sourceId = boundedString(input.sourceId, "sourceId", 2048);
  const title = boundedString(input.title, "title", 500);
  // Preserve the exact passage. Leading/trailing whitespace is part of its content hash.
  const text = boundedString(input.text, "text", MAX_TEXT, false);
  const url = canonicalUrl(boundedString(input.url, "url", 2048));
  const provenanceUrl = canonicalUrl(boundedString(input.provenanceUrl, "provenanceUrl", 4096));
  const availableAt = instant(input.availableAt, "availableAt");
  const capturedAt = input.capturedAt === undefined ? undefined : instant(input.capturedAt, "capturedAt");
  const publishedAt = input.publishedAt === undefined ? undefined : instant(input.publishedAt, "publishedAt");
  if (typeof input.provenanceKind !== "string" || !["primary-source", "archive", "revision"].includes(input.provenanceKind)) throw new Error("provenanceKind must be primary-source, archive, or revision.");
  const provenanceKind = input.provenanceKind as TemporalDocumentInput["provenanceKind"];
  if (typeof input.reviewed !== "boolean") throw new Error("reviewed must explicitly be true or false; true is an operator's provenance attestation.");
  if (provenanceKind !== "primary-source" && !capturedAt) throw new Error("Archived and revision sources require capturedAt for the exact source version.");
  if (capturedAt && Date.parse(capturedAt) < Date.parse(availableAt)) throw new Error("capturedAt cannot precede availableAt.");
  if (publishedAt && Date.parse(publishedAt) > Date.parse(availableAt)) throw new Error("publishedAt cannot follow availableAt for the same source version.");
  return { sourceId, url, title, text, availableAt, ...(capturedAt ? { capturedAt } : {}), ...(publishedAt ? { publishedAt } : {}), provenanceKind, provenanceUrl, reviewed: input.reviewed };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS temporal_documents (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  hostname TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  available_at INTEGER NOT NULL,
  captured_at INTEGER,
  published_at INTEGER,
  provenance_kind TEXT NOT NULL CHECK (provenance_kind IN ('primary-source', 'archive', 'revision')),
  provenance_url TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  recorded_at INTEGER NOT NULL,
  UNIQUE (source_id, content_hash, available_at),
  CHECK (provenance_kind = 'primary-source' OR captured_at IS NOT NULL),
  CHECK (captured_at IS NULL OR captured_at >= available_at),
  CHECK (published_at IS NULL OR published_at <= available_at)
);
CREATE INDEX IF NOT EXISTS temporal_documents_by_time ON temporal_documents (available_at);
CREATE INDEX IF NOT EXISTS temporal_documents_by_source ON temporal_documents (source_id, available_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS temporal_documents_version_time ON temporal_documents (source_id, available_at);
CREATE INDEX IF NOT EXISTS temporal_documents_by_url ON temporal_documents (url);
CREATE INDEX IF NOT EXISTS temporal_documents_by_hostname ON temporal_documents (hostname);
CREATE TABLE IF NOT EXISTS temporal_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES temporal_documents(id),
  reviewed INTEGER NOT NULL CHECK (reviewed IN (0, 1)),
  reason TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS temporal_reviews_by_document ON temporal_reviews (document_id, id DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS temporal_documents_fts USING fts5 (
  title, text, source_id, content = 'temporal_documents', content_rowid = 'rowid', tokenize = 'porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS temporal_documents_index AFTER INSERT ON temporal_documents BEGIN
  INSERT INTO temporal_documents_fts (rowid, title, text, source_id) VALUES (new.rowid, new.title, new.text, new.source_id);
END;
CREATE TRIGGER IF NOT EXISTS temporal_documents_no_update BEFORE UPDATE ON temporal_documents BEGIN
  SELECT RAISE(ABORT, 'Historical source versions are immutable; import a new version.');
END;
CREATE TRIGGER IF NOT EXISTS temporal_documents_no_delete BEFORE DELETE ON temporal_documents BEGIN
  SELECT RAISE(ABORT, 'Historical source versions are immutable.');
END;
CREATE TRIGGER IF NOT EXISTS temporal_reviews_no_update BEFORE UPDATE ON temporal_reviews BEGIN
  SELECT RAISE(ABORT, 'Historical review events are append-only.');
END;
CREATE TRIGGER IF NOT EXISTS temporal_reviews_no_delete BEFORE DELETE ON temporal_reviews BEGIN
  SELECT RAISE(ABORT, 'Historical review events are append-only.');
END;
`;

const reviewState = `(SELECT r.reviewed FROM temporal_reviews r WHERE r.document_id = d.id ORDER BY r.id DESC LIMIT 1)`;
const eligible = `d.available_at <= ? AND ${reviewState} = 1 AND (d.provenance_kind = 'primary-source' OR d.captured_at <= ?)`;
const toPassage = (row: Row): TemporalPassage => ({
  id: row.id as string, sourceId: row.source_id as string, url: row.url as string, title: row.title as string, text: row.text as string,
  availableAt: new Date(row.available_at as number).toISOString(),
  ...(row.captured_at === null ? {} : { capturedAt: new Date(row.captured_at as number).toISOString() }),
  ...(row.published_at === null ? {} : { publishedAt: new Date(row.published_at as number).toISOString() }),
  provenanceKind: row.provenance_kind as TemporalDocumentInput["provenanceKind"], provenanceUrl: row.provenance_url as string,
  reviewed: row.reviewed === 1, contentHash: row.content_hash as string, recordedAt: new Date(row.recorded_at as number).toISOString(),
});

/** Canonical source versions and operational reviews, separate from generated conversation memory. */
export class TemporalStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close(): void { this.db.close(); }

  importDocument(input: TemporalDocumentInput): TemporalPassage { return this.importDocuments([input])[0]!; }

  /** Validate the entire batch before its first write, then commit all versions and reviews together. */
  importDocuments(inputs: readonly unknown[]): TemporalPassage[] {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > MAX_BATCH) throw new Error(`Expected 1 to ${MAX_BATCH} historical documents.`);
    const documents = inputs.map(validateTemporalDocument);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = documents.map(input => {
        const contentHash = HASH(input.text);
        const id = HASH(JSON.stringify([input.sourceId, contentHash, input.availableAt]));
        const ambiguous = this.db.prepare("SELECT id FROM temporal_documents WHERE source_id = ? AND available_at = ? AND id <> ?")
          .get(input.sourceId, Date.parse(input.availableAt), id);
        if (ambiguous) throw new Error(`Ambiguous version time for ${input.sourceId}; different source text requires its own exact version availability timestamp.`);
        const existing = this.db.prepare(`SELECT d.*, ${reviewState} AS reviewed FROM temporal_documents d WHERE d.id = ?`).get(id) as Row | undefined;
        if (existing) {
          const passage = toPassage(existing);
          const { id: _id, contentHash: _hash, recordedAt: _time, ...stored } = passage;
          // Reimporting never changes provenance or implicitly changes a review decision.
          if (JSON.stringify(normalizedInput(stored)) !== JSON.stringify(normalizedInput(input))) throw new Error(`Conflicting metadata or review state for source version ${input.sourceId}; import a new version or use review().`);
          return passage;
        }
        const recordedAt = Date.now();
        this.db.prepare(`INSERT INTO temporal_documents (id, source_id, url, hostname, title, text, available_at, captured_at, published_at, provenance_kind, provenance_url, content_hash, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.sourceId, input.url, new URL(input.url).hostname, input.title, input.text, Date.parse(input.availableAt), input.capturedAt ? Date.parse(input.capturedAt) : null,
          input.publishedAt ? Date.parse(input.publishedAt) : null, input.provenanceKind, input.provenanceUrl, contentHash, recordedAt);
        this.db.prepare("INSERT INTO temporal_reviews (document_id, reviewed, reason, recorded_at) VALUES (?, ?, ?, ?)").run(id, Number(input.reviewed), "Initial import: operator supplied provenance review status.", recordedAt);
        return { ...input, id, contentHash, recordedAt: new Date(recordedAt).toISOString() };
      });
      this.db.exec("COMMIT");
      return results;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  /** Operational review time is never substituted for a source's historical availability. */
  review(id: string, reviewed: boolean, reason = "Operator provenance review."): void {
    if (typeof reviewed !== "boolean") throw new Error("reviewed must be a boolean.");
    const note = boundedString(reason, "Review reason", 2000);
    if (!this.db.prepare("SELECT 1 FROM temporal_documents WHERE id = ?").get(id)) throw new Error("Historical source version not found.");
    this.db.prepare("INSERT INTO temporal_reviews (document_id, reviewed, reason, recorded_at) VALUES (?, ?, ?, ?)").run(id, Number(reviewed), note, Date.now());
  }

  reviewHistory(id: string): TemporalReview[] {
    return (this.db.prepare("SELECT * FROM temporal_reviews WHERE document_id = ? ORDER BY id").all(id) as Row[]).map(row => ({
      id: row.id as number, documentId: row.document_id as string, reviewed: row.reviewed === 1, reason: row.reason as string, recordedAt: new Date(row.recorded_at as number).toISOString(),
    }));
  }

  search(input: TemporalSearchInput): TemporalPassage[] {
    if (!(input.asOf instanceof Date) || !Number.isFinite(input.asOf.getTime())) throw new Error("A valid historical cutoff is required.");
    const query = normalizeQuery(input);
    const limit = input.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Historical result limit must be 1 to 50.");
    const allTokens = [...new Set(query.query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 32);
    const significant = allTokens.filter(token => !STOP_WORDS.has(token));
    const tokens = significant.length ? significant : allTokens;
    // Tokens are quoted data, never raw FTS syntax. Punctuation-only input has no keyword matches.
    if (!tokens.length && !query.urls) return [];
    const at = input.asOf.getTime();
    const params: Array<string | number> = [at, at];
    const filters = [eligible];
    if (query.urls) {
      filters.push(`d.url IN (${query.urls.map(() => "?").join(",")})`);
      params.push(...query.urls);
    }
    if (query.domains) {
      filters.push(`(${query.domains.map(() => "(d.hostname = ? OR d.hostname LIKE ?)").join(" OR ")})`);
      for (const domain of query.domains) params.push(domain, `%.${domain}`);
    }
    if (query.publishedAfter) {
      filters.push("d.published_at >= ?"); params.push(Date.parse(`${query.publishedAfter}T00:00:00.000Z`));
    }
    if (!query.urls && tokens.length) {
      filters.push("d.rowid IN (SELECT rowid FROM temporal_documents_fts WHERE temporal_documents_fts MATCH ?)");
      params.push(tokens.map(token => `"${token}"`).join(" OR "));
    }
    // Select the newest admissible reviewed version, before matching keywords. A superseded
    // version cannot resurface merely because a newer version stopped mentioning the query.
    filters.push(`NOT EXISTS (SELECT 1 FROM temporal_documents newer WHERE newer.source_id = d.source_id AND
      newer.available_at > d.available_at AND newer.available_at <= ? AND
      (SELECT r.reviewed FROM temporal_reviews r WHERE r.document_id = newer.id ORDER BY r.id DESC LIMIT 1) = 1 AND
      (newer.provenance_kind = 'primary-source' OR newer.captured_at <= ?))`);
    params.push(at, at);
    // Score only the eligible row's own text. Global BM25 statistics would let future
    // documents influence historical ranking even when their passages are filtered out.
    const scores = tokens.map(() => "(CASE WHEN instr(lower(d.title), ?) > 0 THEN 3 ELSE 0 END + CASE WHEN instr(lower(d.text), ?) > 0 THEN 1 ELSE 0 END)");
    const scoreParams = tokens.flatMap(token => [token, token]);
    const rows = this.db.prepare(`SELECT d.*, ${reviewState} AS reviewed, ${scores.join(" + ") || "0"} AS relevance FROM temporal_documents d
      WHERE ${filters.join(" AND ")} ORDER BY relevance DESC, d.available_at DESC, d.id LIMIT ?`).all(...scoreParams, ...params, limit) as Row[];
    return rows.map(toPassage);
  }

  coverage(asOf?: Date): TemporalCoverage {
    if (asOf && (!(asOf instanceof Date) || !Number.isFinite(asOf.getTime()))) throw new Error("A valid historical cutoff is required.");
    const at = asOf?.getTime() ?? Date.now();
    const reviewed = this.db.prepare(`SELECT count(*) AS n FROM temporal_documents d WHERE ${reviewState} = 1`).get() as Row;
    const available = this.db.prepare(`SELECT count(*) AS n, min(d.available_at) AS earliest, max(d.available_at) AS latest FROM temporal_documents d WHERE ${eligible}`).get(at, at) as Row;
    return {
      reviewedDocuments: reviewed.n as number, eligibleDocuments: available.n as number,
      earliestAvailableAt: available.earliest === null ? null : new Date(available.earliest as number).toISOString(),
      latestAvailableAt: available.latest === null ? null : new Date(available.latest as number).toISOString(),
    };
  }
}

// Stabilize optional-property ordering for idempotent import comparisons.
function normalizedInput(input: TemporalDocumentInput): TemporalDocumentInput {
  return { sourceId: input.sourceId, url: input.url, title: input.title, text: input.text, availableAt: input.availableAt,
    capturedAt: input.capturedAt, publishedAt: input.publishedAt, provenanceKind: input.provenanceKind, provenanceUrl: input.provenanceUrl, reviewed: input.reviewed };
}
