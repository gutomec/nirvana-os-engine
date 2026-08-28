// audit-events.ts — the audit-event contract as squad and business CONTENT
// expresses it, and the one reader of the closed enum.
//
// Why this module exists. `scripts/check-audit-parity.ts` compares the enum,
// the harness docs and `emit()` literals across `skills/**/{lib,scripts}` —
// engine code. Squads and businesses are content, so the gate ran green while
// 285 event types (961 occurrences, 877 of them with no attribution at all)
// were emitted outside every rule. The rule those events break already exists
// and is not new here: `references/03-audit.md` declares the `x_` namespace
// open BY DESIGN, on the condition that the name carries the prefix and the
// event carries its author.
//
// What a file scan can and cannot see. Content is Markdown and YAML, so there
// is no `emit()` call to read: an event reaches the log because a *sentence*
// told an agent to write it. This module finds the five forms that name an
// event literally — the `nrv audit emit` command, an `audit.emit()` call in a
// script an entity ships, an `event=`/`event:` field, a `"event": "..."` JSON
// key, and a backticked name on a line that says "audit event". It cannot see
// an event an agent invents at run time with no literal anywhere on disk, and
// that gap is most of the 285: scanning the installed library and the pack
// sources finds emission sites in 3 squads, not in 285. The difference is not a
// bug in the scan; it is the measurement that says the contract never reached
// the author.
//
// Precision, and why the anchor is required. `event=veranico`, `event=geada`
// and `event=black_friday` are an agro calendar; `"event": "qr"` and
// `"event": "pairing_code"` are a WhatsApp library; `"event": "render_success"`
// belongs to a squad's own `render_audit.jsonl`. None of them is a harness
// audit event. So a field or JSON literal only counts when its ±3-line window
// names the harness audit sink, and `audit.jsonl` only anchors when no word
// character precedes it — otherwise `render_audit.jsonl` anchors its own file.

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/** The closed enum, from the one file that owns it. */
export function allowedEvents(): Set<string> {
  const audit = require_(path.join(import.meta.dir, "..", "..", "harness", "lib", "audit.js")) as { ALLOWED_EVENTS: Set<string> };
  return new Set(audit.ALLOWED_EVENTS);
}

/** An extension event: the open namespace `references/03-audit.md` declares. */
export function isExtension(event: string): boolean {
  return event.startsWith("x_");
}

/**
 * The keys and flags that name the author of an event.
 *
 * Both spellings, and the aliases are not a courtesy: measured over both audit
 * roots (176,198 events, 2026-08-28), the 961 rogue occurrences carry
 * `squad_name` 0 times and `squad` 63, `business_slug` 0 times and `business`
 * 22. Even across the closed enum `squad` (295) outnumbers `squad_name` (6) by
 * 49×. A checker that knew only the canonical keys would read 0% attribution
 * and be wrong about what the library does.
 */
export const ATTRIBUTION_KEYS = [
  "squad_name", "business_slug", "agent_or_employee",   // canonical (audit.js emit ctx)
  "squad", "business",                                  // aliases the library actually writes
] as const;

/** `--squad=x`, `--business=x`, `squad: x`, `"squad_name": "x"`, `squad=x`. */
const ATTRIBUTION_RE = new RegExp(`(?:--)?\\b(?:${ATTRIBUTION_KEYS.join("|")})\\b\\s*["']?\\s*[=:]`, "i");

/** Files that can carry an emission instruction. `.tmpl` covers the scaffolds. */
const TEXT_FILE = /\.(md|markdown|ya?ml|tmpl|txt|ts|js|mjs|cjs|py|sh)$/i;
/** Never scanned: run outputs, vendored code, and anything a build produced. */
const SKIP_DIR = new Set(["node_modules", ".git", "outputs", "dist", "build", "__pycache__", "venv", ".venv"]);

