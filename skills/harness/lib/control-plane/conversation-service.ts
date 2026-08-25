import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface Conversation { conversation_id: string; project_id: string; title: string; state: "active" | "archived"; created_at: string; updated_at: string }
export interface Message { message_id: string; conversation_id: string; project_id: string; run_id?: string; role: "user" | "assistant" | "system"; content: string; created_at: string; sequence: number }

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
  }
  close(): void { this.db.close(); }
  create(projectId: string, title = "Nova conversa", conversationId = `cnv_${randomUUID()}`): Conversation {
    const now = new Date().toISOString();
    this.db.run("INSERT OR IGNORE INTO conversations VALUES (?, ?, ?, 'active', ?, ?)", conversationId, projectId, title, now, now);
    return this.get(conversationId)!;
  }
  get(id: string): Conversation | null { return this.db.query("SELECT * FROM conversations WHERE conversation_id = ?").get(id) as Conversation | null; }
  list(projectId: string): Conversation[] { return this.db.query("SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) as Conversation[]; }
  append(input: { conversationId: string; projectId: string; role: Message["role"]; content: string; runId?: string; messageId?: string }): Message {
    const conversation = this.get(input.conversationId);
    if (!conversation || conversation.project_id !== input.projectId) throw new Error("conversation does not belong to project");
    if (!input.content.trim()) throw new Error("message content is required");
    if (!["user", "assistant", "system"].includes(input.role)) throw new Error("invalid visible message role");
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
}
