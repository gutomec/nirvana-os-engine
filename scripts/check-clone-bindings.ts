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
 * The declaration reading lives in skills/_shared/lib/entity-graph.ts — the
 * same reader that builds the typed dependency graph for the installer and
 * `nrv graph`. This script is the gate over it; its CLI contract (flags, JSON
 * shape, exit codes, output) is frozen.
 *
 * Usage:
 *   bun scripts/check-clone-bindings.ts                  # the live library
 *   bun scripts/check-clone-bindings.ts --strict
 *   bun scripts/check-clone-bindings.ts --pack <dir>     # a pack's content dir
 *   bun scripts/check-clone-bindings.ts --json
 */
import { homedir } from "node:os";
import { readCloneBindings, resolveRoots } from "../skills/_shared/lib/entity-graph.ts";

const RED = "\x1b[31m", GRN = "\x1b[32m", YEL = "\x1b[33m", DIM = "\x1b[2m", BOLD = "\x1b[1m", RST = "\x1b[0m";

const argv = process.argv.slice(2);
const strict = argv.includes("--strict");
const asJson = argv.includes("--json");
const packDir = argv.includes("--pack") ? argv[argv.indexOf("--pack") + 1] : null;

const HOME = homedir();
const roots = resolveRoots(packDir);
const scan = readCloneBindings(roots);
const available = scan.availableClones;
const businesses = scan.businesses.length;

interface Row { business: string; employee: string; clone: string; source: "employee" | "dna/" }
const missing: Row[] = [];
let checked = 0;
for (const b of scan.bindings) {
  if (b.dangling) {
    // A symlink that no longer resolves is a binding that already broke.
    missing.push({ business: b.business, employee: b.employee, clone: `${b.clone} — dangling symlink`, source: b.source });
    continue;
  }
  checked++;
  if (!available.has(b.clone)) {
    missing.push({ business: b.business, employee: b.employee, clone: b.clone, source: b.source });
  }
}

if (asJson) {
  console.log(JSON.stringify({ scope: packDir ?? "live", businesses, bindings: checked, missing }, null, 2));
  process.exitCode = strict && missing.length ? 1 : 0;
} else {
  console.log(`\n${BOLD}CLONE BINDINGS — does every named clone resolve?${RST}`);
  console.log(`${DIM}  ${businesses} businesses · ${checked} bindings · ${available.size} clones in ${packDir ? "the pack" : "the library"}${RST}`);
  console.log(`${DIM}  ${roots.clonesDir.replace(HOME, "~")}${RST}\n`);

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
