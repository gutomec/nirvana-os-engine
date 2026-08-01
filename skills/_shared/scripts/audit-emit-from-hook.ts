#!/usr/bin/env bun
/**
 * audit-emit-from-hook.ts — bridge between Claude Code PreToolUse/PostToolUse
 * hooks and the harness audit log.
 *
 * Reads a JSON envelope on stdin (the hook payload Claude Code sends), maps
 * it to a harness audit event, and appends to ~/.harness-logs/<today>/audit.jsonl.
 *
 * The goal: every Write/Edit/Bash the agent performs leaves a trail in the
 * audit log so `nrv watch` and the Glance Projects view can see what's
 * happening — even when the agent doesn't voluntarily call audit.emit.
 *
 * Stdin payload (Claude Code hook contract):
 *   {
 *     "session_id": "...",
 *     "tool_name": "Write" | "Edit" | "Bash" | ...,
 *     "tool_input": { "file_path": "...", "content": "..." } | { "command": "..." },
 *     "tool_response"?: { "success": true, "filePath": "..." }      // PostToolUse only
 *   }
 *
 * Mapping (PreToolUse):
 *   Write file_path     → tool_invoked  (hint: "write")
 *   Edit file_path      → tool_invoked  (hint: "edit")
 *   Bash command        → tool_invoked  (hint: "bash")  // command truncated to 200 chars
 *
 * Mapping (PostToolUse):
 *   Write/Edit success  → artifact_touched  (path = filePath / file_path)
 *   Bash success        → bash_completed   (exit_code if available)
 *
 * Filtering: only emit when the touched path is inside a Nirvana project
 * (heuristic: cwd contains "/projects/" OR file_path starts with NIRVANA_PROJECT_ROOT).
 * Otherwise stays silent — we don't want every Edit anywhere flooding the log.
 *
 * Failure mode: never block the tool call. If anything goes wrong, exit 0
 * silently so the hook doesn't kill the agent's flow.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const HARNESS_LOGS_ROOT = process.env.HARNESS_LOGS_DIR
  ? path.resolve(process.env.HARNESS_LOGS_DIR)
  : path.join(os.homedir(), ".harness-logs");

const NIRVANA_PROJECT_ROOT = process.env.NIRVANA_PROJECT_ROOT || "";

function todayDir(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function appendEvent(ev: Record<string, any>): void {
  try {
    const dir = path.join(HARNESS_LOGS_ROOT, todayDir());
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "audit.jsonl");
    fs.appendFileSync(file, JSON.stringify(ev) + "\n", "utf8");
  } catch { /* never block */ }
}

// F7: identify the "target project" of a write — the topmost recognizable
// project dir in the file_path tree. Walks up from the file's dir until it
// finds a marker (.nirvana/, business.yaml, CLAUDE.md, .git, or matches a
// well-known top-level like nirvana-os-launch). Returns the basename of that
// dir, or undefined if no marker found.
function deriveTargetProject(filePath: string): string | undefined {
  let dir = path.dirname(filePath);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, ".nirvana"))) return path.basename(dir);
    if (fs.existsSync(path.join(dir, "business.yaml"))) return path.basename(dir);
    if (fs.existsSync(path.join(dir, "squad.yaml"))) return path.basename(dir);
    if (fs.existsSync(path.join(dir, "CLAUDE.md"))) return path.basename(dir);
    if (fs.existsSync(path.join(dir, ".git"))) return path.basename(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: 1st level under HOME
  const home = os.homedir();
  if (filePath.startsWith(home + "/")) {
    const rel = filePath.slice(home.length + 1);
    const firstSeg = rel.split("/")[0];
    if (firstSeg) return firstSeg;
  }
  return undefined;
}

