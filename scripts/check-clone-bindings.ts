#!/usr/bin/env bun
/**
 * check-clone-bindings.ts — every clone an employee names has to be somewhere
 * the runtime will look.
 *
 * A business binds a mind-clone to an employee by naming it in the employee's
 * frontmatter (`assigned_mind_clones`), and the runtime resolves that name
 * against the clone library. Nothing verified the name resolves. The failure is
 * silent by construction: the employee simply runs without the persona it was
 * written to carry, and the output is plausible prose that reads like anyone.
 *
 * It is worse in a pack. A pack ships `mind-clones/` alongside `businesses/`,
 * and the installer lays those into the library. If a packaged business declares
 * a clone the pack does not carry, the buyer installs an employee bound to
 * nothing. Found while adding `tracking-360` to the flagship: its 17 employees
 * declare 17 clones and the pack carried 5. The other 12 were found by listing
 * them out by hand — which is exactly the work a gate should be doing.
 *
 * Some businesses also keep a `dna/` directory of symlinks into the library.
 * That is not in the protocol — the protocol binds per employee, by reference —
 * and symlinks cannot travel in a zip: they point at the author's absolute home.
 * This gate reads them anyway, because in one business they are the ONLY
 * binding, and losing that silently is the thing being prevented.
 *
 * Usage:
 *   bun scripts/check-clone-bindings.ts                  # the live library
 *   bun scripts/check-clone-bindings.ts --strict
 *   bun scripts/check-clone-bindings.ts --pack <dir>     # a pack's content dir
 *   bun scripts/check-clone-bindings.ts --json
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RED = "\x1b[31m", GRN = "\x1b[32m", YEL = "\x1b[33m", DIM = "\x1b[2m", BOLD = "\x1b[1m", RST = "\x1b[0m";

const argv = process.argv.slice(2);
const strict = argv.includes("--strict");
const asJson = argv.includes("--json");
const packDir = argv.includes("--pack") ? argv[argv.indexOf("--pack") + 1] : null;

const HOME = homedir();
/** In a pack the three kinds sit side by side; live, they are three roots. */
const BUSINESSES = packDir ? join(packDir, "businesses") : join(HOME, "businesses");
const CLONES = packDir ? join(packDir, "mind-clones") : join(HOME, "businesses", "_library", "dna");

/** A ref in `assigned_mind_clones` may be category-prefixed
 *  (`21-media-moguls/jane-friedman`) or flat. The slug is the last segment. */
const slugOf = (ref: string) => (ref.lastIndexOf("/") === -1 ? ref : ref.slice(ref.lastIndexOf("/") + 1));

/**
 * `dna_reference` is a different shape: a path INTO the clone, not to it —
 * `dna/michael-thaut-music-therapist/agent/AGENT.md`. Reading its last segment
 * yields `AGENT`, which is not a clone and never will be; the first pass of this
 * gate reported six businesses "missing AGENT" for exactly that reason. The
 * clone is the directory that follows the library marker.
 */
function refToSlug(ref: string): string | null {
  const parts = ref.replace(/^\$\{?DNA_LIBRARY\}?\/?/, "").split("/").filter(Boolean);
  const i = parts.indexOf("dna");
  const slug = i >= 0 ? parts[i + 1] : parts[0];
  if (!slug || /\.(md|ya?ml|json)$/.test(slug)) return null;
  return slug;
}

function declaredBy(employeeFile: string): string[] {
  const text = readFileSync(employeeFile, "utf8");
  const fm = text.match(/^---[\s\S]*?^---/m)?.[0] ?? "";
  const out: string[] = [];
  const list = fm.match(/^assigned_mind_clones\s*:\s*\n((?:[ \t]*-\s.+\n?)+)/m);
  if (list) {
    for (const line of list[1].split("\n")) {
      const s = line.replace(/^[ \t]*-\s*/, "").trim();
      if (s) out.push(slugOf(s));
    }
  }
  // `dna_reference:` — the protocol's own form, a path into the clone.
  for (const m of fm.matchAll(/^dna_reference\s*:\s*(\S+)/gm)) {
    const slug = refToSlug(m[1]);
    if (slug) out.push(slug);
  }
  return out;
}

