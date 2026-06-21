#!/usr/bin/env bun
/**
 * build-content-pack.ts — build a content-only paid pack artifact.
 *
 * Output: dist/<slug>-pack/ — starter-pack content + a generic setup.ts +
 * pack.yaml. Carries NO engine. The pack installs on top of the engine
 * (npx @nirvana-os/cli) via its setup.ts. This is the base that squads.sh
 * watermarks per-buyer; the SAME shape works for Genesis Circle and every
 * future pack — only the slug + content repo change.
 *
 * Invariants (build fails otherwise): content present, NO engine (skills/bin/scripts).
 *
 * Usage:
 *   bun scripts/build-content-pack.ts <slug> [contentDir] [outDir]
 *   e.g. bun scripts/build-content-pack.ts genesis-circle starter-pack
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(SCRIPT_DIR, "..");
const SLUG = process.argv[2] ?? "";
const CONTENT = resolve(SRC, process.argv[3] ?? "starter-pack");
const OUT = resolve(process.argv[4] ?? join(SRC, "dist", `${SLUG}-pack`));

if (!SLUG) { console.error("usage: build-content-pack.ts <slug> [contentDir] [outDir]"); process.exit(2); }
if (!existsSync(CONTENT)) { console.error(`content dir não existe: ${CONTENT}`); process.exit(1); }

const KINDS = ["squads", "businesses", "mind-clones"];
const COPY_FILTER = (s: string): boolean =>
  !s.split(/[\\/]/).includes("node_modules") && !s.endsWith(".DS_Store") && !/\.bak\./.test(s);

console.log(`Building content pack '${SLUG}'`);
console.log(`  content: ${CONTENT}`);
console.log(`  out:     ${OUT}`);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "starter-pack"), { recursive: true });

let components = 0;
for (const k of KINDS) {
  const from = join(CONTENT, k);
  if (!existsSync(from)) continue;
  cpSync(from, join(OUT, "starter-pack", k), { recursive: true, filter: COPY_FILTER });
  components += readdirSync(from).filter((e) => !e.startsWith(".") && e !== "README.md").length;
}

const engineVer = JSON.parse(readFileSync(join(SRC, "package.json"), "utf8")).version;
writeFileSync(join(OUT, "pack.yaml"), `slug: ${SLUG}\nrequires_engine: ">=${engineVer}"\n`);
cpSync(join(SRC, "packaging", "pack", "setup.ts"), join(OUT, "setup.ts"));

// invariant: no engine in a content pack
const engineLeak = ["skills", "bin", "scripts"].filter((d) => existsSync(join(OUT, d)));

console.log(`  components:   ${components}`);
console.log(`  engine leak:  ${engineLeak.length === 0 ? "none (correct)" : engineLeak.join(",") + " — ERROR"}`);
if (components === 0 || engineLeak.length > 0) {
  console.error("\nBuild FAILED invariants.");
  process.exit(1);
}
console.log(`\nOK → ${OUT}`);
