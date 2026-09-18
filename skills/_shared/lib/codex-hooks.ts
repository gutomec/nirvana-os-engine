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
import { isDeepStrictEqual } from "node:util";

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
type TomlDocument = Record<string, any>;

function parseToml(raw: string, configFile: string): TomlDocument {
  if (!raw.trim()) return {};
  try { return Bun.TOML.parse(raw) as TomlDocument; }
  catch (error) { throw new Error(`refusing to modify invalid TOML at ${configFile}: ${(error as Error).message}`); }
}

function stateFrom(doc: TomlDocument): Record<string, any> {
  const hooks = doc.hooks;
  if (!hooks || typeof hooks !== "object") return {};
  const state = hooks.state;
  return state && typeof state === "object" ? state : {};
}

function sameToml(a: TomlDocument, b: TomlDocument): boolean {
  return isDeepStrictEqual(a, b);
}

function expectedWithTrust(doc: TomlDocument, key: string, hash: string): TomlDocument {
  const expected = structuredClone(doc);
  if (!expected.hooks || typeof expected.hooks !== "object") expected.hooks = {};
  if (!expected.hooks.state || typeof expected.hooks.state !== "object") expected.hooks.state = {};
  if (!expected.hooks.state[key] || typeof expected.hooks.state[key] !== "object") expected.hooks.state[key] = {};
  expected.hooks.state[key].trusted_hash = hash;
  return expected;
}

function expectedWithoutTrust(doc: TomlDocument, keys: string[]): TomlDocument {
  const expected = structuredClone(doc);
  const state = stateFrom(expected);
  for (const key of keys) delete state[key];
  if (expected.hooks && typeof expected.hooks === "object" && expected.hooks.state && Object.keys(expected.hooks.state).length === 0) delete expected.hooks.state;
  if (expected.hooks && typeof expected.hooks === "object" && Object.keys(expected.hooks).length === 0) delete expected.hooks;
  return expected;
}

interface TableSpan { start: number; end: number; headerEnd: number; }

