#!/usr/bin/env bun
/**
 * index-clones.ts — build the mind-clone registry (.mind-clones-registry.json).
 *
 * Parallel to index-squads / index-businesses, which `nrv index` lacked for
 * clones. Walks the scope-resolved mind-clone library (scope.mindCloneDirs),
 * parses each canonical clone's MANIFEST.yaml, detects its persona files, and
 * writes a registry the unified resolver + task→clone search consume. Flat
 * layout: one dir per slug; the drive category lives in .pack-categories.json
 * (metadata, not path). The `match` block (one_liner / domains / when_to_use)
 * is left enrichable — populated from MANIFEST `routing:` if present, empty
 * otherwise, so the personal enrichment pass fills it incrementally.
 *
 * Scope: global → ~/.nirvana/.mind-clones-registry.json; project/merge →
 * <projectRoot>/.nirvana/.mind-clones-registry.json (project clones override).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { paths, parseArgs, EXIT } from "../lib/bun-helpers.ts";
import { resolveScope } from "../lib/scope.ts";
import { writeFileAtomic } from "../lib/atomic-write.js";

const YAML = require("yaml");

const { flags } = parseArgs();
const quiet = !!flags.quiet || !!flags.q;
/** Publishing an empty index over a populated one is refused unless asked for. */
const allowEmpty = !!flags["allow-empty"];

const scope = resolveScope();
const roots = scope.mindCloneDirs.length ? scope.mindCloneDirs : [paths.DNA_LIBRARY];

const registryDir = scope.projectRoot
  ? path.join(scope.projectRoot, ".nirvana")
  : path.join(os.homedir(), ".nirvana");
const registryPath = path.join(registryDir, ".mind-clones-registry.json");

/**
 * slug → drive category, written next to the library (by the installer, on
 * pack/clone install). Resolved PER ROOT: in project scope the clones
 * live in <project>/.nirvana/mind-clones, with their own map — reading only
 * the global one would lose the category of every project clone.
 */
function loadCatMap(root: string): Record<string, string> {
  const p = path.join(root, ".pack-categories.json");
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { /* ignore */ }
  }
  return {};
}

function readManifest(dir: string): any | null {
  for (const n of ["MANIFEST.yaml", "manifest.yaml"]) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) {
      try { return YAML.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
    }
  }
  return null;
}

