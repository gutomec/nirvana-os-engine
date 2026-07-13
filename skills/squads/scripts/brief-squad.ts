#!/usr/bin/env bun
/**
 * brief-squad.ts — register a brief for a squad and prepare the invocation plan.
 * Squad analogue of businesses/scripts/brief-business.ts.
 *
 * WHY THIS EXISTS (audit-trail guarantee, runtime-agnostic):
 * The agentic squad flow was "Read manifest → write enriched brief → Agent()",
 * with NO scripted step — so the ONLY way a squad dispatch left an audit trail
 * was the orchestrator agent voluntarily running `nrv audit emit dispatch_squad`.
 * Non-Claude runtimes (Codex, headless) routinely skip that, so `nrv doctor`
 * showed "no dispatches" even after real work. This script makes the audit event
 * a SIDE EFFECT of the prep step the agent must run anyway (it produces the
 * project dir + brief the subagent needs), so the trail exists on ANY runtime —
 * no reliance on the agent obeying SKILL.md.
 *
 * The actual invocation (spawning the subagent over squad.yaml + workflow) stays
 * the SKILL.md orchestrator's responsibility; this only validates + scaffolds +
 * emits the dispatch_squad / brief_received events.
 *
 * Usage:
 *   bun brief-squad.ts <slug> "<brief text>" [--project <id>]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { exec, paths, EXIT, BUN_BIN } from "../../_shared/lib/bun-helpers.ts";
import { resolveScope, enumerate, outputsDir } from "../../_shared/lib/scope.ts";

const skillDir = path.join(paths.CLAUDE_SKILLS_DIR, "squads");
const scope = resolveScope();

let slug = "";
let brief = "";
let projectId = "";

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--project") { projectId = argv[++i]; continue; }
  if (a === "-h" || a === "--help") {
    console.log('Uso: brief-squad <slug> "<brief>" [--project <id>]');
    process.exit(EXIT.OK);
  }
  if (!slug) slug = a;
  else if (!brief) brief = a;
  else { console.error(`ERRO: argumento extra '${a}'`); process.exit(EXIT.INVALID_ARGS); }
}

if (!slug || !brief) {
  console.error('Uso: brief-squad <slug> "<brief>" [--project <id>]');
  process.exit(EXIT.INVALID_ARGS);
}

const hit = enumerate(scope, "squads").find(e => e.slug === slug && !e.overridden);
const target = hit?.dir ?? path.join(paths.SQUADS_DIR, slug);
if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
  console.error(`ERRO: squad '${slug}' não encontrado (scope=${scope.mode})`);
  process.exit(EXIT.FAILURES);
}

// Validate the v5 manifest before dispatching (fail closed).
const validator = path.join(skillDir, "scripts", "validate-squad.ts");
const validate = exec(`${JSON.stringify(BUN_BIN)} ${JSON.stringify(validator)} ${JSON.stringify(target)}`, { silent: true });
if (!validate.ok) {
  console.error(validate.stdout || validate.stderr);
  process.exit(validate.code ?? EXIT.FAILURES);
}

// Project ID (auto if not given) — same shape as brief-business.
if (!projectId) {
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  projectId = `proj-${ts}-${slug}`;
}

const outputsRoot = outputsDir(scope);
const projectDir = path.join(outputsRoot, projectId, "squads", slug);
fs.mkdirSync(path.join(projectDir, "handoffs"), { recursive: true });

const briefFile = path.join(outputsRoot, projectId, "brief.md");
fs.mkdirSync(path.dirname(briefFile), { recursive: true });
const submitted = new Date().toISOString().replace(/\.\d+Z$/, "Z");
fs.writeFileSync(briefFile, `# Brief

**Squad:** ${slug}
**Project ID:** ${projectId}
**Submitted:** ${submitted}

## Conteúdo

${brief}
`);

// Audit — the whole point. Emit brief_received AND dispatch_squad with the
// normalized `squad_name` field (the improver/learning loop reads squad_name).
// Dual-write: project-local audit.jsonl + the harness daily log (so nrv glance,
// nrv doctor and validate-chain see it). This runs regardless of runtime.
const auditFile = path.join(projectDir, "audit.jsonl");
function emit(event: string, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: submitted, event, project_id: projectId, squad_name: slug, ...extra });
  fs.appendFileSync(auditFile, line + "\n");
  try {
    const { harnessLogsDir } = require(path.join(skillDir, "..", "_shared", "lib", "log-paths.ts"));
    const auditDir = path.join(harnessLogsDir({ cwd: projectDir }), submitted.slice(0, 10));
    fs.mkdirSync(auditDir, { recursive: true });
    fs.appendFileSync(path.join(auditDir, "audit.jsonl"), line + "\n");
  } catch { /* non-fatal */ }
}
emit("brief_received", { brief_chars: brief.length });
emit("dispatch_squad", { trace_id: projectId });

// Initial HANDOFF.json — minimum state to allow resume after /clear or crash.
try {
  const { writeHandoff } = require(path.join(skillDir, "..", "_shared", "lib", "handoff.js"));
  writeHandoff(projectDir, {
    project_id: projectId,
    squad_name: slug,
    phase: "plan",
    brief_original: brief,
    last_task_completed: null,
    next_task_id: null,
    decisions: [],
    open_questions: [],
    audit_log_path: "audit.jsonl",
    resumption_prompt_hint: `Project just received initial brief. Start the ${slug} squad entry workflow.`,
  });
} catch (e: any) {
  console.error(`[brief-squad] WARN: HANDOFF.json write failed: ${e.message}`);
}

console.log(`OK: brief registrado.

  Project ID:    ${projectId}
  Squad:         ${slug}
  Project dir:   ${projectDir}
  Brief file:    ${briefFile}
  Audit log:     ${auditFile}

Próximo passo (executado pela skill via Agent tool):
  Spawn um subagente sobre ${slug}/squad.yaml + workflow, com o brief acima e o
  output_path em ${projectDir}. Esperar o entregável + outputs/_SUMMARY.md.`);

process.exit(EXIT.OK);
