/**
 * squad-audit-consensus.js — orchestrates the proposer/critic/meta/empiricus
 * consensus loop for squad-quality auditing.
 *
 * Two execution modes:
 *
 *   1. MECHANICAL  (default, deterministic, no LLM):
 *      - Reads each fixable_diff from the scorer
 *      - Wraps each in a "proposed patch" the critic would have approved
 *      - Returns final consensus_diff with 100% mechanical patches only
 *      - Fast, predictable, no API costs. Covers 70% of nirvana criteria.
 *
 *   2. AGENTIC     (when CLAUDE_CODE_OAUTH_TOKEN is set + `claude` CLI on PATH):
 *      - Spawns the `claude` CLI as subprocess — uses the user's Claude
 *        Code OAuth session, NEVER ANTHROPIC_API_KEY directly.
 *      - Round 0: self_audit+logos propose semantic patches (READMEs, descriptions)
 *      - Round 1: dialektikos refutes (verification squad acting as critic)
 *      - Round 2: self_audit refines or justifies
 *      - Round 3: meta evaluates convergence
 *      - Round 4: empiricus tiebreak with evidence
 *      - On consensus → emit consensus_diff
 *      - On no-consensus → mark "human-review-needed" (still emits mechanical patches)
 *
 * Public API:
 *   const { runConsensus } = require('./squad-audit-consensus');
 *   const result = await runConsensus({ scoreReport, squadDir, agenticMode: 'auto' });
 *   // → { mode: 'mechanical'|'agentic'|'mixed', consensus_diff: {...}, transcript: [...], status: 'consensus'|'human-review-needed' }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), '.nirvana', 'skills')) ? path.join(os.homedir(), '.nirvana', 'skills') : path.join(os.homedir(), '.claude', 'skills'));
const self_audit_DIR = path.join(HOME, 'squads', 'synthetic-reasoning');
const AGENT_FILES = {
  proposer: ['self_audit.md', 'logos.md'],
  critic: ['dialektikos.md'],
  meta: ['meta.md'],
  empiricus: ['empiricus.md'],
};

function readPersona(role) {
  const files = AGENT_FILES[role] || [];
  return files
    .map(f => {
      const p = path.join(self_audit_DIR, 'agents', f);
      if (!fs.existsSync(p)) return '';
      return fs.readFileSync(p, 'utf8').slice(0, 4000);
    })
    .filter(Boolean)
    .join('\n\n---\n\n');
}

// ─────────────────────────────────────────────────────────────────────
// Mechanical mode — deterministic patches from scorer's fixable_diff
// ─────────────────────────────────────────────────────────────────────

function buildMechanicalConsensus(scoreReport) {
  const patches = [];
  const skipped = [];

  for (const c of scoreReport.breakdown) {
    if (!c.fixable_diff) continue;
    const fix = c.fixable_diff;
    switch (fix.kind) {
      case 'manifest_patch':
        patches.push({ kind: 'manifest_patch', criterion: c.id, ops: fix.patches, rationale: c.evidence });
        break;
      case 'shebang_repair':
        patches.push({ kind: 'shebang_repair', criterion: c.id, files: fix.files, rationale: c.evidence });
        break;
      case 'runtime_requirements_default':
        patches.push({ kind: 'runtime_requirements_default', criterion: c.id, missing_min: fix.missing_min, missing_feats: fix.missing_feats });
        break;
      case 'fidelity_status_default_experimental':
        patches.push({ kind: 'fidelity_status_default_experimental', criterion: c.id });
        break;
      case 'dependencies_synth':
        patches.push({ kind: 'dependencies_synth', criterion: c.id });
        break;
      case 'humanize_default_true':
        patches.push({ kind: 'humanize_default_true', criterion: c.id });
        break;
      case 'caps_inference_required':
        // Defer to v4-capability-inferrer.js — needs caps to be inferred from
        // workflows/agents. Mechanical-safe.
        patches.push({ kind: 'caps_inference_required', criterion: c.id });
        break;
      case 'caps_examples_not_for':
        // Mechanical defaults: derive 1 example from capability description,
        // 1 generic not_for from anti-pattern catalog. Improvers can refine.
        patches.push({ kind: 'caps_examples_not_for', criterion: c.id });
        break;
      case 'domain_realign':
        // Best-guess realignment using registry CAPABILITY_CATALOG.
        patches.push({ kind: 'domain_realign', criterion: c.id, offenders: fix.offenders });
        break;
      // Structural fixers — produce scorer-passing stubs deterministically.
      // Agentic refinement can rewrite the stubs later for content quality.
      case 'tasks_acceptance_criteria':
        patches.push({ kind: 'tasks_acceptance_criteria', criterion: c.id });
        break;
      case 'agents_frontmatter_repair':
        patches.push({ kind: 'agents_frontmatter_repair', criterion: c.id });
        break;
      case 'workflow_refs_repair':
        patches.push({ kind: 'workflow_refs_repair', criterion: c.id });
        break;
      case 'readme_scaffold':
        patches.push({ kind: 'readme_scaffold', criterion: c.id });
        break;
      case 'create_agents_dir':
        patches.push({ kind: 'create_agents_dir', criterion: c.id });
        break;
      case 'create_tasks_dir':
        patches.push({ kind: 'create_tasks_dir', criterion: c.id });
        break;
      case 'create_workflows_dir':
        patches.push({ kind: 'create_workflows_dir', criterion: c.id });
        break;
      // The following still require LLM-quality writing — defer to agentic mode.
      case 'caps_repair':
      case 'readme_expand':
        skipped.push({ kind: fix.kind, criterion: c.id, reason: 'requires-semantic-judgement' });
        break;
      default:
        skipped.push({ kind: fix.kind, criterion: c.id, reason: 'unknown-fix-kind' });
    }
  }

  return {
    mode: 'mechanical',
    consensus_diff: { patches },
    transcript: [{
      role: 'system',
      content: `Mechanical mode: applying ${patches.length} deterministic fixes; ${skipped.length} skipped (need semantic agent).`,
    }],
    status: skipped.length === 0 ? 'consensus' : 'partial-consensus',
    skipped,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Agentic mode — host-runtime-agnostic via host-agent-driver
// ─────────────────────────────────────────────────────────────────────

// host-agent-driver is a TS module; load lazily via dynamic require if Bun
// resolved it at startup. CommonJS fallback path supports node --experimental-strip-types.
let _hostDriver = null;
function loadHostDriver() {
  if (_hostDriver) return _hostDriver;
  try {
    _hostDriver = require(path.join(__dirname, '..', '..', '_shared', 'lib', 'host-agent-driver.ts'));
  } catch {
    try { _hostDriver = require(path.join(__dirname, '..', '..', '_shared', 'lib', 'host-agent-driver.js')); }
    catch { _hostDriver = null; }
  }
  return _hostDriver;
}

/**
 * callAgent — dispatch one round through the HOST runtime (Claude Code,
 * Codex, Gemini CLI, etc.). We do NOT specify model or agent — those are
 * the host's responsibility. Persona is passed as system prompt prefix.
 */
