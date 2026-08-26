#!/usr/bin/env bun
// check-organizational-non-regression.ts — the entity test suites must leave
// the installed organization untouched.
//
// Criterion 8 of the program (docs/architecture/implementation-status.md):
// the tests of existing businesses, squads and mind-clones pass without a
// destructive migration. This gate proves it mechanically instead of by
// reading the suites: it snapshots every file under the installed roots (the
// roots the engine itself resolves through resolveRoots — businesses, the DNA
// library, squads), runs `bun test` over the entity suites, snapshots again
// and fails on any difference, listing the paths. A machine without installed
// entities has nothing to protect and passes with a note.
//
// Inside the roots, .git and node_modules are not walked: a squad may vendor
// its dependencies (tens of thousands of files no suite touches), and
// check-engine-purity skips the same names. Symlinks are recorded by target,
// never followed.
//
// Usage:
//   bun scripts/check-organizational-non-regression.ts
//   bun scripts/check-organizational-non-regression.ts --strict   # same exit codes; parity with the other checks
//   --roots <dir,dir>    snapshot these roots instead of the installed ones (hermetic tests)
//   --suites <dir,dir>   run these suites instead of the entity suites (hermetic tests)
//
// Exit 1 when a suite fails or a root changed; exit 0 otherwise. The gate is
// never report-only: a modified root is the regression it exists to catch.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRoots } from "../skills/_shared/lib/entity-graph.ts";
import { diffTreeSnapshots, snapshotTree } from "../skills/_shared/lib/tree-digest.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = homedir();
const argv = process.argv.slice(2);
const strict = argv.includes("--strict");

const SKIP_DIRS = new Set([".git", "node_modules"]);
const ENTITY_SUITES = ["skills/businesses", "skills/squads", "skills/_shared"];

function listFlag(name: string): string[] | null {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return (argv[index + 1] ?? "").split(",").map((item) => item.trim()).filter(Boolean).map((item) => resolve(item));
}

const live = resolveRoots();
const roots = listFlag("--roots") ?? [live.businessesDir, live.clonesDir, live.squadsDir!];
const suites = listFlag("--suites") ?? ENTITY_SUITES;
const short = (file: string) => (file.startsWith(HOME) ? `~${file.slice(HOME.length)}` : file);

console.log(`ORGANIZATIONAL NON-REGRESSION${strict ? " (--strict)" : ""}`);
console.log(`  roots ........... ${roots.map(short).join(", ")}`);
console.log(`  suites .......... ${suites.map(short).join(", ")}`);

const present = roots.filter((root) => existsSync(root));
if (present.length === 0) {
  console.log("\nORGANIZATIONAL NON-REGRESSION: OK — no businesses, squads or mind-clones are installed here; nothing to protect.");
  process.exit(0);
}

const before = snapshotTree(present, { skipDirs: SKIP_DIRS });
console.log(`  snapshot ........ ${before.size} entries`);

const started = Date.now();
const run = Bun.spawnSync([process.execPath, "test", ...suites], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
const output = `${run.stdout.toString()}\n${run.stderr.toString()}`.trim();
const summary = output.split("\n").map((line) => line.trim()).filter((line) => /^\d+ (pass|fail|skip)$|^Ran \d+ tests?/.test(line));
console.log(`  run ............. exit ${run.exitCode} in ${((Date.now() - started) / 1000).toFixed(1)}s${summary.length ? ` · ${summary.join(" · ")}` : ""}`);

const after = snapshotTree(present, { skipDirs: SKIP_DIRS });
const diff = diffTreeSnapshots(before, after);
const differences = diff.added.length + diff.removed.length + diff.changed.length;
console.log(`  difference ...... ${differences} path(s)`);
console.log("");

if (run.exitCode !== 0) console.error(`${output.split("\n").slice(-40).join("\n")}\n`);
for (const [label, files] of [["added", diff.added], ["removed", diff.removed], ["changed", diff.changed]] as const) {
  for (const file of files) console.error(`  ${label.padEnd(8)}${short(file)}`);
}
if (run.exitCode !== 0 || differences > 0) {
  const why = [
    run.exitCode !== 0 ? `suites exited ${run.exitCode}` : "",
    differences > 0 ? `${differences} path(s) differ under the installed roots` : "",
  ].filter(Boolean).join("; ");
  console.error(`ORGANIZATIONAL NON-REGRESSION: FAIL — ${why}`);
  process.exit(1);
}
console.log("ORGANIZATIONAL NON-REGRESSION: OK — the entity suites passed and left the installed roots untouched.");
