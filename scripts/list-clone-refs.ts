#!/usr/bin/env bun
/**
 * list-clone-refs.ts — the mind-clone slugs a set of businesses actually
 * declares, read from the declarations (not grepped from prose).
 *
 * Replaces the pack build's resolution heuristic: 556 recursive `grep -rqiw`
 * word-matches per business, which produced false positives and missed 12 of
 * tracking-360's 17 clones. One graph read answers exactly.
 *
 * Usage (bash-friendly, one slug per line):
 *   bun scripts/list-clone-refs.ts [--businesses-dir <dir>] [--business <slug>]... [--json]
 */
import { readCloneBindings, resolveRoots } from "../skills/_shared/lib/entity-graph.ts";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const businessesDir = argv.includes("--businesses-dir")
  ? argv[argv.indexOf("--businesses-dir") + 1]
  : null;
const only: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--business" && argv[i + 1]) only.push(argv[i + 1]);
}

const live = resolveRoots(null);
const roots = {
  businessesDir: businessesDir ?? live.businessesDir,
  clonesDir: live.clonesDir,
};
const scan = readCloneBindings(roots);
const slugs = new Set<string>();
const byBusiness: Record<string, string[]> = {};
for (const b of scan.bindings) {
  if (b.dangling) continue;
  if (only.length && !only.includes(b.business)) continue;
  slugs.add(b.clone);
  (byBusiness[b.business] ??= []).push(b.clone);
}

if (asJson) {
  console.log(JSON.stringify({ clones: [...slugs].sort(), by_business: byBusiness }, null, 2));
} else {
  for (const s of [...slugs].sort()) console.log(s);
}
