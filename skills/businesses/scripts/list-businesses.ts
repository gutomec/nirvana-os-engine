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

// One line of what the business is, beside its slug: a runtime asked "which
// businesses do I have" used to go digging in the registry and the manifests
// for it (measured on Antigravity, 2026-09-16: a private lister, five registry
// reads). The first sentence of `description`, capped, from the manifest.
function blurb(text: string | undefined): string {
  if (!text) return "";
  const first = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "";
  return first.length > 96 ? first.slice(0, 93).trimEnd() + "…" : first;
}
function blurbOf(dir: string | undefined): string {
  if (!dir) return "";
  try {
    // Parsed, not grepped: a folded scalar (`description: >-`) is common here.
    const doc = Bun.YAML.parse(fs.readFileSync(path.join(dir, "business.yaml"), "utf8")) as { description?: unknown } | null;
    return blurb(typeof doc?.description === "string" ? doc.description : "");
  } catch { return ""; }
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
      const what = blurb(e.description) || blurbOf(e.manifest_path ? path.dirname(e.manifest_path) : undefined);
      console.log(`  [global] ${s}${what ? ` — ${what}` : ""} (v${e.version}, protocol ${e.protocol}, employees ${e.employee_count ?? "?"})`);
    }
    console.log(`\n  total: ${slugs.length} businesses (scope=global)`);
  }
  process.exit(EXIT.OK);
}

if (fmt === "json") {
  console.log(JSON.stringify(entries.map(e => ({ slug: e.slug, description: blurbOf(e.dir) || undefined, source: e.source, path: e.dir })), null, 2));
} else {
  for (const e of entries) {
    const what = blurbOf(e.dir);
    console.log(`  [${e.source}] ${e.slug}${what ? ` — ${what}` : ""}  (${e.dir})`);
  }
  console.log(`\n  total: ${entries.length} businesses (scope=${scope.mode})`);
}
process.exit(EXIT.OK);
