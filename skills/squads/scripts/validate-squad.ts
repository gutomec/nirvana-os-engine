#!/usr/bin/env bun
/**
 * validate-squad.ts — Squad Protocol Engine v5 validator (pure Bun port).
 *
 * Replaces validate-squad.sh. Branches by manifest protocol:
 *   protocol: 5.0  → capability-validator.js (Pydantic via _shared/validators)
 *   protocol: 4.0  → legacy B1-B8 + A-block checks in TS
 *
 * Usage:
 *   bun validate-squad.ts <squad-path|slug> [--report] [--runtime <id>]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { exec, paths, parseArgs, EXIT, BUN_BIN } from "../../_shared/lib/bun-helpers.ts";
import { collectFindings, writeDoctorReport } from "../lib/squad-doctor.ts";

const YAML = require("yaml");
const outputsLint = require(path.join(paths.CLAUDE_SKILLS_DIR, "_shared", "lib", "outputs-lint.js"));

const { positional, flags } = parseArgs();
if (!positional[0] || flags.h || flags.help) {
  console.error("usage: validate-squad <squad-path|slug> [--report] [--runtime <id>]");
  process.exit(positional[0] ? EXIT.OK : EXIT.INVALID_ARGS);
}

const REPORT = !!flags.report;

// Resolve slug → path if needed
let squadPath = positional[0];
if (!fs.existsSync(squadPath)) {
  const candidate = path.join(paths.SQUADS_DIR, squadPath);
  if (fs.existsSync(candidate)) squadPath = candidate;
}
squadPath = path.resolve(squadPath);

if (!fs.existsSync(squadPath) || !fs.statSync(squadPath).isDirectory()) {
  console.error(`[FAIL] Squad path does not exist: ${squadPath}`);
  process.exit(EXIT.FAILURES);
}

// Outputs-pollution lint — runs before manifest checks since it's protocol-agnostic.
const lintResult = outputsLint.lintDir(squadPath);
for (const w of lintResult.warnings) console.log(`[WARN] outputs-lint: ${w}`);
if (lintResult.errors.length > 0) {
  for (const e of lintResult.errors) console.log(`[FAIL] outputs-lint: ${e}`);
  process.exit(EXIT.FAILURES);
}

const manifestPath = path.join(squadPath, "squad.yaml");
if (!fs.existsSync(manifestPath)) {
  console.error(`[FAIL] B1: squad.yaml not found at ${squadPath}`);
  process.exit(EXIT.FAILURES);
}

// Parse manifest
let manifest: any;
try {
  manifest = YAML.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (e: any) {
  console.error(`[FAIL] B2: squad.yaml is not valid YAML: ${e.message}`);
  process.exit(EXIT.FAILURES);
}
const protocol = String(manifest?.protocol || "");

console.log(`Validating squad at: ${squadPath}`);
console.log(`Protocol: ${protocol || "unknown"}`);
console.log("================================");

// ─────────────────────────────────────────────────────────────────────
// Branch: protocol 5.0 → capability-validator.js
// ─────────────────────────────────────────────────────────────────────
if (protocol === "5.0") {
  const capValidator = path.join(paths.CLAUDE_SKILLS_DIR, "squads", "lib", "capability-validator.js");
  if (!fs.existsSync(capValidator)) {
    console.error(`[FAIL] capability-validator.js missing at ${capValidator}`);
    process.exit(2);
  }

  const r = exec(`${JSON.stringify(BUN_BIN)} ${JSON.stringify(capValidator)} squad ${JSON.stringify(squadPath)}`, { silent: true });
  const raw = (r.stdout || r.stderr || "").trim();

  let result: any;
  try {
    result = JSON.parse(raw);
  } catch {
    console.error("[FAIL] capability-validator returned non-JSON output:");
    console.error(raw);
    process.exit(EXIT.FAILURES);
  }

  const errs: string[] = result.errors || [];
  const warns: string[] = result.warnings || [];
  if (errs.length === 0) {
    console.log("[PASS] v5 manifest valid");
  } else {
    console.log(`[FAIL] v5 manifest has ${errs.length} error(s):`);
    errs.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
  }
  if (warns.length > 0) {
    console.log("");
    console.log(`Warnings (${warns.length}):`);
    warns.forEach((w, i) => console.log(`  ${i + 1}. ${w}`));
  }
  if (result.referenced_files) {
    const refs = result.referenced_files;
    const total = (refs.agents?.length || 0) + (refs.tasks?.length || 0) + (refs.workflows?.length || 0);
    const missing = [...(refs.agents || []), ...(refs.tasks || []), ...(refs.workflows || [])]
      .filter((f: any) => !f.exists).length;
    console.log("");
    console.log(`Components: ${total} referenced, ${missing} missing`);
  }

  // Auto-relatório de remediação (fidelity + portabilidade) — problemas que o
  // schema-validator não pega. "Falha silenciosa" vira relatório + ponteiro pro
  // fix. Não reprova por isso (severidade warn; não quebra o catálogo).
  try {
    const docFindings = collectFindings(squadPath);
    if (docFindings.length) {
      const rp = writeDoctorReport(squadPath, docFindings, new Date().toISOString());
      console.log("");
      console.log(`⚠ ${docFindings.length} problema(s) de fidelity/portabilidade — diagnóstico: ${rp}`);
      console.log(`  Corrigir o que for seguro: nrv fix-squad ${path.basename(squadPath)} --apply`);
    }
  } catch (e: any) { console.error(`  (squad-doctor não rodou: ${e.message})`); }

  if (REPORT) {
    console.log("");
    console.log("── Fix guidance ─────────────────────────────");
    console.log("  schema:    ~/.nirvana/skills/_shared/schemas/capability.schema.json");
    console.log("  validator: python3 ~/.nirvana/skills/_shared/validators/validators.py test");
    console.log("  template:  ~/.nirvana/skills/squads/templates/capability-block.tmpl");
    console.log("  catalog:   ~/.nirvana/skills/_shared/catalogs/CAPABILITY_CATALOG_V1.yaml");
    console.log("  reference: ~/.nirvana/skills/squads/references/12-v5-capabilities.md");
  }

  process.exit(result.valid ? EXIT.OK : EXIT.FAILURES);
}

// ─────────────────────────────────────────────────────────────────────
// Branch: protocol 4.0 (legacy) — B-checks
// ─────────────────────────────────────────────────────────────────────
let errors = 0;
let warnings = 0;

const name = String(manifest?.name || "");
const version = String(manifest?.version || "");

if (!name) {
  console.log("[FAIL] B3: name field missing");
  errors++;
} else {
  console.log(`[PASS] B3: name = ${name}`);
  if (!/^[a-z0-9-]+$/.test(name)) {
    console.log("[FAIL] B4: name format invalid (must be kebab-case)");
    errors++;
  } else {
    console.log("[PASS] B4: name format valid");
  }
}

if (!version) {
  console.log("[FAIL] B5: version field missing");
  errors++;
} else if (/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
  console.log(`[PASS] B5: version = ${version} (valid semver)`);
} else {
  console.log("[FAIL] B5: version format invalid (must be semver)");
  errors++;
}

function checkFiles(type: string, checkId: string, dir: string) {
  const files: string[] = manifest?.components?.[type] || [];
  if (files.length === 0) {
    console.log(`[INFO] ${checkId}: No ${type} defined`);
    return;
  }
  for (const file of files) {
    const inDir = path.join(squadPath, dir, file);
    const inRoot = path.join(squadPath, file);
    if (!fs.existsSync(inDir) && !fs.existsSync(inRoot)) {
      console.log(`[FAIL] ${checkId}: ${dir}/${file} not found`);
      errors++;
    }
  }
  console.log(`[PASS] ${checkId}: ${files.length} ${type} files referenced`);
}

checkFiles("agents", "B6", "agents");
checkFiles("tasks", "B7", "tasks");
checkFiles("workflows", "B8", "workflows");

console.log("");
for (const field of ["description", "author", "license", "tags", "slashPrefix"]) {
  if (manifest?.[field]) {
    console.log(`[PASS] A: ${field} present`);
  } else {
    console.log(`[WARN] A: ${field} missing (recommended)`);
    warnings++;
  }
}

if (fs.existsSync(path.join(squadPath, "README.md"))) {
  console.log("[PASS] A: README.md exists");
} else {
  console.log("[WARN] A: README.md missing");
  warnings++;
}

console.log("");
console.log("================================");
console.log(`Squad: ${name} v${version} (protocol 4.0)`);
console.log(`Blocking errors: ${errors}`);
console.log(`Warnings: ${warnings}`);
if (errors === 0) {
  console.log("Verdict: PASS");
  process.exit(EXIT.OK);
} else {
  console.log("Verdict: FAIL");
  process.exit(EXIT.FAILURES);
}
