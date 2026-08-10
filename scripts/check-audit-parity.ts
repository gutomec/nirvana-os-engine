#!/usr/bin/env bun
// check-audit-parity.ts — parity gate for the audit-event surface.
//
// Compares three sources of truth about audit event names:
//   (a) PRESCRIBED — event-shaped identifiers in skills/harness/SKILL.md and
//       skills/harness/references/03-audit.md (backticked tokens + the bare
//       enum listing in the fenced block of 03-audit.md).
//   (b) ALLOWED — the ALLOWED_EVENTS closed enum in skills/harness/lib/audit.js.
//   (c) EMITTED — `emit('x')` / `event: 'x'` string literals across
//       skills/**/{lib,scripts}/*.{ts,js} (node_modules and tests excluded).
//
// The `x_` namespace is open BY DESIGN (see references/03-audit.md): an
// `x_`-prefixed name, prescribed or emitted, is an extension event and never
// a discrepancy — it is listed informationally. `allowed-but-never-emitted`
// is also informational: the enum includes the maestro-emitted surface
// (events written via `nrv audit emit` at run time, not by code paths).
//
// --strict exits 1 only on the two ACTIONABLE sections:
//   prescribed-not-allowed (non-x_) and emitted-not-allowed (non-x_).
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = join(ROOT, "skills");

// ── (b) ALLOWED_EVENTS from audit.js ────────────────────────────────────────

function allowedEvents(): Set<string> {
  const src = readFileSync(join(SKILLS, "harness", "lib", "audit.js"), "utf8");
  const start = src.indexOf("ALLOWED_EVENTS = new Set([");
  const end = src.indexOf("])", start);
  if (start === -1 || end === -1) throw new Error("ALLOWED_EVENTS block not found in audit.js");
  const block = src.slice(start, end);
  const out = new Set<string>();
  for (const m of block.matchAll(/'([a-z][a-z0-9_]*)'/g)) out.add(m[1]);
  return out;
}

// ── (a) prescribed events in the docs ───────────────────────────────────────

// A token "looks like an event" when it is snake_case AND its first or last
// segment belongs to the event vocabulary — OR it is already an allowed event
// (covers single-word events like `resume` / `handoff`).
const EVENT_SUFFIXES = new Set([
  "received", "amplified", "decision", "start", "end", "emission", "opened",
  "resolved", "fired", "required", "granted", "rejected", "violation", "write",
  "failed", "passed", "applied", "skipped", "detected", "retry", "warning",
  "completed", "committed", "written", "injected", "blocked", "audit",
  "invoked", "generated", "dispatched", "exhausted", "scored", "emitted",
  "request", "rollover", "made", "human", "delivered", "revision",
]);
const EVENT_PREFIXES = new Set([
  "dispatch", "gate", "brief", "briefing", "report", "verify", "notify",
  "session", "assumption", "plan", "research", "chunk", "judge", "critique",
  "clarification", "stall", "loop", "invocation", "routing", "revision",
]);
// Field / non-event snake_case tokens that would otherwise match the vocab.
const NON_EVENT_SUFFIXES = [
  "_id", "_path", "_dir", "_url", "_length", "_text", "_chars", "_usd",
  "_slug", "_name", "_count", "_tokens", "_input", "_output", "_excerpt",
  "_briefs", "_days", "_json", "_yaml", "_md", "_mode", "_state",
];
// Exact tokens that match the event vocabulary but are NOT events:
// `brief_block` is an output field of `nrv changes pending`; `loop_guard_state`
// is a HANDOFF state key rehydrated by `nrv guard tick`.
const NON_EVENT_EXACT = new Set(["brief_block", "loop_guard_state"]);

function looksLikeEvent(token: string, allowed: Set<string>): boolean {
  if (allowed.has(token)) return true;
  if (token.startsWith("x_")) return /^x_[a-z0-9]+(?:_[a-z0-9]+)*$/.test(token);
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(token)) return false;
  if (NON_EVENT_EXACT.has(token)) return false;
  if (NON_EVENT_SUFFIXES.some((s) => token.endsWith(s))) return false;
  const segs = token.split("_");
  return EVENT_SUFFIXES.has(segs[segs.length - 1]) || EVENT_PREFIXES.has(segs[0]);
}

function prescribedEvents(allowed: Set<string>): Map<string, string[]> {
  const sources = [
    join(SKILLS, "harness", "SKILL.md"),
    join(SKILLS, "harness", "references", "03-audit.md"),
  ];
  const found = new Map<string, string[]>(); // event -> source files
  const add = (token: string, file: string) => {
    if (!looksLikeEvent(token, allowed)) return;
    const list = found.get(token) || [];
    if (!list.includes(file)) list.push(file);
    found.set(token, list);
  };
  for (const file of sources) {
    if (!existsSync(file)) continue;
    const src = readFileSync(file, "utf8");
    const short = file.slice(ROOT.length + 1);
    // Backticked identifiers.
    for (const m of src.matchAll(/`([a-z][a-z0-9_]*)`/g)) add(m[1], short);
    // Bare whole-line identifiers (the closed-enum fenced listing in 03-audit.md).
    for (const m of src.matchAll(/^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)$/gm)) add(m[1], short);
  }
  return found;
}

