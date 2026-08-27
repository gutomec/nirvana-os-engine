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
 *   bun install-content.ts <contentDir> --slug <slug> [--dry] [--skip-validate]
 *
 * <contentDir> = the pack's `starter-pack` dir (squads/ businesses/ mind-clones/).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { buildEntityGraph, installKindOrder, readCloneBindings } from "../lib/entity-graph.ts";

/** Best-effort audit emission (open x_ namespace); never blocks an install. */
function auditEmit(event: string, payload: Record<string, unknown>): void {
  try {
    const req = createRequire(import.meta.url);
    req(join(import.meta.dir, "..", "..", "harness", "lib", "audit.js")).emit(event, payload);
  } catch { /* audit unavailable (partial install) — installing still wins */ }
}

// Lazy, env-aware roots — the same resolution `installer.ts` and `paths.js` use.
// These used to be `homedir()` joins fixed at module scope, so a machine with
// NIRVANA_HOME or SQUADS_DIR set got the engine in one place and the paid
// content in another. It also made the overlay untestable by environment:
// `os.homedir()` follows `$HOME` on macOS and Linux but `%USERPROFILE%` on
// Windows, which is why a test that redirected only `HOME` passed on two
// platforms and wrote into the real profile on the third (PR #133).
function nirvanaHome(): string { return process.env.NIRVANA_HOME ?? homedir(); }
function squadsDir(): string { return process.env.SQUADS_DIR ?? join(nirvanaHome(), "squads"); }
function businessesDir(): string { return process.env.BUSINESSES_DIR ?? join(nirvanaHome(), "businesses"); }
function dnaDir(): string { return process.env.DNA_LIBRARY ?? join(businessesDir(), "_library", "dna"); }
function packsDir(): string { return join(nirvanaHome(), ".nirvana", "packs"); }

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const SKIP_VALIDATE = argv.includes("--skip-validate");
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

if (!CONTENT || !existsSync(CONTENT)) { console.error(`install-content: invalid contentDir: ${CONTENT || "(empty)"}`); process.exit(2); }
if (!SLUG) { console.error("install-content: --slug <slug> is required"); process.exit(2); }

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
  for (const p of [join(import.meta.dir, "..", "..", "VERSION"), join(homedir(), ".nirvana", "skills", "VERSION")]) {
    try { const v = readFileSync(p, "utf8").trim(); if (v) return v; } catch { /* next */ }
  }
  return null;
}
{
  const req = requiresEngine();
  const eng = engineVersion();
  if (req && eng && cmpVer(eng, req) < 0) {
    console.error(`install-content: engine ${eng} is older than the pack '${SLUG}' requires (>=${req}).`);
    console.error(`  Update the engine first:     npx @nirvana-os/cli   (or: nrv update)`);
    console.error(`  Then reinstall the pack:     nrv update ${SLUG}`);
    process.exit(3);
  }
}

const RSYNC = spawnSync("rsync", ["--version"], { stdio: "ignore" }).status === 0;
const RUNSTATE_EXCLUDES = RUN_STATE_EXCLUDES;

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

import { contractBreaks, reportBreaks, type BreakingChange } from "../lib/contract-breaks.ts";
import { InstallManifest } from "../lib/install-manifest.ts";
import { RUN_STATE_EXCLUDES } from "../lib/run-state.ts";
import { randomUUID } from "node:crypto";

interface Manifest { slug?: string; version?: string | null; updated_at?: string; squads?: Record<string, string>; businesses?: Record<string, string>; "mind-clones"?: Record<string, string>; }

/**
 * Record the install in ~/.nirvana-installed.jsonl, which is what `nrv installed`
 * replays.
 *
 * This overlay wrote only ~/.nirvana/packs/<slug>.json, and list-installed.ts
 * reads only the jsonl — two tracks that never spoke. A buyer finished a
 * successful paid install and `nrv installed` answered "No installations
 * recorded", which reads as "nothing was installed" and is the same shape as the
 * license bug: written on one track, looked for on another.
 *
 * Best-effort on purpose: the content is already on disk and correct: failing
 * the install over a bookkeeping line would trade a real problem for a
 * cosmetic one. But it says so when it cannot, which is the part that was
 * missing everywhere else.
 */
