#!/usr/bin/env bun
/**
 * gemini-session-start.ts — Gemini-CLI SessionStart hook.
 *
 * Triggered when a new Gemini-CLI session begins. Reads the most recent
 * session-*.jsonl in the current project's chat dir, captures the first
 * user prompt, and emits a `brief_received` audit event so we have intent
 * captured even when the agent itself doesn't emit it.
 *
 * Stdin envelope (Gemini hook contract): a JSON object with at least
 * { session_id, project, ... }. We're tolerant if fields are missing.
 *
 * Strategy:
 *   1. Read stdin (Gemini hook payload). Parse session_id and project (cwd).
 *   2. If session_id is missing, fall back to ENV (GEMINI_SESSION_ID).
 *   3. Find ~/.gemini/tmp/<project-hash>/chats/session-<id>.jsonl  (Gemini's session dir).
 *   4. If no file yet (SessionStart fires before first user message), write a
 *      placeholder marker: emit `session_started` with cwd + session_id.
 *      The first BeforeTool hook will emit `brief_received` from the prompt
 *      preceding it (read via tail of session JSONL). For now, just announce.
 *
 * Failure mode: never block. Exit 0 silently on any error.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const HARNESS_LOGS_ROOT = process.env.HARNESS_LOGS_DIR
  ? path.resolve(process.env.HARNESS_LOGS_DIR)
  : path.join(os.homedir(), ".harness-logs");

function todayDir(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function appendEvent(ev: Record<string, any>): void {
  try {
    const dir = path.join(HARNESS_LOGS_ROOT, todayDir());
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify(ev) + "\n", "utf8");
  } catch { /* never block */ }
}

function readStdin(timeoutMs = 500): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => buf += c);
    process.stdin.on("end", () => resolve(buf));
    setTimeout(() => resolve(buf), timeoutMs);
  });
}

// Gemini stores chats under ~/.gemini/tmp/<projectHash>/chats/session-*.jsonl.
// projectHash is a slugified cwd. We search for the most recent session file
// matching the session_id, or fall back to most-recent overall.
function findSessionFile(sessionId: string | null, cwd: string): string | null {
  const root = path.join(os.homedir(), ".gemini", "tmp");
  if (!fs.existsSync(root)) return null;
  const candidates: string[] = [];
  for (const proj of fs.readdirSync(root)) {
    const chats = path.join(root, proj, "chats");
    if (!fs.existsSync(chats)) continue;
    for (const f of fs.readdirSync(chats)) {
      if (!f.startsWith("session-") || !f.endsWith(".jsonl")) continue;
      candidates.push(path.join(chats, f));
    }
  }
  if (!candidates.length) return null;
  // Filter by session_id if available
  if (sessionId) {
    const exact = candidates.find(p => p.includes(sessionId.slice(0, 8)));
    if (exact) return exact;
  }
  // Fall back to most recent
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] || null;
}

function extractFirstUserPrompt(jsonlPath: string): string | null {
  try {
    const lines = fs.readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const obj = JSON.parse(line);
      if (obj.type === "user" && Array.isArray(obj.content)) {
        const text = obj.content.map((c: any) => c?.text || "").filter(Boolean).join("\n");
        if (text.trim()) return text.slice(0, 2000);
      }
    }
  } catch { /* skip */ }
  return null;
}

async function main() {
  const raw = await readStdin();
  let payload: any = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch { /* tolerate empty/malformed */ }

  const sessionId = payload.session_id || process.env.GEMINI_SESSION_ID || null;
  const cwd = payload.cwd || process.env.PWD || process.cwd();
  const traceId = sessionId ? sessionId.slice(0, 36) : `gemini-${Date.now()}`;

  appendEvent({
    ts: new Date().toISOString(),
    trace_id: traceId,
    host: "gemini-cli-hook",
    event: "session_started",
    cwd,
  });

  // Try to extract the first user prompt from the session JSONL (if it already
  // has content — sometimes SessionStart fires before any messages, in which
  // case we'll emit brief_received later when an Edit/Write hook fires and
  // sees the prompt).
  const sessionFile = findSessionFile(sessionId, cwd);
  if (sessionFile) {
    const prompt = extractFirstUserPrompt(sessionFile);
    if (prompt) {
      appendEvent({
        ts: new Date().toISOString(),
        trace_id: traceId,
        host: "gemini-cli-hook",
        event: "brief_received",
        brief: prompt,
        cwd,
        session_file: sessionFile,
      });
    }
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
