import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface Conversation {
  conversation_id: string; project_id: string; title: string; state: "active" | "archived"; created_at: string; updated_at: string;
  /** The index of the runtime's native session (kept by the runtime, per working directory): the
   * maestro turn resumes `session_id` on `session_runtime`; null until the first turn answers. */
  session_id: string | null; session_runtime: string | null; session_started_at: string | null; last_turn_at: string | null;
  /** JSON list of the sessions this conversation had before the current one (`SessionRecord[]`). */
  session_history: string | null;
}
export interface SessionRecord { session_id: string; session_runtime: string; started_at: string | null; ended_at: string; reason: string }
export interface Message { message_id: string; conversation_id: string; project_id: string; run_id?: string; role: "user" | "assistant" | "system"; content: string; created_at: string; sequence: number }

// Columns added after the first release; the migration is idempotent (PRAGMA table_info, then ALTER).
const SESSION_COLUMNS: ReadonlyArray<[string, string]> = [
  ["session_id", "TEXT"], ["session_runtime", "TEXT"], ["session_started_at", "TEXT"], ["last_turn_at", "TEXT"], ["session_history", "TEXT"],
];

export class ConversationService {
  readonly db: Database;
  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON");
    this.db.exec(`CREATE TABLE IF NOT EXISTS conversations (
      conversation_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS conversation_messages (
      message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
      project_id TEXT NOT NULL, run_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
      sequence INTEGER NOT NULL, UNIQUE(conversation_id, sequence)
    );`);
    const columns = new Set((this.db.query("PRAGMA table_info(conversations)").all() as Array<{ name: string }>).map(column => column.name));
    for (const [name, type] of SESSION_COLUMNS) if (!columns.has(name)) this.db.exec(`ALTER TABLE conversations ADD COLUMN ${name} ${type}`);
  }
  close(): void { this.db.close(); }
  create(projectId: string, title = "Nova conversa", conversationId = `cnv_${randomUUID()}`): Conversation {
    const now = new Date().toISOString();
    this.db.run("INSERT OR IGNORE INTO conversations (conversation_id, project_id, title, state, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)", conversationId, projectId, title, now, now);
    return this.get(conversationId)!;
  }
  get(id: string): Conversation | null { return this.db.query("SELECT * FROM conversations WHERE conversation_id = ?").get(id) as Conversation | null; }
  list(projectId: string): Conversation[] { return this.db.query("SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) as Conversation[]; }
  /** Records the session a turn ran on. A different session (a recreated one, or another runtime)
   * moves the previous one into `session_history` with `reason`; the same session only advances
   * `last_turn_at`. */
  setSession(conversationId: string, input: { sessionId: string; runtime: string; reason?: string }): Conversation {
    const current = this.get(conversationId);
    if (!current) throw new Error("conversation not found");
    const now = new Date().toISOString();
    const changed = current.session_id !== input.sessionId || current.session_runtime !== input.runtime;
    let history = current.session_history;
    if (changed && current.session_id && current.session_runtime) {
      const records: SessionRecord[] = (() => { try { return JSON.parse(history ?? "[]"); } catch { return []; } })();
      records.push({ session_id: current.session_id, session_runtime: current.session_runtime, started_at: current.session_started_at, ended_at: now, reason: input.reason ?? "replaced" });
      history = JSON.stringify(records);
    }
    this.db.run("UPDATE conversations SET session_id = ?, session_runtime = ?, session_started_at = ?, last_turn_at = ?, session_history = ?, updated_at = ? WHERE conversation_id = ?",
      input.sessionId, input.runtime, changed ? now : current.session_started_at ?? now, now, history, now, conversationId);
    return this.get(conversationId)!;
  }
  append(input: { conversationId: string; projectId: string; role: Message["role"]; content: string; runId?: string; messageId?: string }): Message {
    const conversation = this.get(input.conversationId);
    if (!conversation || conversation.project_id !== input.projectId) throw new Error("conversation does not belong to project");
    if (!input.content.trim()) throw new Error("message content is required");
    if (!["user", "assistant", "system"].includes(input.role)) throw new Error("invalid visible message role");
    if (input.messageId) {
      const existing = this.db.query("SELECT * FROM conversation_messages WHERE message_id = ?").get(input.messageId) as Message | null;
      if (existing) {
        if (existing.conversation_id !== input.conversationId || existing.project_id !== input.projectId || existing.role !== input.role || existing.content !== input.content) {
          throw new Error("message identity conflict");
        }
        return existing;
      }
    }
    const createdAt = new Date().toISOString();
    return this.db.transaction(() => {
      const row = this.db.query("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM conversation_messages WHERE conversation_id = ?").get(input.conversationId) as { next: number };
      const message: Message = { message_id: input.messageId || `msg_${randomUUID()}`, conversation_id: input.conversationId, project_id: input.projectId, ...(input.runId ? { run_id: input.runId } : {}), role: input.role, content: input.content, created_at: createdAt, sequence: row.next };
      this.db.run("INSERT INTO conversation_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)", message.message_id, message.conversation_id, message.project_id, message.run_id || null, message.role, message.content, message.created_at, message.sequence);
      this.db.run("UPDATE conversations SET updated_at = ?, title = CASE WHEN title = 'Nova conversa' AND ? = 'user' THEN substr(?, 1, 80) ELSE title END WHERE conversation_id = ?", createdAt, input.role, input.content, input.conversationId);
      return message;
    })();
  }
  messages(conversationId: string): Message[] { return this.db.query("SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY sequence").all(conversationId) as Message[]; }
  messageForRun(projectId: string, runId: string): Message | null {
    return this.db.query("SELECT * FROM conversation_messages WHERE project_id = ? AND run_id = ? ORDER BY sequence LIMIT 1").get(projectId, runId) as Message | null;
  }
  linkRun(messageId: string, projectId: string, runId: string): Message {
    const result = this.db.run("UPDATE conversation_messages SET run_id = ? WHERE message_id = ? AND project_id = ? AND run_id IS NULL", runId, messageId, projectId);
    if (result.changes !== 1) {
      const existing = this.db.query("SELECT * FROM conversation_messages WHERE message_id = ? AND project_id = ?").get(messageId, projectId) as Message | null;
      if (!existing || existing.run_id !== runId) throw new Error("message cannot be linked to run");
      return existing;
    }
    return this.db.query("SELECT * FROM conversation_messages WHERE message_id = ?").get(messageId) as Message;
  }
}
