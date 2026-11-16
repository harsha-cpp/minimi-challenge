import { DatabaseSync } from "node:sqlite";
import type { ChatMessage } from "../llm.ts";
import type { Source } from "../memory/store.ts";
import type { SimulationReview } from "../agent/simulation.ts";
import type { ClarificationAnswer } from "../agent/clarification.ts";
import type { ResponseMode } from "../agent/response-mode.ts";

export interface ResearchProgress {
  stage: "researched" | "drafted" | "reviewed";
  messages: ChatMessage[];
  sources: Source[];
  draft?: string;
  review?: SimulationReview;
  searches: number;
  modelCalls: number;
  researchRounds?: number;
  evidence?: { toolChars: number; admittedPassages: number; rejectedTemporal: number; omittedForBudget: number;
    duplicatePassages: number; duplicateCharsAvoided: number; rawCandidates: number };
}

export interface ResearchRequest {
  sessionId: string; message: string; tz: string; mode: "live" | "era"; asOf: number | null;
  responseMode: ResponseMode; recheckEpisodeId?: number; clarification?: ClarificationAnswer; retryUnfinished?: boolean;
}
export interface ResearchResumption { ownerId: string; idempotencyKey: string; turnId: string; fromTurnId: string; request: ResearchRequest; }

export interface ResearchCheckpoint {
  version: 1;
  ownerId: string; turnId: string; sessionId: string;
  requestHash: string; contextHash: string; policyHash: string;
  effectiveAt: string; createdAt: number; expiresAt: number;
  request: ResearchRequest;
  progress: ResearchProgress;
  usage: { calls: number; tokens: number; spendUsd: number | null };
}

