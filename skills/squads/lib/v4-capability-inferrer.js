/**
 * v4-capability-inferrer.js
 *
 * Infers virtual `capabilities[]` for Squad Protocol v4 squads (which only
 * declare components.workflows/agents/tasks but no capability metadata).
 *
 * The output is consumed by:
 *   - registry.js (writes them into ~/.squads-registry.json#_v4_inferred_capabilities)
 *   - harness router.js Stage 2 (treats them as additional BM25 docs)
 *
 * Without this, ~119 v4 squads (e.g. awwwards-singularity-studio) are
 * invisible to harness discovery — only the 2 explicit-v5 squads can win
 * BM25 routing.
 *
 * Strategy:
 *   For each workflow in the v4 manifest, generate 1 inferred capability:
 *     id:          <namespace>.<workflow_slug>.execute (≥3 dotted segments)
 *     description: workflow.description ∪ workflow_name + squad summary (≥20 chars)
 *     domains:     heuristic match of squad.name + workflow.name vs catalog
 *     examples:    derived from workflow_name + squad.description chunks
 *     invoke:      {type: "workflow", ref: "workflows/<file>.yaml"}
 *     score_boost: 1.2 for premium-marker squads (awwwards, nirvana, master, elite, premium)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Premium-marker keywords (case-insensitive substring).
//
// ELITE markers (boost 2.0): squads with proven external track record.
// `awwwards` alone — squads named after the Awwwards.com curation site
// signal "production-grade premium web experience" tier. They MUST win
// over project-internal "premium" peers in BM25 ties.
//
// TOP markers (boost 1.5): project-internal premium signaling.
// `nirvana, singularity` — these are project naming conventions for
// elevated quality, but should not outweigh ELITE in tie-breaking.
//
// REGULAR markers (boost 1.2): quality-signaling but not elite.
const ELITE_PREMIUM_MARKERS = [
  'awwwards',
];
const TOP_PREMIUM_MARKERS = [
  'singularity', 'nirvana',
];
const REGULAR_PREMIUM_MARKERS = [
  'master', 'elite', 'premium', 'cinematic', 'studio', 'forge',
];
const PREMIUM_MARKERS = [
  ...ELITE_PREMIUM_MARKERS,
  ...TOP_PREMIUM_MARKERS,
  ...REGULAR_PREMIUM_MARKERS,
];

// Heuristic mapping squad/workflow name keywords → canonical catalog domain.
// Catalog reference: ~/.claude/skills/_shared/catalogs/CAPABILITY_CATALOG_V1.yaml
const KEYWORD_DOMAINS = [
  // Marketing & Sales
  { keys: ['marketing', 'campaign', 'launch'], domain: 'marketing' },
  { keys: ['sales', 'funnel', 'offer', 'closer'], domain: 'sales' },
  { keys: ['copy', 'copywriter', 'copywriting', 'sales-letter'], domain: 'copy' },
  { keys: ['growth', 'experiment', 'retention'], domain: 'growth' },
  { keys: ['ads', 'paid', 'meta-ads', 'google-ads'], domain: 'ads' },
  { keys: ['lifecycle', 'crm', 'email-automation'], domain: 'lifecycle' },
  // Branding & Design
  { keys: ['brand', 'branding', 'identity', 'logo'], domain: 'branding' },
  { keys: ['design', 'visual', 'ui', 'ux', 'awwwards', 'singularity'], domain: 'design' },
  // Content & Media
  { keys: ['content', 'editorial', 'blog'], domain: 'content' },
  { keys: ['video', 'cinema', 'film', 'reels'], domain: 'video' },
  { keys: ['audio', 'podcast'], domain: 'podcasting' },
  { keys: ['social', 'instagram', 'tiktok'], domain: 'social_media' },
  { keys: ['image', 'photo', 'illustration'], domain: 'image' },
  // Engineering
  { keys: ['frontend', 'react', 'nextjs', 'webgl', 'gsap'], domain: 'frontend' },
  { keys: ['backend', 'api', 'service'], domain: 'backend' },
  { keys: ['mobile', 'ios', 'android'], domain: 'mobile' },
  { keys: ['data', 'pipeline', 'etl'], domain: 'data_engineering' },
  { keys: ['security', 'audit', 'threat'], domain: 'security' },
  { keys: ['ai', 'ml', 'llm'], domain: 'ai_engineering' },
  { keys: ['qa', 'test', 'testing'], domain: 'qa' },
  // Business
  { keys: ['strategy', 'okr', 'consulting'], domain: 'strategy' },
  { keys: ['operations', 'ops', 'process'], domain: 'business_operations' },
  { keys: ['finance', 'pricing'], domain: 'finance' },
  { keys: ['legal', 'compliance', 'gdpr'], domain: 'legal' },
  { keys: ['analytics', 'kpi', 'dashboard'], domain: 'analytics' },
  // Verticals
  { keys: ['healthcare', 'clinical', 'medical', 'saude'], domain: 'healthcare' },
  { keys: ['edu', 'education', 'curriculum'], domain: 'education' },
  { keys: ['real-estate', 'property'], domain: 'real_estate' },
  { keys: ['fintech', 'banking', 'payment'], domain: 'fintech' },
  { keys: ['crypto', 'token', 'defi'], domain: 'crypto' },
  { keys: ['game', 'gaming'], domain: 'gaming' },
  { keys: ['ecommerce', 'shop'], domain: 'ecommerce' },
  // Cross-cutting
  { keys: ['research', 'intel', 'competitive'], domain: 'research' },
  { keys: ['knowledge', 'docs', 'wiki'], domain: 'knowledge_management' },
  { keys: ['multi-agent', 'orchestrator', 'maestro'], domain: 'multi_agent_orchestration' },
];

/**
 * slugify a workflow name into a kebab-case-ish snake_case identifier
 * suitable for capability id. Strips file extensions, converts to lower,
 * replaces non-alnum with underscore, collapses repeats, trims edges.
 */
