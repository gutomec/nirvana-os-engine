#!/usr/bin/env bun
// memory.ts — `nrv memory`: memória cross-session temporal (supersede-never-delete).
//
//   nrv memory add <business> "<statement>" [--source <s>] [--supersedes <id>]
//   nrv memory list <business> [--all]
//   nrv memory supersede <id> --by <newId>
//
// Fatos vigentes (superseded_by IS NULL) são recuperados no prompt do employee.
// Nada é apagado: mudar um fato = inserir o novo e marcar o antigo como superseded.

import { resolveScope } from "../../_shared/lib/scope.ts";
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
} else {
  console.error("uso: nrv memory <add|list|supersede> ...");
  process.exit(2);
}
process.exit(0);
