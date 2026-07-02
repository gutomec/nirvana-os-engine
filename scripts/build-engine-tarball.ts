#!/usr/bin/env bun
/**
 * build-engine-tarball.ts — produce the Nirvana-OS engine release asset.
 *
 * Output: dist/nirvana-os-engine.tar.gz — the engine ONLY (skills + bin +
 * installer), no content. Attach it to a GitHub release; @nirvana-os/cli
 * downloads `releases/latest/download/nirvana-os-engine.tar.gz` and installs it.
 * Engine updates ship by cutting a new GitHub release — npm is never touched.
 *
 * Layout inside the tarball (extract root):
 *   skills/{harness,businesses,squads,_shared,nirvana-os} + VERSION + EDITION
 *   bin/{nrv,nrv-gemini,nrv-hermes}
 *   scripts/install.ts
 *   package.json (engine deps + version)  +  bun.lock
 *
 * Invariants (build fails otherwise): 5 skills, ZERO deliverable content
 * (squad.yaml / business.yaml / MANIFEST.yaml outside any templates/ dir),
 * ZERO watermark.
 *
 * Usage: bun scripts/build-engine-tarball.ts [outDir]
 */
import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(SCRIPT_DIR, "..");
const OUT = resolve(process.argv[2] ?? join(SRC, "dist"));
const STAGE = join(OUT, "engine-stage");
const TARBALL = join(OUT, "nirvana-os-engine.tar.gz");

const SKILLS = ["harness", "businesses", "squads", "_shared", "nirvana-os"];
const BINARIES = ["nrv", "nrv-gemini", "nrv-hermes"];
const COPY_FILTER = (s: string): boolean =>
  !s.split(/[\\/]/).includes("node_modules") && !s.endsWith(".DS_Store") && !/\.bak\./.test(s);

const CONTENT_SIGNATURES = new Set(["squad.yaml", "business.yaml", "MANIFEST.yaml"]);
function findContentLeaks(root: string): string[] {
  const leaks: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      const rel = abs.slice(root.length + 1);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(abs); }
      else if (CONTENT_SIGNATURES.has(e.name) && !rel.split(/[\\/]/).includes("templates")) leaks.push(rel);
    }
  })(root);
  return leaks;
}

const WM_RE = /^\/\/[A-Za-z0-9_-]{22}$|^\[\/\/\]: # \([A-Za-z0-9_-]{22}\)$|^#[A-Za-z0-9_-]{22}$/m;
function findWatermarks(root: string): string[] {
  const hits: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(abs); }
      else { try { if (WM_RE.test(readFileSync(abs, "utf8"))) hits.push(abs.slice(root.length + 1)); } catch { /* binary */ } }
    }
  })(root);
  return hits;
}

console.log("Building Nirvana-OS engine tarball");
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

// skills (no starter-pack)
mkdirSync(join(STAGE, "skills"), { recursive: true });
for (const s of SKILLS) {
  const from = join(SRC, "skills", s);
  if (!existsSync(from)) throw new Error(`missing skill: ${from}`);
  cpSync(from, join(STAGE, "skills", s), { recursive: true, filter: COPY_FILTER });
}
const vf = join(SRC, "skills", "VERSION");
if (existsSync(vf)) cpSync(vf, join(STAGE, "skills", "VERSION"));
// Rótulo NEUTRO do motor — nunca "Free". Quem instala um pack pago sobrescreve
// este arquivo com o nome do produto (ver packaging/pack/setup.ts).
writeFileSync(join(STAGE, "skills", "EDITION"), "Nirvana-OS\n");

// dispatchers + installer
mkdirSync(join(STAGE, "bin"), { recursive: true });
for (const b of BINARIES) { const f = join(SRC, "bin", b); if (existsSync(f)) cpSync(f, join(STAGE, "bin", b)); }
mkdirSync(join(STAGE, "scripts"), { recursive: true });
cpSync(join(SRC, "scripts", "install.ts"), join(STAGE, "scripts", "install.ts"));

// engine manifest + lockfile
const repoPkg = JSON.parse(readFileSync(join(SRC, "package.json"), "utf8"));
const version: string = repoPkg.version;
writeFileSync(
  join(STAGE, "package.json"),
  JSON.stringify(
    { name: "nirvana-os", version, private: true, description: repoPkg.description, license: repoPkg.license, author: repoPkg.author, engines: repoPkg.engines, dependencies: repoPkg.dependencies },
    null, 2,
  ) + "\n",
);
if (existsSync(join(SRC, "bun.lock"))) cpSync(join(SRC, "bun.lock"), join(STAGE, "bun.lock"));

// invariants
const skillCount = readdirSync(join(STAGE, "skills")).filter((e) => SKILLS.includes(e)).length;
const leaks = findContentLeaks(STAGE);
const wms = findWatermarks(STAGE);
console.log(`  version:      ${version}`);
console.log(`  skills:       ${skillCount}/5`);
console.log(`  content leak: ${leaks.length === 0 ? "none (correct)" : `${leaks.length} — ERROR`}`);
console.log(`  watermark:    ${wms.length === 0 ? "clean (correct)" : `${wms.length} — ERROR`}`);
if (skillCount !== 5 || leaks.length > 0 || wms.length > 0) {
  for (const l of leaks) console.error(`  content: ${l}`);
  for (const w of wms) console.error(`  watermark: ${w}`);
  console.error("\nBuild FAILED invariants.");
  process.exit(1);
}

// CLI parity gate — the command table (commands.ts), bin/nrv and nrv.ts must agree.
const parity = spawnSync(process.execPath, [join(SRC, "scripts", "check-cli-parity.ts")], { stdio: "inherit" });
if (parity.status !== 0) { console.error("\nBuild FAILED: CLI parity drift."); process.exit(1); }

// pack
rmSync(TARBALL, { force: true });
if (spawnSync("tar", ["-czf", TARBALL, "-C", STAGE, "."], { stdio: "inherit" }).status !== 0) {
  console.error("tar failed");
  process.exit(1);
}
rmSync(STAGE, { recursive: true, force: true });
console.log(`\nOK → ${TARBALL}`);