/** A snake_case identifier — the shape every audit event name has. */
const NAME = "[a-z][a-z0-9]*(?:_[a-z0-9]+)+";
/** Extension names, which may be a single segment after the prefix. */
const X_NAME = "x_[a-z0-9]+(?:_[a-z0-9]+)*";
const ANY_NAME = `(?:${X_NAME}|${NAME})`;

/**
 * The harness audit sink, named in the window around a literal. `audit.jsonl`
 * is guarded on the left so `render_audit.jsonl` — a squad's own log — never
 * anchors itself into the harness contract.
 */
const AUDIT_ANCHOR = /(?<![\w-])audit\.jsonl|\baudit events?\b|\beventos? de auditoria\b|\bnrv audit\b|harness-logs|\baudit trail\b|\btrilha de auditoria\b|audit\.emit|\baudit_event\b/i;
/**
 * What lets a bare backticked name count. Two readings, because the live
 * library writes both: a line that says "audit event" / "evento de auditoria"
 * qualifies every name on it (`Emita os eventos de auditoria: \`a\`, \`b\`, \`c\``),
 * and a name the word `event` follows directly qualifies on its own
 * (``writes a `dispatch_subagent` event``). "Audit trail" alone does not: it
 * anchors the window, but a line saying a rectification *carries* an audit
 * trail is naming a quality gate, not emitting an event.
 */
const EMISSION_PHRASE = /\baudit events?\b|\beventos? de auditoria\b/i;
const NAME_IS_EVENT = /^\s*(?:audit\s+)?events?\b|^\s*(?:de\s+)?auditoria\b/i;

/**
 * Reads a backticked token as an event name. `event=` and `"event":` name an
 * event by construction and skip this; a name sitting in a sentence does not,
 * and `page_geometry`, `target_platforms` and `trace_id` are all fields that
 * shared a line with the words "audit event" in the live library. A past
 * participle or one of the engine's own event stems is the discriminator.
 */
const EVENT_STEMS = new Set([
  "dispatch", "gate", "brief", "briefing", "report", "verify", "notify", "session", "assumption",
  "plan", "research", "chunk", "judge", "critique", "clarification", "stall", "loop", "invocation", "routing", "revision",
]);
function readsAsEvent(token: string): boolean {
  if (isExtension(token)) return true;
  const segs = token.split("_");
  const last = segs[segs.length - 1];
  return /(?:ed|ing)$/.test(last) || EVENT_STEMS.has(segs[0]);
}

export type SiteForm = "cmd" | "code" | "field" | "json" | "prose";

export interface EventSite {
  /** Entity-relative, posix separators — the same shape a finding's `where` uses. */
  file: string;
  /** 1-indexed. */
  line: number;
  event: string;
  form: SiteForm;
  /** An attribution key or flag inside the ±3-line window. */
  attributed: boolean;
  /** The line itself, trimmed and capped, so a report can quote its evidence. */
  text: string;
}

function* textFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (SKIP_DIR.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* textFiles(full);
    else if (e.isFile() && TEXT_FILE.test(e.name)) yield full;
  }
}

