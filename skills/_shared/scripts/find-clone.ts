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
  console.error('usage: nrv find-clone "<task>" [--limit N] [--all] [--json]');
  process.exit(task ? 0 : 2);
}

const limit = flags.limit ? parseInt(String(flags.limit), 10) || 8 : 8;
// Only clones that cover enough of the task are offered: the business-creation
// flow assigns clones from this list, and the ranking alone always puts some
// clone first at 1.00. `--all` shows the hits below the gate too, marked.
const all = Boolean(flags.all);
const hits = findCloneForTask(task, { limit, gated: !all });

if (flags.json) {
  console.log(JSON.stringify(hits, null, 2));
  process.exit(0);
}

if (!hits.length) {
  console.log("(no clone is relevant to this task — operate without a clone, default persona)");
  console.log("(`--all` lists the closest clones anyway, below the relevance gate)");
  process.exit(0);
}

console.log(`Most useful clones for: "${task}"`);
console.log("(embody in this order: requested → this ranking → default. Use `nrv ask <slug>` to inspect.)");
console.log("(the number is how many of the task's terms the clone covers)\n");
for (const h of hits) {
  const cat = h.pack_category ? `  [${h.pack_category}]` : "";
  const ol = h.one_liner ? `\n        ${h.one_liner}` : "";
  const cov = typeof h.coverage.matched === "number" ? `${h.coverage.matched}/${h.coverage.total}` : "-";
  const gate = h.below_gate ? "  (below the relevance gate)" : "";
  console.log(`  ${cov.padStart(5)}  ${h.slug}${cat}${gate}${ol}`);
}
process.exit(0);
