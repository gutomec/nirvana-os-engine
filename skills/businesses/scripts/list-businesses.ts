#!/usr/bin/env bun
/**
 * list-businesses.ts — list businesses, scope-aware (project / global / merge).
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { paths, parseArgs, EXIT } from "../../_shared/lib/bun-helpers.ts";
import { resolveScope, enumerate, describeScope } from "../../_shared/lib/scope.ts";

const { flags } = parseArgs();
const fmt = (flags.format as string) || "compact";
const showScope = !!flags["show-scope"];

const scope = resolveScope();
const entries = enumerate(scope, "businesses").filter(e => !e.overridden);

if (showScope) {
  console.error(describeScope(scope));
  console.error("---");
}

// Global scope with no project root: read the registry JSON directly (no Python).
if (scope.mode === "global" && !scope.projectRoot) {
  const regPath = paths.BUSINESSES_REGISTRY_PATH;
  const reg = fs.existsSync(regPath) ? JSON.parse(fs.readFileSync(regPath, "utf8")) : { businesses: {} };
  const slugs = Object.keys(reg.businesses ?? {}).sort();
  if (fmt === "json") {
    console.log(JSON.stringify(slugs.map(s => ({ slug: s, ...reg.businesses[s] })), null, 2));
  } else {
    for (const s of slugs) {
      const e = reg.businesses[s];
      console.log(`  [global] ${s} (v${e.version}, protocol ${e.protocol}, employees ${e.employee_count ?? "?"})`);
    }
    console.log(`\n  total: ${slugs.length} businesses (scope=global)`);
  }
  process.exit(EXIT.OK);
}

if (fmt === "json") {
  console.log(JSON.stringify(entries.map(e => ({ slug: e.slug, source: e.source, path: e.dir })), null, 2));
} else {
  for (const e of entries) console.log(`  [${e.source}] ${e.slug}  (${e.dir})`);
  console.log(`\n  total: ${entries.length} businesses (scope=${scope.mode})`);
}
process.exit(EXIT.OK);