function recordInstall(m: Manifest): void {
  try {
    const items = ([["squad", m.squads], ["business", m.businesses], ["mind-clone", m["mind-clones"]]] as const)
      .flatMap(([kind, hashes]) => Object.keys(hashes ?? {}).map((slug) => ({
        kind, name: slug, slug,
        path: join(kind === "squad" ? squadsDir() : kind === "business" ? businessesDir() : dnaDir(), slug),
      })));
    new InstallManifest().append({
      ts: new Date().toISOString(),
      action: existsSync(manifestPath) && man.version ? "update" : "install",
      install_id: randomUUID(),
      kind: "pack",
      name: SLUG,
      version: m.version ?? "0.0.0",
      // A pack has no single canonical directory — uninstall walks `items`.
      source: `pack:${SLUG}`,
      path: "",
      checksum: createHash("sha256").update(JSON.stringify(items.map((i) => i.slug).sort())).digest("hex").slice(0, 16),
      scope: "global",
      items,
      prev_version: man.version ?? undefined,
    });
  } catch (e) {
    console.log(`  ⚠ could not record the install in ~/.nirvana-installed.jsonl: ${(e as Error).message}`);
    console.log(`    The pack is installed and working; 'nrv installed' just will not list it.`);
  }
}

const manifestPath = join(packsDir(), `${SLUG}.json`);
const man: Manifest = (() => { try { return JSON.parse(readFileSync(manifestPath, "utf8")); } catch { return {}; } })();