/** Locate a simple hooks.state table header outside multiline TOML strings. */
function findStateTable(raw: string, key: string): TableSpan | null {
  const lines = raw.split(/(?<=\n)/);
  let offset = 0;
  let inMultiline: "'''" | '\"\"\"' | null = null;
  const tables: Array<{ key?: string; start: number; headerEnd: number }> = [];
  for (const line of lines) {
    const code = inMultiline ? "" : line;
    if (!inMultiline) {
      const m = code.match(/^\s*\[\s*hooks\s*\.\s*state\s*\.\s*((?:"(?:[^"\\]|\\.)*")|(?:'(?:''|[^'])*'))\s*\]\s*(?:#.*)?(?:\r?\n)?$/);
      if (m) {
        try {
          const value = Bun.TOML.parse(`value = ${m[1]}`) as { value?: unknown };
          if (typeof value.value === "string") tables.push({ key: value.value, start: offset, headerEnd: offset + line.length });
        } catch { /* candidate validation below fails closed if a header is exotic */ }
      } else if (/^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?(?:\r?\n)?$/.test(code)) {
        tables.push({ start: offset, headerEnd: offset + line.length });
      }
    }
    // Table-like text inside a multiline string must never be treated as a header.
    const marker = inMultiline || (line.includes('"""') ? '"""' : line.includes("'''") ? "'''" : null);
    if (marker) {
      const count = line.split(marker).length - 1;
      if (count % 2 === 1) inMultiline = inMultiline === marker ? null : marker;
    }
    offset += line.length;
  }
  const index = tables.findIndex((h) => h.key === key);
  if (index < 0) return null;
  return { start: tables[index].start, headerEnd: tables[index].headerEnd, end: index + 1 < tables.length ? tables[index + 1].start : raw.length };
}

function replaceTrustHash(raw: string, span: TableSpan, hash: string): string {
  const body = raw.slice(span.headerEnd, span.end);
  const withoutHash = body.replace(/^\s*trusted_hash\s*=.*(?:\r?\n|$)/m, "");
  const header = raw.slice(span.start, span.headerEnd);
  const newline = header.includes("\r\n") ? "\r\n" : "\n";
  return raw.slice(0, span.start) + header + `trusted_hash = "${hash}"${newline}` + withoutHash + raw.slice(span.end);
}

function publishToml(configFile: string, existed: boolean, raw: string, next: string, expected: TomlDocument): void {
  const dir = path.dirname(configFile);
  fs.mkdirSync(dir, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temp = path.join(dir, `.${path.basename(configFile)}.nirvana-${nonce}.tmp`);
  const mode = existed ? fs.statSync(configFile).mode : 0o600;
  try {
    fs.writeFileSync(temp, next, { encoding: "utf8", flag: "wx" });
    fs.chmodSync(temp, mode);
    const candidate = parseToml(fs.readFileSync(temp, "utf8"), configFile);
    if (!sameToml(candidate, expected)) throw new Error(`refusing a TOML edit whose semantics exceed the requested hook trust update at ${configFile}`);
    const unchanged = fs.existsSync(configFile) === existed && (!existed || fs.readFileSync(configFile, "utf8") === raw);
    if (!unchanged) throw new Error(`refusing to replace ${configFile}: it changed while the candidate was prepared`);
    if (existed) fs.copyFileSync(configFile, `${configFile}.nirvana-backup.${nonce}`, fs.constants.COPYFILE_EXCL);
    const stillUnchanged = fs.existsSync(configFile) === existed && (!existed || fs.readFileSync(configFile, "utf8") === raw);
    if (!stillUnchanged) throw new Error(`refusing to replace ${configFile}: it changed while the backup was prepared`);
    fs.renameSync(temp, configFile);
    if (!sameToml(parseToml(fs.readFileSync(configFile, "utf8"), configFile), expected)) throw new Error(`TOML readback validation failed for ${configFile}`);
  } finally {
    try { if (fs.existsSync(temp)) fs.rmSync(temp); } catch { /* preserve the original failure */ }
  }
}

/** Every `[hooks.state."key"]` block in a config.toml, key → { trusted_hash?, enabled? }. */
export function readCodexHookState(configFile: string): Map<string, { trusted_hash?: string; enabled?: boolean }> {
  const out = new Map<string, { trusted_hash?: string; enabled?: boolean }>();
  try {
    const state = stateFrom(parseToml(fs.readFileSync(configFile, "utf8"), configFile));
    for (const [key, value] of Object.entries(state)) {
      if (!value || typeof value !== "object") continue;
      const entry: { trusted_hash?: string; enabled?: boolean } = {};
      if (typeof value.trusted_hash === "string") entry.trusted_hash = value.trusted_hash;
      if (typeof value.enabled === "boolean") entry.enabled = value.enabled;
      out.set(key, entry);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw error;
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
  let existed = true;
  try { raw = fs.readFileSync(configFile, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; existed = false; }
  const before = parseToml(raw, configFile);
  if (stateFrom(before)[key]?.trusted_hash === hash) return false;
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const header = `[hooks.state."${tomlEscape(key)}"]`;
  const block = `${header}${newline}trusted_hash = "${hash}"${newline}`;
  const span = findStateTable(raw, key);
  const separator = raw ? (raw.endsWith("\n") ? newline : `${newline}${newline}`) : "";
  const next = span ? replaceTrustHash(raw, span, hash) : raw + separator + block;
  publishToml(configFile, existed, raw, next, expectedWithTrust(before, key, hash));
  return true;
}

/** Remove the `[hooks.state."key"]` blocks for `keys`. Returns whether the file changed. */
export function removeCodexHookTrust(configFile: string, keys: string[]): boolean {
  let raw: string;
  try { raw = fs.readFileSync(configFile, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  const before = parseToml(raw, configFile);
  let next = raw;
  for (const key of keys) {
    const span = findStateTable(next, key);
    if (span) next = next.slice(0, span.start) + next.slice(span.end);
  }
  if (next === raw) return false;
  publishToml(configFile, true, raw, next, expectedWithoutTrust(before, keys));
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