/** Every emission site in one file. `rel` is how the site names itself. */
export function scanFileEvents(file: string, rel: string): EventSite[] {
  let src: string;
  try { src = fs.readFileSync(file, "utf8"); } catch { return []; }
  if (!src.includes("event") && !src.includes("audit")) return [];

  const lines = src.split("\n");
  const out: EventSite[] = [];
  const seen = new Set<string>();
  const push = (i: number, event: string, form: SiteForm, attributed: boolean) => {
    const key = `${i}:${event}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file: rel, line: i + 1, event, form, attributed, text: lines[i].trim().slice(0, 160) });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("event") && !line.includes("audit")) continue;
    const window = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
    const attributed = ATTRIBUTION_RE.test(window);

    // Self-anchored: the command and the call name the sink themselves.
    for (const m of line.matchAll(new RegExp(`nrv\\s+audit\\s+emit\\s+(${ANY_NAME})`, "g"))) push(i, m[1], "cmd", ATTRIBUTION_RE.test(window) || ATTRIBUTION_RE.test(line));
    for (const m of line.matchAll(new RegExp(`audit\\.emit\\(\\s*['"\`](${ANY_NAME})`, "g"))) push(i, m[1], "code", attributed);

    if (!AUDIT_ANCHOR.test(window)) continue;
    for (const m of line.matchAll(new RegExp(`["']?\\bevent["']?\\s*[=:]\\s*["'\`]?(${ANY_NAME})`, "g"))) {
      push(i, m[1], /["']event["']\s*:/.test(m[0]) ? "json" : "field", attributed);
    }
    const phraseLine = EMISSION_PHRASE.test(line);
    for (const m of line.matchAll(new RegExp("`(" + ANY_NAME + ")`", "g"))) {
      if (!readsAsEvent(m[1])) continue;
      if (!phraseLine && !NAME_IS_EVENT.test(line.slice(m.index + m[0].length))) continue;
      push(i, m[1], "prose", attributed);
    }
  }
  return out;
}

/** Every emission site under an entity directory, sorted by file then line. */
export function scanEntityEvents(dir: string): EventSite[] {
  const out: EventSite[] = [];
  for (const file of textFiles(dir)) {
    const rel = path.relative(dir, file).split(path.sep).join("/");
    out.push(...scanFileEvents(file, rel));
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export type Verdict = "enum" | "extension" | "unprefixed" | "unattributed";

/**
 * Today's rule, unchanged, applied to one site: a name in the closed enum
 * passes; a name outside it must carry the `x_` prefix AND the author. The
 * enum is the platform's own vocabulary, so an entity emitting `gate_passed`
 * is not asked to attribute it — the closed core is engine lifecycle and its
 * attribution is the dispatcher's job.
 */
export function verdictOf(site: EventSite, allowed: Set<string>): Verdict {
  if (isExtension(site.event)) return site.attributed ? "extension" : "unattributed";
  return allowed.has(site.event) ? "enum" : "unprefixed";
}

export interface EventFinding {
  id: "audit_event_unprefixed" | "audit_event_unattributed";
  /** `<file>:<event>` — one finding per file and name, however many lines say it. */
  where: string;
  message: string;
  evidence: string;
}

/**
 * The two findings both kinds share, built once so `kinds/squad.ts` and
 * `kinds/business.ts` cannot drift into two readings of the same rule. Sites
 * collapse per file and name: `refresh_started` on two lines of one task is
 * one thing to fix, and the evidence carries the lines.
 */
export function eventFindings(dir: string, kind: "squad" | "business", allowed: Set<string> = allowedEvents()): EventFinding[] {
  const attributionHint = kind === "squad" ? "--squad=<slug>" : "--business=<slug>";
  const grouped = new Map<string, { site: EventSite; verdict: Verdict; lines: number[] }>();
  for (const site of scanEntityEvents(dir)) {
    const verdict = verdictOf(site, allowed);
    if (verdict === "enum" || verdict === "extension") continue;
    const key = `${site.file}:${site.event}`;
    const hit = grouped.get(key);
    if (hit) { hit.lines.push(site.line); continue; }
    grouped.set(key, { site, verdict, lines: [site.line] });
  }

  const out: EventFinding[] = [];
  for (const [where, { site, verdict, lines }] of grouped) {
    const at = `${site.file}:${lines.join(",")} — ${site.text}`;
    if (verdict === "unprefixed") {
      out.push({
        id: "audit_event_unprefixed",
        where,
        message: `\`${site.event}\` is neither a closed-enum event nor \`x_\`-prefixed — the log records it as \`x_${site.event}\`, so the file and the trail disagree`,
        evidence: at,
      });
    } else {
      out.push({
        id: "audit_event_unattributed",
        where,
        message: `\`${site.event}\` carries the prefix but names no author — add ${attributionHint} so a reader can tell whose event it is`,
        evidence: at,
      });
    }
  }
  return out.sort((a, b) => a.where.localeCompare(b.where));
}
