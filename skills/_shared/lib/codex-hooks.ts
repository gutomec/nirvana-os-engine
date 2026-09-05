// codex-hooks.ts — Codex hooks the engine can install ALREADY TRUSTED.
//
// Codex runs a hook only after the user reviews it: the TUI records a hash of
// the normalized hook definition under `[hooks.state."<file>:<event>:<g>:<h>"]
// trusted_hash` in config.toml, and an unreviewed hook is skipped in silence —
// `codex exec` says nothing, the hook simply never fires (measured 2026-09-05:
// zero payloads without trust, five with it). So an installer that only writes
// hooks.json installs nothing a headless run can use.
//
// The hash is reproducible. From codex-rs (0.153): `hook_hash` builds an
// identity `{ event_name: <label>, matcher?, hooks: [<normalized handler>] }`,
// turns it into a TOML value, then `version_for_toml` re-serializes it as
// canonical JSON (keys sorted recursively, compact) and takes SHA-256, prefixed
// `sha256:`. The normalized command handler carries `type`, `command` (the
// string as written, before env substitution), `timeout` (as written, else
// 600; SessionEnd/Interrupt default lower), `async` (as written, false when
// absent), plus `statusMessage` / `additionalContextLimit` only when set;
// `commandWindows` never survives normalization. Verified against a hash Codex
// itself had recorded on a live machine before this file existed.
//
// With that, `nrv install` writes our hooks AND the trust record the TUI would
// have written, and `nrv install --uninstall` removes both.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const CODEX_HOOK_EVENT_LABEL: Record<string, string> = {
  PreToolUse: "pre_tool_use",
  PermissionRequest: "permission_request",
  PostToolUse: "post_tool_use",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  SessionStart: "session_start",
  SessionEnd: "session_end",
  UserPromptSubmit: "user_prompt_submit",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  Stop: "stop",
  Interrupt: "interrupt",
};

