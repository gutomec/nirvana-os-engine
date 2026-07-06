/**
 * handoff.js — read/write HANDOFF.json + build resumption prompt.
 *
 * HANDOFF.json is the minimum state needed to reconstruct context after
 * /clear, crash, or session switch. It lives at the project root next to
 * brief.md / project-plan.json / dag-state.json — never replaces those,
 * only references them.
 *
 * Schema (v1.0):
 *   {
 *     schema_version: "1.0",
 *     project_id, business_slug, handoff_timestamp,
 *     phase: 'plan'|'execute'|'verify'|'ship',
 *     last_task_completed: { task_id, wave },
 *     next_task_id,
 *     brief_original, amplified_brief,
 *     decisions: [{ id, text }],
 *     open_questions: [],
 *     quality_gate_results: {...},
 *     loop_guard_state: {...},
 *     dag_snapshot_path: "dag-state.json",
 *     audit_log_path: "audit.jsonl",
 *     resumption_prompt_hint: "..."
 *   }
 *
 * Atomic write: writes to .HANDOFF.json.tmp then renames. Avoids partial
 * states if the process dies mid-write.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));

const SCHEMA_VERSION = '1.0';
const FILENAME = 'HANDOFF.json';

function handoffPath(projectDir) {
  return path.join(projectDir, FILENAME);
}

// Walk up from cwd looking for .nirvana/ or .git/ — same logic as scope.ts
// but in plain JS so it's loadable from CommonJS callers.
function findProjectRootFromCwd() {
  let cur = process.cwd();
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(path.join(cur, '.nirvana')) || fs.existsSync(path.join(cur, '.git'))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

function writeHandoff(projectDir, partial) {
  if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
  const target = handoffPath(projectDir);
  const existing = readHandoff(projectDir) || {};
  const merged = Object.assign(
    { schema_version: SCHEMA_VERSION, decisions: [], open_questions: [] },
    existing,
    partial || {},
    { handoff_timestamp: new Date().toISOString() },
  );
  // Stable defaults for paths if caller didn't provide them.
  if (!merged.dag_snapshot_path) merged.dag_snapshot_path = 'dag-state.json';
  if (!merged.audit_log_path) merged.audit_log_path = 'audit.jsonl';
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, target);
  return merged;
}

function readHandoff(projectDir) {
  const target = handoffPath(projectDir);
  if (!fs.existsSync(target)) return null;
  try { return JSON.parse(fs.readFileSync(target, 'utf8')); }
  catch { return null; }
}

function buildResumePrompt(handoff) {
  if (!handoff) return '# Resume\n\nNo HANDOFF.json found.';
  const lines = [];
  lines.push(`# Resume project · ${handoff.project_id || '(unknown)'}`);
  lines.push('');
  lines.push(`**Business:** ${handoff.business_slug || '(none)'}`);
  lines.push(`**Phase:** ${handoff.phase || 'unknown'}`);
  lines.push(`**Handoff at:** ${handoff.handoff_timestamp || '(no timestamp)'}`);
  lines.push('');
  if (handoff.brief_original) {
    lines.push('## Original brief');
    lines.push('');
    lines.push('> ' + handoff.brief_original.replace(/\n/g, '\n> '));
    lines.push('');
  }
  if (handoff.amplified_brief && handoff.amplified_brief !== handoff.brief_original) {
    lines.push('## Amplified brief (Stage -2)');
    lines.push('');
    lines.push(handoff.amplified_brief);
    lines.push('');
  }
  if (handoff.last_task_completed) {
    lines.push(`## Last task completed`);
    lines.push('');
    lines.push(`- **task_id:** ${handoff.last_task_completed.task_id || '(none)'}`);
    if (handoff.last_task_completed.wave != null) {
      lines.push(`- **wave:** ${handoff.last_task_completed.wave}`);
    }
    lines.push('');
  }
  if (handoff.next_task_id) {
    lines.push(`## Next task`);
    lines.push('');
    lines.push(`Resume from: \`${handoff.next_task_id}\``);
    lines.push('');
  }
  if (Array.isArray(handoff.decisions) && handoff.decisions.length > 0) {
    lines.push('## Decisions locked');
    lines.push('');
    for (const d of handoff.decisions) {
      lines.push(`- **${d.id || 'D-?'}** — ${d.text || ''}`);
    }
    lines.push('');
  }
  // Decisions history (recent, from SQLite). Optional — when SQLite is
  // available and the project has rows, surfaces them here. Best-effort:
  // any error reading the DB is swallowed (the resume prompt still works
  // from HANDOFF.json content alone). Walks up from cwd looking for a
  // .nirvana directory or .git marker (mirrors scope.ts logic in plain JS,
  // since scope.ts can't be require()d from CommonJS).
  try {
    const sdb = require(path.join(SKILLS_ROOT, '_shared', 'lib', 'state-db.js'));
    const projectRoot = findProjectRootFromCwd();
    const handle = sdb.openDb(projectRoot);
    if (handle.available && handoff.project_id) {
      const rows = sdb.listDecisions(handle, handoff.project_id, { limit: 10 });
      if (rows && rows.length > 0) {
        lines.push('## Decisions history (recent · from state.db)');
        lines.push('');
        for (const r of rows) {
          lines.push(`- **${r.decision_id}** · ${r.recorded_at}${r.source ? ` · _${r.source}_` : ''}`);
          lines.push(`  ${r.text}`);
          if (r.rationale) lines.push(`  > ${r.rationale}`);
        }
        lines.push('');
      }
    }
  } catch { /* non-fatal */ }
  if (Array.isArray(handoff.open_questions) && handoff.open_questions.length > 0) {
    lines.push('## Open questions');
    lines.push('');
    for (const q of handoff.open_questions) lines.push(`- ${q}`);
    lines.push('');
  }
  if (handoff.quality_gate_results) {
    const last = Array.isArray(handoff.quality_gate_results)
      ? handoff.quality_gate_results[handoff.quality_gate_results.length - 1]
      : handoff.quality_gate_results;
    if (last && last.verdict) {
      lines.push(`## Last quality gate`);
      lines.push('');
      lines.push(`- verdict: \`${last.verdict}\` (score=${last.score ?? 'n/a'})`);
      if (Array.isArray(last.failed_checks) && last.failed_checks.length) {
        lines.push(`- failed checks: ${last.failed_checks.length}`);
      }
      lines.push('');
    }
  }
  if (handoff.resumption_prompt_hint) {
    lines.push('## Resumption hint');
    lines.push('');
    lines.push(handoff.resumption_prompt_hint);
    lines.push('');
  }
  lines.push('## State files');
  lines.push('');
  lines.push(`- DAG snapshot: \`${handoff.dag_snapshot_path}\``);
  lines.push(`- Audit log: \`${handoff.audit_log_path}\``);
  return lines.join('\n');
}

