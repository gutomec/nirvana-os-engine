#!/usr/bin/env bun
// memory.ts — `nrv memory`: memória cross-session temporal (supersede-never-delete).
//
//   nrv memory add <business> "<statement>" --scope <global|project> [--source <s>] [--supersedes <id>]
//   nrv memory list <business> [--all] [--scope <global|project>]
//   nrv memory supersede <id> --by <newId>
//   nrv memory gc <business> [--ttl-days N] [--sim-threshold F] [--on-conflict keep_newer|keep_both|audit_only]
//   nrv memory relocate [--kind businesses] [--apply]
//
// `relocate` moves curated memory OUT of the entity directories and into
// `.nirvana`. A business, a squad and a mind-clone are the product: a pack
// update, a migration or a reinstall replaces those directories whole, so memory
// kept inside them sits on a surface built to be overwritten. Dry-run by default.
//
// Fatos vigentes (superseded_by IS NULL) são recuperados no prompt do employee.
// Nada é apagado: mudar um fato = inserir o novo e marcar o antigo como superseded.

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveScope } from "../../_shared/lib/scope.ts";
import { paths } from "../../_shared/lib/bun-helpers.ts";
import { MEMORY_FILES, entityMemoryDir, globalMemoryHome, seedFromEntity } from "../../_shared/lib/entity-memory.ts";
import { createRequire } from "node:module";
const db = createRequire(import.meta.url)("../../_shared/lib/state-db.js");

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i === -1) return fallback;
  const a = process.argv[i];
  if (a.includes("=")) return a.split("=").slice(1).join("=");
  return process.argv[i + 1] || fallback;
}

const sub = process.argv[2];
const PROJECT_ROOT = resolveScope().projectRoot || undefined;

/**
 * The scope is a JUDGEMENT about the fact, never an inference from the cwd.
 *
 * `openDb(projectRoot)` answers with the project's database when it is called
 * from inside a project and the machine's otherwise, which means a fact true of
 * the business everywhere would be filed under whichever project happened to be
 * open — invisible to every other one. That is the same loss as keeping memory
 * inside the entity, one level up. So the caller states it, and there is no
 * default: an agent that has not decided has not finished thinking.
 */
function dbFor(scope: string | undefined, verb: string): any {
  if (scope !== "global" && scope !== "project") {
    console.error(`usage: nrv memory ${verb} ... --scope <global|project>`);
    console.error("  global  — true about this entity in every project (how it works, who decides, what it refuses)");
    console.error("  project — true only in this engagement (a deadline, a client preference, a one-off constraint)");
    console.error("  the scope follows the MEANING of the fact, not the directory you are in. Unsure between the two? project.");
    process.exit(2);
  }
  if (scope === "project" && !PROJECT_ROOT) {
    console.error("--scope project needs a Nirvana project (run `nrv init .`), or record it as --scope global");
    process.exit(2);
  }
  const h = db.openDb(scope === "project" ? PROJECT_ROOT : undefined);
  if (!h.available) { console.error("state-db unavailable (sqlite missing)"); process.exit(1); }
  return h;
}

// Reads default to both scopes; only a write has to commit to one.
const handle = db.openDb(PROJECT_ROOT);
if (!handle.available) { console.error("state-db unavailable (sqlite missing)"); process.exit(1); }

