#!/usr/bin/env bun
// memory.ts — `nrv memory`: memória cross-session temporal (supersede-never-delete).
//
//   nrv memory add <business> "<statement>" [--source <s>] [--supersedes <id>]
//   nrv memory list <business> [--all]
//   nrv memory supersede <id> --by <newId>
//   nrv memory gc <business> [--ttl-days N] [--sim-threshold F] [--on-conflict keep_newer|keep_both|audit_only]
//
// Fatos vigentes (superseded_by IS NULL) são recuperados no prompt do employee.
// Nada é apagado: mudar um fato = inserir o novo e marcar o antigo como superseded.

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveScope } from "../../_shared/lib/scope.ts";
import { paths } from "../../_shared/lib/bun-helpers.ts";
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
const handle = db.openDb(resolveScope().projectRoot || undefined);
if (!handle.available) { console.error("state-db indisponível (sqlite ausente)"); process.exit(1); }

if (sub === "add") {
  const business = process.argv[3];
  const statement = process.argv[4];
  if (!business || !statement || statement.startsWith("--")) {
    console.error('uso: nrv memory add <business> "<statement>" [--source <s>] [--supersedes <id>]');
    process.exit(2);
  }
  const id = db.recordMemory(handle, {
    business_slug: business, statement,
    source: arg("--source"), supersedes: arg("--supersedes"),
  });
  console.log(`memória #${id} registrada para ${business}`);
} else if (sub === "list") {
  const business = process.argv[3];
  if (!business) { console.error("uso: nrv memory list <business> [--all]"); process.exit(2); }
  const all = process.argv.includes("--all");
  const rows = all ? db.listMemoryHistory(handle, business) : db.activeMemories(handle, business);
  if (!rows.length) { console.log(`(sem memória ${all ? "" : "ativa "}para ${business})`); }
  for (const r of rows) {
    const sup = r.superseded_by ? ` [superseded→#${r.superseded_by}]` : "";
    console.log(`#${r.id}${sup} ${r.statement}${r.source ? ` (${r.source})` : ""}`);
  }
} else if (sub === "supersede") {
  const id = process.argv[3];
  if (!id) { console.error("uso: nrv memory supersede <id> --by <newId>"); process.exit(2); }
  db.supersedeMemory(handle, id, arg("--by") || null);
  console.log(`#${id} marcada como superseded${arg("--by") ? ` por #${arg("--by")}` : ""}`);
} else if (sub === "gc") {
  // The GC existed and the docs promised it ("TTL eviction + dedup"), but nothing
  // could reach it: no caller, no subcommand, no instruction an agent could follow.
  // A door is all it was missing — an agent asked to tidy a business's memory now
  // has a command to run, exactly like `add` and `list`.
  const business = process.argv[3];
  if (!business || business.startsWith("--")) {
    console.error("uso: nrv memory gc <business> [--ttl-days N] [--sim-threshold F] [--on-conflict keep_newer|keep_both|audit_only]");
    process.exit(2);
  }
  const { MemoryStore } = await import("../../_shared/lib/memory-store.ts");
  const { runGc } = await import("../../_shared/lib/memory-gc.ts");
  const root = path.join(paths.BUSINESSES_DIR, business, "memory");
  if (!fs.existsSync(root)) {
    console.error(`sem memória para '${business}' (${root} não existe)`);
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
  console.log(`memória de ${business}: ${report.entries_before} → ${report.entries_after} entradas`);
  if (report.ttl_evicted.length) console.log(`  expiradas por TTL: ${report.ttl_evicted.length}`);
  if (report.duplicates_merged.length) console.log(`  duplicatas unidas: ${report.duplicates_merged.length}`);
} else {
  console.error("uso: nrv memory <add|list|supersede|gc> ...");
  process.exit(2);
}
process.exit(0);
