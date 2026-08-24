#!/usr/bin/env bun
/**
 * activate.ts — `nrv activate`: prepare squads to touch the real world.
 *
 * A squad is prose plus scripts. Most of it an LLM executes on its own, but
 * the ones that call real tools — ffmpeg, epubcheck, playwright, a Python
 * library, a downloaded model — need those tools present. `dependencies.yaml`
 * declares them; this command installs and verifies them.
 *
 * Activation was reachable only as a raw script path
 * (skills/squads/scripts/activate-squad.ts), invisible to `nrv --help`, one
 * squad per invocation. Asked to "activate all squads", an agent had to grep
 * the filesystem to find the door and then walk 107 of them by hand. This is
 * that door, with the batch the library-sized case always needed.
 *
 * Usage:
 *   nrv activate <slug> [--dry-run] [--confirm-heavy] [--verbose]
 *   nrv activate --all [--dry-run] [--confirm-heavy] [--only-declared]
 *   nrv activate status <slug>
 *
 * Exit codes mirror the per-squad contract, aggregated over the batch:
 *   0 = every squad ready · 1 = at least one failed
 *   2 = at least one needs confirmation (heavy download / sudo)
 *   4 = invalid args / squad not found
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveScope, enumerate } from "../../_shared/lib/scope.ts";

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(process.env.HOME || "", ".nirvana", "skills"))
    ? path.join(process.env.HOME || "", ".nirvana", "skills")
    : path.resolve(import.meta.dir, "..", ".."));
const ACTIVATOR = path.join(SKILLS_ROOT, "squads", "scripts", "activate-squad.ts");
const BUN = process.env.NIRVANA_BUN || "bun";

const DIM = "\x1b[2m", GRN = "\x1b[32m", YEL = "\x1b[33m", RED = "\x1b[31m", BOLD = "\x1b[1m", RST = "\x1b[0m";

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith("--"));
const positional = argv.filter((a) => !a.startsWith("--"));
const all = flags.includes("--all");
const onlyDeclared = flags.includes("--only-declared");
const passthrough = flags.filter((f) => ["--dry-run", "--confirm-heavy", "--verbose", "-v"].includes(f));

if (flags.includes("--help") || flags.includes("-h") || (!all && positional.length === 0)) {
  console.error(`usage:
  nrv activate <slug> [--dry-run] [--confirm-heavy] [--verbose]
  nrv activate --all [--dry-run] [--confirm-heavy] [--only-declared]
  nrv activate status <slug>

Installs what a squad's dependencies.yaml declares: system tools, Python and
Node packages, sub-app node_modules, model downloads (heavy ones need
--confirm-heavy) — then verifies each check. Idempotent: an already-active
squad is re-verified, not reinstalled.

--all walks the library ONE SQUAD AT A TIME and never stops on a failure;
the summary at the end says what is ready, what needs confirmation and what
broke. --only-declared skips squads with no dependencies.yaml (they need no
activation at all).`);
  process.exit(flags.includes("--help") || flags.includes("-h") ? 0 : 4);
}

/** status passes straight through — it is a per-squad question. */
if (positional[0] === "status" || positional[0] === "deactivate") {
  const r = spawnSync(BUN, [ACTIVATOR, positional[0], positional[1] ?? "", ...passthrough], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

function runOne(slug: string): number {
  const r = spawnSync(BUN, [ACTIVATOR, "activate", slug, ...passthrough], { stdio: "inherit" });
  return r.status ?? 1;
}

if (!all) {
  process.exit(runOne(positional[0]));
}

// ── batch ──────────────────────────────────────────────────────────────────
const scope = resolveScope();
const squads = enumerate(scope, "squads")
  .filter((e) => !e.overridden)
  .filter((e) => !onlyDeclared || fs.existsSync(path.join(e.dir, "dependencies.yaml")))
  .sort((a, b) => a.slug.localeCompare(b.slug));

if (squads.length === 0) {
  console.error("no squads found in scope — check `nrv list-squads`");
  process.exit(4);
}

const declared = squads.filter((e) => fs.existsSync(path.join(e.dir, "dependencies.yaml"))).length;
console.log(`\n${BOLD}ACTIVATING ${squads.length} SQUAD(S)${RST} ${DIM}· ${declared} declare dependencies · one at a time${RST}\n`);

const ready: string[] = [];
const needsConfirm: string[] = [];
const failed: string[] = [];
const nothingToDo: string[] = [];

let i = 0;
for (const s of squads) {
  i++;
  const hasDeps = fs.existsSync(path.join(s.dir, "dependencies.yaml"));
  process.stdout.write(`${DIM}[${i}/${squads.length}]${RST} ${s.slug} ${DIM}…${RST}\n`);
  if (!hasDeps) {
    nothingToDo.push(s.slug);
    continue;
  }
  // A failure never stops the walk: the point of --all is to leave the
  // library as ready as it can be, then report what still needs a human.
  const code = runOne(s.slug);
  if (code === 0) ready.push(s.slug);
  else if (code === 2) needsConfirm.push(s.slug);
  else failed.push(s.slug);
}

console.log(`\n${BOLD}SUMMARY${RST}`);
console.log(`  ${GRN}ready${RST} ................ ${ready.length}`);
if (nothingToDo.length) console.log(`  ${DIM}no dependencies${RST} ...... ${nothingToDo.length} ${DIM}(nothing to install)${RST}`);
if (needsConfirm.length) {
  console.log(`  ${YEL}needs confirmation${RST} ... ${needsConfirm.length}`);
  for (const s of needsConfirm.slice(0, 10)) console.log(`      ${YEL}·${RST} ${s}`);
  if (needsConfirm.length > 10) console.log(`      ${DIM}… and ${needsConfirm.length - 10} more${RST}`);
  console.log(`  ${DIM}heavy downloads or sudo: re-run with --confirm-heavy to accept${RST}`);
}
if (failed.length) {
  console.log(`  ${RED}failed${RST} ............... ${failed.length}`);
  for (const s of failed.slice(0, 10)) console.log(`      ${RED}✗${RST} ${s}`);
  if (failed.length > 10) console.log(`      ${DIM}… and ${failed.length - 10} more${RST}`);
  console.log(`  ${DIM}inspect one with: nrv activate <slug> --verbose${RST}`);
}
console.log("");

process.exit(failed.length ? 1 : needsConfirm.length ? 2 : 0);
