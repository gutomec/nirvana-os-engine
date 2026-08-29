#!/usr/bin/env bun
// check-no-ts-require-in-js.ts — a `.js` file must never `require()` a `.ts`
// file, and the project-root walk must never fork.
//
// Why this gate exists: three separate Windows-only failures blocked one PR
// in one day, each fixed as its own instance while the class kept producing
// the next one. Two of them share a root cause this gate closes for good:
//
//   1. `require()` of a `.ts` file from a `.js` file. Bun's CJS/ESM interop
//      throws `TypeError: require() async module` on Windows (tolerated on
//      macOS/ubuntu) when the required module's dependency chain carries a
//      top-level await — and even when it provably does not, this repo has
//      already been burned twice trusting that static read. budget.js and
//      context-budget.js hit it for real (PR #158 round 1); both are fixed
//      now (dynamic import() for budget.js's settings.ts, a genuine `.js`
//      sibling — log-paths.js — for context-budget.js's log path lookup). A
//      third, previously unmapped instance turned up in this same sweep:
//      business-fixers.js requiring frontmatter-edit.ts/entity-graph.ts at
//      module load time, unguarded — the exact "worst shape" budget.js had.
//      The fix going forward is structural, not per-instance: this gate
//      fails on the PATTERN.
//   2. A hand-rolled "walk up from cwd, stop at HOME or the filesystem root"
//      outside project-root.js (the one implementation — see that file's
//      header). Two independent copies of the HARDENING (not just the walk)
//      drifted out of sync with each other in the same afternoon; this
//      heuristic exists to catch a new fork appearing.
//
// Detection is static (regex over source text), not a require() probe: the
// point is to catch the shape before it ships, on any OS, without needing a
// live Windows machine to reproduce the crash.
//
// ALLOWLISTs below hold every surviving, ARGUED exception — not places
// future code should copy from. A new, unlisted instance is always an error.
// See each entry's comment for why it stays.
//
// Usage:
//   bun scripts/check-no-ts-require-in-js.ts            # report
//   bun scripts/check-no-ts-require-in-js.ts --strict   # exit 1 on any unlisted finding
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.argv.includes("--strict");

const SCAN_DIRS = ["skills", "scripts"];
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "tmp", "outputs", ".nirvana", "scratch"]);

// relative path → `.ts` basenames this file is allowed to require(). Each
// entry argues its own safety inline; every one left here is try/catch
// guarded and degrades to a documented fallback — never a crash.
const REQUIRE_TS_ALLOWLIST: Record<string, string[]> = {
  // Leaves audit.js untouched: a concurrent, unrelated cut (the event
  // contract's cloudevents envelope work) is mid-edit on this exact file in
  // the same tree. Pre-existing, try/catch-guarded, degrades to
  // ~/.harness-logs on failure (silent — a real but separate defect, out of
  // this cut's scope; see the audit report for the recommended follow-up).
  "skills/harness/lib/audit.js": ["log-paths.ts"],
  // capability-validator.js: guarded; falls back to the canonical hardcoded
  // default (1500) on failure, which the comment states explicitly matches.
  "skills/squads/lib/capability-validator.js": ["limits.ts"],
  // host-agent-driver.js: the .js IS the CJS half of the pair; requiring its
  // own .ts sibling under Bun is the documented delegation (falls back to an
  // inline legacy implementation for plain `node` callers where this whole
  // file is itself unreachable via require('./host-agent-driver.js')).
  "skills/_shared/lib/host-agent-driver.js": ["host-agent-driver.ts"],
  // handoff.js: the project-root walk itself now delegates to
  // project-root.js (a `.js`, not a `.ts` — see below); this is its OTHER,
  // unrelated require of run-ledger.ts, guarded, non-fatal (best-effort
  // heartbeat). run-ledger.ts documents itself as deliberately reimplementing
  // the project-root walk locally rather than importing scope.ts, exactly so
  // it stays safe to require() from CJS.
  "skills/_shared/lib/handoff.js": ["run-ledger.ts"],
};

// Files allowed to define their own project-root-shaped walk, with the
// reason each is not routed through project-root.js:
const WALK_IMPLEMENTATION_ALLOWLIST: Record<string, string> = {
  "skills/_shared/lib/project-root.js": "the canonical implementation itself",
  "skills/harness/lib/run-ledger.ts": "documented exception — reimplements locally so it stays require()-able from CJS callers without depending on scope.ts's async-tainted chain",
  // Already hardened (canonical realpath compare, checks NIRVANA_HOME + HOME
  // + USERPROFILE + os.homedir() as home candidates — a strict superset of
  // project-root.js's single-home check) and carries domain logic
  // project-root.js does not share (a `.nirvana/skills` directory is the
  // engine's OWN store, not a project, and must return null rather than the
  // generic "found a marker" answer). Consolidating would need
  // project-root.js to accept multiple home candidates first — flagged as a
  // follow-up, not done in this cut.
  "skills/_shared/lib/settings.ts": "already hardened, with settings-specific domain logic (multi-home + engine-store exclusion) project-root.js does not model — follow-up, not a defect",
  // Not a crash or a mis-scoped-write risk (unlike the fixed instances):
  // resolveLocale() falls back to a sane DEFAULT_LOCALE, and the absence of
  // a HOME exclusion here may be intentional (it doubles as reading the
  // GLOBAL ~/.nirvana/config.yaml locale, which no other tier reads).
  // Forcing project-root.js's strict HOME exclusion would drop that without
  // a replacement, and zero tests exist to verify the change either way —
  // reported, not fixed, in this cut.
  "skills/_shared/lib/locale-resolver.ts": "low-stakes heuristic with a safe default fallback; HOME exclusion may be an intentional global-config path; no test coverage to safely verify a behavior change — reported, not fixed",
  // Same reasoning: an audit-scoping label (inNirvanaScope), not a write
  // location. Different semantics from the fixed instances (12-level cap,
  // its own "1st level under HOME" fallback) and zero test coverage.
  "skills/_shared/scripts/audit-emit-from-hook.ts": "audit-scoping heuristic, not a write location; own HOME fallback semantics; no test coverage — reported, not fixed",
  // This gate's own test embeds a hand-rolled walk as fixture TEXT (a string
  // this gate's regex would otherwise legitimately catch) to prove the
  // fingerprint fires on a fresh instance. It is not real walk logic.
  "skills/harness/tests/no-ts-require-in-js-gate.test.ts": "fixture text for this gate's own test, not real walk logic",
};

function listFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listFiles(full, out);
    } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".ts"))) {
      out.push(full);
    }
  }
}

/** Extract the balanced-parens argument text of every `require(...)` call. */
function requireArgs(text: string): string[] {
  const args: string[] = [];
  const re = /require\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      i++;
    }
    args.push(text.slice(start, i - 1));
  }
  return args;
}

/** Does this require() argument resolve to a `.ts` path? Heuristic: the last
 *  quoted string literal in the argument (the last path.join() segment, or
 *  the whole literal for a bare require('./x.ts')) ends in `.ts`. */
function requiredTsBasename(arg: string): string | null {
  const literals = [...arg.matchAll(/['"]([^'"]*)['"]/g)].map((m) => m[1]);
  if (literals.length === 0) return null;
  const last = literals[literals.length - 1];
  if (!last.endsWith(".ts")) return null;
  return last.split("/").pop()!;
}

interface Finding { file: string; basename: string; }

const findings: Finding[] = [];
const walkOffenders: string[] = [];

// A hand-rolled walk's fingerprint in this codebase: a loop (`for`/`while`)
// whose body combines a marker existence check (`existsSync`/`statSync`) with
// a climb to the parent (`path.dirname(`), within a tight window. Requiring
// the loop keyword (not just co-occurrence of the two calls anywhere in the
// file) is what keeps this from flagging an unrelated `mkdirSync(path.dirname(x))`
// three paragraphs away from an unrelated `.nirvana` path literal.
const WALK_FINGERPRINT = /\b(?:for|while)\s*\([^{]{0,80}\)\s*\{[\s\S]{0,250}?(?:existsSync|statSync)\([\s\S]{0,120}?path\.dirname\(|\b(?:for|while)\s*\([^{]{0,80}\)\s*\{[\s\S]{0,250}?path\.dirname\([\s\S]{0,120}?(?:existsSync|statSync)\(/;

const allFiles: string[] = [];
for (const dir of SCAN_DIRS) listFiles(join(ROOT, dir), allFiles);

for (const abs of allFiles) {
  const rel = relative(ROOT, abs).split("\\").join("/");
  const text = readFileSync(abs, "utf8");

  if (rel.endsWith(".js")) {
    for (const arg of requireArgs(text)) {
      const basename = requiredTsBasename(arg);
      if (!basename) continue;
      const allowed = REQUIRE_TS_ALLOWLIST[rel] || [];
      if (!allowed.includes(basename)) findings.push({ file: rel, basename });
    }
  }

  if (!(rel in WALK_IMPLEMENTATION_ALLOWLIST) && WALK_FINGERPRINT.test(text)) {
    walkOffenders.push(rel);
  }
}

console.log(`NO-TS-REQUIRE-IN-JS${STRICT ? " (--strict)" : " (report-only)"} — the class, not the instance`);
console.log(`  scanned ${allFiles.length} file(s) under ${SCAN_DIRS.join(", ")}`);

if (findings.length === 0) {
  console.log("  ✓ no unlisted .js → .ts require() found");
} else {
  console.log(`  ✗ ${findings.length} unlisted .js → .ts require() found:`);
  for (const f of findings) console.log(`      ${f.file} requires '${f.basename}'`);
}

if (walkOffenders.length === 0) {
  console.log("  ✓ no project-root walk found outside project-root.js (or an argued exception)");
} else {
  console.log(`  ✗ ${walkOffenders.length} file(s) look like they carry their own project-root walk:`);
  for (const f of walkOffenders) console.log(`      ${f}`);
  console.log("      → delegate to skills/_shared/lib/project-root.js, or add a reasoned entry to");
  console.log("        WALK_IMPLEMENTATION_ALLOWLIST in this gate if it genuinely cannot.");
}

const failed = findings.length > 0 || walkOffenders.length > 0;
if (failed) {
  console.error("\n  A `.js` requiring a `.ts` can crash on Windows (TypeError: require() async module).");
  console.error("  Fix: give the `.ts` a CJS sibling (brief-excerpt.js/.ts, log-paths.js/.ts) and require()");
  console.error("  the `.js`, or make the caller's function async and use dynamic import() (budget.js).\n");
}
process.exit(failed && STRICT ? 1 : 0);