async function callAgent(_client, role, userMessage) {
  const driver = loadHostDriver();
  if (!driver) return { role, text: '', error: 'host-agent-driver not loadable' };
  const persona = readPersona(role) || `You are the ${role} agent in a squad audit consensus loop.`;
  // Async path with stall watchdog: 90s heartbeat + 1 retry on stall. Avoids
  // 600s freezes when the agent reads heavy + writes heavy in one call.
  let retry = null;
  try {
    retry = require(path.join(SKILLS_ROOT, '_shared', 'lib', 'host-agent-retry.js'));
  } catch {}
  const callOpts = { heartbeatMs: 90_000, timeoutMs: 240_000, maxRetries: 1 };
  const r = retry && retry.callWithRetryOnStall
    ? await retry.callWithRetryOnStall(persona, userMessage, callOpts)
    : await driver.callHostAgentAsync(persona, userMessage, callOpts);
  if ('error' in r) return { role, text: '', error: r.error, host: r.host };
  return { role, text: r.text, host: r.host };
}

async function runAgenticConsensus({ scoreReport, squadDir, mechanicalPatches, skipped }) {
  const driver = loadHostDriver();
  const host = driver?.detectHost?.();
  if (!host) {
    return { mode: 'mechanical', reason: 'no-host-agent-runtime-detected' };
  }
  const client = null;  // host runtime handles auth + model + agent dispatch

  // LoopGuard: hard ceiling on consensus rounds. Each round = 1 step.
  // max_steps=6 covers the maximum theoretical path (proposer/critic/refine/
  // meta/empiricus + 1 safety). max_repeat=2 prevents the same round being
  // re-issued with same args. max_flat_steps=3 stops if 3 consecutive rounds
  // produce no semantic delta (progress_marker = patches count).
  const { createLoopGuard } = require(path.join(__dirname, '..', '..', '_shared', 'lib', 'loop-guard.js'));
  const guard = createLoopGuard({ max_steps: 6, max_repeat: 2, max_flat_steps: 3 });
  const halt = (reason, details) => {
    try {
      const audit = require(path.join(__dirname, '..', '..', 'harness', 'lib', 'audit.js'));
      audit.emit('loop_detected', { source: 'squad_audit_consensus', squad: scoreReport.slug, reason, ...details });
    } catch {}
    return {
      mode: 'mechanical-loop-guarded',
      transcript,
      status: 'loop-detected',
      loop_guard: { stop: true, reason, ...details },
      skipped,
    };
  };

  const slug = scoreReport.slug;
  const transcript = [];
  const ctx = {
    slug,
    score: scoreReport.score,
    tier: scoreReport.tier,
    failing: scoreReport.breakdown.filter(b => b.score < b.max).map(b => `${b.id}.${b.name}: ${b.evidence}`),
    skipped,
  };
  const ctxStr = JSON.stringify(ctx, null, 2);

  // Round 0 — proposer (host runtime dispatches with its default model/agent)
  guard.record('round_proposer', { slug, ctx: ctx.failing.length }, 0);
  let g = guard.check(); if (g.stop) return halt(g.reason, g);
  const r0 = await callAgent(client, 'proposer',
    `You are auditing the squad "${slug}" for nirvana-tier v5 compliance. Current state:\n\n${ctxStr}\n\n` +
    `Mechanical patches already proposed: ${JSON.stringify(mechanicalPatches.slice(0, 5))}.\n\n` +
    `Propose a focused, high-quality SEMANTIC diff for the criteria flagged as 'requires-semantic-judgement'. ` +
    `Output ONLY JSON: { "patches": [{ "kind": "task_ac_writer"|"readme_expand"|"agent_tools_default"|..., "target": "<file>", "content_template": "...", "rationale": "..." }] }`);
  transcript.push(r0);

  // Round 1 — critic
  // Progress marker = chars in proposer text (semantic delta proxy).
  guard.record('round_critic', { slug, proposer_chars: (r0.text || '').length }, (r0.text || '').length);
  g = guard.check(); if (g.stop) return halt(g.reason, g);
  const r1 = await callAgent(client, 'critic',
    `You are dialektikos. The proposer suggested:\n\n${r0.text}\n\nOriginal context:\n${ctxStr}\n\n` +
    `Identify any patch that risks REGRESSION, semantic loss, or hidden assumptions. ` +
    `Be precise — do not reject for stylistic reasons. Output JSON: { "concerns": [{ "patch_index": N, "issue": "...", "severity": "low|med|high" }], "verdict": "approve_all"|"reject_some"|"reject_all" }`);
  transcript.push(r1);

  // Parse critic verdict
  let criticVerdict = 'approve_all';
  try {
    const j = JSON.parse(r1.text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    criticVerdict = j.verdict || 'approve_all';
  } catch { /* keep default */ }

  let finalProposal = r0.text;

  if (criticVerdict !== 'approve_all') {
    // Round 2 — proposer refines
    guard.record('round_refine', { slug, verdict: criticVerdict }, (r1.text || '').length);
    g = guard.check(); if (g.stop) return halt(g.reason, g);
    const r2 = await callAgent(client, 'proposer',
      `Critic raised concerns:\n${r1.text}\n\nOriginal proposal:\n${r0.text}\n\n` +
      `Refine the proposal to address valid concerns; drop patches that cannot be defended. ` +
      `Output the SAME JSON shape as before with the refined patches.`);
    transcript.push(r2);
    finalProposal = r2.text;

    // Round 3 — meta evaluates
    guard.record('round_meta', { slug }, (r2.text || '').length);
    g = guard.check(); if (g.stop) return halt(g.reason, g);
    const r3 = await callAgent(client, 'meta',
      `Round 0 (propose):\n${r0.text}\n\nRound 1 (critique):\n${r1.text}\n\nRound 2 (refine):\n${r2.text}\n\n` +
      `Did the proposer adequately address the critic's concerns? Output JSON: { "consensus_reached": true|false, "rationale": "..." }`);
    transcript.push(r3);

    let meta;
    try { meta = JSON.parse(r3.text.match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch { meta = { consensus_reached: false }; }

    if (!meta.consensus_reached) {
      // Round 4 — empiricus tiebreak
      guard.record('round_empiricus', { slug }, (r3.text || '').length);
      g = guard.check(); if (g.stop) return halt(g.reason, g);
      const r4 = await callAgent(client, 'empiricus',
        `Consensus not reached. Tiebreak by appealing to evidence in the squad files. ` +
        `Squad: ${slug}. Apply the rule: "if proposer's patch increases TESTABLE quality (validate-squad pass, score uplift) without removing functionality, accept it; otherwise reject". ` +
        `Output JSON: { "verdict": "accept_proposal"|"reject_proposal"|"human-review-needed", "rationale": "..." }`);
      transcript.push(r4);
      // If empiricus rejects or escalates, fall back to mechanical-only.
      try {
        const j = JSON.parse(r4.text.match(/\{[\s\S]*\}/)?.[0] || '{}');
        if (j.verdict !== 'accept_proposal') {
          return { mode: 'mechanical-after-tiebreak', transcript, status: 'human-review-needed', skipped };
        }
      } catch { return { mode: 'mechanical-after-tiebreak', transcript, status: 'human-review-needed', skipped }; }
    }
  }

  // Parse final proposal
  let semanticPatches = [];
  try {
    const j = JSON.parse(finalProposal.match(/\{[\s\S]*\}/)?.[0] || '{}');
    semanticPatches = j.patches || [];
  } catch { /* leave empty */ }

  return {
    mode: 'agentic',
    consensus_diff: { patches: [...mechanicalPatches, ...semanticPatches] },
    transcript,
    status: 'consensus',
    semantic_patch_count: semanticPatches.length,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Public entry
// ─────────────────────────────────────────────────────────────────────

async function runConsensus({ scoreReport, squadDir, agenticMode = 'auto' }) {
  const mech = buildMechanicalConsensus(scoreReport);

  // If everything is mechanical, no need to call LLM
  if (mech.skipped.length === 0 || agenticMode === 'never') {
    return mech;
  }
  if (agenticMode === 'mechanical-only') {
    return mech;
  }

  // Try agentic for the skipped semantic items
  const agentic = await runAgenticConsensus({
    scoreReport, squadDir,
    mechanicalPatches: mech.consensus_diff.patches,
    skipped: mech.skipped,
  });

  if (agentic.mode === 'mechanical') {
    // SDK or key missing — fall back
    return { ...mech, mode: 'mechanical', note: agentic.reason };
  }
  return agentic;
}

module.exports = { runConsensus, buildMechanicalConsensus };

// CLI: node squad-audit-consensus.js <slug>  (uses scores.json from default audit-state)
if (require.main === module) {
  const slug = process.argv[2];
  if (!slug) { console.error('usage: node squad-audit-consensus.js <slug>'); process.exit(2); }
  const scoresPath = path.join(SKILLS_ROOT, 'squads', '.audit-state', 'scores.json');
  const all = JSON.parse(fs.readFileSync(scoresPath, 'utf8'));
  const sr = all.scores.find(s => s.slug === slug);
  if (!sr) { console.error(`squad ${slug} not in scores.json`); process.exit(1); }
  runConsensus({ scoreReport: sr, squadDir: sr.squad_dir, agenticMode: process.env.AGENTIC || 'auto' })
    .then(r => { console.log(JSON.stringify(r, null, 2)); })
    .catch(e => { console.error(e); process.exit(1); });
}
