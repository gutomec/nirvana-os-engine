#!/usr/bin/env bun
/**
 * install-content.ts — overlay a paid pack's content onto the installed engine.
 *
 * Syncs <contentDir>/{squads,businesses,mind-clones} into ~/squads, ~/businesses
 * and ~/businesses/_library/dna. Pack-owned components fully replace their copy
 * (changed files in, removed files out); user run-state inside a component
 * (projects/, outputs/, memory/projects/, .squad-state, …) is preserved. Per-pack
 * ownership is tracked in ~/.nirvana/packs/<slug>.json, so a later update of the
 * SAME pack can drop files it removed without ever touching the user's own
 * squads/businesses/clones or another pack's components.
 *
 * Usage:
 *   bun install-content.ts <contentDir> --slug <slug> [--dry]
 *
 * <contentDir> = the pack's `starter-pack` dir (squads/ businesses/ mind-clones/).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const HOME = homedir();
const SQUADS_DIR = join(HOME, "squads");
const BUSINESSES_DIR = join(HOME, "businesses");
const DNA_DIR = join(BUSINESSES_DIR, "_library/dna");
const PACKS_DIR = join(HOME, ".nirvana", "packs");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const slugIdx = argv.indexOf("--slug");
const SLUG = slugIdx >= 0 ? (argv[slugIdx + 1] ?? "") : "";
const verIdx = argv.indexOf("--version");
const VERSION = verIdx >= 0 ? (argv[verIdx + 1] ?? null) : null;
// First positional arg, skipping flags and their values — robust even when the
// content path happens to equal the slug or version string.
const FLAGS_WITH_VALUE = new Set(["--slug", "--version"]);
let CONTENT = "";
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) { if (FLAGS_WITH_VALUE.has(argv[i])) i++; continue; }
  CONTENT = argv[i]; break;
}

if (!CONTENT || !existsSync(CONTENT)) { console.error(`install-content: contentDir inválido: ${CONTENT || "(vazio)"}`); process.exit(2); }
if (!SLUG) { console.error("install-content: --slug <slug> é obrigatório"); process.exit(2); }

// ── Engine version gate (single enforcement point) ──────────────────────────
// A pack declares the minimum engine it needs (pack.yaml: requires_engine). Both
// the first-install (setup.ts) and the update (update-pack.ts → nrv update <slug>)
// paths funnel through here, so refusing a stale engine in ONE place protects both:
// never overlay new content onto an engine too old to run it.
function cmpVer(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
function requiresEngine(): string | null {
  // pack.yaml sits beside the content dir (starter-pack/) or inside it.
  for (const p of [join(CONTENT, "..", "pack.yaml"), join(CONTENT, "pack.yaml")]) {
    try { const m = readFileSync(p, "utf8").match(/^requires_engine:\s*["']?>=?\s*([0-9][^"'\s]*)/m); if (m) return m[1]; } catch { /* next */ }
  }
  return null;
}
function engineVersion(): string | null {
  // This script lives at <skills>/_shared/scripts/; the engine VERSION at <skills>/VERSION.
  for (const p of [join(import.meta.dir, "..", "..", "VERSION"), join(HOME, ".nirvana", "skills", "VERSION")]) {
    try { const v = readFileSync(p, "utf8").trim(); if (v) return v; } catch { /* next */ }
  }
  return null;
}
{
  const req = requiresEngine();
  const eng = engineVersion();
  if (req && eng && cmpVer(eng, req) < 0) {
    console.error(`install-content: engine ${eng} é mais antigo que o exigido pelo pack '${SLUG}' (>=${req}).`);
    console.error(`  Atualize o engine primeiro:  npx @nirvana-os/cli   (ou: nrv update)`);
    console.error(`  Depois reinstale o pack:     nrv update ${SLUG}`);
    process.exit(3);
  }
}

const RSYNC = spawnSync("rsync", ["--version"], { stdio: "ignore" }).status === 0;
const RUNSTATE_EXCLUDES: Record<string, string[]> = {
  squads: ["projects", "outputs", ".squad-state", ".squads-outputs", ".wiki-brain-state", ".vercel", ".omc", "_internal"],
  businesses: ["memory/projects", ".squad-state", ".squads-outputs", ".vercel"],
  "mind-clones": [],
};

