#!/usr/bin/env bun
/**
 * list-squads.ts — list squads, scope-aware.
 *
 * Honors NIRVANA_SCOPE (global / project / merge) from <project>/.env.
 * In merge mode, project squads override global ones with the same slug.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { paths, EXIT, parseArgs } from "../../_shared/lib/bun-helpers.ts";
import { resolveScope, enumerate, describeScope } from "../../_shared/lib/scope.ts";

const { flags } = parseArgs();
const fmt = (flags.format as string) || "compact";
const showScope = !!flags["show-scope"];

const scope = resolveScope();
const entries = enumerate(scope, "squads").filter(e => !e.overridden);

if (showScope) {
  console.error(describeScope(scope));
  console.error("---");
}

// Try to enrich with registry metadata (version/protocol/caps) when available
const registryPath = paths.SQUADS_REGISTRY_PATH;
const reg = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, "utf8")) : { squads: {} };

const squads = entries.map(e => {
  const meta = reg.squads?.[e.slug] ?? {};
  return {
    name: e.slug,
    source: e.source,
    version: meta.version ?? "?",
    protocol: meta.protocol ?? "?",
    caps: (meta.capabilities ?? []).length,
    path: e.dir,
  };
});

if (fmt === "json") {
  console.log(JSON.stringify(squads, null, 2));
} else if (fmt === "table") {
  const w = Math.max(...squads.map(s => s.name.length), 8);
  console.log(`${"name".padEnd(w)}  source   version  protocol  caps  path`);
  squads.forEach(s => console.log(`${s.name.padEnd(w)}  ${s.source.padEnd(7)} v${String(s.version).padEnd(7)} ${String(s.protocol).padEnd(8)} ${String(s.caps).padEnd(4)} ${s.path}`));
} else {
  squads.forEach(s => console.log(`  [${s.source}] ${s.name} (v${s.version}, protocol ${s.protocol}, caps=${s.caps})`));
  console.log(`\n  total: ${squads.length} squads (scope=${scope.mode})`);
}
process.exit(EXIT.OK);
