#!/usr/bin/env bun
// check-audit-parity.ts — parity gate for the audit-event surface.
//
// Compares four sources of truth about audit event names:
//   (a) PRESCRIBED — event-shaped identifiers in skills/harness/SKILL.md and
//       skills/harness/references/03-audit.md (backticked tokens + the bare
//       enum listing in the fenced block of 03-audit.md).
//   (b) ALLOWED — the ALLOWED_EVENTS closed enum in skills/harness/lib/audit.js.
//   (c) EMITTED — `emit('x')` / `event: 'x'` string literals across
//       skills/**/{lib,scripts}/*.{ts,js} (node_modules and tests excluded).
//   (d) CONTENT — the same contract as squad and business FILES express it:
//       the templates this repo ships, the installed library, and the pack
//       sources. Added 2026-08-28, because (a)–(c) are all engine code and
//       docs: the gate ran green while 285 event types (961 occurrences)
//       were emitted outside every rule, 100% of them from content.
//
// The `x_` namespace is open BY DESIGN (see references/03-audit.md): an
// `x_`-prefixed name, prescribed or emitted, is an extension event and never
// a discrepancy — it is listed informationally. `allowed-but-never-emitted`
// is also informational: the enum includes the maestro-emitted surface
// (events written via `nrv audit emit` at run time, not by code paths).
//
// --strict exits 1 on the ACTIONABLE sections: prescribed-not-allowed (non-x_),
// emitted-not-allowed (non-x_), and content this REPOSITORY owns. The installed
// library and the pack sources are reported, never gated here — the repo cannot
// fix a machine's library, CI has neither, and each entity is gated where it
// lives, by `nrv validate <kind> <slug>` (`audit_event_unprefixed` /
// `audit_event_unattributed`, both baselineable).
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "../skills/_shared/lib/bun-helpers.ts";
import { scanEntityEvents, scanFileEvents, verdictOf, type EventSite } from "../skills/_shared/lib/audit-events.ts";

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
        // Call patterns capture the callee NAME in group 1 and are only
        // counted when that name is a KNOWN forwarding wrapper around the
        // real `audit.emit()` — not the literal `emit(` alone, and not a bare
        // "name contains emit" test either. `\bemit\(` cannot match
        // "emitAudit(" (it needs 2+ characters before the literal "mit", and
        // a camelCase wrapper name puts "emit" at the very start of the
        // identifier, leaving no room), so these forwarders were invisible
        // here before. Measured cause of 3 of the 21 "never emitted by code"
        // false negatives plan cut 5 found: `human_notification_required`
        // (`supervisor.ts`), `stall_detected` / `stall_retry`
        // (`host-agent-retry.js`).
        //
        // The allowlist, not a blanket `/emit/i` test, is deliberate: this
        // codebase also has helpers whose NAME contains "emit" but whose
        // first argument is not an event name at all — `emitProjection(kind,
        // run, state)` in `compatibility-facade.ts` hardcodes its own event
        // name internally and takes an "open"/"transition" KIND as its first
        // argument. A name-only test misread that kind as two invented event
        // types and would have failed `--strict` on this cut's own fix.
        const EMIT_WRAPPER_NAMES = new Set(["emit", "emitSafe", "emitAudit", "emitLedgerAudit", "emitDriverAudit", "auditEmit"]);
        const callPatterns = [
          /\b([A-Za-z_][A-Za-z0-9_]*)\(\s*['"]([a-z][a-z0-9_]*)['"]/g,
          // Ternary verdicts: emitAudit(ok ? 'a' : 'b', ...)
          /\b([A-Za-z_][A-Za-z0-9_]*)\(\s*[^,()\n]*?\?\s*['"]([a-z][a-z0-9_]*)['"]\s*:\s*['"]([a-z][a-z0-9_]*)['"]/g,
        ];
        for (const re of callPatterns) {
          for (const m of src.matchAll(re)) {
            if (!EMIT_WRAPPER_NAMES.has(m[1])) continue;
            for (const token of [m[2], m[3]]) {
              if (!token) continue;
              const list = found.get(token) || [];
              if (!list.includes(short)) list.push(short);
              found.set(token, list);
            }
          }
        }
        // Field/literal patterns: not a call, so no name to check.
        const fieldPatterns = [
          /\bevent:\s*['"]([a-z][a-z0-9_]*)['"]/g,   // { event: 'x' } literals
          // Ternary verdicts: event: ok ? "a" : "b"
          /\bevent:\s*[^,\n]*?\?\s*['"]([a-z][a-z0-9_]*)['"]\s*:\s*['"]([a-z][a-z0-9_]*)['"]/g,
        ];
        for (const re of fieldPatterns) {
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

// ── (d) content: squad and business files ───────────────────────────────────

interface ContentHit { root: string; entity: string; site: EventSite; verdict: "unprefixed" | "unattributed"; }
interface ContentRoot { label: string; owned: boolean; where: string; entities: number; present: boolean; }

/** Entity directories under a root of the given kind, one level down. */
function entityDirs(root: string, manifest: string): Array<{ slug: string; dir: string }> {
  if (!existsSync(root)) return [];
  const out: Array<{ slug: string; dir: string }> = [];
  for (const name of readdirSync(root)) {
    if (name.startsWith(".") || name === "_library") continue;
    const dir = join(root, name);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    if (existsSync(join(dir, manifest))) out.push({ slug: name, dir });
  }
  return out;
}

/** `~/nirvana-packs/{genesis-content,packs-content/<pack>}`, or $NIRVANA_PACKS_DIR. */
function packContentRoots(): string[] {
  const base = process.env.NIRVANA_PACKS_DIR || join(paths.HOME, "nirvana-packs");
  if (!existsSync(base)) return [];
  const out: string[] = [];
  for (const candidate of ["genesis-content", "packs-content"]) {
    const dir = join(base, candidate);
    if (!existsSync(dir)) continue;
    if (candidate === "genesis-content") { out.push(dir); continue; }
    for (const pack of readdirSync(dir)) {
      const p = join(dir, pack);
      try { if (statSync(p).isDirectory()) out.push(p); } catch { /* not a pack */ }
    }
  }
  return out;
}

/** Loose template files — a scaffold is not an entity, and it teaches every squad built from it. */
function scanLooseTree(dir: string, label: string): ContentHit[] {
  const hits: ContentHit[] = [];
  if (!existsSync(dir)) return hits;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = join(cur, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!/\.(md|markdown|ya?ml|tmpl)$/i.test(e.name)) continue;
      const rel = relative(ROOT, full).split(sep).join("/");
      for (const site of scanFileEvents(full, rel)) {
        const v = verdictOf(site, allowed);
        if (v === "unprefixed" || v === "unattributed") hits.push({ root: label, entity: "(template)", site, verdict: v });
      }
    }
  }
  return hits;
}

function contentScan(): { hits: ContentHit[]; roots: ContentRoot[]; sites: number } {
  const hits: ContentHit[] = [];
  const roots: ContentRoot[] = [];
  let sites = 0;

  // Repo-owned scaffolds. These ship in the engine, so they are gated here.
  const REPO_TREES = [join(SKILLS, "squads", "templates"), join(SKILLS, "businesses", "templates")];
  let repoFiles = 0;
  for (const tree of REPO_TREES) {
    if (!existsSync(tree)) continue;
    repoFiles++;
    hits.push(...scanLooseTree(tree, "repo"));
  }
  roots.push({ label: "repo templates", owned: true, where: "skills/{squads,businesses}/templates", entities: repoFiles, present: repoFiles > 0 });

  const scanEntities = (label: string, root: string, manifest: string) => {
    const found = entityDirs(root, manifest);
    for (const { slug, dir } of found) {
      for (const site of scanEntityEvents(dir)) {
        sites++;
        const v = verdictOf(site, allowed);
        if (v === "unprefixed" || v === "unattributed") hits.push({ root: label, entity: `${manifest === "squad.yaml" ? "squad" : "business"}:${slug}`, site, verdict: v });
      }
    }
    return found.length;
  };

  const lib = scanEntities("library", paths.SQUADS_DIR, "squad.yaml") + scanEntities("library", paths.BUSINESSES_DIR, "business.yaml");
  roots.push({ label: "installed library", owned: false, where: `${home(paths.SQUADS_DIR)}, ${home(paths.BUSINESSES_DIR)}`, entities: lib, present: existsSync(paths.SQUADS_DIR) || existsSync(paths.BUSINESSES_DIR) });

  const packRoots = packContentRoots();
  let packs = 0;
  for (const p of packRoots) {
    // The same slug ships in more than one pack; the label carries the pack so
    // two copies of `ebook-maestro-nirvana` do not collapse into one row.
    const label = `packs/${p.split(sep).pop()}`;
    packs += scanEntities(label, join(p, "squads"), "squad.yaml") + scanEntities(label, join(p, "businesses"), "business.yaml");
  }
  roots.push({ label: "pack sources", owned: false, where: packRoots.length ? `${home(packRoots[0])} (+${packRoots.length - 1} more)` : "(none found)", entities: packs, present: packRoots.length > 0 });

  return { hits, roots, sites };
}

function home(p: string): string {
  return paths.HOME && p.startsWith(paths.HOME) ? "~" + p.slice(paths.HOME.length) : p;
}

// ── report ──────────────────────────────────────────────────────────────────

const strict = process.argv.includes("--strict");
const allowed = allowedEvents();
const prescribed = prescribedEvents(allowed);
const emitted = emittedEvents();
const content = contentScan();

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
console.log(`  content sites (squad + business files)  ${content.sites}`);
for (const r of content.roots) {
  const mark = r.present ? `${r.entities} scanned` : "ABSENT — not scanned";
  console.log(`    ${r.label.padEnd(18)} ${mark.padEnd(22)} ${r.where}`);
}
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

// ── (d) content ─────────────────────────────────────────────────────────────
// What this scan CAN see: the five forms a file names an event literally —
// `nrv audit emit <name>`, `audit.emit('<name>')` in a shipped script, an
// `event=`/`event:` field, a `"event": "..."` JSON key, and a backticked name
// on a line that says "audit event". What it CANNOT see: an event an agent
// invents at run time with no literal on disk, which is most of what the log
// holds. Both halves are printed, because a gate that silently covers half is
// what produced this situation.
const CONTENT_CAP = 12;
function contentSection(title: string, hits: ContentHit[]): number {
  const byEntity = new Map<string, ContentHit[]>();
  for (const h of hits) {
    const key = h.root === "repo" ? h.site.file : `${h.root}/${h.entity}`;
    byEntity.set(key, [...(byEntity.get(key) ?? []), h]);
  }
  console.log(`${title} (${hits.length} site(s) in ${byEntity.size} place(s)):`);
  if (hits.length === 0) console.log("  (none)");
  let shown = 0;
  for (const [key, group] of [...byEntity.entries()].sort()) {
    if (shown >= CONTENT_CAP) { console.log(`  … and ${byEntity.size - shown} more`); break; }
    shown++;
    console.log(`  ${key}  (${group.length})`);
    for (const h of group.slice(0, 3)) console.log(`    ${h.site.event.padEnd(32)} ${h.site.file}:${h.site.line} [${h.site.form}]`);
    if (group.length > 3) console.log(`    … ${group.length - 3} more in this ${group[0].root === "repo" ? "file" : "entity"}`);
  }
  console.log("");
  return byEntity.size;
}

const repoHits = content.hits.filter((h) => h.root === "repo");
const foreignHits = content.hits.filter((h) => h.root !== "repo");
const repoPlaces = contentSection("CONTENT the REPO owns — templates naming an event outside the rule (strict-gated)", repoHits);
const foreignPlaces = contentSection("CONTENT elsewhere — installed library and pack sources (reported; gated by `nrv validate`)", foreignHits);
// The two figures below are COMPUTED, never typed in. An earlier draft of this
// note hardcoded them and drifted within one run: it claimed "sites in 6" three
// lines under a section header this same program had printed as "7 place(s)".
// A gate that contradicts its own output is the defect this cut exists to kill.
// Only the entity roots count here — the `repo templates` row counts template
// TREES, not entities. The 285 is the plan's audited log figure, cited as a
// dated measurement because the log is live and grows during a run.
const entitiesScanned = content.roots.filter((r) => !r.owned).reduce((n, r) => n + r.entities, 0);
console.log("What the content scan cannot see: an event a model invents at run time with no");
console.log("literal on disk, which is most of what the log holds. The plan measured 285 rogue");
console.log(`event types across both audit roots (2026-08-28), while scanning ${entitiesScanned} entities finds`);
console.log(`sites in ${repoPlaces + foreignPlaces}. The gap is the finding, not the miss — the contract never reached`);
console.log("the author (plan cut 3).");
console.log("");

const actionable = prescribedNotAllowed.length + emittedNotAllowed.length + repoHits.length;
console.log(`${actionable} actionable discrepancies (informational sections excluded).`);
if (strict && actionable > 0) process.exit(1);
process.exit(0);