/**
 * updateHandoffPhase — advance a project's HANDOFF.json phase + emit audit.
 *
 * Required to fix F1/F6 from NIRVANA-OS-CORRECTION-REPORT: workflows were
 * stuck at `phase: "plan"` because there was no symmetric setter for the
 * phase. Without this, resume after rate-limit / crash had no way to know
 * where the workflow really stopped.
 *
 * Usage:
 *   const { updateHandoffPhase } = require('.../handoff.js');
 *   updateHandoffPhase(projectDir, 'execute', {
 *     lastTaskCompleted: { task_id: 'T-001', wave: 1 },
 *     nextTaskId: 'T-002',
 *     decision: { id: 'D-1', text: 'Chose Sustainable Use License' },
 *   });
 *
 * @param {string} projectDir   Project root containing HANDOFF.json
 * @param {string} newPhase     'plan' | 'execute' | 'verify' | 'ship' | 'complete' | 'failed'
 * @param {object} [opts]
 *   - lastTaskCompleted {task_id, wave?}
 *   - nextTaskId        string
 *   - decision          {id, text}
 *   - openQuestions     string[]  (appended)
 *   - resumptionHint    string
 * @returns the merged handoff object after write.
 */
function updateHandoffPhase(projectDir, newPhase, opts) {
  opts = opts || {};
  const allowed = new Set(['plan', 'execute', 'verify', 'ship', 'complete', 'failed']);
  if (!allowed.has(newPhase)) {
    throw new Error(`updateHandoffPhase: invalid phase '${newPhase}'. Allowed: ${[...allowed].join(', ')}`);
  }
  const existing = readHandoff(projectDir);
  if (!existing) {
    throw new Error(`updateHandoffPhase: HANDOFF.json not found at ${projectDir}. Call writeHandoff() first.`);
  }
  const previousPhase = existing.phase || null;
  const partial = { phase: newPhase };
  if (opts.lastTaskCompleted) partial.last_task_completed = opts.lastTaskCompleted;
  if (opts.nextTaskId !== undefined) partial.next_task_id = opts.nextTaskId;
  if (opts.resumptionHint) partial.resumption_prompt_hint = opts.resumptionHint;
  if (opts.decision) {
    partial.decisions = [...(existing.decisions || []), opts.decision];
  }
  if (Array.isArray(opts.openQuestions) && opts.openQuestions.length > 0) {
    partial.open_questions = [...(existing.open_questions || []), ...opts.openQuestions];
  }
  const merged = writeHandoff(projectDir, partial);

  // Audit event — best effort, never throw. Writes to both LOCAL project audit
  // (for project-scoped views like brief-business audit chain) AND GLOBAL
  // ~/.harness-logs/YYYY-MM-DD/audit.jsonl (for nrv glance + cross-trace tools).
  try {
    const event = {
      ts: merged.handoff_timestamp,
      event: 'handoff_phase_advanced',
      project_id: merged.project_id,
      business_slug: merged.business_slug,
      from_phase: previousPhase,
      to_phase: newPhase,
      last_task_completed: merged.last_task_completed || null,
      next_task_id: merged.next_task_id || null,
    };
    const payload = JSON.stringify(event) + '\n';
    // Local project audit
    const localAuditPath = path.join(projectDir, merged.audit_log_path || 'audit.jsonl');
    fs.appendFileSync(localAuditPath, payload);
    // Global daily audit (so nrv glance and cross-trace tools can see it)
    const today = new Date().toISOString().slice(0, 10);
    const globalDir = path.join(require('os').homedir(), '.harness-logs', today);
    fs.mkdirSync(globalDir, { recursive: true });
    fs.appendFileSync(path.join(globalDir, 'audit.jsonl'), payload);
  } catch (e) {
    // non-fatal — handoff.json was still written
  }

  return merged;
}

function fingerprint(handoff) {
  // Stable hash for change detection (e.g. did anything change since last resume?).
  if (!handoff) return null;
  const subset = {
    phase: handoff.phase,
    last_task_completed: handoff.last_task_completed,
    next_task_id: handoff.next_task_id,
    decisions: handoff.decisions,
  };
  return crypto.createHash('sha1').update(JSON.stringify(subset)).digest('hex').slice(0, 12);
}

module.exports = { writeHandoff, readHandoff, updateHandoffPhase, buildResumePrompt, handoffPath, fingerprint, SCHEMA_VERSION };
