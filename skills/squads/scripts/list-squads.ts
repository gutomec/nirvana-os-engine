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

/**
 * What a squad SAYS it does, in full.
 *
 * This listing carried the slug, a version, a protocol number and a capability
 * COUNT — and nothing about the work. An orchestrator surveying the library saw
 * 224 lines of `[global] some-slug (v5.1.0, protocol 6.0, caps=3)` and could
 * decide nothing from them; the only way forward was to open all 224. So the
 * survey step that is supposed to be cheap was either useless or enormous.
 *
 * Read from the manifest rather than the registry because the registry stores a
 * capability array, not the prose. Parsed, never grepped: `description: >-` is
 * a folded scalar and a grep returns its first physical line.
 */
function manifestOf(dir: string | undefined): { description: string; domains: string[]; produces: string[] } {
  const empty = { description: "", domains: [] as string[], produces: [] as string[] };
  if (!dir) return empty;
  try {
    const y = Bun.YAML.parse(fs.readFileSync(path.join(dir, "squad.yaml"), "utf8")) as any;
    const caps = Array.isArray(y?.capabilities) ? y.capabilities : [];
    const domains = [...new Set(caps.flatMap((c: any) => Array.isArray(c?.domains) ? c.domains : []))].map(String);
    const produces = [...new Set(caps.flatMap((c: any) => Array.isArray(c?.produces) ? c.produces : []))].map(String);
    return {
      description: typeof y?.description === "string" ? y.description.replace(/\s+/g, " ").trim() : "",
      domains, produces,
    };
  } catch { return empty; }
}

const squads = entries.map(e => {
  const meta = reg.squads?.[e.slug] ?? {};
  const m = manifestOf(e.dir);
  return {
    name: e.slug,
    source: e.source,
    version: meta.version ?? "?",
    protocol: meta.protocol ?? "?",
    caps: (meta.capabilities ?? []).length,
    description: m.description,
    domains: m.domains,
    produces: m.produces,
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
  // Full by default: this listing is read by the orchestrator surveying the
  // library, and a truncated description hides exactly the part that
  // discriminates. `--short` is for a human scrolling a terminal.
  const short = !!flags.short;
  squads.forEach(s => {
    console.log(`  [${s.source}] ${s.name} (v${s.version}, protocol ${s.protocol}, caps=${s.caps})`);
    if (short || !s.description) return;
    console.log(`      ${s.description}`);
  });
  console.log(`\n  total: ${squads.length} squads (scope=${scope.mode})`);
}
process.exit(EXIT.OK);