if (sub === "add") {
  const business = process.argv[3];
  const statement = process.argv[4];
  if (!business || !statement || statement.startsWith("--")) {
    console.error('usage: nrv memory add <business> "<statement>" [--source <s>] [--supersedes <id>]');
    process.exit(2);
  }
  const scope = arg("--scope");
  const h = dbFor(scope, "add");
  const id = db.recordMemory(h, {
    business_slug: business, statement,
    source: arg("--source"), supersedes: arg("--supersedes"),
  });
  console.log(`memory #${id} recorded for ${business} [${scope}] → ${h.path}`);
} else if (sub === "list") {
  const business = process.argv[3];
  if (!business) { console.error("usage: nrv memory list <business> [--all]"); process.exit(2); }
  const all = process.argv.includes("--all");
  const only = arg("--scope");
  // A read shows both by default: a project fact does not replace a machine
  // fact, it narrows it, and you cannot tell them apart if only one is printed.
  const wanted: Array<"global" | "project"> = only === "global" ? ["global"]
    : only === "project" ? ["project"]
    : PROJECT_ROOT ? ["global", "project"] : ["global"];
  let total = 0;
  for (const scope of wanted) {
    const h = db.openDb(scope === "project" ? PROJECT_ROOT : undefined);
    if (!h.available) continue;
    const rows = all ? db.listMemoryHistory(h, business) : db.activeMemories(h, business);
    if (!rows.length) continue;
    total += rows.length;
    console.log(`── ${scope} · ${h.path}`);
    for (const r of rows) {
      const sup = r.superseded_by ? ` [superseded→#${r.superseded_by}]` : "";
      console.log(`  #${r.id}${sup} ${r.statement}${r.source ? ` (${r.source})` : ""}`);
    }
  }
  if (!total) console.log(`(no ${all ? "" : "active "}memory for ${business})`);
} else if (sub === "supersede") {
  const id = process.argv[3];
  if (!id) { console.error("usage: nrv memory supersede <id> --by <newId>"); process.exit(2); }
  db.supersedeMemory(handle, id, arg("--by") || null);
  console.log(`#${id} marked as superseded${arg("--by") ? ` by #${arg("--by")}` : ""}`);
} else if (sub === "gc") {
  // The GC existed and the docs promised it ("TTL eviction + dedup"), but nothing
  // could reach it: no caller, no subcommand, no instruction an agent could follow.
  // A door is all it was missing — an agent asked to tidy a business's memory now
  // has a command to run, exactly like `add` and `list`.
  const business = process.argv[3];
  if (!business || business.startsWith("--")) {
    console.error("usage: nrv memory gc <business> [--ttl-days N] [--sim-threshold F] [--on-conflict keep_newer|keep_both|audit_only]");
    process.exit(2);
  }
  const { MemoryStore } = await import("../../_shared/lib/memory-store.ts");
  const { runGc } = await import("../../_shared/lib/memory-gc.ts");
  const root = path.join(paths.BUSINESSES_DIR, business, "memory");
  if (!fs.existsSync(root)) {
    console.error(`no memory for '${business}' (${root} does not exist)`);
    process.exit(1);
  }
  const store = new MemoryStore({ root });
  const ttl = arg("--ttl-days");
  const sim = arg("--sim-threshold");
  const conflict = arg("--on-conflict") as "keep_newer" | "keep_both" | "audit_only" | undefined;
  const report = await runGc(store, {
    ...(ttl ? { ttl_days: Number(ttl) } : {}),
    ...(sim ? { sim_threshold: Number(sim) } : {}),
    ...(conflict ? { on_conflict: conflict } : {}),
  });
  console.log(`memory for ${business}: ${report.entries_before} → ${report.entries_after} entries`);
  if (report.ttl_evicted.length) console.log(`  expired by TTL: ${report.ttl_evicted.length}`);
  if (report.duplicates_merged.length) console.log(`  duplicates merged: ${report.duplicates_merged.length}`);
} else if (sub === "relocate") {
  const kind = (arg("--kind") || "businesses") as "businesses" | "squads" | "mind-clones";
  const apply = process.argv.includes("--apply");
  const roots: Record<string, string> = {
    businesses: paths.BUSINESSES_DIR, squads: paths.SQUADS_DIR, "mind-clones": paths.DNA_LIBRARY,
  };
  const root = roots[kind];
  // The entity roots this walks are the machine's, so what a pack shipped about
  // them is machine-wide by construction. A fact that is only true in one project
  // is recorded as such by `nrv memory add --scope project`; it is never something
  // a bulk relocation can infer.
  let moved = 0, skipped = 0, empty = 0;
  for (const slug of (fs.existsSync(root) ? fs.readdirSync(root) : []).sort()) {
    const entityDir = path.join(root, slug);
    if (!fs.statSync(entityDir).isDirectory()) continue;
    const memDir = path.join(entityDir, "memory");
    if (!fs.existsSync(memDir)) continue;
    const dest = entityMemoryDir(kind, slug, "global");
    const pending: string[] = [];
    for (const name of MEMORY_FILES) {
      if (!fs.existsSync(path.join(memDir, name))) continue;
      if (fs.existsSync(path.join(dest, name))) { skipped++; continue; }
      pending.push(name);
    }
    if (!pending.length) { empty++; continue; }
    const bytes = pending.reduce((n, f) => n + fs.statSync(path.join(memDir, f)).size, 0);
    console.log(`${apply ? "→" : "·"} ${slug}: ${pending.join(", ")} (${bytes} B) → ${dest}`);
    if (apply) {
      const done = seedFromEntity(kind, slug, entityDir);
      moved += done.length;
    } else moved += pending.length;
  }
  console.log("");
  console.log(`${apply ? "moved" : "would move"}: ${moved} file(s) · already in place: ${skipped} · nothing to move: ${empty}`);
  console.log(`home: ${globalMemoryHome()}/memory/${kind}/<slug>/`);
  if (!apply) console.log("dry-run — re-run with --apply to copy. The entity copy is left untouched; a pack update overwrites it harmlessly.");
} else {
  console.error("usage: nrv memory <add|list|supersede|gc|relocate> ...");
  process.exit(2);
}
process.exit(0);
