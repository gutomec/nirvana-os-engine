#!/usr/bin/env bun
/**
 * validate-starter.ts — comprehensive validation of all 4 starter pack components.
 *
 * Validates:
 *   1. starter-pack/squads/nirvana-squad-creator/  → squad.schema v5
 *   2. starter-pack/squads/fabrica-de-genios/      → squad.schema v5
 *   3. starter-pack/businesses/business-creator/   → business.schema v1 (Pydantic loader)
 *   4. starter-pack/mind-clones/<all>/             → mind-clone.schema (5 required fields)
 *
 * Exits 0 if all pass, 1 if any fails.
 *
 * Usage:
 *   bun scripts/validate-starter.ts
 *   bun scripts/validate-starter.ts --json
 *   bun scripts/validate-starter.ts --quiet  # only summary
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(SCRIPT_DIR, "..");
const STARTER = join(REPO_DIR, "starter-pack");

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const quiet = args.includes("--quiet");

interface ComponentResult {
  component: string;
  type: "squad" | "business" | "mind-clone";
  path: string;
  passed: boolean;
  detail: string;
  warnings?: string[];
}

const results: ComponentResult[] = [];

function log(msg: string): void {
  if (!quiet && !jsonOutput) console.log(msg);
}

function header(msg: string): void {
  if (!quiet && !jsonOutput) {
    console.log("");
    console.log(msg);
    console.log("=".repeat(Math.min(msg.length, 60)));
  }
}

function squadValidate(name: string, slug: string): ComponentResult {
  const dir = join(STARTER, "squads", slug);
  if (!existsSync(dir)) {
    return { component: name, type: "squad", path: dir, passed: false, detail: "directory missing" };
  }
  const validator = join(HOME, ".claude/skills/squads/scripts/validate-squad.ts");
  if (!existsSync(validator)) {
    return { component: name, type: "squad", path: dir, passed: false, detail: "validator missing at " + validator };
  }
  const r = spawnSync("bun", [validator, dir], { stdio: ["ignore", "pipe", "pipe"] });
  const stdout = r.stdout?.toString() ?? "";
  const stderr = r.stderr?.toString() ?? "";
  const passed = r.status === 0 && stdout.includes("[PASS]");
  const warnLine = stdout.match(/Warnings \((\d+)\):/);
  const warnings = warnLine ? Number(warnLine[1]) : 0;
  return {
    component: name,
    type: "squad",
    path: dir,
    passed,
    detail: passed ? `v5 manifest valid; ${warnings} warnings` : (stderr || stdout).slice(0, 200),
    warnings: warnings > 0 ? [`${warnings} schema warnings`] : undefined,
  };
}

function businessValidate(name: string, slug: string): ComponentResult {
  const dir = join(STARTER, "businesses", slug);
  if (!existsSync(dir)) {
    return { component: name, type: "business", path: dir, passed: false, detail: "directory missing" };
  }
  const loader = join(HOME, ".claude/skills/businesses/lib/loader.py");
  if (!existsSync(loader)) {
    return { component: name, type: "business", path: dir, passed: false, detail: "loader.py missing" };
  }
  const r = spawnSync("python3", [loader, dir], { stdio: ["ignore", "pipe", "pipe"] });
  const stdout = r.stdout?.toString() ?? "";
  const passed = r.status === 0 && stdout.startsWith("OK:");
  return {
    component: name,
    type: "business",
    path: dir,
    passed,
    detail: passed ? stdout.split("\n")[0].replace(/^OK: /, "") : stdout.slice(0, 200),
  };
}

function mindCloneValidate(slug: string): ComponentResult {
  const dir = join(STARTER, "mind-clones", slug);
  const manifestPath = join(dir, "MANIFEST.yaml");
  const requiredArtifacts = [
    "agent/AGENT.md",
    "agent/SOUL.md",
    "agent/DNA-CONFIG.yaml",
    "dna/dna-schema.md",
  ];

  if (!existsSync(dir)) {
    return { component: slug, type: "mind-clone", path: dir, passed: false, detail: "directory missing" };
  }
  if (!existsSync(manifestPath)) {
    return { component: slug, type: "mind-clone", path: dir, passed: false, detail: "MANIFEST.yaml missing" };
  }

  // Parse MANIFEST.yaml
  let manifest: Record<string, unknown>;
  try {
    const text = readFileSync(manifestPath, "utf8");
    manifest = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML.parse(text) as Record<string, unknown>;
  } catch (e) {
    return { component: slug, type: "mind-clone", path: dir, passed: false, detail: `YAML parse error: ${(e as Error).message}` };
  }

  // Check 5 required top-level fields
  const requiredFields = ["manifest", "artifacts", "scores", "validation_verdict", "dna_layers"];
  const missing = requiredFields.filter((f) => !(f in manifest));
  if (missing.length > 0) {
    return { component: slug, type: "mind-clone", path: dir, passed: false, detail: `missing fields: ${missing.join(", ")}` };
  }

  // Check manifest sub-fields
  const m = manifest.manifest as Record<string, unknown>;
  if (!m.name || !m.display_name || !m.version) {
    return { component: slug, type: "mind-clone", path: dir, passed: false, detail: "manifest.{name,display_name,version} required" };
  }

  // Check version semver
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+$/.test(m.version)) {
    return { component: slug, type: "mind-clone", path: dir, passed: false, detail: `version not semver: ${m.version}` };
  }

  // Check 4 mandatory artifacts exist
  const missingArtifacts = requiredArtifacts.filter((a) => !existsSync(join(dir, a)));
  if (missingArtifacts.length > 0) {
    return { component: slug, type: "mind-clone", path: dir, passed: false, detail: `missing artifacts: ${missingArtifacts.join(", ")}` };
  }

  // Check dna_layers minimums
  const dna = manifest.dna_layers as Record<string, number>;
  const dnaTotal = Object.values(dna).reduce((s: number, v) => s + (typeof v === "number" ? v : 0), 0);
  if (dnaTotal < 30) {
    return { component: slug, type: "mind-clone", path: dir, passed: false, detail: `DNA total too low: ${dnaTotal} (min 30)` };
  }

  // Check validation_verdict is a valid value
  const verdict = manifest.validation_verdict as string;
  const validVerdicts = ["APPROVED", "COMPILED_FROM_CANONICAL_KNOWLEDGE", "NEEDS_REVISION", "REJECTED"];
  if (!validVerdicts.includes(verdict)) {
    return { component: slug, type: "mind-clone", path: dir, passed: false, detail: `invalid verdict: ${verdict}` };
  }

  // Check scores all between 0 and 1
  const scores = manifest.scores as Record<string, number>;
  for (const k of ["template_compliance", "source_coverage", "coherence", "completeness"]) {
    const v = scores[k];
    if (typeof v !== "number" || v < 0 || v > 1) {
      return { component: slug, type: "mind-clone", path: dir, passed: false, detail: `scores.${k} out of [0,1]: ${v}` };
    }
  }

  return {
    component: slug,
    type: "mind-clone",
    path: dir,
    passed: true,
    detail: `${dnaTotal} DNA items, ${verdict}, src_cov=${scores.source_coverage}`,
  };
}

// === Run validations ===

if (!existsSync(STARTER)) {
  console.error(`Starter pack not found at ${STARTER}`);
  process.exit(1);
}

header("Squads");
results.push(squadValidate("nirvana-squad-creator (NSC)", "nirvana-squad-creator"));
results.push(squadValidate("fabrica-de-genios (FdG)", "fabrica-de-genios"));
results.forEach((r) => {
  if (r.type !== "squad") return;
  log(`  [${r.passed ? "OK  " : "FAIL"}] ${r.component} — ${r.detail}`);
});

header("Businesses");
const nbcResult = businessValidate("business-creator (NBC)", "business-creator");
results.push(nbcResult);
log(`  [${nbcResult.passed ? "OK  " : "FAIL"}] ${nbcResult.component} — ${nbcResult.detail}`);

header("Mind-Clones");
const cloneDir = join(STARTER, "mind-clones");
const cloneSlugs = existsSync(cloneDir)
  ? readdirSync(cloneDir).filter((e) => {
      if (e.startsWith(".") || e === "README.md") return false;
      try { return statSync(join(cloneDir, e)).isDirectory(); } catch { return false; }
    }).sort()
  : [];

for (const slug of cloneSlugs) {
  const r = mindCloneValidate(slug);
  results.push(r);
  log(`  [${r.passed ? "OK  " : "FAIL"}] ${r.component} — ${r.detail}`);
}

// === Summary ===

const total = results.length;
const passed = results.filter((r) => r.passed).length;
const failed = total - passed;

if (jsonOutput) {
  console.log(JSON.stringify({
    total,
    passed,
    failed,
    by_type: {
      squad: results.filter((r) => r.type === "squad").length,
      business: results.filter((r) => r.type === "business").length,
      mind_clone: results.filter((r) => r.type === "mind-clone").length,
    },
    status: failed === 0 ? "PASS" : "FAIL",
    results,
  }, null, 2));
} else {
  log("");
  log("=".repeat(60));
  log(`Total: ${total}  Passed: ${passed}  Failed: ${failed}`);
  log(failed === 0 ? "STATUS: PASS — all starter components validate" : `STATUS: FAIL — ${failed} component(s) failed`);
}

process.exit(failed === 0 ? 0 : 1);