// ── (c) emitted events across skills/**/{lib,scripts} ───────────────────────

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "tests") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|js)$/.test(entry.name) && !/\.test\.(ts|js)$/.test(entry.name)) yield full;
  }
}

function emittedEvents(): Map<string, string[]> {
  const found = new Map<string, string[]>(); // event -> files
  for (const skill of readdirSync(SKILLS, { withFileTypes: true })) {
    if (!skill.isDirectory()) continue;
    for (const sub of ["lib", "scripts"]) {
      const dir = join(SKILLS, skill.name, sub);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      for (const file of walk(dir)) {
        const src = readFileSync(file, "utf8");
        const short = file.slice(ROOT.length + 1);
        const patterns = [
          /\bemit\(\s*['"]([a-z][a-z0-9_]*)['"]/g,   // audit.emit('x') / emit("x")
          /\bevent:\s*['"]([a-z][a-z0-9_]*)['"]/g,   // { event: 'x' } literals
          // Ternary verdicts: emit(ok ? 'a' : 'b') / event: ok ? "a" : "b"
          /\bemit\(\s*[^,()\n]*?\?\s*['"]([a-z][a-z0-9_]*)['"]\s*:\s*['"]([a-z][a-z0-9_]*)['"]/g,
          /\bevent:\s*[^,\n]*?\?\s*['"]([a-z][a-z0-9_]*)['"]\s*:\s*['"]([a-z][a-z0-9_]*)['"]/g,
        ];
        for (const re of patterns) {
          for (const m of src.matchAll(re)) {
            for (const token of [m[1], m[2]]) {
              if (!token) continue;
              const list = found.get(token) || [];
              if (!list.includes(short)) list.push(short);
              found.set(token, list);
            }
          }
        }
      }
    }
  }
  return found;
}

// ── report ──────────────────────────────────────────────────────────────────

const strict = process.argv.includes("--strict");
const allowed = allowedEvents();
const prescribed = prescribedEvents(allowed);
const emitted = emittedEvents();

const sortedKeys = (m: Map<string, string[]>) => [...m.keys()].sort();

const isX = (e: string) => e.startsWith("x_");
const prescribedNotAllowed = sortedKeys(prescribed).filter((e) => !allowed.has(e) && !isX(e));
const emittedNotAllowed = sortedKeys(emitted).filter((e) => !allowed.has(e) && !isX(e));
const xNamespace = [...new Set([...prescribed.keys(), ...emitted.keys()])].filter(isX).sort();
const allowedNeverEmitted = [...allowed].sort().filter((e) => !emitted.has(e));

console.log(`AUDIT EVENT PARITY${strict ? " (--strict)" : " (report-only)"}`);
console.log(`  allowed (audit.js ALLOWED_EVENTS) ... ${allowed.size}`);
console.log(`  prescribed (SKILL.md + 03-audit.md) . ${prescribed.size}`);
console.log(`  emitted (skills/**/{lib,scripts}) ... ${emitted.size}`);
console.log("");

function section(title: string, names: string[], where: Map<string, string[]> | null) {
  console.log(`${title} (${names.length}):`);
  if (names.length === 0) console.log("  (none)");
  for (const n of names) {
    const src = where?.get(n);
    console.log(`  ${n}${src ? `  <- ${src.slice(0, 3).join(", ")}` : ""}`);
  }
  console.log("");
}

// ACTIONABLE (strict-gated): non-x_ names outside the closed enum. audit.emit
// records those as x_<event> at runtime (throws under NIRVANA_AUDIT_STRICT=1),
// so a bare non-enum literal means source and log disagree — fix the doc, add
// the event to the enum, or spell the x_ prefix explicitly.
section("PRESCRIBED but NOT ALLOWED — docs prescribe non-x_ events outside the closed enum", prescribedNotAllowed, prescribed);
section("EMITTED but NOT ALLOWED — code emits non-x_ events outside the closed enum", emittedNotAllowed, emitted);
// INFORMATIONAL: the open x_ namespace (extension events, accepted by design)
// and the maestro-emitted surface (enum events written via `nrv audit emit`
// by the orchestrating model, not by engine code).
section("x_ NAMESPACE — extension events (open by design, never a discrepancy)", xNamespace, null);
section("ALLOWED but NEVER EMITTED BY CODE — maestro-emitted / reserved enum entries (informational)", allowedNeverEmitted, null);

const actionable = prescribedNotAllowed.length + emittedNotAllowed.length;
console.log(`${actionable} actionable discrepancies (informational sections excluded).`);
if (strict && actionable > 0) process.exit(1);
process.exit(0);
