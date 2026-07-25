#!/usr/bin/env bun
// find-clone.ts — `nrv find-clone "<tarefa>"`: rank mind-clones for a task.
//
// The agent-facing search tool the employee/squad prompt points to for the
// "se não solicitado, pesquise um clone útil" step. Thin CLI over
// findCloneForTask (BM25 over the clone registry).

import { parseArgs } from "../lib/bun-helpers.ts";
import { findCloneForTask } from "../lib/clone-search.ts";

const { positional, flags } = parseArgs();
const task = positional.join(" ").trim();

if (!task || flags.h || flags.help) {
  console.error('uso: nrv find-clone "<tarefa>" [--limit N] [--json]');
  process.exit(task ? 0 : 2);
}

const limit = flags.limit ? parseInt(String(flags.limit), 10) || 8 : 8;
const hits = findCloneForTask(task, { limit });

if (flags.json) {
  console.log(JSON.stringify(hits, null, 2));
  process.exit(0);
}

if (!hits.length) {
  console.log("(nenhum clone relevante para esta tarefa — opere sem clone, persona padrão)");
  process.exit(0);
}

console.log(`Clones mais úteis para: "${task}"`);
console.log("(incorpore com a ordem: solicitado → este ranking → padrão. Use `nrv ask <slug>` para inspecionar.)\n");
for (const h of hits) {
  const cat = h.pack_category ? `  [${h.pack_category}]` : "";
  const ol = h.one_liner ? `\n        ${h.one_liner}` : "";
  console.log(`  ${h.normalized.toFixed(2)}  ${h.slug}${cat}${ol}`);
}
process.exit(0);
