#!/usr/bin/env bun
// gen-pack-manifest.ts — generates starter-pack/PACK-MANIFEST.json: the pack's provenance.
//
// Solves the problem: a loose business.yaml / squad.yaml / MANIFEST.yaml does not carry
// the version of the pack that delivered it. This single manifest maps pack_version → each
// component and its own version. Runs at build/re-ship time (before zipping).
//
// Usage:
//   bun gen-pack-manifest.ts <starter-pack-dir> [--version <v>] [--out <file>]
//   - <starter-pack-dir>: default = ./starter-pack (cwd) if it exists
//   - --version: default = <skills>/VERSION (single source of the pack version)
//   - --out:     default = <starter-pack-dir>/PACK-MANIFEST.json

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const raw = process.argv.slice(2);
const flags: Record<string, string> = {};
const positional: string[] = [];
for (let i = 0; i < raw.length; i++) {
  if (raw[i].startsWith("--")) { flags[raw[i].slice(2)] = raw[i + 1] ?? ""; i++; }
  else positional.push(raw[i]);
}

// _shared/scripts → skills
const skillsDir = join(import.meta.dir, "..", "..");

const sp =
  positional[0] ||
  (existsSync(join(process.cwd(), "starter-pack")) ? join(process.cwd(), "starter-pack") : "");
if (!sp || !existsSync(sp)) {
  console.error("usage: gen-pack-manifest.ts <starter-pack-dir> [--version <v>] [--out <file>]");
  console.error("  starter-pack/ not found");
  process.exit(2);
}

let version = flags.version;
if (!version) {
  const vf = join(skillsDir, "VERSION");
  version = existsSync(vf) ? readFileSync(vf, "utf8").trim() : "unknown";
}

/** First `version:` key of the manifest = the component's own version. */
function extractVersion(file: string): string {
  if (!existsSync(file)) return "0.0.0";
  const m = readFileSync(file, "utf8").match(/^\s*version:\s*['"]?([^\s'"\n]+)/m);
  return m?.[1] || "0.0.0";
}

function scan(subdir: string, manifestName: string): Array<{ slug: string; version: string }> {
  const base = join(sp, subdir);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ slug: d.name, version: extractVersion(join(base, d.name, manifestName)) }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

const businesses = scan("businesses", "business.yaml");
const squads = scan("squads", "squad.yaml");
const mind_clones = scan("mind-clones", "MANIFEST.yaml");

const manifest = {
  pack: "Nirvana-OS Genesis Circle",
  pack_version: version,
  generated_at: flags.now || new Date().toISOString(),
  counts: { businesses: businesses.length, squads: squads.length, mind_clones: mind_clones.length },
  businesses,
  squads,
  mind_clones,
};

const out = flags.out || join(sp, "PACK-MANIFEST.json");
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`✓ ${out.replace(process.env.HOME || "", "~")}`);
console.log(
  `  pack ${version} — ${businesses.length} businesses, ${squads.length} squads, ${mind_clones.length} mind-clones`,
);
