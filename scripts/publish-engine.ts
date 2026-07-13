#!/usr/bin/env bun
/**
 * publish-engine.ts — stage the PUBLIC engine repo from this monorepo.
 *
 * Produces a clean staging dir containing exactly what belongs in the public
 * `nirvana-os-engine` repository, then runs hard safety gates. This is the
 * single source of the publish policy: anything not in the engine (paid content,
 * internal planning/ADRs, private notes, build cruft) is excluded here, so a
 * push can never leak it.
 *
 * Gates (build fails on any): zero watermark markers, zero deliverable content
 * (squad.yaml / business.yaml / MANIFEST.yaml outside any templates/ dir), zero
 * internal docs.
 *
 * Usage:
 *   bun scripts/publish-engine.ts [outDir]
 * Then push the staging dir to the engine repo (see the printed next steps).
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(SCRIPT_DIR, "..");
const OUT = resolve(process.argv[2] ?? join(mkdtempSync(join(tmpdir(), "nirvana-engine-")), "nirvana-os-engine"));

// Everything NOT in the public engine. Paid content, internal strategy, private
// notes, runtime data, and build cruft. rsync --exclude patterns.
const EXCLUDES = [
  ".git", ".nirvana", ".sanitization-work", "_private", "node_modules",
  "starter-pack", "packs-content", ".readme-work", "tmp", "dist", ".DS_Store", "*.bak.*",
  "docs/plans", "docs/nirvana-evolution",
  "docs/ARQUITETURA-E-REPOS.md", "docs/IDENTIDADE-E-RECONHECIMENTO-NIRVANA-OS.md",
  // Tooling do workstream de catálogo/build de packs (squads.sh): tem caminhos absolutos
  // locais + nomes de projetos privados; não é código do engine open-core.
  "scripts/build-corpus.ts", "scripts/gen-pack-contents.mjs", "scripts/gen-product-entries.mjs",
  "scripts/merge-i18n.mjs", "scripts/set-pack-descriptions.mjs", "scripts/build-all-packs.sh",
];
// Only these top-level docs/*.md are public. The gate below fails the build on
// ANY other .md in docs/, so a new internal doc can never leak even if someone
// forgets to add it to EXCLUDES (fails closed).
const ALLOWED_DOCS = new Set(["CLI.md"]);

console.log("Staging public engine repo");
console.log(`  src: ${SRC}`);
console.log(`  out: ${OUT}`);

const rsyncArgs = ["-a", "--delete"];
for (const e of EXCLUDES) rsyncArgs.push(`--exclude=${e}`);
rsyncArgs.push(`${SRC}/`, `${OUT}/`);
if (spawnSync("rsync", rsyncArgs, { stdio: ["ignore", "ignore", "inherit"] }).status !== 0) {
  console.error("rsync failed");
  process.exit(1);
}

// ── Gates ──────────────────────────────────────────────────────────────
const WM_RE = /^\/\/[A-Za-z0-9_-]{22}$|^\[\/\/\]: # \([A-Za-z0-9_-]{22}\)$|^#[A-Za-z0-9_-]{22}$/m;
const CONTENT_SIG = new Set(["squad.yaml", "business.yaml", "MANIFEST.yaml"]);
// Gate de .env: o .env pessoal do dono NUNCA é publicável. O único permitido é
// o template genérico do project-skeleton, e sem nada com cara de segredo.
const ENV_ALLOWED = join("skills", "_shared", "templates", "project-skeleton", ".env");
const SECRET_RX = /AIza[0-9A-Za-z_-]{10,}|sk-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}|xox[bap]-|AKIA[0-9A-Z]{12,}|-----BEGIN/;
const watermarks: string[] = [];
const content: string[] = [];
const envLeaks: string[] = [];
(function walk(dir: string) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    const rel = abs.slice(OUT.length + 1);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(abs); continue; }
    if (CONTENT_SIG.has(e.name) && !rel.split(/[\\/]/).includes("templates")) content.push(rel);
    if (/^\.env(\..+)?$/.test(e.name) && e.name !== ".env.example") {
      if (rel !== ENV_ALLOWED) envLeaks.push(`${rel} (não permitido)`);
      else { try { if (SECRET_RX.test(readFileSync(abs, "utf8"))) envLeaks.push(`${rel} (segredo no template!)`); } catch { /* binary */ } }
    }
    try { if (WM_RE.test(readFileSync(abs, "utf8"))) watermarks.push(rel); } catch { /* binary */ }
  }
})(OUT);

const docsDir = join(OUT, "docs");
const strayDocs = existsSync(docsDir)
  ? readdirSync(docsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md") && !ALLOWED_DOCS.has(e.name))
      .map((e) => `docs/${e.name}`)
  : [];
const internalDocs = [
  ...["docs/plans", "docs/nirvana-evolution", "_private"].filter((d) => existsSync(join(OUT, d))),
  ...strayDocs,
];

console.log(`  watermark:     ${watermarks.length === 0 ? "clean" : `${watermarks.length} — ERROR`}`);
console.log(`  content leak:  ${content.length === 0 ? "none" : `${content.length} — ERROR`}`);
console.log(`  internal docs: ${internalDocs.length === 0 ? "none" : internalDocs.join(", ") + " — ERROR"}`);
console.log(`  .env gate:     ${envLeaks.length === 0 ? "clean" : `${envLeaks.length} — ERROR`}`);

if (watermarks.length || content.length || internalDocs.length || envLeaks.length) {
  for (const w of watermarks) console.error(`  watermark: ${w}`);
  for (const c of content) console.error(`  content:   ${c}`);
  for (const ev of envLeaks) console.error(`  .env:      ${ev}`);
  console.error("\nPublish FAILED gates. Nothing staged for push.");
  process.exit(1);
}

console.log(`\nOK. Staged at: ${OUT}`);
console.log("Next (push to the PUBLIC engine repo, replacing history):");
console.log(`  cd ${OUT} && git init -q -b main && git add -A \\`);
console.log(`    && git commit -q -m "<message>" \\`);
console.log(`    && git push --force https://github.com/gutomec/nirvana-os-engine.git main`);