interface Row { business: string; employee: string; clone: string; source: "employee" | "dna/" }
const missing: Row[] = [];
let checked = 0, businesses = 0;
const available = new Set(existsSync(CLONES) ? readdirSync(CLONES) : []);

for (const b of existsSync(BUSINESSES) ? readdirSync(BUSINESSES) : []) {
  if (b === "_library") continue;
  const dir = join(BUSINESSES, b);
  if (!existsSync(join(dir, "business.yaml"))) continue;
  businesses++;

  const empDir = join(dir, "employees");
  if (existsSync(empDir)) {
    for (const f of readdirSync(empDir).filter((x) => x.endsWith(".md"))) {
      for (const clone of declaredBy(join(empDir, f))) {
        checked++;
        if (!available.has(clone)) missing.push({ business: b, employee: f.replace(/\.md$/, ""), clone, source: "employee" });
      }
    }
  }

  // The symlink directory, where a business still has one.
  const dnaDir = join(dir, "dna");
  if (existsSync(dnaDir)) {
    for (const e of readdirSync(dnaDir)) {
      // Only links and directories are bindings. `medwork360/dna/` holds a
      // README.md and nothing else, which the first pass counted as a clone
      // named "README" — and, worse, as evidence that the business had one.
      let entry;
      try { entry = lstatSync(join(dnaDir, e)); } catch { continue; }
      if (!entry.isSymbolicLink() && !entry.isDirectory()) continue;
      const clone = e.replace(/\.md$/, "");
      checked++;
      if (!available.has(clone)) missing.push({ business: b, employee: "(business dna/)", clone, source: "dna/" });
      // A symlink that no longer resolves is a binding that already broke.
      try {
        const p = join(dnaDir, e);
        if (lstatSync(p).isSymbolicLink() && !existsSync(p)) {
          missing.push({ business: b, employee: "(business dna/)", clone: `${clone} — dangling symlink`, source: "dna/" });
        }
      } catch { /* unreadable entry */ }
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ scope: packDir ?? "live", businesses, bindings: checked, missing }, null, 2));
  process.exitCode = strict && missing.length ? 1 : 0;
} else {
  console.log(`\n${BOLD}CLONE BINDINGS — does every named clone resolve?${RST}`);
  console.log(`${DIM}  ${businesses} businesses · ${checked} bindings · ${available.size} clones in ${packDir ? "the pack" : "the library"}${RST}`);
  console.log(`${DIM}  ${CLONES.replace(HOME, "~")}${RST}\n`);

  if (!missing.length) {
    console.log(`${GRN}  Every clone an employee names is present.${RST}\n`);
    process.exitCode = 0;
  } else {
    const byBiz = new Map<string, Row[]>();
    for (const m of missing) byBiz.set(m.business, [...(byBiz.get(m.business) ?? []), m]);
    console.log(`  unresolved: ${RED}${missing.length}${RST} across ${byBiz.size} business(es)\n`);
    for (const [b, rows] of byBiz) {
      console.log(`  ${RED}▼${RST} ${BOLD}${b}${RST} ${DIM}— ${rows.length}${RST}`);
      for (const r of rows.slice(0, 12)) {
        console.log(`      ${YEL}${r.clone}${RST} ${DIM}← ${r.employee}${RST}`);
      }
      if (rows.length > 12) console.log(`      ${DIM}… and ${rows.length - 12} more${RST}`);
    }
    console.log(`\n${DIM}  An employee bound to a clone that is not there runs without it, and says`);
    console.log(`  nothing. In a pack that means the buyer installs the business and gets`);
    console.log(`  prose that reads like anyone.${RST}\n`);
    process.exitCode = strict ? 1 : 0;
  }
}
