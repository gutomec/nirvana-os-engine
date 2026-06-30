#!/usr/bin/env bun
/**
 * brief-business.ts — register a brief for a business and prepare the
 * invocation plan. Pure Bun port of brief-business.sh.
 *
 * The actual invocation (spawning subagents) is the SKILL.md orchestrator's
 * responsibility; this script only validates + builds the initial context.
 *
 * Usage:
 *   bun brief-business.ts <slug> "<brief text>" [--project <id>]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { exec, paths, EXIT, BUN_BIN } from "../../_shared/lib/bun-helpers.ts";
import { resolveScope, enumerate, outputsDir } from "../../_shared/lib/scope.ts";

const skillDir = path.join(paths.CLAUDE_SKILLS_DIR, "businesses");
// Single scope, reused for the business lookup AND outputsDir (don't resolve twice).
const scope = resolveScope();

let slug = "";
let brief = "";
let projectId = "";
let manifestFile = "";

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--project") { projectId = argv[++i]; continue; }
  if (a === "--manifest") { manifestFile = argv[++i]; continue; }  // F11 fix
  if (a === "-h" || a === "--help") {
    console.log('Uso: brief-business <slug> "<brief>" [--project <id>] [--manifest <file>]');
    console.log('');
    console.log('  --manifest <file>   Path para arquivo .json ou .txt listando deliverables');
    console.log('                      esperados (1 path por linha em .txt; array em .json).');
    console.log('                      Permite que verify-deliverable.ts valide sem regex no brief.');
    process.exit(EXIT.OK);
  }
  if (!slug) slug = a;
  else if (!brief) brief = a;
  else { console.error(`ERRO: argumento extra '${a}'`); process.exit(EXIT.INVALID_ARGS); }
}

if (!slug || !brief) {
  console.error('Uso: brief-business <slug> "<brief>" [--project <id>] [--manifest <file>]');
  process.exit(EXIT.INVALID_ARGS);
}

const hit = enumerate(scope, "businesses").find(e => e.slug === slug && !e.overridden);
const target = hit?.dir ?? path.join(paths.BUSINESSES_DIR, slug);
if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
  console.error(`ERRO: business '${slug}' não encontrada (scope=${scope.mode})`);
  process.exit(EXIT.FAILURES);
}

// Validate
const validate = exec(`${JSON.stringify(BUN_BIN)} ${JSON.stringify(path.join(skillDir, "lib", "loader.ts"))} ${JSON.stringify(target)}`, { silent: true });
if (!validate.ok) {
  console.error(validate.stdout || validate.stderr);
  process.exit(validate.code ?? EXIT.FAILURES);
}

// Project ID (auto if not given)
if (!projectId) {
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  projectId = `proj-${ts}-${slug}`;
}

// Resolve outputs root via canonical scope helper. Defaults to
// <projectRoot>/.nirvana/outputs (or HOME fallback when not in a project).
// Honors NIRVANA_OUTPUTS_DIR override. Reuses the single `scope` resolved above.
const outputsRoot = outputsDir(scope);

const projectDir = path.join(outputsRoot, projectId, "businesses", slug);
fs.mkdirSync(path.join(projectDir, "handoffs"), { recursive: true });
fs.mkdirSync(path.join(projectDir, "tickets"), { recursive: true });
fs.mkdirSync(path.join(projectDir, "employees"), { recursive: true });

const briefFile = path.join(outputsRoot, projectId, "brief.md");
fs.mkdirSync(path.dirname(briefFile), { recursive: true });
const submitted = new Date().toISOString().replace(/\.\d+Z$/, "Z");
fs.writeFileSync(briefFile, `# Brief

**Business:** ${slug}
**Project ID:** ${projectId}
**Submitted:** ${submitted}

## Conteúdo

${brief}
`);

const auditFile = path.join(projectDir, "audit.jsonl");
const auditEntry = JSON.stringify({
  ts: submitted,
  event: "brief_received",
  project_id: projectId,
  business_slug: slug,
  brief_chars: brief.length,
});
fs.appendFileSync(auditFile, auditEntry + "\n");

// Dual-emit to the harness daily audit so nrv glance + validate-chain can see
// it. Resolves per-project when inside a project, falls back to ~/.harness-logs
// otherwise (single source of truth via lib/log-paths).
try {
  const { harnessLogsDir } = require(path.join(skillDir, "..", "_shared", "lib", "log-paths.ts"));
  const today = submitted.slice(0, 10);
  // Pass cwd (a subdir of the project), let log-paths walk up to find the
  // real root via .nirvana/.env/.git markers. Passing projectDir verbatim
  // would put logs under the deeply-nested deliverable dir.
  const auditDir = path.join(harnessLogsDir({ cwd: projectDir }), today);
  fs.mkdirSync(auditDir, { recursive: true });
  fs.appendFileSync(path.join(auditDir, "audit.jsonl"), auditEntry + "\n");
} catch { /* non-fatal */ }

