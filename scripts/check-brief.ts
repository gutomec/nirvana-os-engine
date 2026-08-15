#!/usr/bin/env bun
/**
 * check-brief.ts — verify a dispatch brief before an agent burns an hour on it.
 *
 * Two briefs went out this session with instructions that could not be followed:
 * one told an agent to run `coverage-ratchet.ts`, which existed on another
 * branch; another told it to edit a squad in `genesis-content/squads/`, where
 * that squad has never lived. Both agents recovered — one of them caught a `cp`
 * that would have deleted three capabilities from the installed library — but
 * each lost a detour, and the errors were one command away from being caught.
 *
 * At one dispatch that is an annoyance. Across 195 it is a class of failure, and
 * the failures are silent in the worst way: the agent improvises, produces
 * something plausible against the wrong target, and reports success.
 *
 * So: extract every checkable claim from the brief and check it.
 *
 *   file paths        must exist on disk
 *   script commands   the script named after `bun`/`node` must exist
 *   entity slugs      must be in the live registry
 *
 * Deliberately conservative: it only flags what it can prove wrong. A path
 * inside a fenced code block that is meant as an example, a slug the brief asks
 * the agent to CREATE — those would be false positives, so the brief marks them
 * with a trailing `(new)` or the checker leaves anything it cannot resolve
 * unjudged and says so. A preflight that cries wolf is a preflight people skip.
 *
 * Usage:
 *   bun scripts/check-brief.ts brief.md
 *   bun scripts/check-brief.ts brief.md --strict     # exit 1 on any hard failure
 *   cat brief.md | bun scripts/check-brief.ts -
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "../skills/_shared/lib/bun-helpers.ts";

const require_ = createRequire(import.meta.url);
const { flags, positional } = parseArgs(process.argv.slice(2));

const RED = "\x1b[31m", GRN = "\x1b[32m", YEL = "\x1b[33m", DIM = "\x1b[2m", BOLD = "\x1b[1m", RST = "\x1b[0m";

const src = positional[0];
if (!src) {
  console.error("usage: bun scripts/check-brief.ts <brief.md|-> [--strict]");
  process.exit(2);
}
const text = src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");

const HOME = homedir();
const expand = (p: string) => (p.startsWith("~/") ? join(HOME, p.slice(2)) : p);

/**
 * Known entity slugs, from the live registry — or from a file, so this can be
 * tested on a machine that has no library. CI is exactly that machine, and a
 * test that silently checks nothing there is worse than no test.
 */
const slugs = new Set<string>();
if (typeof flags.slugs === "string") {
  for (const s of JSON.parse(readFileSync(flags.slugs, "utf8")) as string[]) slugs.add(s);
} else {
  try {
    const all = require_(join(import.meta.dir, "..", "skills", "harness", "lib", "registry-loader.js")).loadAll();
    for (const s of Object.keys(all?.squads?.squads ?? {})) slugs.add(s);
    for (const b of Object.keys(all?.businesses?.businesses ?? {})) slugs.add(b);
  } catch { /* no registry: slug checks are skipped, and said so below */ }
}

/** The line a match sits on. Both `lastIndexOf` and `indexOf` return -1 at the
 *  edges of the text, and a negative index makes `slice` count from the end —
 *  which silently returns "" for a single-line brief, disabling every per-line
 *  escape below. */
function lineAt(idx: number): string {
  const start = text.lastIndexOf("\n", Math.max(idx - 1, 0));
  const end = text.indexOf("\n", idx);
  return text.slice(start < 0 ? 0 : start + 1, end < 0 ? text.length : end);
}
/** A brief may legitimately name something the agent will CREATE. */
const isPlanned = (idx: number) => /\(new\)|will create|vai criar|to create/i.test(lineAt(idx));

interface Finding { kind: "path" | "script" | "slug"; value: string; note: string; }
const bad: Finding[] = [];
const ok = { path: 0, script: 0, slug: 0 };
let slugsChecked = 0;

/** Absolute or ~-relative paths. Relative paths are ambiguous without a cwd and
 *  are left alone rather than guessed at. */
for (const m of text.matchAll(/(?:^|[\s`"'(])((?:~|\/)[\w./~-]{6,})/g)) {
  const raw = m[1].replace(/[.,;:)`"']+$/, "");
  if (isPlanned(m.index ?? 0)) continue;
  const p = expand(raw);
  if (existsSync(p)) { ok.path++; continue; }
  bad.push({ kind: "path", value: raw, note: "does not exist" });
}

/** `bun <script>` / `node <script>` — the script must be there. */
for (const m of text.matchAll(/\b(?:bun|node)\s+((?:~|\/|\.\/|[\w.-]+\/)[\w./~-]+\.(?:ts|js|mjs|sh))/g)) {
  const raw = m[1];
  const cands = [expand(raw), resolve(join(import.meta.dir, ".."), raw), resolve(HOME, raw)];
  if (cands.some((c) => existsSync(c) && statSync(c).isFile())) { ok.script++; continue; }
  bad.push({ kind: "script", value: raw, note: "no such script — check the branch it lives on" });
}

/**
 * Slugs the brief names as targets or neighbours.
 *
 * Only hyphenated names are judged. Thirteen of the 255 entities are a single
 * word, and several of those words are `documentation`, `testing` and
 * `monitoring` — which appear in backticks in ordinary prose for reasons that
 * have nothing to do with a squad. Catching those thirteen would cost a false
 * alarm on every brief that mentions testing, and a preflight that cries wolf
 * is a preflight people stop running.
 */
if (slugs.size > 0) {
  const seen = new Set<string>();
  for (const m of text.matchAll(/`([a-z][a-z0-9]+(?:-[a-z0-9]+){1,5})`/g)) {
    const s = m[1];
    if (seen.has(s)) continue;
    // Only judge things that look like entity slugs, not filenames or flags.
    if (/\.(ts|js|md|ya?ml|json|sh)$/.test(s) || s.startsWith("-")) continue;
    seen.add(s);
    if (isPlanned(m.index ?? 0)) continue;
    slugsChecked++;
    if (slugs.has(s)) { ok.slug++; continue; }
    bad.push({ kind: "slug", value: s, note: "not in the registry" });
  }
}

console.log(`\n${BOLD}BRIEF PREFLIGHT${RST} ${DIM}${src === "-" ? "(stdin)" : src}${RST}`);
console.log(`${DIM}  checked ${ok.path + bad.filter((b) => b.kind === "path").length} paths · ${ok.script + bad.filter((b) => b.kind === "script").length} scripts · ${slugsChecked} slugs${RST}`);
if (slugs.size === 0) console.log(`${YEL}  registry unavailable — slug checks skipped${RST}`);
console.log();

if (bad.length === 0) {
  console.log(`${GRN}  Every path, script and slug in this brief resolves.${RST}\n`);
  process.exit(0);
}

for (const f of bad) {
  console.log(`  ${RED}✗${RST} ${f.kind.padEnd(7)} ${f.value}`);
  console.log(`      ${DIM}${f.note}${RST}`);
}
console.log(`\n${DIM}  An agent given an unresolvable instruction improvises, and reports success`);
console.log(`  against the wrong target. Fix the brief, not the agent.${RST}`);
console.log(`${DIM}  If a path or slug is meant to be created by the agent, mark it "(new)" on`);
console.log(`  the same line and this check will leave it alone.${RST}\n`);

process.exit(flags.strict ? 1 : 0);
