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
import { briefExcerpt } from "../../_shared/lib/brief-excerpt.ts";

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
    console.log('Usage: brief-business <slug> "<brief>" [--project <id>] [--manifest <file>]');
    console.log('');
    console.log('  --manifest <file>   Path to a .json or .txt file listing the expected');
    console.log('                      deliverables (1 path per line in .txt; array in .json).');
    console.log('                      Lets verify-deliverable.ts validate without a regex on the brief.');
    process.exit(EXIT.OK);
  }
  if (!slug) slug = a;
  else if (!brief) brief = a;
  else { console.error(`ERROR: extra argument '${a}'`); process.exit(EXIT.INVALID_ARGS); }
}

if (!slug || !brief) {
  console.error('Usage: brief-business <slug> "<brief>" [--project <id>] [--manifest <file>]');
  process.exit(EXIT.INVALID_ARGS);
}

const hit = enumerate(scope, "businesses").find(e => e.slug === slug && !e.overridden);
const target = hit?.dir ?? path.join(paths.BUSINESSES_DIR, slug);
if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
  console.error(`ERROR: business '${slug}' not found (scope=${scope.mode})`);
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

// The event carries the trace AND a bounded excerpt of the brief. Without the
// trace it landed in buildRuns' "no-trace" bucket and the business's own run card
// read "(no brief captured)"; with only `brief_chars` there was nothing to show
// even once it arrived. `brief_chars` stays as the TRUE length beside the excerpt.
const auditFile = path.join(projectDir, "audit.jsonl");
const auditEntry = JSON.stringify({
  ts: submitted,
  event: "brief_received",
  trace_id: projectId,
  project_id: projectId,
  business_slug: slug,
  brief_excerpt: briefExcerpt(brief),
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
    console.error(`ERROR: --manifest file not found: ${manifestFile}`);
    process.exit(EXIT.FAILURES);
  }
  let manifestPaths: string[] = [];
  const raw = fs.readFileSync(manifestFile, "utf8").trim();
  if (manifestFile.endsWith(".json")) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) manifestPaths = parsed;
    else if (parsed && Array.isArray(parsed.deliverables)) manifestPaths = parsed.deliverables;
    else {
      console.error("ERROR: --manifest .json must be an array of paths or { deliverables: [...] }");
      process.exit(EXIT.FAILURES);
    }
  } else {
    // .txt — 1 path por linha; ignora linhas vazias e comments com #
    manifestPaths = raw.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  }
  if (manifestPaths.length === 0) {
    console.error("ERROR: --manifest is empty");
    process.exit(EXIT.FAILURES);
  }
  // Validate paths are absolute (verify-deliverable expects absolute)
  const invalid = manifestPaths.filter(p => !p.startsWith("/"));
  if (invalid.length > 0) {
    console.error(`ERROR: manifest contains non-absolute paths: ${invalid.slice(0, 3).join(", ")}...`);
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

// Open the dispatch run-ledger row for this agentic dispatch. Same reasoning as
// the audit events above, one layer up: the supervisor's never-forgotten
// guarantee only ever covered scripted dispatch, because only `nrv dispatch
// --exec` opened a run. An agent orchestrating in-session left the ledger empty,
// so a run that finished — or died — reached nobody. Making it a side effect of
// the prep step the agent must run anyway is what turns the guarantee from prose
// into coverage. Fail-soft: openAgenticRun warns and returns null, never throws.
//
// Not under a scripted dispatch: `nrv dispatch --exec` spawns this script only to scaffold and
// tracks the run in the ledger itself, which it states with NIRVANA_DISPATCH_TRACKS_RUN=1. The
// agentic row would then be a second one that no process closes, escalated to a human as
// stalled once its lease expired.
const trackedByDispatch = process.env.NIRVANA_DISPATCH_TRACKS_RUN === "1";
let runId: string | null = null;
if (!trackedByDispatch) {
  try {
    const { openAgenticRun } = require(path.join(skillDir, "..", "harness", "lib", "run-ledger.ts"));
    runId = openAgenticRun({
      projectId, traceId: projectId, targetSlug: slug, targetKind: "business",
      outputsRoot: projectDir, projectDir,
      meta: { opened_by: "brief-business", brief_path: briefFile },
    })?.runId ?? null;
  } catch (e: any) {
    console.error(`[brief-business] WARN: run-ledger unavailable (${e.message}) — this dispatch will not be supervised`);
  }
}

// Initial HANDOFF.json — minimum state to allow resume after /clear or crash.
try {
  const { writeHandoff } = require(path.join(skillDir, "..", "_shared", "lib", "handoff.js"));
  writeHandoff(projectDir, {
    project_id: projectId,
    business_slug: slug,
    run_id: runId,
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
  console.error(`ERROR: business '${slug}' declares no employee with is_brief_intake: true.`);
  console.error(`Edit ${path.join(target, "employees")}/*.md and add 'is_brief_intake: true' to one of them.`);
  process.exit(EXIT.FAILURES);
}

console.log(`OK: brief registered.

  Project ID:    ${projectId}
  Business:      ${slug}
  Intake:        ${intake}
  Project dir:   ${projectDir}
  Brief file:    ${briefFile}
  Audit log:     ${auditFile}
  Run ID:        ${runId ?? (trackedByDispatch ? "(tracked by the dispatch that spawned this step)" : "(not tracked — see the warning above)")}

Next step (run by the skill via the Agent tool):
  Spawn employee '${intake}' with the brief above as context. Wait for the handoff
  artifact in ${projectDir}/handoffs/.
${runId ? `
REQUIRED when you finish (this is what tells the owner it is done):
  nrv run-track close ${runId} --state delivered|withheld|failed [--error "<reason>"]` : ""}`);

process.exit(EXIT.OK);
