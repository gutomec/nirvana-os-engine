#!/usr/bin/env bun
/**
 * audit-emit-from-hermes-hook.ts — bridge between Hermes Agent shell hooks
 * (pre_tool_call / post_tool_call) and the harness audit log.
 *
 * Hermes hooks speak a different wire protocol than Claude Code / Codex:
 * the payload tool names are `terminal` (shell), `write_file` and `patch`
 * (`file` is the name of their toolset, not of a tool), not `Bash`/`Write`/`Edit`. This shim reads the Hermes envelope on stdin,
 * normalizes it to the Claude Code hook contract, and delegates to the canonical
 * audit-emit-from-hook.ts (3rd arg "hermes-cli" → host:"hermes-cli-hook"), which
 * already owns the Nirvana-scope filter and the audit append.
 *
 * Hermes payload (agent/shell_hooks.py :_serialize_payload):
 *   { "hook_event_name": "pre_tool_call"|"post_tool_call",
 *     "tool_name": "terminal"|"write_file"|"patch"|...,
 *     "tool_input": { "command": "..." } | { "path": "...", "content": "..." }
 *                 | { "mode": "replace", "path": "...", ... } | { "mode": "patch", "patch": "..." },
 *     "session_id": "...", "cwd": "...", "profile": "..." (0.23),
 *     "extra": { "status": "ok"|"error"|"blocked", "result": "<string>", ... } }
 * Checked against the serializer of the installed 0.20.5 and read at v0.23.4.
 *
 * GOLDEN RULE: this script MUST keep stdout empty and exit 0 — Hermes blocks the
 * tool if the hook prints something that parses as {"action":"block"} / a non-zero
 * exit. We only observe; we never decide.
 *
 * Usage (wired into ~/.hermes/config.yaml by scripts/install.ts):
 *   bun audit-emit-from-hermes-hook.ts pre
 *   bun audit-emit-from-hermes-hook.ts post
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));

const stage = (process.argv[2] || "pre").toLowerCase(); // "pre" | "post"
const TARGET = path.join(SKILLS_ROOT, "_shared", "scripts", "audit-emit-from-hook.ts");

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => (buf += c));
      process.stdin.on("end", () => resolve(buf));
    } catch {
      resolve(buf);
    }
    // Stdin not piped: resolve fast so the hook never hangs the tool.
    setTimeout(() => resolve(buf), 500);
  });
}

(async () => {
  try {
    const raw = await readStdin();
    if (raw.trim()) {
      const p: any = JSON.parse(raw);
      const tool = String(p.tool_name || "");
      const ti: any =
        p.tool_input && typeof p.tool_input === "object" ? p.tool_input
        : p.args && typeof p.args === "object" ? p.args
        : {};

      // Normalize Hermes tool names → Claude Code contract so the canonical
      // script's writeTools/bashTools sets (Write/Edit/Bash) match.
      let mapped: Record<string, any> | null = null;

      if (tool === "terminal" || tool === "shell" || tool === "bash") {
        if (ti.command) {
          mapped = { tool_name: "Bash", tool_input: { command: ti.command }, session_id: p.session_id };
        }
      } else if (tool === "file" || tool === "write_file" || tool === "patch" || tool === "edit_file" || tool === "fs") {
        // `patch` in its V4A mode names its files inside the patch text, not in `path`.
        const inPatch = typeof ti.patch === "string" ? /^\*\*\* (?:Update|Add|Delete) File:\s*(.+?)\s*$/m.exec(ti.patch)?.[1] : undefined;
        const fp = ti.path || ti.file_path || ti.filename || ti.filepath || ti.target || inPatch;
        if (fp) {
          const op = String(ti.operation || ti.mode || ti.action || "").toLowerCase();
          const isEdit = tool === "patch" || op.includes("edit") || op.includes("patch") || op.includes("append") || op.includes("replace") || op.includes("insert");
          mapped = { tool_name: isEdit ? "Edit" : "Write", tool_input: { file_path: fp }, session_id: p.session_id };
        }
      }

      if (mapped) {
        // PostToolUse: pass any result through so success/exit can be recorded.
        // Hermes puts the outcome under `extra`: `status` is "ok", "error" or "blocked".
        if (stage === "post") {
          const res = p.tool_result || p.result || p.tool_response;
          const status = p.extra && typeof p.extra === "object" ? p.extra.status : undefined;
          if (res && typeof res === "object") mapped.tool_response = res;
          else if (typeof status === "string") mapped.tool_response = { success: status === "ok" };
        }
        spawnSync(process.execPath, [TARGET, stage, "hermes-cli"], {
          windowsHide: true,
          input: JSON.stringify(mapped),
          cwd: p.cwd || process.cwd(), // inherit so inNirvanaScope(cwd) sees the project
          stdio: ["pipe", "ignore", "ignore"],
          timeout: 4000,
        });
      }
    }
  } catch {
    /* never propagate — observing only */
  }
  // stdout stays empty ⇒ Hermes _parse_response = None ⇒ tool is NOT blocked.
  process.exit(0);
})();