function firstExisting(dir: string, rels: string[]): string | null {
  for (const r of rels) {
    const p = path.join(dir, r);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const clones: Record<string, any> = {};
let scanned = 0;
let legacyNested = 0;

function addClone(slug: string, dir: string, m: any, packCategory: string | null): void {
  scanned++;
  if (clones[slug]) return; // first wins: flat before nested, project before global
  const man = m.manifest || m;
  const persona = {
    agent: firstExisting(dir, ["agent/AGENT.md", "AGENT.md"]),
    soul: firstExisting(dir, ["agent/SOUL.md", "SOUL.md"]),
    dna_schema: firstExisting(dir, ["dna/dna-schema.md"]),
    manifest: firstExisting(dir, ["MANIFEST.yaml", "manifest.yaml"]),
  };
  // The enrichment pass writes the routing block. It is deliberately split into
  // fields that get INDEXED (positive: what this clone is for) and fields that
  // never do (negative: what it refuses, who to call instead). BM25 has no notion
  // of negation, so "do not use for direct response" indexes as a vote FOR direct
  // response — the exact defect that made two independently written blocks rank
  // first on queries they meant to repel. Keeping the negative text out of the
  // corpus fixes that structurally instead of asking every author to dodge it.
  const routing = m.routing || {};
  clones[slug] = {
    slug,
    display_name: man.display_name || slug,
    pack_category: packCategory,
    manifest_category: man.category || null,
    tags: Array.isArray(man.tags) ? man.tags : [],
    validation_verdict: m.validation_verdict || man.validation_verdict || null,
    scores: m.scores || null,
    dir,
    has_full_dna: !!(persona.agent && persona.soul),
    persona_files: persona,
    match: {
      // ── indexed ────────────────────────────────────────────────────────────
      one_liner: routing.one_liner || null,
      domains: Array.isArray(routing.domains) ? routing.domains : [],
      serves: routing.serves || null,
      // Legacy: pre-split blocks put positive AND negative prose in when_to_use.
      // Still indexed while `serves` is absent, so the 171 blocks written before
      // the split keep working; ignored by the corpus once `serves` exists.
      when_to_use: routing.when_to_use || null,
      // ── never indexed — read by the orchestrator after retrieval ───────────
      not_for: routing.not_for || null,
      delegates_to: Array.isArray(routing.delegates_to) ? routing.delegates_to : [],
      refuses: Array.isArray(routing.refuses) ? routing.refuses : [],
    },
  };
}

for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  const catMap = loadCatMap(root);
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."));

  // Pass 1 — CANONICAL layout (flat): dna/<slug>/MANIFEST.yaml.
  const notClones: typeof entries = [];
  for (const entry of entries) {
    const dir = path.join(root, entry.name);
    const m = readManifest(dir);
    if (m) addClone(entry.name, dir, m, catMap[entry.name] ?? null);
    else notClones.push(entry);
  }

  // Pass 2 — LEGACY layout (nested): dna/<category>/<slug>/MANIFEST.yaml.
  // Written by pack installs ≤ 0.1.61, when the installer nested by
  // category while this scanner only saw one level — which zeroed the roster
  // (github.com/gutomec/nirvana-os-engine/issues/2, fixed in 0.1.62).
  //
  // Liberal reader, strict writer: NOTHING is moved on disk (touching the
  // user's data during a read command would be worse than the bug). The writer
  // is already flat, so this path is compatibility only and decays on its own
  // as old installs reinstall. Flat wins on a slug tie (pass 1
  // first), and here the category comes from the parent directory itself.
  for (const catEntry of notClones) {
    const catDir = path.join(root, catEntry.name);
    let subs: typeof entries;
    try { subs = fs.readdirSync(catDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")); }
    catch { continue; } // unreadable → not a clone library
    for (const sub of subs) {
      const dir = path.join(catDir, sub.name);
      const m = readManifest(dir);
      if (!m) continue;
      legacyNested++;
      addClone(sub.name, dir, m, catMap[sub.name] ?? catEntry.name);
    }
  }
}

// EEXIST tolerated: on Windows Bun may throw it even with recursive:true.
try { fs.mkdirSync(registryDir, { recursive: true }); }
catch (e) { if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e; }
const out = {
  schema_version: "1.0",
  generated_at: new Date().toISOString(),
  scope_mode: scope.mode,
  mind_clone_roots: roots,
  count: Object.keys(clones).length,
  mind_clones: clones,
};
// A clone must not be summoned by what it refuses. The canonical case is
// `saul-steinberg`, which declared "cartum" in domains while the AGENT.md opens
// with "Não-cartunista" and treats cartoons as the failure mode: whoever routes
// by that domain gets a refusal, and the dispatch dies after it has already cost.
//
// Detecting this by reading the prose is unfeasible — two regex attempts over the
// refusal sections gave 716 false positives, because "never cast purely by
// celebrity" is a heuristic on HOW to do casting, not a refusal of casting. What
// makes the check possible is the representation: with `refuses` declared as a
// list, the contradiction becomes set intersection, with no inference at all.
//
// Warning, not error: it blocks nothing until the criterion is calibrated against
// human judgement. A gate failing on false positives teaches everyone to ignore warnings.
// A `domains` item that is not a string left the corpus without warning. The usual
// cause is a colon inside the item (`- margem de segurança: desconto sobre o valor`),
// which YAML reads as a map instead of text — the domain vanishes from the index and
// the author only notices because "o score não mexe entre reindexações". Noisy on
// purpose: it is invisible coverage loss, not a matter of style.
const malformados: string[] = [];
for (const [slug, c] of Object.entries(clones) as Array<[string, any]>) {
  for (const d of c.match?.domains || []) {
    if (typeof d !== "string") {
      malformados.push(`${slug}: a domains item is not text (${JSON.stringify(d).slice(0, 60)}) — use a comma, not a colon`);
    }
  }
}
if (malformados.length && !quiet) {
  console.warn(`[index-clones] ${malformados.length} domain(s) left out of the corpus, malformed:`);
  for (const m of malformados.slice(0, 20)) console.warn(`  ! ${m}`);
}

const contradicoes: string[] = [];
for (const [slug, c] of Object.entries(clones) as Array<[string, any]>) {
  const refuses: string[] = c.match?.refuses || [];
  const domains: string[] = c.match?.domains || [];
  if (!refuses.length || !domains.length) continue;
  const norm = (s: string) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const recusados = new Set(refuses.map(norm));
  for (const d of domains) {
    if (recusados.has(norm(d))) contradicoes.push(`${slug}: domain "${d}" is also in refuses`);
  }
}
if (contradicoes.length && !quiet) {
  console.warn(`[index-clones] ${contradicoes.length} domain(s) contradict their own refusal:`);
  for (const c of contradicoes.slice(0, 20)) console.warn(`  ! ${c}`);
}

/** How many clones the registry at `p` currently describes. -1 when absent. */
function existingCount(p: string): number {
  try {
    const n = JSON.parse(fs.readFileSync(p, "utf8"))?.count;
    return typeof n === "number" && Number.isFinite(n) ? n : -1;
  } catch { return -1; }
}

/**
 * Atomic write: a temp file in the SAME directory, then rename. rename(2) is
 * atomic within the filesystem, so a concurrent reader sees either the whole
 * old registry or the whole new one, never a truncated JSON. It matters because
 * the enrichment runs several agents in parallel and each one reindexes to
 * verify its own block — without this, two simultaneous reindexes can hand a
 * corrupted registry to a third one that was only reading.
 *
 * The floor: a scan that found NOTHING never replaces a registry that had
 * something. Going from N>0 to 0 is a misconfiguration far more often than an
 * intent — a library behind a bad mount, a wrong NIRVANA_HOME, a fixture .env —
 * and every consumer reads this file as truth, so an index describing nothing
 * makes the whole library invisible. A stale index is the lesser harm. When
 * emptying IS the intent, `--allow-empty` says so out loud.
 *
 * Staging and the rename itself live in _shared/lib/atomic-write.js, shared
 * with the squads and businesses registries, which each had their own answer
 * and two of them were wrong.
 */
function writeRegistry(target: string, label: string): boolean {
  const had = existingCount(target);
  if (out.count === 0 && had > 0 && !allowEmpty) {
    console.error(`[index-clones] REFUSED to overwrite ${label} (${had} clones) with an empty index.`);
    console.error(`[index-clones]   scanned: ${roots.join(", ") || "(no readable root)"}`);
    console.error(`[index-clones]   the clones themselves are untouched; this file is a derived cache.`);
    console.error(`[index-clones]   if emptying is intended, rerun with --allow-empty.`);
    return false;
  }
  writeFileAtomic(target, JSON.stringify(out, null, 1));
  return true;
}

writeRegistry(registryPath, "the project registry");

// Mirror into global scope: when the scan covered exactly the global library,
// the content of the two registries is identical by construction — so the
// global one is updated along. Without this, reindexing only in the project
// leaves the install blind to the new work (it happened: the global registry
// sat still for 5 days while the project one moved).
//
// Deciding "exactly the global library" used to be
// `resolve(roots[0]) === resolve(paths.DNA_LIBRARY)`, and in global mode
// `roots` IS `[paths.DNA_LIBRARY]` — a tautology. Worse, DNA_LIBRARY resolves
// through the PROJECT's .env, so a project pointing it at a local fixture
// scanned that fixture, passed the guard by construction, and published it as
// the global truth. It happened: an empty benchmark fixture took the owner's
// 617 clones out of every listing for two minutes.
//
// So the root must also live OUTSIDE the project. A directory the project
// carries is the project's, whatever a variable calls it, and it never speaks
// for the install.
const globalRegistryPath = path.join(os.homedir(), ".nirvana", ".mind-clones-registry.json");
// Does the PROJECT relocate the clone library? That is the whole attack
// surface, and naming it directly beats measuring it. `paths.DNA_LIBRARY`
// resolves through `cfg()`, which reads the project's .env, so a project that
// declares DNA_LIBRARY (or moves NIRVANA_HOME under it) is describing ITS
// library, never the install's — and must not publish it as the global truth.
//
// This replaced a path-containment test, which was right in principle and kept
// losing to the filesystem. On macOS /tmp is a symlink to /private/tmp and
// $TMPDIR sits under /private/var, so one side arrived resolved and the other
// did not; on Windows the same comparison met 8.3 short names
// (C:\Users\RUNNER~1) against their long form. Both waved the fixture through.
// Containment is kept below as a second net, now case-folded, but the decision
// no longer rests on it.
const projectEnvRelocatesLibrary = (): boolean => {
  if (!scope.projectRoot) return false;
  try {
    const env = fs.readFileSync(path.join(scope.projectRoot, ".env"), "utf8");
    return /^\s*(?:export\s+)?(?:DNA_LIBRARY|NIRVANA_HOME)\s*=/m.test(env);
  } catch { return false; }
};

const real = (p: string): string => {
  try { return fs.realpathSync(path.resolve(p)); } catch { return path.resolve(p); }
};
const insideProject = (dir: string): boolean => {
  if (!scope.projectRoot) return false;
  const fold = (x: string) => (process.platform === "win32" ? x.toLowerCase() : x);
  const rel = path.relative(fold(real(scope.projectRoot)), fold(real(dir)));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const scannedOnlyGlobalLibrary =
  roots.length === 1
  && path.resolve(roots[0]) === path.resolve(paths.DNA_LIBRARY)
  && !projectEnvRelocatesLibrary()
  && !insideProject(roots[0]);
if (registryPath !== globalRegistryPath && scannedOnlyGlobalLibrary) {
  if (writeRegistry(globalRegistryPath, "the global registry") && !quiet) {
    console.error(`[index-clones] espelhado no escopo global → ${globalRegistryPath}`);
  }
}

if (!quiet) {
  console.error(`[index-clones] scope=${scope.mode} → scanning: ${roots.join(", ")}`);
  console.error(`[index-clones] registry → ${registryPath}`);
  const enriched = Object.values(clones).filter((c: any) => c.match.one_liner).length;
  console.error(`[index-clones] ✓ ${out.count} mind-clones indexed (${scanned} scanned, ${enriched} enriched)`);
  if (legacyNested > 0) {
    console.error(`[index-clones] ⚠ ${legacyNested} clone(s) in the legacy nested layout (dna/<category>/<slug>/) — indexed normally.`);
    console.error(`[index-clones]   The canonical layout is flat (dna/<slug>/). Reinstalling the pack on 0.1.62+ normalizes it; nothing needs moving by hand.`);
  }
}
process.exit(EXIT.OK);
