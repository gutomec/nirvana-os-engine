// session-capture.ts — the session id of a run, read where the runtime keeps it.
//
// `nrv revise` and every correction round continue the worker's own
// conversation, which needs its id. Most CLIs take an id from the caller
// (claude, grok and pi `--session-id`, kimi `--session`), so the driver picks
// one before the run and never has to read it back. Two cannot:
//
//   codex   the id is the thread's. Headless runs print it on the `--json`
//           stream (`thread.started.thread_id`); an interactive worker prints
//           nothing the engine reads, but codex writes every session to
//           `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`, whose first line
//           is `{"type":"session_meta","payload":{"id","cwd","timestamp"}}`
//           (codex-cli 0.162.1, read 2026-10-15). The newest session started
//           in the worker's own folder after the worker started is the one.
//   agy     headless runs print `conversation_id` in the stream-json events.
//           An interactive worker records each prompt in
//           `~/.gemini/antigravity-cli/history.jsonl` as
//           `{"display","timestamp","workspace","conversationId"}` (agy 1.3.5,
//           read 2026-10-15). The last entry for the worker's folder after it
//           started names the conversation.
//
// A worker runs in its own run folder (run-workspace.ts), so "this folder,
// after this moment" is one session. Every reader is best-effort: a file that
// is missing or unreadable gives null, and the run is recorded without an id,
// which `nrv revise` answers with a fresh, seeded session.
//
// The claude transcript (`<config>/projects/<cwd slug>/<id>.jsonl`) is read
// for two things: whether a session the driver named exists at all, and the
// token usage of an interactive worker, which reports no cost of its own.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Env = Record<string, string | undefined>;

function homeOf(env: Env): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/** Two spellings of one folder: resolved, real path when it exists, case-folded on Windows. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string) => {
    let r = path.resolve(p);
    try { r = fs.realpathSync.native(r); } catch { /* not on disk: the resolved form is all there is */ }
    return platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** Claude Code's config folder: CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeConfigDir(env: Env = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(homeOf(env), ".claude");
}

/** The transcript of a claude session, wherever its project folder is, or null. */
export function findClaudeTranscript(sessionId: string, env: Env = process.env): string | null {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return null;
  const projects = path.join(claudeConfigDir(env), "projects");
  let dirs: string[];
  try { dirs = fs.readdirSync(projects); } catch { return null; }
  for (const d of dirs) {
    const file = path.join(projects, d, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export interface TranscriptUsage {
  usage: { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
  model: string | null;
}

/** Token usage of the assistant turns written to a claude transcript at or
 *  after `sinceMs`, each message counted once (a message with several content
 *  blocks is written on several lines with the same id and usage). Null when
 *  the file has no such turn. */
export function claudeTranscriptUsage(file: string, sinceMs: number): TranscriptUsage | null {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  const seen = new Set<string>();
  const usage = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  let model: string | null = null;
  let turns = 0;
  for (const line of text.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let j: any;
    try { j = JSON.parse(line); } catch { continue; }
    if (j?.type !== "assistant" || !j.message?.usage) continue;
    const at = Date.parse(j.timestamp ?? "");
    if (Number.isFinite(at) && at < sinceMs) continue;
    const id = j.message.id ?? j.uuid;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const u = j.message.usage;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const cacheRead = n(u.cache_read_input_tokens);
    const cacheWrite = n(u.cache_creation_input_tokens);
    usage.inputTokens += n(u.input_tokens) + cacheRead + cacheWrite;
    usage.cachedInputTokens += cacheRead;
    usage.cacheWriteInputTokens += cacheWrite;
    usage.outputTokens += n(u.output_tokens);
    usage.reasoningOutputTokens += n(u.output_tokens_details?.thinking_tokens);
    if (typeof j.message.model === "string" && j.message.model) model = j.message.model;
    turns++;
  }
  return turns ? { usage, model } : null;
}

/** The days a session started between `sinceMs` and now can be filed under,
 *  in local time and in UTC (codex names the folder by the local date). */
function dayFolders(sinceMs: number, nowMs: number): string[] {
  const out = new Set<string>();
  const pad = (n: number) => String(n).padStart(2, "0");
  for (let t = sinceMs - 86_400_000; t <= nowMs + 86_400_000; t += 86_400_000) {
    const d = new Date(t);
    out.add(path.join(String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
    out.add(path.join(String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())));
  }
  return [...out];
}

function firstLine(file: string, max = 256 * 1024): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    const s = buf.subarray(0, n).toString("utf8");
    const i = s.indexOf("\n");
    return i >= 0 ? s.slice(0, i) : s;
  } catch { return ""; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } } }
}

/** Seconds of clock skew tolerated between the engine and the CLI's timestamp. */
const SKEW_MS = 5_000;

/** The codex session started in `cwd` at or after `sinceMs`, newest first, or null. */
export function codexSessionFor(cwd: string, sinceMs: number, env: Env = process.env, nowMs: number = Date.now()): string | null {
  const root = path.join(env.CODEX_HOME || path.join(homeOf(env), ".codex"), "sessions");
  let best: { id: string; at: number } | null = null;
  for (const day of dayFolders(sinceMs, nowMs)) {
    let files: string[];
    try { files = fs.readdirSync(path.join(root, day)).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const file = path.join(root, day, f);
      try { if (fs.statSync(file).mtimeMs < sinceMs - SKEW_MS) continue; } catch { continue; }
      let meta: any;
      try { meta = JSON.parse(firstLine(file)); } catch { continue; }
      const p = meta?.type === "session_meta" ? meta.payload : null;
      const id = p?.id || p?.session_id;
      if (typeof id !== "string" || !id || typeof p?.cwd !== "string" || !samePath(p.cwd, cwd)) continue;
      const at = Date.parse(p.timestamp ?? meta.timestamp ?? "");
      if (!Number.isFinite(at) || at < sinceMs - SKEW_MS) continue;
      if (!best || at > best.at) best = { id, at };
    }
  }
  return best?.id ?? null;
}

/** The agy conversation a prompt in `cwd` went to at or after `sinceMs`, or null. */
export function agyConversationFor(cwd: string, sinceMs: number, env: Env = process.env): string | null {
  const file = path.join(homeOf(env), ".gemini", "antigravity-cli", "history.jsonl");
  let text: string;
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    try {
      const len = Math.min(size, 2 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  let found: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes("conversationId")) continue;
    let j: any;
    try { j = JSON.parse(line); } catch { continue; }
    if (typeof j?.conversationId !== "string" || !j.conversationId) continue;
    if (typeof j.timestamp !== "number" || j.timestamp < sinceMs - SKEW_MS) continue;
    if (typeof j.workspace !== "string" || !samePath(j.workspace, cwd)) continue;
    found = j.conversationId;
  }
  return found;
}

/** True when a run's error says the session it was asked to resume does not
 *  exist (pruned, deleted, made in another folder): claude "No conversation
 *  found with session ID", codex "no rollout found" / "thread not found", grok
 *  and others "session ... not found". A spent quota or a model error is not
 *  this, and must not start a fresh session. */
export function looksLikeMissingSession(text: string | null | undefined): boolean {
  const t = String(text ?? "");
  return /no (conversation|session|thread|rollout)s? found|(conversation|session|thread|rollout)\b[^\n]{0,80}\bnot found|unknown (session|conversation|thread)|(session|conversation)[^\n]{0,40}does not exist/i.test(t);
}