const availableIn = (dir: string, marker: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((e) => !e.startsWith(".") && e !== "README.md" && existsSync(join(dir, e, marker))) : [];

interface SyncRes { added: string[]; updated: string[]; unchanged: string[]; removed: string[]; overwritten: string[]; hashes: Record<string, string>; breaking: BreakingChange[]; }
function syncKind(kind: string, srcRoot: string, dstRoot: string, available: string[], old: Record<string, string>, precomputed?: Record<string, string>): SyncRes {
  const ex = RUNSTATE_EXCLUDES[kind] ?? [];
  const res: SyncRes = { added: [], updated: [], unchanged: [], removed: [], overwritten: [], hashes: {}, breaking: [] };
  if (available.length) mkdirSync(dstRoot, { recursive: true });
  for (const slug of available) {
    const src = join(srcRoot, slug), dst = join(dstRoot, slug);
    const h = precomputed?.[slug] ?? hashDir(src, ex); res.hashes[slug] = h;
    if (!existsSync(dst)) { res.added.push(slug); if (!DRY) mirror(src, dst, ex); }
    // Collision: it exists on disk but the pack never owned it (outside the
    // manifest) — a user creation with the same slug. The pack wins (it is the
    // source of truth) and there is no backup; warning only makes the loss
    // visible, it does not prevent it.
    else if (!(slug in old)) { res.overwritten.push(slug); if (!DRY) mirror(src, dst, ex); }
    else {
      const prev = old[slug] ?? hashDir(dst, ex);
      if (prev !== h) {
        res.updated.push(slug);
        // BEFORE the mirror: the only window when installed and incoming coexist.
        res.breaking.push(...contractBreaks(dst, src, `${kind}/${slug}`));
        if (!DRY) mirror(src, dst, ex);
      } else res.unchanged.push(slug);
    }
  }
  for (const slug of Object.keys(old)) { if (available.includes(slug)) continue; const dst = join(dstRoot, slug); if (existsSync(dst)) { res.removed.push(slug); if (!DRY) rmSync(dst, { recursive: true, force: true }); } }
  return res;
}

const squadsSrc = join(CONTENT, "squads"), bizSrc = join(CONTENT, "businesses"), cloneSrc = join(CONTENT, "mind-clones");

// Dependency-ordered install (typed entity graph): a business's employees
// embody mind-clones, so clones must be on disk BEFORE the business that
// needs them — the legacy literal order laid businesses down first and
// degraded silently when a clone was absent. The graph decides the kind
// order; a cycle (hand-crafted content) falls back to the legacy order with
// a named warning, never a throw mid-install. Execution order changed;
// PRINT order below is intentionally unchanged (buyer-visible output).
const packGraph = buildEntityGraph({ businessesDir: bizSrc, clonesDir: cloneSrc, squadsDir: squadsSrc });
const kindOrder = installKindOrder(packGraph);
if (kindOrder.has_cycle) {
  console.warn("  warning: pack entity graph has a dependency cycle; using legacy install order");
}
auditEmit("x_install_order_resolved", {
  pack: SLUG,
  kinds: kindOrder.order,
  fallback_legacy: kindOrder.has_cycle,
  nodes: packGraph.nodes.length,
  edges: packGraph.edges.length,
});

const KIND_SOURCES: Record<string, { src: string; dst: string; marker: string; entity: "squad" | "business" | "mind-clone"; recorded: Record<string, string> }> = {
  "squads": { src: squadsSrc, dst: squadsDir(), marker: "squad.yaml", entity: "squad", recorded: man.squads ?? {} },
  "businesses": { src: bizSrc, dst: businessesDir(), marker: "business.yaml", entity: "business", recorded: man.businesses ?? {} },
  "mind-clones": { src: cloneSrc, dst: dnaDir(), marker: "MANIFEST.yaml", entity: "mind-clone", recorded: man["mind-clones"] ?? {} },
};

// ── The admission gate, per entity, BEFORE anything is mirrored ─────────────
//
// Only what is actually ENTERING is checked: a slug whose source hash equals
// the one this pack recorded last time is already installed and unchanged, and
// re-judging it every update would make an install pay for the whole library.
// The hashes computed here are handed to syncKind so nothing is hashed twice.
//
// A refusal aborts the WHOLE overlay before the first file moves — a pack that
// half-installs is worse than one that does not install. And it only ever
// refuses when the buyer turned `verify.enforce_on_install` on: with the
// shipped defaults this block prints and proceeds.
const srcHashes: Record<string, Record<string, string>> = {};
const entering: Array<{ kind: string; entity: "squad" | "business" | "mind-clone"; slug: string; dir: string }> = [];
for (const [kind, k] of Object.entries(KIND_SOURCES)) {
  const ex = RUNSTATE_EXCLUDES[kind] ?? [];
  srcHashes[kind] = {};
  for (const slug of availableIn(k.src, k.marker)) {
    const dir = join(k.src, slug);
    const h = hashDir(dir, ex);
    srcHashes[kind][slug] = h;
    if (!existsSync(join(k.dst, slug)) || k.recorded[slug] !== h) entering.push({ kind, entity: k.entity, slug, dir });
  }
}
if (entering.length) {
  // Loaded lazily and defensively: a gate that cannot even be imported (a
  // partially updated engine, a skills tree mid-copy) must not be the reason
  // a paid pack fails to install.
  const verifyHook = await import("../lib/verify/index.ts")
    .then((m) => m.verifyHook)
    .catch((e) => { console.warn(`  verify: the admission gate is unavailable (${(e as Error).message}) — installing without it`); return null; });
  const refused: string[] = [];
  for (const e of verifyHook ? entering : []) {
    const gate = await verifyHook!({ kind: e.entity, target: e.dir, gate: "install", skip: SKIP_VALIDATE, stateDir: null });
    for (const line of gate.lines) console.warn(`  ${line}`);
    if (gate.blocked) refused.push(`${e.kind}/${e.slug}`);
  }
  if (refused.length) {
    console.error(`\ninstall-content: ${refused.length} component(s) were refused by the admission gate (verify.enforce_on_install):`);
    for (const r of refused) console.error(`    ✗ ${r}`);
    console.error("  Nothing was installed. Fix them with `nrv validate <kind> <slug> --fix`, or re-run with --skip-validate.\n");
    auditEmit("x_verify_install_refused", { pack: SLUG, refused });
    process.exit(1);
  }
}

const kindRuns: Record<string, () => SyncRes> = {
  "squads": () => syncKind("squads", squadsSrc, squadsDir(), availableIn(squadsSrc, "squad.yaml"), man.squads ?? {}, srcHashes["squads"]),
  "businesses": () => syncKind("businesses", bizSrc, businessesDir(), availableIn(bizSrc, "business.yaml"), man.businesses ?? {}, srcHashes["businesses"]),
  "mind-clones": () => syncKind("mind-clones", cloneSrc, dnaDir(), availableIn(cloneSrc, "MANIFEST.yaml"), man["mind-clones"] ?? {}, srcHashes["mind-clones"]),
};
const runs: Record<string, SyncRes> = {};
for (const kind of kindOrder.order) runs[kind] = kindRuns[kind]();
const sq = runs["squads"], bz = runs["businesses"], cl = runs["mind-clones"];

// A dependency the pack neither carries nor finds already installed is a
// named failure, not a silent degradation. Warning-only in P0: the hard
// gate lives in the pack build (check-clone-bindings --strict).
{
  const scan = readCloneBindings({ businessesDir: bizSrc, clonesDir: cloneSrc });
  const reported = new Set<string>();
  for (const bind of scan.bindings) {
    if (bind.dangling) continue;
    if (scan.availableClones.has(bind.clone)) continue;
    if (existsSync(join(dnaDir(), bind.clone))) continue;
    const key = `${bind.clone}|${bind.business}/${bind.employee}`;
    if (reported.has(key)) continue;
    reported.add(key);
    console.warn(`  dependency missing: mind-clone '${bind.clone}' required by ${bind.business}/${bind.employee}`);
    auditEmit("x_dependency_missing", { pack: SLUG, clone: bind.clone, required_by: `${bind.business}/${bind.employee}` });
  }
}

const line = (l: string, r: SyncRes) => console.log(`  ${l}: ${r.added.length} new · ${r.updated.length} updated · ${r.unchanged.length} unchanged · ${r.removed.length} removed${r.overwritten.length ? ` · ${r.overwritten.length} overwritten` : ""}`);
console.log(`${DRY ? "[DRY] " : ""}install-content '${SLUG}' ← ${CONTENT}`);
line("squads", sq); line("businesses", bz); line("mind-clones", cl);

// Contract breaks come BEFORE collisions: a "~ updated" does not tell a prose
// improvement from a capability that vanished, and it is the latter that makes
// the user's project stop working without anyone noticing.
reportBreaks([sq, bz, cl].flatMap((r) => r.breaking), DRY, (m) => console.log(m));

// Slug collisions in their own block: it is the only line that means loss of
// the user's work, and it drowns in the counts unless highlighted.
const collisions = ([["squads", sq], ["businesses", bz], ["mind-clones", cl]] as const)
  .flatMap(([l, r]) => r.overwritten.map((s) => `${l}/${s}`));
if (collisions.length > 0) {
  console.log();
  console.log(`  ${DRY ? "WOULD OVERWRITE" : "OVERWRITTEN"}: ${collisions.length} component(s) you created share a slug with a pack component.`);
  for (const c of collisions) console.log(`    ! ${c}`);
  console.log("    The pack is the source of truth for its own components, so it wins — and there is no backup.");
  console.log("    To keep your version, give it a different slug (your own components are never touched).");
  console.log("    Your run-state (projects/, outputs/, memory/projects) was preserved.");
}

if (!DRY) {
  mkdirSync(packsDir(), { recursive: true });
  const out: Manifest = { slug: SLUG, version: VERSION, updated_at: new Date().toISOString(), squads: sq.hashes, businesses: bz.hashes, "mind-clones": cl.hashes };
  writeFileSync(manifestPath, JSON.stringify(out, null, 2) + "\n");
  recordInstall(out);
  // Reindex: without this the content stays on disk and the orchestrator cannot
  // see it — the most expensive failure possible, because everything LOOKS installed.
  //
  // It used to try only `~/.local/bin/nrv` and skip SILENTLY when the binary
  // lived elsewhere. Now it falls back to the engine's own indexer, which is
  // where it always is: whoever gets here already has the engine, because this
  // script lives inside it.
  console.log("  re-indexing registries...");
  const nrvBin = join(homedir(), ".local", "bin", "nrv");
  const indexer = join(import.meta.dir, "..", "..", "harness", "scripts", "index.ts");
  const reindex = existsSync(nrvBin)
    ? spawnSync(nrvBin, ["index"], { stdio: "inherit" })
    : spawnSync("bun", [indexer], { stdio: "inherit" });
  if (reindex.status !== 0) {
    console.log(`  ⚠ Indexes not built (exit ${reindex.status ?? "?"}). The content is installed;`);
    console.log(`    run 'nrv index' — without them routing cannot find what was just installed.`);
  }
}
