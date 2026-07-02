#!/usr/bin/env bun
/**
 * init-business.ts — create a business from a pre-validated template.
 *
 * Bun-first implementation for macOS/Linux/WSL/Windows. Mirrors the legacy
 * init-business.sh behavior while avoiding direct shell invocation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import { exec, ensureDir, paths, EXIT, parseArgs, BUN_BIN } from "../../_shared/lib/bun-helpers.ts";
import { resolveScope, writeDir } from "../../_shared/lib/scope.ts";

const SKILL_DIR = path.join(paths.CLAUDE_SKILLS_DIR, "businesses");
const TYPES_DIR = path.join(SKILL_DIR, "templates", "business-types");
// Scope-aware target: in a project (scope=project|merge) a new business is
// created in <project>/.nirvana/businesses/, NOT the global ~/businesses/.
// Falls back to global only in global scope. (paths.BUSINESSES_DIR is always
// global — using it directly here was the create-in-wrong-scope bug.)
const BUSINESSES_ROOT = writeDir(resolveScope(), "businesses");

const { positional, flags } = parseArgs();
const slug = positional[0];
const template = String(flags.template || flags.type || "");
const fromJson = flags["from-json"] ? String(flags["from-json"]) : "";
const force = Boolean(flags.force);
const nonInteractive = Boolean(flags["non-interactive"]);
const domains = flags.domains ? String(flags.domains) : "";
const description = flags.description ? String(flags.description) : "";

function listTypes(): string[] {
  if (!fs.existsSync(TYPES_DIR)) return [];
  return fs.readdirSync(TYPES_DIR).filter((name) =>
    fs.statSync(path.join(TYPES_DIR, name)).isDirectory()
  ).sort();
}

function usage(): void {
  console.error(`usage: init-business <slug> [--template <type>|--type <type>] [--from-json <path>] [--non-interactive] [--domains a,b] [--description <s>] [--force]

Available types: ${listTypes().join(", ") || "(none)"}`);
}

if (!slug || flags.help || flags.h) {
  usage();
  process.exit(slug ? EXIT.OK : EXIT.INVALID_ARGS);
}

if (!/^[a-z][a-z0-9-]+$/.test(slug)) {
  console.error(`ERROR: slug must be kebab-case: ${slug}`);
  process.exit(EXIT.INVALID_ARGS);
}

let selectedTemplate = template;
if (fromJson) {
  if (!fs.existsSync(fromJson)) {
    console.error(`ERROR: --from-json path does not exist: ${fromJson}`);
    process.exit(EXIT.INVALID_ARGS);
  }
  try {
    const spec = JSON.parse(fs.readFileSync(fromJson, "utf8"));
    selectedTemplate = String(spec.type || "solo");
  } catch {
    selectedTemplate = "solo";
  }
}

if (!selectedTemplate) {
  if (nonInteractive) {
    console.error("ERROR: --non-interactive requires --template <type>");
    usage();
    process.exit(EXIT.INVALID_ARGS);
  }
  selectedTemplate = "solo";
}

const src = path.join(TYPES_DIR, selectedTemplate);
if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
  console.error(`ERROR: unknown template '${selectedTemplate}'`);
  usage();
  process.exit(EXIT.INVALID_ARGS);
}

ensureDir(BUSINESSES_ROOT);
const target = path.join(BUSINESSES_ROOT, slug);
if (fs.existsSync(target) && !force) {
  console.error(`ERROR: ${target} already exists. Use --force to overwrite.`);
  process.exit(EXIT.FAILURES);
}
if (force) fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(src, target, { recursive: true });

// Overlay manifest fields (name, description, domains, from-json merge) — pure Bun.
const manifestPath = path.join(target, "business.yaml");
try {
  const data: Record<string, any> =
    (YAML.parse(fs.readFileSync(manifestPath, "utf8"), { uniqueKeys: false }) as any) || {};
  data.name = slug;
  if (description) data.description = description;
  if (domains) data.domains = domains.split(",").map((d) => d.trim()).filter(Boolean);
  if (fromJson) {
    const spec = JSON.parse(fs.readFileSync(fromJson, "utf8"));
    for (const k of ["description", "domains", "license", "authority_level", "operation_mode"]) {
      if (k in spec) data[k] = spec[k];
    }
  }
  fs.writeFileSync(manifestPath, YAML.stringify(data, { lineWidth: 0 }));
} catch (e) {
  fs.rmSync(target, { recursive: true, force: true });
  console.error(`ERROR: failed to overlay business.yaml: ${(e as Error).message}`);
  process.exit(EXIT.FAILURES);
}

const validation = exec(`${JSON.stringify(BUN_BIN)} ${JSON.stringify(path.join(SKILL_DIR, "lib", "loader.ts"))} ${JSON.stringify(target)}`, { silent: true });
if (!validation.ok) {
  console.error(`ERROR: validation failed for '${slug}' after scaffold.`);
  console.error(validation.stdout || validation.stderr);
  fs.rmSync(target, { recursive: true, force: true });
  process.exit(validation.code ?? EXIT.FAILURES);
}

console.log(`OK: business '${slug}' (type=${selectedTemplate}) created at ${target}`);
process.exit(EXIT.OK);