export const RESEARCH_CHECKPOINT_TTL_MS = 120_000;
const MAX_BYTES = 300_000;
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Opaque to clients: only owner-scoped server code may restore model messages and evidence. */
export class ResearchCheckpoints {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly now = Date.now) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=250;
      CREATE TABLE IF NOT EXISTS research_checkpoints (
        owner_id TEXT NOT NULL, turn_id TEXT NOT NULL, session_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(owner_id,turn_id)
      );
      CREATE INDEX IF NOT EXISTS research_checkpoints_expiry ON research_checkpoints(expires_at);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS research_resumptions (
      owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, turn_id TEXT NOT NULL, from_turn_id TEXT NOT NULL, request_json TEXT NOT NULL,
      PRIMARY KEY(owner_id,idempotency_key)
    );`);
    this.purge();
  }
  save(checkpoint: ResearchCheckpoint): void {
    const payload = JSON.stringify(checkpoint);
    if (Buffer.byteLength(payload) > MAX_BYTES || !this.valid(checkpoint)) throw new Error("Invalid research checkpoint.");
    this.purge();
    const prior = this.db.prepare("SELECT session_id FROM research_checkpoints WHERE owner_id=? AND turn_id=?").get(checkpoint.ownerId, checkpoint.turnId) as { session_id: string } | undefined;
    if (prior && prior.session_id !== checkpoint.sessionId) throw new Error("Research checkpoint conversation changed.");
    this.db.prepare(`INSERT INTO research_checkpoints(owner_id,turn_id,session_id,expires_at,payload) VALUES(?,?,?,?,?)
      ON CONFLICT(owner_id,turn_id) DO UPDATE SET expires_at=MIN(research_checkpoints.expires_at,excluded.expires_at),payload=excluded.payload
      WHERE research_checkpoints.session_id=excluded.session_id`)
      .run(checkpoint.ownerId, checkpoint.turnId, checkpoint.sessionId, checkpoint.expiresAt, payload);
  }
  get(turnId: string, ownerId: string): ResearchCheckpoint | null {
    const row = this.db.prepare("SELECT payload,expires_at FROM research_checkpoints WHERE owner_id=? AND turn_id=? AND expires_at>?")
      .get(ownerId, turnId, this.now()) as { payload: string; expires_at: number } | undefined;
    if (!row) return null;
    try {
      const checkpoint: unknown = JSON.parse(row.payload);
      if (!this.valid(checkpoint) || checkpoint.ownerId !== ownerId || checkpoint.turnId !== turnId) return null;
      return { ...checkpoint, expiresAt: Math.min(checkpoint.expiresAt, row.expires_at) };
    } catch { return null; }
  }
  remove(turnId: string, ownerId: string): void { this.db.prepare("DELETE FROM research_checkpoints WHERE owner_id=? AND turn_id=?").run(ownerId, turnId); }
  recordResumption(value: ResearchResumption): void {
    this.db.prepare("INSERT INTO research_resumptions(owner_id,idempotency_key,turn_id,from_turn_id,request_json) VALUES(?,?,?,?,?)")
      .run(value.ownerId, value.idempotencyKey, value.turnId, value.fromTurnId, JSON.stringify(value.request));
  }
  resumption(key: string, ownerId: string): ResearchResumption | null {
    const row = this.db.prepare("SELECT * FROM research_resumptions WHERE owner_id=? AND idempotency_key=?").get(ownerId, key) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { ownerId, idempotencyKey: key, turnId: String(row.turn_id), fromTurnId: String(row.from_turn_id), request: JSON.parse(String(row.request_json)) as ResearchRequest };
  }
  purge(): void { this.db.prepare("DELETE FROM research_checkpoints WHERE expires_at<=?").run(this.now()); }
  close(): void { this.db.close(); }
  private valid(value: unknown): value is ResearchCheckpoint {
    if (!record(value) || value.version !== 1 || typeof value.ownerId !== "string" || !value.ownerId || value.ownerId.length > 200
      || typeof value.turnId !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(value.turnId)
      || typeof value.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.sessionId)
      || !hash(value.requestHash) || !hash(value.contextHash) || !hash(value.policyHash)
      || typeof value.effectiveAt !== "string" || !Number.isFinite(Date.parse(value.effectiveAt))
      || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt)
      || Number(value.expiresAt) <= Number(value.createdAt) || Number(value.expiresAt) - Number(value.createdAt) > RESEARCH_CHECKPOINT_TTL_MS
      || Number(value.createdAt) > this.now() + 1000 || !record(value.request) || !record(value.progress) || !record(value.usage)) return false;
    const request = value.request, progress = value.progress, usage = value.usage;
    if (request.sessionId !== value.sessionId || typeof request.message !== "string" || !request.message.trim() || request.message.length > 8000
      || typeof request.tz !== "string" || !["live", "era"].includes(String(request.mode)) || !["standard", "fast"].includes(String(request.responseMode))
      || (request.mode === "live" ? request.asOf !== null : !Number.isSafeInteger(request.asOf))
      || !["researched", "drafted", "reviewed"].includes(String(progress.stage))
      || !Array.isArray(progress.messages) || progress.messages.length > 128 || !Array.isArray(progress.sources) || progress.sources.length > 64
      || !Number.isSafeInteger(progress.searches) || Number(progress.searches) < 0 || Number(progress.searches) > 100
      || !Number.isSafeInteger(progress.modelCalls) || Number(progress.modelCalls) < 0 || Number(progress.modelCalls) > 100
      || progress.researchRounds !== undefined && (!Number.isSafeInteger(progress.researchRounds) || Number(progress.researchRounds) < 0 || Number(progress.researchRounds) > 4)
      || progress.draft !== undefined && (typeof progress.draft !== "string" || progress.draft.length > 20_000)
      || progress.stage !== "researched" && (typeof progress.draft !== "string" || !progress.draft.trim())
      || progress.stage === "reviewed" && (!record(progress.review) || !["approved", "needs_revision", "unavailable"].includes(String(progress.review.status)))
      || !Number.isSafeInteger(usage.calls) || Number(usage.calls) < 0 || !Number.isSafeInteger(usage.tokens) || Number(usage.tokens) < 0
      || usage.spendUsd !== null && (typeof usage.spendUsd !== "number" || !Number.isFinite(usage.spendUsd) || usage.spendUsd < 0)) return false;
    const numbers = new Set<number>();
    for (const source of progress.sources) {
      if (!record(source) || !Number.isSafeInteger(source.n) || Number(source.n) < 1 || numbers.has(Number(source.n))
        || typeof source.url !== "string" || source.url.length > 2048 || !/^https?:\/\//i.test(source.url)
        || typeof source.title !== "string" || source.text !== undefined && (typeof source.text !== "string" || source.text.length > 40_000)) return false;
      numbers.add(Number(source.n));
    }
    if (progress.evidence !== undefined && (!record(progress.evidence)
      || Object.values(progress.evidence).some(value => !Number.isSafeInteger(value) || Number(value) < 0)
      || Number(progress.evidence.toolChars) > 32_000)) return false;
    return true;
  }
}