function slugifyWorkflowId(name) {
  if (typeof name !== 'string') return 'execute';
  return name
    .replace(/\.ya?ml$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'execute';
}

/**
 * Extracts the namespace prefix for a v4 squad's inferred capability ids.
 * Tries: first matching domain → fallback to 'general'.
 */
function inferNamespace(squadName, workflowName) {
  const blob = `${squadName || ''} ${workflowName || ''}`.toLowerCase();
  for (const entry of KEYWORD_DOMAINS) {
    if (entry.keys.some((k) => blob.includes(k))) return entry.domain;
  }
  return 'general';
}

/**
 * Infers up to 5 domains for a capability based on squad + workflow names.
 * At least 1 always returned ('general' fallback).
 */
function inferDomains(squadName, workflowName) {
  const blob = `${squadName || ''} ${workflowName || ''}`.toLowerCase();
  const found = new Set();
  for (const entry of KEYWORD_DOMAINS) {
    if (entry.keys.some((k) => blob.includes(k))) {
      found.add(entry.domain);
      if (found.size >= 5) break;
    }
  }
  if (found.size === 0) found.add('general');
  return Array.from(found);
}

/**
 * Detects premium-marker presence in squad name → returns score_boost.
 * ELITE (awwwards) → 2.0
 * TOP (singularity/nirvana) → 1.5
 * REGULAR (master/elite/premium/cinematic/studio/forge) → 1.2
 * Otherwise → 1.0
 */
function inferScoreBoost(squadName) {
  const lc = (squadName || '').toLowerCase();
  if (ELITE_PREMIUM_MARKERS.some((m) => lc.includes(m))) return 2.0;
  if (TOP_PREMIUM_MARKERS.some((m) => lc.includes(m))) return 1.5;
  if (REGULAR_PREMIUM_MARKERS.some((m) => lc.includes(m))) return 1.2;
  return 1.0;
}

/**
 * Reads a workflow YAML file and tries to extract description + objective.
 * Returns null if file unreadable. Returns {description, objective} otherwise.
 */
function readWorkflowSummary(workflowPath) {
  try {
    const raw = fs.readFileSync(workflowPath, 'utf8');
    // Light YAML scrape (no full parser to keep deps zero).
    const lines = raw.split(/\r?\n/);
    let description = '';
    let objective = '';
    let workflowName = '';
    for (const line of lines) {
      const m = line.match(/^\s*(description|objective|workflow_name|name):\s*(.+)$/i);
      if (m) {
        const k = m[1].toLowerCase();
        const v = m[2].replace(/^["'`]|["'`]$/g, '').trim();
        if (k === 'description' && !description) description = v;
        else if (k === 'objective' && !objective) objective = v;
        else if (k === 'workflow_name' && !workflowName) workflowName = v;
        else if (k === 'name' && !workflowName) workflowName = v;
      }
    }
    return { description, objective, workflowName };
  } catch {
    return { description: '', objective: '', workflowName: '' };
  }
}

/**
 * Generates 1 example phrase for a capability based on workflow + squad.
 * Always returns a non-empty string ≥5 chars.
 */
function generateExample(squadName, workflowSlug, workflowDescription) {
  const slug = workflowSlug.replace(/_/g, ' ');
  const sname = (squadName || '').replace(/-/g, ' ');
  if (workflowDescription && workflowDescription.length > 10) {
    return workflowDescription.slice(0, 200);
  }
  return `Run ${slug} via ${sname}`;
}

/**
 * Pads a description string to ≥20 chars (schema minimum) by appending
 * the squad summary if needed.
 */
function padDescription(initial, squadName, squadDescription) {
  const minLen = 20;
  let out = (initial || '').trim();
  if (out.length >= minLen) return out;
  // Append squad context to fill.
  const fallback = squadDescription
    ? `Workflow do squad ${squadName}: ${squadDescription}`
    : `Workflow do squad ${squadName} (descrição não declarada)`;
  out = out ? `${out} — ${fallback}` : fallback;
  if (out.length < minLen) {
    out = `${out}.`.padEnd(minLen, ' execução de squad legacy.');
  }
  return out.slice(0, 500);
}

/**
 * Main entry: infer capabilities for one v4 manifest.
 *
 * @param {object} manifest — parsed squad.yaml
 * @param {string} manifestDir — absolute path to squad's directory (for reading workflow files)
 * @returns {Array} array of inferred capability objects (registry entry shape)
 */
function inferCapabilities(manifest, manifestDir) {
  if (!manifest || typeof manifest !== 'object') return [];
  // Skip squads that ALREADY declare capabilities[] (v5 explicit).
  if (Array.isArray(manifest.capabilities) && manifest.capabilities.length > 0) {
    return [];
  }
  const squadName = typeof manifest.name === 'string' ? manifest.name : path.basename(manifestDir);
  const squadDescription = typeof manifest.description === 'string' ? manifest.description : '';
  const components = manifest.components || {};
  const workflows = Array.isArray(components.workflows) ? components.workflows : [];

  const scoreBoost = inferScoreBoost(squadName);
  const inferred = [];

  // Strategy A: 1 capability per workflow file.
  for (const wfRef of workflows) {
    if (typeof wfRef !== 'string') continue;
    const wfFile = wfRef.endsWith('.yaml') || wfRef.endsWith('.yml') ? wfRef : `${wfRef}.yaml`;
    const wfBaseName = path.basename(wfFile).replace(/\.ya?ml$/i, '');
    const wfPath = path.join(manifestDir, 'workflows', wfFile);
    const summary = readWorkflowSummary(wfPath);
    const wfName = summary.workflowName || wfBaseName;
    const wfDesc = summary.description || summary.objective || '';

    const namespace = inferNamespace(squadName, wfName);
    const slug = slugifyWorkflowId(wfBaseName);
    const id = `${namespace}.${slug}.execute`;

    // Verify id pattern matches schema: ^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/.test(id)) continue;

    // Concatenate workflow + squad descriptions so BM25 catches keywords
    // from squad.yaml#description (e.g. "landing pages", "cinematic",
    // "experience web") that are missing from workflow yamls.
    // ROOT CAUSE FIX: awwwards-singularity-studio was losing to
    // nirvana-landingpage on "landing page" queries because the inferrer
    // only read workflow yaml — squad description ("Squad de elite para
    // criação de landing pages e experiências web cinematográficas")
    // never reached BM25.
    const richDesc = wfDesc && squadDescription
      ? `${wfDesc} — ${squadDescription}`
      : (wfDesc || squadDescription);
    const description = padDescription(richDesc, squadName, squadDescription).slice(0, 500);
    const domains = inferDomains(squadName, wfName);

    // Examples carry strongest BM25 signal. Add 1 from workflow + 1 from
    // squad description (first sentence) when available.
    const examples = [generateExample(squadName, slug, wfDesc)];
    if (squadDescription && squadDescription.length > 30) {
      const firstSentence = squadDescription.split(/[.!?]/)[0].trim();
      if (firstSentence.length >= 10 && firstSentence.length <= 300 && firstSentence !== wfDesc) {
        examples.push(firstSentence);
      }
    }

    inferred.push({
      squad: squadName,
      capability_id: id,
      description,
      domains,
      examples,
      not_for: [],
      fidelity_status: 'inferred', // not 'validated' — these are heuristic
      invoke: { type: 'workflow', ref: `workflows/${wfFile}` },
      score_boost: scoreBoost,
      inferred_from: 'v4_workflow', // marker for debugging
    });
  }

  // Strategy B (fallback): if 0 workflows but ≥1 agent, generate 1 generic capability.
  // Useful for v4 squads structured purely around agents (no workflow files).
  if (inferred.length === 0) {
    const agents = Array.isArray(components.agents) ? components.agents : [];
    if (agents.length > 0) {
      const namespace = inferNamespace(squadName, '');
      const id = `${namespace}.${slugifyWorkflowId(squadName)}.execute`;
      if (/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/.test(id)) {
        inferred.push({
          squad: squadName,
          capability_id: id,
          description: padDescription(squadDescription, squadName, ''),
          domains: inferDomains(squadName, ''),
          examples: [generateExample(squadName, 'execute', squadDescription)],
          not_for: [],
          fidelity_status: 'inferred',
          invoke: { type: 'agent', ref: `agents/${agents[0]}` },
          score_boost: scoreBoost,
          inferred_from: 'v4_squad_agents',
        });
      }
    }
  }

  return inferred;
}

module.exports = {
  inferCapabilities,
  // exported for testing:
  slugifyWorkflowId,
  inferNamespace,
  inferDomains,
  inferScoreBoost,
  readWorkflowSummary,
};