// F11 fix: process --manifest if given. Writes canonical deliverables.json
// inside project dir so verify-deliverable.ts can validate without relying on
// regex-matching paths in the brief.md (which is unreliable for short briefs).
if (manifestFile) {
  if (!fs.existsSync(manifestFile)) {
    console.error(`ERRO: --manifest file não encontrado: ${manifestFile}`);
    process.exit(EXIT.FAILURES);
  }
  let manifestPaths: string[] = [];
  const raw = fs.readFileSync(manifestFile, "utf8").trim();
  if (manifestFile.endsWith(".json")) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) manifestPaths = parsed;
    else if (parsed && Array.isArray(parsed.deliverables)) manifestPaths = parsed.deliverables;
    else {
      console.error("ERRO: --manifest .json deve ser array de paths ou { deliverables: [...] }");
      process.exit(EXIT.FAILURES);
    }
  } else {
    // .txt — 1 path por linha; ignora linhas vazias e comments com #
    manifestPaths = raw.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  }
  if (manifestPaths.length === 0) {
    console.error("ERRO: --manifest está vazio");
    process.exit(EXIT.FAILURES);
  }
  // Validate paths are absolute (verify-deliverable expects absolute)
  const invalid = manifestPaths.filter(p => !p.startsWith("/"));
  if (invalid.length > 0) {
    console.error(`ERRO: manifest contém paths não-absolutos: ${invalid.slice(0, 3).join(", ")}...`);
    process.exit(EXIT.FAILURES);
  }
  // Persist as canonical deliverables.json in projectDir
  fs.writeFileSync(
    path.join(projectDir, "deliverables.json"),
    JSON.stringify({ deliverables: manifestPaths, source: "manifest-cli-flag", count: manifestPaths.length }, null, 2)
  );
  const manifestEvent = JSON.stringify({
    ts: submitted,
    event: "deliverable_manifest_registered",
    project_id: projectId,
    business_slug: slug,
    count: manifestPaths.length,
  });
  fs.appendFileSync(auditFile, manifestEvent + "\n");
}

// Initial HANDOFF.json — minimum state to allow resume after /clear or crash.
try {
  const { writeHandoff } = require(path.join(skillDir, "..", "_shared", "lib", "handoff.js"));
  writeHandoff(projectDir, {
    project_id: projectId,
    business_slug: slug,
    phase: "plan",
    brief_original: brief,
    last_task_completed: null,
    next_task_id: null,
    decisions: [],
    open_questions: [],
    audit_log_path: "audit.jsonl",
    resumption_prompt_hint: `Project just received initial brief. Start at the brief_intake employee for ${slug}.`,
  });
} catch (e: any) {
  // Non-fatal: project still usable without HANDOFF.json
  console.error(`[brief-business] WARN: HANDOFF.json write failed: ${e.message}`);
}

// Identify the brief_intake employee via the Bun loader (--field).
const loaderTs = path.join(skillDir, "lib", "loader.ts");
const r = exec(`${JSON.stringify(BUN_BIN)} ${JSON.stringify(loaderTs)} ${JSON.stringify(target)} --field intake_employee`, { silent: true });
const intake = (r.stdout || "").trim();
if (!intake) {
  console.error(`ERRO: business '${slug}' não declara nenhum employee com is_brief_intake: true.`);
  console.error(`Edite ${path.join(target, "employees")}/*.md e adicione 'is_brief_intake: true' a um deles.`);
  process.exit(EXIT.FAILURES);
}

console.log(`OK: brief registrado.

  Project ID:    ${projectId}
  Business:      ${slug}
  Intake:        ${intake}
  Project dir:   ${projectDir}
  Brief file:    ${briefFile}
  Audit log:     ${auditFile}

Próximo passo (executado pela skill via Agent tool):
  Spawn employee '${intake}' com o brief acima como context. Esperar handoff
  artifact em ${projectDir}/handoffs/.`);

process.exit(EXIT.OK);