function listFilesRel(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string, base: string) => {
    for (const e of readdirSync(d)) {
      const abs = join(d, e); const rel = base ? `${base}/${e}` : e;
      let st; try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs, rel); else out.push(rel);
    }
  };
  if (existsSync(root)) walk(root, "");
  return out;
}
const isExcluded = (rel: string, ex: string[]): boolean => ex.some((e) => rel === e || rel.startsWith(e + "/"));
function hashDir(dir: string, ex: string[]): string {
  const h = createHash("sha256");
  for (const rel of listFilesRel(dir).filter((r) => !isExcluded(r, ex)).sort()) {
    h.update(rel); h.update("\0");
    try { h.update(readFileSync(join(dir, rel))); } catch { /* ignore */ }
  }
  return h.digest("hex");
}
function mirror(src: string, dst: string, ex: string[]): void {
  mkdirSync(dst, { recursive: true });
  if (RSYNC) {
    const a = ["-a", "--checksum", "--delete"]; for (const e of ex) a.push(`--exclude=${e}`); a.push(`${src}/`, `${dst}/`);
    if (spawnSync("rsync", a, { stdio: ["ignore", "ignore", "inherit"] }).status === 0) return;
  }
  const srcFiles = new Set(listFilesRel(src));
  for (const rel of listFilesRel(dst)) { if (srcFiles.has(rel) || isExcluded(rel, ex)) continue; try { rmSync(join(dst, rel), { force: true }); } catch { /* ignore */ } }
  cpSync(src, dst, { recursive: true, force: true, filter: (s) => { const rel = relative(src, s).split(sep).join("/"); return rel === "" || !isExcluded(rel, ex); } });
}

interface Manifest { slug?: string; version?: string | null; updated_at?: string; squads?: Record<string, string>; businesses?: Record<string, string>; "mind-clones"?: Record<string, string>; }
const manifestPath = join(PACKS_DIR, `${SLUG}.json`);
const man: Manifest = (() => { try { return JSON.parse(readFileSync(manifestPath, "utf8")); } catch { return {}; } })();

const availableIn = (dir: string, marker: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((e) => !e.startsWith(".") && e !== "README.md" && existsSync(join(dir, e, marker))) : [];

interface SyncRes { added: string[]; updated: string[]; unchanged: string[]; removed: string[]; hashes: Record<string, string>; }
function syncKind(kind: string, srcRoot: string, dstRoot: string, available: string[], old: Record<string, string>): SyncRes {
  const ex = RUNSTATE_EXCLUDES[kind] ?? [];
  const res: SyncRes = { added: [], updated: [], unchanged: [], removed: [], hashes: {} };
  if (available.length) mkdirSync(dstRoot, { recursive: true });
  for (const slug of available) {
    const src = join(srcRoot, slug), dst = join(dstRoot, slug);
    const h = hashDir(src, ex); res.hashes[slug] = h;
    if (!existsSync(dst)) { res.added.push(slug); if (!DRY) mirror(src, dst, ex); }
    else { const prev = old[slug] ?? hashDir(dst, ex); if (prev !== h) { res.updated.push(slug); if (!DRY) mirror(src, dst, ex); } else res.unchanged.push(slug); }
  }
  for (const slug of Object.keys(old)) { if (available.includes(slug)) continue; const dst = join(dstRoot, slug); if (existsSync(dst)) { res.removed.push(slug); if (!DRY) rmSync(dst, { recursive: true, force: true }); } }
  return res;
}

const squadsSrc = join(CONTENT, "squads"), bizSrc = join(CONTENT, "businesses"), cloneSrc = join(CONTENT, "mind-clones");
const sq = syncKind("squads", squadsSrc, SQUADS_DIR, availableIn(squadsSrc, "squad.yaml"), man.squads ?? {});
const bz = syncKind("businesses", bizSrc, BUSINESSES_DIR, availableIn(bizSrc, "business.yaml"), man.businesses ?? {});
const cl = syncKind("mind-clones", cloneSrc, DNA_DIR, availableIn(cloneSrc, "MANIFEST.yaml"), man["mind-clones"] ?? {});

const line = (l: string, r: SyncRes) => console.log(`  ${l}: ${r.added.length} new · ${r.updated.length} updated · ${r.unchanged.length} unchanged · ${r.removed.length} removed`);
console.log(`${DRY ? "[DRY] " : ""}install-content '${SLUG}' ← ${CONTENT}`);
line("squads", sq); line("businesses", bz); line("mind-clones", cl);

if (!DRY) {
  mkdirSync(PACKS_DIR, { recursive: true });
  const out: Manifest = { slug: SLUG, version: VERSION, updated_at: new Date().toISOString(), squads: sq.hashes, businesses: bz.hashes, "mind-clones": cl.hashes };
  writeFileSync(manifestPath, JSON.stringify(out, null, 2) + "\n");
  const nrv = join(HOME, ".local", "bin", "nrv");
  if (existsSync(nrv)) { console.log("  re-indexando registries..."); spawnSync(nrv, ["index"], { stdio: "inherit" }); }
}
