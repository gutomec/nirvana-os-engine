#!/usr/bin/env bun
/**
 * inspect-clone.ts — show details of a single mind-clone.
 *
 * Usage:
 *   bun inspect-clone.ts <slug>           # narrative summary
 *   bun inspect-clone.ts <slug> --format=json
 *   bun inspect-clone.ts <slug> --commands  # just list available commands
 *   bun inspect-clone.ts <slug> --dna       # just show DNA layer counts
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const DNA_DIR = join(HOME, "businesses/_library/dna");

const args = process.argv.slice(2);
if (args.length < 1 || args[0].startsWith("--")) {
  console.error("Usage: bun inspect-clone.ts <slug> [--format=json|--commands|--dna|--prefer=<parent_dir>]");
  process.exit(1);
}

const slug = args[0];
const format = args.find((a) => a.startsWith("--format="))?.split("=")[1] ?? "narrative";
const onlyCommands = args.includes("--commands");
const onlyDna = args.includes("--dna");
const preferParent = args.find((a) => a.startsWith("--prefer="))?.split("=")[1];

function safeIsDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

interface Candidate {
  path: string;
  parent_dir: string;
  format: "canonical" | "canonical-in-category" | "simplified-legacy";
}

// Resolve clone path across all 3 formats:
//   1. ~/businesses/_library/dna/<slug>/MANIFEST.yaml      (canonical top-level)
//   2. ~/businesses/_library/dna/<category>/<slug>/MANIFEST.yaml  (canonical-in-category)
//   3. ~/businesses/_library/dna/<category>/<slug>.md      (simplified-legacy)
function findCandidates(slug: string): Candidate[] {
  const candidates: Candidate[] = [];

  // 1. top-level canonical
  const topDir = join(DNA_DIR, slug);
  if (safeIsDir(topDir) && existsSync(join(topDir, "MANIFEST.yaml"))) {
    candidates.push({ path: topDir, parent_dir: "(top-level)", format: "canonical" });
  }

  // 2 + 3. scan categories
  let topEntries: string[] = [];
  try {
    topEntries = readdirSync(DNA_DIR).filter((e) => !e.startsWith(".") && e !== "INDEX.json");
  } catch {
    return candidates;
  }

  for (const top of topEntries) {
    const topPath = join(DNA_DIR, top);
    if (!safeIsDir(topPath)) continue;
    if (top === slug) continue; // already counted as top-level if matched
    // skip top-level canonical clones (they have MANIFEST directly) — they're not categories
    if (existsSync(join(topPath, "MANIFEST.yaml"))) continue;

    // 2. canonical-in-category: <top>/<slug>/MANIFEST.yaml
    const subPath = join(topPath, slug);
    if (safeIsDir(subPath) && existsSync(join(subPath, "MANIFEST.yaml"))) {
      candidates.push({ path: subPath, parent_dir: top, format: "canonical-in-category" });
      continue;
    }

    // 3. simplified-legacy: <top>/<slug>.md
    const mdPath = join(topPath, `${slug}.md`);
    if (existsSync(mdPath) && !safeIsDir(mdPath)) {
      candidates.push({ path: mdPath, parent_dir: top, format: "simplified-legacy" });
    }
  }

  return candidates;
}

const candidates = findCandidates(slug);

if (candidates.length === 0) {
  console.error(`mind-clone '${slug}' not found in ${DNA_DIR}`);
  console.error("");
  console.error("Searched:");
  console.error(`  - ${DNA_DIR}/${slug}/MANIFEST.yaml          (canonical top-level)`);
  console.error(`  - ${DNA_DIR}/<category>/${slug}/MANIFEST.yaml  (canonical-in-category)`);
  console.error(`  - ${DNA_DIR}/<category>/${slug}.md          (simplified-legacy)`);
  console.error("");
  console.error("Run 'nrv list-clones --format=table' to see available clones.");
  process.exit(1);
}

// If multiple candidates, pick by preference or warn
let picked: Candidate;
if (candidates.length === 1) {
  picked = candidates[0];
} else {
  // multiple — try --prefer=<parent_dir>; else prefer canonical-in-category over canonical
  if (preferParent) {
    const matched = candidates.find((c) => c.parent_dir === preferParent);
    if (!matched) {
      console.error(`--prefer=${preferParent} did not match any candidate.`);
      console.error(`Available locations: ${candidates.map((c) => c.parent_dir).join(", ")}`);
      process.exit(1);
    }
    picked = matched;
  } else {
    // Prefer canonical-in-category (typically deepened) over top-level canonical
    const inCategory = candidates.filter((c) => c.format === "canonical-in-category");
    const topLevel = candidates.filter((c) => c.format === "canonical");
    const simplified = candidates.filter((c) => c.format === "simplified-legacy");
    picked = inCategory[0] ?? topLevel[0] ?? simplified[0];

    if (format !== "json") {
      console.error(`⚠ '${slug}' exists in ${candidates.length} locations:`);
      for (const c of candidates) {
        const tag = c === picked ? " ← inspecting" : "";
        console.error(`  [${c.format}] ${c.parent_dir}/  ${c.path}${tag}`);
      }
      console.error(`  (use --prefer=<parent_dir> to select a different one)`);
      console.error("");
    }
  }
}

if (picked.format === "simplified-legacy") {
  console.error(`Note: '${slug}' is in simplified-legacy format (single .md file).`);
  console.error(`Path: ${picked.path}`);
  console.error("Convert it to canonical format first via the conversion agent.");
  process.exit(1);
}

const cloneDir = picked.path;

const manifestPath = join(cloneDir, "MANIFEST.yaml");
const agentPath = join(cloneDir, "agent/AGENT.md");
const soulPath = join(cloneDir, "agent/SOUL.md");
const dnaSchemaPath = join(cloneDir, "dna/dna-schema.md");

function readYAML(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8");
    return (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractCommands(agentMd: string): Array<{ command: string; description: string }> {
  // Parse the "## Commands" or "## Comandos" (Portuguese) table — rows like "| `/cmd` | description |"
  const cmdSection = agentMd.match(/## (?:Commands|Comandos)[^\n]*\n([\s\S]*?)(\n## |$)/);
  if (!cmdSection) return [];
  const lines = cmdSection[1].split("\n");
  const cmds: Array<{ command: string; description: string }> = [];
  for (const line of lines) {
    const m = line.match(/^\|\s*`?\/?([a-z][a-z0-9-]+)`?\s*\|\s*(.+?)\s*\|/);
    if (m && m[1] !== "command" && m[1] !== "comando") {
      cmds.push({ command: `/${m[1]}`, description: m[2] });
    }
  }
  return cmds;
}

function extractFrontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return fm;
}

const manifest = readYAML(manifestPath);
const agentMd = existsSync(agentPath) ? readFileSync(agentPath, "utf8") : "";
const soulExists = existsSync(soulPath);
const dnaExists = existsSync(dnaSchemaPath);
const fm = extractFrontmatter(agentMd);
const commands = extractCommands(agentMd);

const m = (manifest?.manifest ?? manifest?.mind_clone ?? {}) as Record<string, unknown>;
const scores = (manifest?.scores ?? (manifest?.quality as Record<string, unknown>) ?? {}) as Record<string, unknown>;
const dna = (manifest?.dna_layers ?? {}) as Record<string, number>;
const dnaTotal = Object.values(dna).reduce((s: number, v) => s + (typeof v === "number" ? v : 0), 0);

if (format === "json") {
  console.log(JSON.stringify({
    slug,
    display_name: m.display_name ?? slug,
    category: m.category,
    tags: m.tags,
    compilation_method: m.compilation_method,
    validation_verdict: manifest?.validation_verdict,
    scores,
    dna_layers: dna,
    dna_total: dnaTotal,
    artifacts: {
      manifest: existsSync(manifestPath),
      agent: existsSync(agentPath),
      soul: soulExists,
      dna_schema: dnaExists,
    },
    commands,
    description: fm.description ?? "(no description)",
    path: cloneDir,
  }, null, 2));
  process.exit(0);
}

if (onlyCommands) {
  if (commands.length === 0) {
    console.log("(no commands declared)");
  } else {
    for (const c of commands) console.log(`  ${c.command.padEnd(28)} ${c.description}`);
  }
  process.exit(0);
}

if (onlyDna) {
  console.log(`DNA Layers — ${m.display_name ?? slug}:`);
  console.log(`  L1 Philosophies:  ${dna.L1_philosophies ?? 0}`);
  console.log(`  L2 Mental Models: ${dna.L2_mental_models ?? 0}`);
  console.log(`  L3 Heuristics:    ${dna.L3_heuristics ?? 0}`);
  console.log(`  L4 Frameworks:    ${dna.L4_frameworks ?? 0}`);
  console.log(`  L5 Methodologies: ${dna.L5_methodologies ?? 0}`);
  console.log(`  TOTAL:            ${dnaTotal}`);
  process.exit(0);
}

// narrative (default)
console.log("");
console.log(`Mind-clone: ${m.display_name ?? slug}  (${slug})`);
console.log("=".repeat(60));
console.log(`Category:     ${m.category ?? "?"}`);
console.log(`Version:      ${m.version ?? "?"}`);
console.log(`Compiled by:  ${m.compiled_by ?? "?"}`);
console.log(`Method:       ${m.compilation_method ?? "?"}`);
console.log(`Verdict:      ${manifest?.validation_verdict ?? "?"}`);
console.log("");
console.log("Scores:");
console.log(`  template_compliance: ${scores.template_compliance ?? "?"}`);
console.log(`  source_coverage:     ${scores.source_coverage ?? "?"}`);
console.log(`  coherence:           ${scores.coherence ?? "?"}`);
console.log(`  completeness:        ${scores.completeness ?? "?"}`);
console.log("");
console.log(`DNA: ${dnaTotal} items (L1=${dna.L1_philosophies ?? 0}, L2=${dna.L2_mental_models ?? 0}, L3=${dna.L3_heuristics ?? 0}, L4=${dna.L4_frameworks ?? 0}, L5=${dna.L5_methodologies ?? 0})`);
console.log("");
if (m.tags && Array.isArray(m.tags) && (m.tags as string[]).length > 0) {
  console.log(`Tags: ${(m.tags as string[]).join(", ")}`);
  console.log("");
}
console.log("Artifacts:");
console.log(`  ${existsSync(manifestPath) ? "OK  " : "MISS"} MANIFEST.yaml`);
console.log(`  ${existsSync(agentPath) ? "OK  " : "MISS"} agent/AGENT.md`);
console.log(`  ${soulExists ? "OK  " : "MISS"} agent/SOUL.md`);
console.log(`  ${dnaExists ? "OK  " : "MISS"} dna/dna-schema.md`);
console.log("");
if (commands.length > 0) {
  console.log(`Commands (${commands.length}):`);
  for (const c of commands.slice(0, 15)) console.log(`  ${c.command.padEnd(28)} ${c.description.slice(0, 60)}`);
  if (commands.length > 15) console.log(`  ... and ${commands.length - 15} more`);
}
console.log("");
console.log(`Path: ${cloneDir}`);
console.log("");
console.log(`Tip: bun inspect-clone.ts ${slug} --commands  # see all commands`);
console.log(`Tip: bun inspect-clone.ts ${slug} --format=json  # full machine-readable output`);
process.exit(0);
