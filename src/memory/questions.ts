import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { TurnTime } from "../clock.ts";
import type { ClarificationAnswer, ClarificationCard, ClarificationPort, ClarificationQuestion, ClarificationSelection } from "../agent/clarification.ts";

interface SavedQuestion {
  card: ClarificationCard;
  sessionId: string;
  selection: ClarificationAnswer | null;
  episodeId: number | null;
}
export class QuestionConflict extends Error {
  constructor(message: string, readonly code: "clarification_unavailable" | "clarification_in_progress" | "clarification_invalid_option" | "clarification_choice_sealed") { super(message); }
}

export class QuestionStore implements ClarificationPort {
  private db: DatabaseSync;
  private active = new Set<string>();
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = 250;
      CREATE TABLE IF NOT EXISTS clarification_questions (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message TEXT NOT NULL,
        time_json TEXT NOT NULL, question_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, selection_json TEXT, episode_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS questions_by_session ON clarification_questions(session_id, created_at);`);
    if (!(this.db.prepare("PRAGMA table_info(clarification_questions)").all() as Array<{name:string}>).some(row => row.name === "owner_id")) {
      this.db.exec("ALTER TABLE clarification_questions ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'local'");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS questions_by_owner_session ON clarification_questions(owner_id, session_id, created_at)");
  }
  create(input: { ownerId?: string; sessionId: string; message: string; time: TurnTime; question: ClarificationQuestion }): ClarificationCard {
    const id = randomUUID(), now = Date.now();
    this.db.prepare("DELETE FROM clarification_questions WHERE expires_at < ? AND episode_id IS NULL").run(now);
    this.db.prepare(`INSERT INTO clarification_questions (id, session_id, message, time_json, question_json, created_at, expires_at, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.sessionId, input.message, JSON.stringify(input.time), JSON.stringify(input.question), now, now + 86_400_000, input.ownerId ?? "local");
    return { id, message: input.message, time: input.time, ...input.question };
  }
  pending(sessionId: string, ownerId = "local"): ClarificationCard | null {
    const row = this.db.prepare("SELECT * FROM clarification_questions WHERE session_id = ? AND owner_id = ? AND episode_id IS NULL AND expires_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(sessionId, ownerId, Date.now());
    if (!row) return null;
    const saved = this.decode(row);
    return { ...saved.card, ...(saved.selection ? { selection: saved.selection } : {}) };
  }
  begin(id: string, sessionId: string, selection: ClarificationSelection, ownerId = "local"): SavedQuestion {
    const row = this.db.prepare("SELECT * FROM clarification_questions WHERE id = ? AND session_id = ? AND owner_id = ? AND expires_at >= ?").get(id, sessionId, ownerId, Date.now());
    if (!row) throw new QuestionConflict("This question has expired or belongs to another conversation. Ask your question again.", "clarification_unavailable");
    if (this.active.has(id)) throw new QuestionConflict("This answer is already being prepared. Please wait.", "clarification_in_progress");
    const saved = this.decode(row);
    let answer: ClarificationAnswer;
    if ("optionId" in selection) {
      const option = saved.card.options.find(option => option.id === selection.optionId);
      if (!option) throw new QuestionConflict("Choose one of the available options, or write your own detail.", "clarification_invalid_option");
      answer = { id, question: saved.card.question, answer: option.label + ": " + option.detail, optionId: option.id, skipped: false };
    } else if ("text" in selection) answer = { id, question: saved.card.question, answer: selection.text, skipped: false };
    else answer = { id, question: saved.card.question, answer: "Use your best judgment and state reasonable assumptions.", skipped: true };
    if (saved.selection && JSON.stringify(saved.selection) !== JSON.stringify(answer)) throw new QuestionConflict("A different choice was already submitted. Start a new question to change it.", "clarification_choice_sealed");
    this.db.prepare("UPDATE clarification_questions SET selection_json = ? WHERE id = ?").run(JSON.stringify(answer), id);
    this.active.add(id);
    return { ...saved, selection: answer };
  }
  finish(id: string, episodeId: number) { this.db.prepare("UPDATE clarification_questions SET episode_id = ? WHERE id = ?").run(episodeId, id); }
  release(id: string) { this.active.delete(id); }
  close() { this.db.close(); }
  private decode(row: Record<string, unknown>): SavedQuestion {
    return { sessionId: row.session_id as string,
      card: { id: row.id as string, message: row.message as string, time: JSON.parse(row.time_json as string), ...JSON.parse(row.question_json as string) },
      selection: row.selection_json ? JSON.parse(row.selection_json as string) : null,
      episodeId: row.episode_id as number | null };
  }
}