function inNirvanaScope(p: string | undefined): boolean {
  if (!p) return false;
  const lower = p.toLowerCase();
  // 1. Explicit override — user-defined project root always wins
  if (NIRVANA_PROJECT_ROOT && lower.startsWith(NIRVANA_PROJECT_ROOT.toLowerCase())) return true;
  // 2. Extra prefixes from env (colon-separated, like PATH)
  const extras = (process.env.NIRVANA_AUDIT_PREFIXES || "")
    .split(":").map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const pre of extras) if (lower.startsWith(pre) || lower.includes(pre)) return true;
  // 3. Built-in heuristics: anything that smells like Nirvana work
  if (lower.includes("/projects/")) return true;
  if (lower.includes("/businesses/") || lower.includes("/squads/")) return true;
  if (lower.includes("/mind-clones/") || lower.includes("/mind_clones/")) return true;
  if (lower.includes(".nirvana/") || lower.includes("/.harness-logs/")) return true;
  // Harness / skills surface (so meta-work on the OS itself shows up too)
  if (lower.includes("/.claude/skills/") || lower.includes("/.codex/skills/")) return true;
  if (lower.includes("/nirvana-os/") || lower.includes("/squads-legacy")) return true;
  if (lower.includes("/harness/lib/") || lower.includes("/harness/scripts/")) return true;
  // Launches and outputs produced by Nirvana (nirvana-os-launch, nirvana-*-launch, *-nirvana, etc.)
  if (lower.includes("nirvana-os-launch") || lower.includes("/nirvana-") || lower.includes("-nirvana/")) return true;
  return false;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => buf += c);
    process.stdin.on("end", () => resolve(buf));
    // Stdin not piped: timeout fast so the hook returns
    setTimeout(() => resolve(buf), 500);
  });
}

async function main() {
  const stage = (process.argv[2] || "").toLowerCase(); // "pre" | "post"
  // Optional 3rd arg: agent identifier (claude-code | gemini-cli | codex). Defaults to claude-code-hook.
  const agentArg = (process.argv[3] || "claude-code").toLowerCase();
  const hostLabel = agentArg.includes("hermes") ? "hermes-cli-hook"
                  : agentArg.includes("gemini") ? "gemini-cli-hook"
                  : agentArg.includes("codex") ? "codex-hook"
                  : "claude-code-hook";
  const raw = await readStdin();
  if (!raw.trim()) { process.exit(0); }

  let payload: any;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }

  const tool = payload.tool_name || "";
  const input = payload.tool_input || {};
  const response = payload.tool_response || {};

  const filePath: string | undefined = input.file_path || input.filePath || response.filePath || response.file_path;
  const command: string | undefined = input.command;

  // Decide if we should record
  const cwd = process.cwd();
  const interesting = inNirvanaScope(filePath) || inNirvanaScope(cwd);
  if (!interesting) { process.exit(0); }

  // Best-effort trace_id: use session_id (Claude Code) so all events from one
  // session group together; falls back to a short stable hash of cwd+session.
  const traceId = (payload.session_id || "").slice(0, 36) || "no-session";

  const base: Record<string, any> = {
    ts: new Date().toISOString(),
    trace_id: traceId,
    host: hostLabel,
    stage,
    tool_name: tool,
  };
  if (process.env.NIRVANA_PROJECT_ID) base.project_id = process.env.NIRVANA_PROJECT_ID;
  if (cwd) base.cwd = cwd;

  // F7 fix: derive target_project from file_path (independent of cwd).
  // When the maestro writes to ~/nirvana-os-launch/ from ~/my-project/,
  // cwd ≠ target. nrv glance and audit-trace need both.
  if (filePath) {
    base.target_project = deriveTargetProject(filePath);
  }

  // Tool name mapping — Claude Code and Gemini-CLI use different names for the same operations.
  // Normalize to action types so the audit log is uniform regardless of agent.
  const writeTools = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "write_file", "replace"]);
  const bashTools = new Set(["Bash", "run_shell_command", "shell"]);

  if (writeTools.has(tool)) {
    const action = (tool === "Write" || tool === "write_file") ? "write" : "edit";
    if (stage === "pre") {
      appendEvent({ ...base, event: "tool_invoked", action, file_path: filePath });
    } else {
      appendEvent({ ...base, event: "artifact_touched", action, file_path: filePath, success: response.success !== false });
    }
  } else if (bashTools.has(tool)) {
    const cmdShort = (command || "").slice(0, 200);
    if (stage === "pre") {
      appendEvent({ ...base, event: "tool_invoked", action: "bash", command: cmdShort });
    } else {
      appendEvent({ ...base, event: "bash_completed", command: cmdShort, success: response.success !== false });
    }
  }
  // Unknown tools: silent — we only care about ones that produce side effects.

  process.exit(0);
}

main().catch(() => process.exit(0)); // never block