export interface CodexCommandHook {
  type: "command";
  command: string;
  commandWindows?: string;
  timeout?: number;
  async?: boolean;
  statusMessage?: string;
  additionalContextLimit?: number;
  [extra: string]: unknown;
}

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}
export function codexHooksPath(): string { return path.join(codexHome(), "hooks.json"); }
export function codexConfigPath(): string { return path.join(codexHome(), "config.toml"); }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) out[k] = canonical((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

/** The trust hash Codex computes for one command handler in one matcher group. */
export function codexHookHash(eventName: string, matcher: string | undefined, handler: CodexCommandHook, platform = process.platform): string {
  const label = CODEX_HOOK_EVENT_LABEL[eventName];
  if (!label) throw new Error(`unknown Codex hook event: ${eventName}`);
  const command = platform === "win32" && typeof handler.commandWindows === "string" ? handler.commandWindows : handler.command;
  const sessionEndLike = eventName === "SessionEnd" || eventName === "Interrupt";
  const timeout = typeof handler.timeout === "number"
    ? (sessionEndLike ? Math.min(Math.max(handler.timeout, 1), 30) : Math.max(handler.timeout, 1))
    : (sessionEndLike ? 1 : 600);
  const normalized: Record<string, unknown> = { type: "command", command, timeout, async: handler.async === true };
  if (typeof handler.statusMessage === "string") normalized.statusMessage = handler.statusMessage;
  const acceptsContext = ["PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "SubagentStart"].includes(eventName);
  if (acceptsContext && typeof handler.additionalContextLimit === "number") normalized.additionalContextLimit = handler.additionalContextLimit;
  const identity: Record<string, unknown> = { event_name: label, hooks: [normalized] };
  if (typeof matcher === "string" && matcher.length > 0) identity.matcher = matcher;
  const bytes = JSON.stringify(canonical(identity));
  return "sha256:" + createHash("sha256").update(bytes, "utf8").digest("hex");
}

/** `<hooks.json path>:<event label>:<group index>:<handler index>` — the key `[hooks.state."…"]` uses. */
export function codexHookStateKey(hooksFile: string, eventName: string, groupIndex: number, handlerIndex: number): string {
  return `${hooksFile}:${CODEX_HOOK_EVENT_LABEL[eventName]}:${groupIndex}:${handlerIndex}`;
}

function tomlEscape(s: string): string { return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
function tomlUnescape(s: string): string { return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\"); }

/** Every `[hooks.state."key"]` block in a config.toml, key → { trusted_hash?, enabled? }. */
export function readCodexHookState(configFile: string): Map<string, { trusted_hash?: string; enabled?: boolean }> {
  const out = new Map<string, { trusted_hash?: string; enabled?: boolean }>();
  let raw: string;
  try { raw = fs.readFileSync(configFile, "utf8"); } catch { return out; }
  const re = /^\[hooks\.state\."((?:[^"\\]|\\.)*)"\]\s*\n((?:(?!^\[).*\n?)*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const key = tomlUnescape(m[1]);
    const body = m[2] || "";
    const entry: { trusted_hash?: string; enabled?: boolean } = {};
    const h = body.match(/^\s*trusted_hash\s*=\s*"([^"]*)"/m); if (h) entry.trusted_hash = h[1];
    const e = body.match(/^\s*enabled\s*=\s*(true|false)/m); if (e) entry.enabled = e[1] === "true";
    out.set(key, entry);
  }
  return out;
}

/**
 * Record trust for `key` exactly as the TUI does. Replaces the block when the
 * hash changed (a command path moved), appends when absent, leaves every other
 * byte of config.toml alone. Returns whether the file changed.
 */
export function upsertCodexHookTrust(configFile: string, key: string, hash: string): boolean {
  let raw = "";
  try { raw = fs.readFileSync(configFile, "utf8"); } catch { /* new file */ }
  const header = `[hooks.state."${tomlEscape(key)}"]`;
  const block = `${header}\ntrusted_hash = "${hash}"\n`;
  const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escapedHeader}\\s*\\n((?:(?!^\\[).*\\n?)*)`, "m");
  const m = raw.match(re);
  let next: string;
  if (m) {
    if (new RegExp(`^\\s*trusted_hash\\s*=\\s*"${hash}"`, "m").test(m[1] || "")) return false;
    const body = (m[1] || "").replace(/^\s*trusted_hash\s*=.*\n?/m, "");
    next = raw.replace(re, `${header}\ntrusted_hash = "${hash}"\n${body}`);
  } else {
    next = raw.replace(/\s*$/, "") + (raw.trim() ? "\n\n" : "") + block;
  }
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, next, "utf8");
  return true;
}

/** Remove the `[hooks.state."key"]` blocks for `keys`. Returns whether the file changed. */
export function removeCodexHookTrust(configFile: string, keys: string[]): boolean {
  let raw: string;
  try { raw = fs.readFileSync(configFile, "utf8"); } catch { return false; }
  let next = raw;
  for (const key of keys) {
    const header = `[hooks.state."${tomlEscape(key)}"]`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    next = next.replace(new RegExp(`\\n*^${header}\\s*\\n((?:(?!^\\[).*\\n?)*)`, "m"), "\n");
  }
  if (next === raw) return false;
  fs.writeFileSync(configFile, next.replace(/\n{3,}/g, "\n\n"), "utf8");
  return true;
}

export interface CodexHookTrustEntry { key: string; event: string; hash: string; trusted: boolean; }

/**
 * Our handlers in a hooks.json (matched by `token` in the command), each with
 * the trust record it needs and whether config.toml already carries it.
 */
export function codexHookTrustEntries(hooksFile: string, configFile: string, token: string): CodexHookTrustEntry[] {
  let doc: any;
  try { doc = JSON.parse(fs.readFileSync(hooksFile, "utf8")); } catch { return []; }
  const state = readCodexHookState(configFile);
  const out: CodexHookTrustEntry[] = [];
  for (const [event, groups] of Object.entries(doc?.hooks ?? {})) {
    if (!Array.isArray(groups) || !CODEX_HOOK_EVENT_LABEL[event]) continue;
    groups.forEach((group: any, gi: number) => {
      (group?.hooks ?? []).forEach((handler: any, hi: number) => {
        if (handler?.type !== "command" || typeof handler.command !== "string" || !handler.command.includes(token)) return;
        const hash = codexHookHash(event, typeof group.matcher === "string" ? group.matcher : undefined, handler);
        const key = codexHookStateKey(hooksFile, event, gi, hi);
        out.push({ key, event, hash, trusted: state.get(key)?.trusted_hash === hash });
      });
    });
  }
  return out;
}
