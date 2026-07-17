/**
 * Harness Protocol v1 router (5-stage pipeline).
 *
 * Stage 1 — Intent classify: heuristic by default; an LLM hook is available
 *           for adapters that want to plug a cheap model. The heuristic
 *           classifies WORK / RUN_ORG / BOTH from verb cues, and extracts
 *           candidate domains by token overlap with the canonical catalog.
 *
 * Stage 2 — Capability matching: BM25 over both registries (zero LLM).
 *
 * Stage 3 — Routing decision: HIGH / AMBIGUOUS / NO_MATCH per §6.4 thresholds.
 *
 * Stage 4 — Budget pre-flight: delegated to lib/budget.js.
 *
 * Stage 5 — Lazy invocation plan: produces an "invocation spec" describing
 *           how the runtime should fork/spawn into squads or businesses.
 *           This module does NOT execute the invocation; it returns a plan
 *           so adapters can dispatch via their native subagent primitives.
 *
 * Each stage is independently exported for unit-test friendliness.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const bm25 = require('./bm25');
const registryLoader = require('./registry-loader');
const budget = require('./budget');
const contextBudget = require('./context-budget');

// Lazy-loaded host-agent-driver (used only by Stage -2 amplifier when WEAK).
let _hostDriver = null;
function getHostDriver() {
  if (_hostDriver) return _hostDriver;
  try {
    _hostDriver = require(path.join(__dirname, '..', '..', '_shared', 'lib', 'host-agent-driver.ts'));
  } catch {
    try { _hostDriver = require(path.join(__dirname, '..', '..', '_shared', 'lib', 'host-agent-driver.js')); }
    catch { _hostDriver = null; }
  }
  return _hostDriver;
}

const DEFAULT_THRESHOLDS = Object.freeze({
  match_high_threshold: 0.80,
  match_high_lead: 0.15,
  match_ambiguous_threshold: 0.60,
  match_ambiguous_window: 0.15,
  not_for_penalty: 0.4,
});

// Verb cues for cheap WORK / RUN_ORG detection. Conservative — when both sets
// match, return BOTH. Adapters can override via Stage 1 LLM call.
// Apenas VERBOS/advérbios de GESTÃO de uma organização ao longo do tempo.
// Substantivos de contexto de negócio (empresa, cliente, business, agência,
// campanha, conta, organização, conglomerado) foram removidos daqui (E2):
// descreviam o TEMA/objeto do brief ("landing para a empresa do meu cliente"),
// não uma ordem de gerir uma organização do sistema — e faziam o intent gate
// ocultar TODAS as squad_capabilities. Um substantivo desses só deveria sinalizar
// RUN_ORG acompanhado de um verbo de gestão, o que já é coberto por estes verbos.
const RUN_ORG_VERBS = [
  'manage', 'manager', 'run', 'rodar', 'gerenciar', 'gerir', 'organizar',
  'organize', 'orchestrate', 'orquestrar',
  'ongoing', 'continuo', 'recorrente', 'mensalmente', 'monthly', 'quarter',
  'trimestre',
];
const WORK_VERBS = [
  'create', 'criar', 'design', 'desenhar', 'audit', 'auditar', 'transcribe',
  'transcrever', 'translate', 'traduzir', 'write', 'escrever', 'generate',
  'gerar', 'analyze', 'analisar', 'review', 'revisar', 'fix', 'consertar',
  'build', 'construir', 'edit', 'editar', 'render', 'compile', 'compilar',
  'plan', 'planejar', 'list', 'listar',
];

/**
 * Lowercase keyword presence test (substring on tokenized words).
 */
function hasAny(text, words) {
  const t = ' ' + (text || '').toLowerCase() + ' ';
  for (const w of words) {
    if (t.includes(' ' + w + ' ') || t.includes(' ' + w + ',') || t.includes(' ' + w + '.')) {
      return true;
    }
  }
  return false;
}

/**
 * Stage 1 — Intent classification (heuristic; LLM hook optional).
 *
 * If a `classifier` function is provided in ctx, it is awaited and its result
 * used directly. Otherwise we use the verb-set heuristic: WORK by default,
 * RUN_ORG when run-org verbs are present and work verbs are not the dominant
 * action, BOTH when both sets match strongly.
 *
 * @param {string} brief
 * @param {object} ctx optional: {classifier?: async (brief) => intent, knownDomains?: string[]}
 * @returns {{intent: 'WORK'|'RUN_ORG'|'BOTH', domains: string[], verbs: string[], confidence: number}}
 */
function stage1IntentClassify(brief, ctx) {
  const text = (brief || '').toLowerCase();
  const wordTokens = bm25.tokenize(text);

  const hasRunOrg = hasAny(text, RUN_ORG_VERBS);
  const hasWork = hasAny(text, WORK_VERBS);

  let intent;
  let confidence;
  if (hasRunOrg && hasWork) { intent = 'BOTH'; confidence = 0.7; }
  else if (hasRunOrg) { intent = 'RUN_ORG'; confidence = 0.8; }
  else { intent = 'WORK'; confidence = 0.65; }

  // Domains: any wordToken that exists in the known-domains list (snake_case).
  const knownDomains = (ctx && Array.isArray(ctx.knownDomains)) ? ctx.knownDomains : [];
  const knownSet = new Set(knownDomains.map((d) => d.toLowerCase()));
  const domains = [];
  for (const w of wordTokens) {
    if (knownSet.has(w) && !domains.includes(w)) domains.push(w);
  }

  // Verbs: keep matched verbs from either set
  const verbs = [];
  for (const v of [...RUN_ORG_VERBS, ...WORK_VERBS]) {
    if (text.includes(v) && !verbs.includes(v)) verbs.push(v);
  }

  return { intent, domains, verbs, confidence };
}

/**
 * Build matchable documents from the squads + businesses registries.
 *
 * Squad capabilities -> one doc per (capability_id, provider) pair.
 * Businesses        -> one doc per business with full description text.
 *
 * @param {object} squadsRegistry
 * @param {object} businessesRegistry
 * @returns {Array<{id: string, text: string, meta: object}>}
 */
function buildMatchDocs(squadsRegistry, businessesRegistry) {
  const docs = [];

  if (squadsRegistry && squadsRegistry.capabilities) {
    for (const [capId, providers] of Object.entries(squadsRegistry.capabilities)) {
      const list = Array.isArray(providers) ? providers : [];
      for (const p of list) {
        const examples = Array.isArray(p.examples) ? p.examples.join(' ') : '';
        const domains = Array.isArray(p.domains) ? p.domains.join(' ') : '';
        // keywords/example_briefs/produces são declarados nos manifestos para
        // descoberta (capability.schema.json) mas eram ignorados pelo BM25 (E6),
        // deixando especialistas de vocabulário estreito invisíveis. Indexa com
        // field-weighting por repetição de termo — idioma já usado neste arquivo
        // (business_route patternClean ×2): keywords ×3 (sinal forte, sinônimos
        // PT/EN), example_briefs ×2 (briefs reais).
        const keywords = Array.isArray(p.keywords) ? p.keywords.join(' ') : '';
        const exampleBriefs = Array.isArray(p.example_briefs) ? p.example_briefs.join(' ') : '';
        const produces = Array.isArray(p.produces) ? p.produces.join(' ') : '';
        const text = [
          capId,
          (p.description || '').trim(),
          examples,
          domains,
          keywords, keywords, keywords,
          exampleBriefs, exampleBriefs,
          produces,
        ].filter(Boolean).join(' ');
        docs.push({
          id: `squad_capability:${p.squad}:${capId}`,
          text,
          meta: {
            type: 'squad_capability',
            capability_id: capId,
            squad: p.squad,
            description: p.description || '',
            domains: p.domains || [],
            not_for: p.not_for || [],
            fidelity_status: p.fidelity_status || null,
            score_boost: typeof p.score_boost === 'number' ? p.score_boost : 1.0,
            invoke: p.invoke || null,
            examples: p.examples || [],
          },
        });
      }
    }
  }

  // v4 inferred capabilities — squads sem capabilities[] explícitas mas com
  // workflows/agents que viram BM25 docs descobríveis. Propagados pelo
  // registry-loader em squadsRegistry._v4_inferred_capabilities.
  // Resolve o caso awwwards-singularity-studio (v4) ficar invisível ao harness.
  const v4Inferred = squadsRegistry && squadsRegistry._v4_inferred_capabilities;
  if (v4Inferred && typeof v4Inferred === 'object') {
    for (const [squadName, caps] of Object.entries(v4Inferred)) {
      if (!Array.isArray(caps)) continue;
      for (const cap of caps) {
        if (!cap || typeof cap.capability_id !== 'string') continue;
        const capId = cap.capability_id;
        const examples = Array.isArray(cap.examples) ? cap.examples.join(' ') : '';
        const domains = Array.isArray(cap.domains) ? cap.domains.join(' ') : '';
        // Mesma indexação de keywords/example_briefs/produces do ramo v5 (E6).
        const keywords = Array.isArray(cap.keywords) ? cap.keywords.join(' ') : '';
        const exampleBriefs = Array.isArray(cap.example_briefs) ? cap.example_briefs.join(' ') : '';
        const produces = Array.isArray(cap.produces) ? cap.produces.join(' ') : '';
        // Boost text by including squad name (BM25 favors keyword overlap with brief).
        const text = [
          capId,
          squadName.replace(/-/g, ' '),
          (cap.description || '').trim(),
          examples,
          domains,
          keywords, keywords, keywords,
          exampleBriefs, exampleBriefs,
          produces,
        ].filter(Boolean).join(' ');
        docs.push({
          id: `squad_capability:${squadName}:${capId}`,
          text,
          meta: {
            type: 'squad_capability',
            capability_id: capId,
            squad: squadName,
            description: cap.description || '',
            domains: cap.domains || [],
            not_for: cap.not_for || [],
            fidelity_status: cap.fidelity_status || 'inferred',
            score_boost: typeof cap.score_boost === 'number' ? cap.score_boost : 1.0,
            invoke: cap.invoke || null,
            examples: cap.examples || [],
            inferred_from: cap.inferred_from || 'v4_workflow',
          },
        });
      }
    }
  }

  if (businessesRegistry && businessesRegistry.businesses) {
    for (const [slug, b] of Object.entries(businessesRegistry.businesses)) {
      const domains = Array.isArray(b.domains) ? b.domains.join(' ') : '';
      const caps = Array.isArray(b.capabilities) ? b.capabilities.join(' ') : '';
      const text = [
        slug,
        b.description || '',
        domains,
        caps,
      ].filter(Boolean).join(' ');
      docs.push({
        id: `business:${slug}`,
        text,
        meta: {
          type: 'business',
          slug,
          description: b.description || '',
          domains: b.domains || [],
          capabilities: b.capabilities || [],
          operation_mode: b.operation_mode || null,
          authority_level: b.authority_level || null,
          manifest_path: b.manifest_path || null,
        },
      });
    }
  }

  // Business auto_routes: 1 doc per (business, route_to, pattern).
  // Lets briefs match business-level routing rules (e.g. "type:refund-request"
  // → nexus-billing-ops). The registry indexer puts these in `_business_routing`
  // (not in the schema-validated portion of the registry).
  const businessRouting = businessesRegistry && businessesRegistry._business_routing;
  if (businessRouting && typeof businessRouting === 'object') {
    for (const [slug, routes] of Object.entries(businessRouting)) {
      if (!Array.isArray(routes)) continue;
      const businessEntry = (businessesRegistry.businesses || {})[slug] || {};
      const businessDomains = Array.isArray(businessEntry.domains) ? businessEntry.domains.join(' ') : '';
      for (const route of routes) {
        if (!route || typeof route.pattern !== 'string' || typeof route.route_to !== 'string') continue;
        // Extract keywords from pattern. Patterns are typically `type:X-Y_Z`.
        // Strip `type:` prefix and split on `[-_:]` to get matchable tokens.
        const patternClean = route.pattern.replace(/^type:/, '').replace(/[-_:]/g, ' ').trim();
        // Boost matchability: include slug, employee, and pattern keywords twice
        // so BM25 favors brief→pattern matches over generic descriptions.
        const text = [
          patternClean, patternClean,
          route.route_to.replace(/-/g, ' '),
          slug,
          businessDomains,
        ].filter(Boolean).join(' ');
        docs.push({
          id: `business_route:${slug}:${route.route_to}:${route.pattern}`,
          text,
          meta: {
            type: 'business_route',
            slug,
            route_to: route.route_to,
            pattern: route.pattern,
            requires_escalation_to: route.requires_escalation_to || null,
            confidence_threshold: typeof route.confidence_threshold === 'number'
              ? route.confidence_threshold : null,
            manifest_path: businessEntry.manifest_path || null,
          },
        });
      }
    }
  }

  return docs;
}

/**
 * Apply post-BM25 boosts/penalties:
 *  - score_boost from registry entry
 *  - not_for penalty when brief mentions any not_for entry
 *  - intent filter: WORK only -> exclude businesses; RUN_ORG only -> exclude squads
 */
function applyAdjustments(results, intent, briefText) {
  const lc = (briefText || '').toLowerCase();
  const adjusted = [];
  for (const r of results) {
    const meta = r.doc.meta;
    if (intent === 'WORK' && meta.type === 'business') continue;
    if (intent === 'RUN_ORG' && meta.type === 'squad_capability') continue;
    // business_route is dispatch-to-employee — passes through both intents
    // (a brief routing to nexus-billing-ops counts as WORK delegation).

    let score = r.normalized;
    // Cap no boost aplicado: com keywords agora indexados (E6), um boost alto
    // (1.5) transforma squads de vocabulário largo em ímãs que roubam domínios
    // alheios. O boost deve favorecer curadoria em empates, não superar diferença
    // real de relevância. Teto 1.3 preserva a intenção sem o efeito-ímã.
    const rawBoost = meta.score_boost != null ? meta.score_boost : 1.0;
    const boost = Math.min(rawBoost, 1.3);
    score *= boost;

    if (Array.isArray(meta.not_for) && meta.not_for.length > 0) {
      for (const nf of meta.not_for) {
        if (typeof nf === 'string' && nf.length > 2 && lc.includes(nf.toLowerCase())) {
          score *= DEFAULT_THRESHOLDS.not_for_penalty;
          break;
        }
      }
    }
    adjusted.push({ ...r, score_adjusted: score });
  }
  // Re-rank by adjusted score
  adjusted.sort((a, b) => b.score_adjusted - a.score_adjusted);
  // Re-normalize so the top is 1.0 again (so thresholds apply consistently)
  const top = adjusted.length ? adjusted[0].score_adjusted : 0;
  for (const a of adjusted) {
    a.normalized = top > 0 ? a.score_adjusted / top : 0;
  }
  return adjusted;
}

/**
 * Stage 2 — Capability matching (BM25, zero LLM).
 *
 * @param {{intent: string, domains?: string[], verbs?: string[]}} intent
 * @param {{squads: object, businesses: object}} registries
 * @param {{topK?: number, brief?: string}} opts
 * @returns {Array<{id: string, score: number, normalized: number, meta: object}>}
 */
function stage2Match(intent, registries, opts) {
  const brief = (opts && opts.brief) || '';
  const docs = buildMatchDocs(registries.squads, registries.businesses);
  if (docs.length === 0) return [];

  const idx = bm25.buildIndex(docs);
  const queryStr = brief + ' ' + ((intent && intent.domains) || []).join(' ') + ' ' + ((intent && intent.verbs) || []).join(' ');
  const raw = bm25.query(idx, queryStr, { topK: (opts && opts.topK) || 10 });

  const adjusted = applyAdjustments(raw, intent && intent.intent, brief);
  return adjusted.map((r) => ({
    id: r.doc.id,
    score: r.score,
    normalized: r.normalized,
    score_adjusted: r.score_adjusted,
    meta: r.doc.meta,
  }));
}

/**
 * Stage 2 híbrido — BM25 (esparso) + braço DENSO opcional (neural), fundidos por
 * Reciprocal Rank Fusion. Quando o backend neural não está ativo, degrada para
 * BM25 puro (idêntico a stage2Match) — o produto base nunca depende do denso.
 * A via densa recupera especialistas que o BM25 perde por vocabulário (sinônimo/
 * paráfrase sem overlap de token), enquanto o BM25 mantém o casamento exato.
 *
 * @returns {Promise<Array<{id, score, normalized, score_adjusted, meta}>>}
 */
async function stage2MatchHybrid(intent, registries, opts) {
  const brief = (opts && opts.brief) || '';
  const topK = (opts && opts.topK) || 10;
  const docs = buildMatchDocs(registries.squads, registries.businesses);
  if (docs.length === 0) return [];

  const idx = bm25.buildIndex(docs);
  const queryStr = brief + ' ' + ((intent && intent.domains) || []).join(' ') + ' ' + ((intent && intent.verbs) || []).join(' ');
  const bm25Full = bm25.query(idx, queryStr, { topK: docs.length });

  // Braço denso opcional. denseRank devolve null quando o neural não está ativo.
  let denseScored = null;
  try {
    const denseIndex = require(path.join(__dirname, '..', '..', '_shared', 'lib', 'dense-index.ts'));
    denseScored = await denseIndex.denseRank(brief, docs);
  } catch { denseScored = null; }

  // business_route ranqueado por cobertura de keywords — TERCEIRA lista do RRF
  // (achado #4d): dá boost por RANK aos business_route sem o normalized=1.0.
  const coverageRanked = Array.isArray(opts && opts.businessRouteRanked) ? opts.businessRouteRanked : [];

  // Fusão só quando há MAIS de uma lista ranqueada (dense ativo OU business_route
  // candidatos). Sem nenhum dos dois → BM25 puro (comportamento calibrado da Fase
  // 2, preservado — zero mudança para briefs sem business_route).
  const lists = [{ id: 'bm25', items: bm25Full.map((r) => ({ id: r.doc.id })) }];
  if (denseScored) lists.push({ id: 'dense', items: denseScored.map((s) => ({ id: s.id })) });
  if (coverageRanked.length) lists.push({ id: 'coverage', items: coverageRanked.map((c) => ({ id: c.id })) });

  if (lists.length === 1) {
    const adjusted = applyAdjustments(bm25Full.slice(0, Math.max(topK, 10)), intent && intent.intent, brief);
    return adjusted.slice(0, topK).map((r) => ({ id: r.doc.id, score: r.score, normalized: r.normalized, score_adjusted: r.score_adjusted, meta: r.doc.meta }));
  }

  // Fusão RRF (rank-based, escala-agnóstica: BM25 0–15 × cosseno 0–1 × cobertura 0–1).
  const { fuse } = require('./rrf');
  const fused = fuse(lists);
  const byId = new Map(docs.map((d) => [d.id, d]));
  const bm25ById = new Map(bm25Full.map((r) => [r.doc.id, r]));
  const topRrf = fused.length ? fused[0].rrf : 0;
  // normalized = rrf/maxRrf → HIGH quando um doc domina AMBOS os rankings;
  // AMBIGUOUS quando há competição (semântica correta para fusão).
  const merged = fused.map((f) => {
    const doc = byId.get(f.id);
    const r = bm25ById.get(f.id);
    return { doc, score: r ? r.score : 0, normalized: topRrf > 0 ? f.rrf / topRrf : 0 };
  }).filter((x) => x.doc);

  const adjusted = applyAdjustments(merged, intent && intent.intent, brief);
  return adjusted.slice(0, topK).map((r) => ({ id: r.doc.id, score: r.score, normalized: r.normalized, score_adjusted: r.score_adjusted, meta: r.doc.meta }));
}

/**
 * Stage 3 — Routing decision (3-signal output).
 *
 * @param {Array} matches result of stage2Match
 * @param {{thresholds?: object}} opts
 * @returns {{
 *   signal: 'HIGH'|'AMBIGUOUS'|'NO_MATCH',
 *   target?: object,
 *   alternatives?: Array,
 *   reason?: string,
 *   thresholds: object,
 * }}
 */
function stage3Decide(matches, opts) {
  const thr = Object.assign({}, DEFAULT_THRESHOLDS, (opts && opts.thresholds) || {});
  if (!matches || matches.length === 0) {
    return { signal: 'NO_MATCH', reason: 'no_candidates', thresholds: thr };
  }
  const top = matches[0];
  const second = matches[1] || { normalized: 0 };

  const lead = top.normalized - second.normalized;

  if (top.normalized >= thr.match_high_threshold && lead >= thr.match_high_lead) {
    return {
      signal: 'HIGH',
      target: top,
      alternatives: matches.slice(1, 3),
      reason: `top=${top.normalized.toFixed(3)} ge ${thr.match_high_threshold} & lead=${lead.toFixed(3)} ge ${thr.match_high_lead}`,
      thresholds: thr,
    };
  }

  // AMBIGUOUS: 2+ candidates within `match_ambiguous_window` of top, all >= ambiguous threshold
  const cluster = matches.filter((m) =>
    m.normalized >= thr.match_ambiguous_threshold &&
    (top.normalized - m.normalized) <= thr.match_ambiguous_window
  );
  if (cluster.length >= 2) {
    return {
      signal: 'AMBIGUOUS',
      alternatives: cluster,
      reason: `${cluster.length} candidates within window ${thr.match_ambiguous_window} of top ${top.normalized.toFixed(3)}`,
      thresholds: thr,
    };
  }

  if (top.normalized >= thr.match_ambiguous_threshold) {
    // Single match between ambiguous and high. Prefer to surface as AMBIGUOUS so user confirms.
    return {
      signal: 'AMBIGUOUS',
      alternatives: [top, ...matches.slice(1, 3)],
      reason: `top ${top.normalized.toFixed(3)} below high threshold ${thr.match_high_threshold} — confirm`,
      thresholds: thr,
    };
  }

  return {
    signal: 'NO_MATCH',
    reason: `top score ${top.normalized.toFixed(3)} below ambiguous threshold ${thr.match_ambiguous_threshold}`,
    alternatives: matches.slice(0, 3),
    thresholds: thr,
  };
}

/**
 * Stage 4 — Budget pre-flight. Delegates to lib/budget.js.
 *
 * @param {object} target match meta from Stage 3 (or null)
 * @param {object} ctx optional cap overrides
 * @returns {{ok: boolean, estimated_usd: number, max_cost_usd: number, breakdown: object}}
 */
function stage4BudgetCheck(target, ctx) {
  const t = target || {};
  return budget.check(t.meta || t, ctx);
}

/**
 * Stage 5 — Lazy invocation spec. Produces a plan rather than executing,
 * so the runtime adapter can dispatch via its native subagent system.
 *
 * @param {object} target match from Stage 3
 * @param {string} brief original brief
 * @param {object} ctx context
 * @returns {{
 *   target_type: string,
 *   target_id: string,
 *   manifest_path?: string,
 *   adapter_hint: string,
 *   loader: string,
 *   inherit_context: boolean,
 *   handoff_artifact_required: boolean,
 *   max_handoff_tokens: number,
 * }}
 */
function stage5Invoke(target, brief, ctx) {
  if (!target) {
    return { error: 'no_target', message: 'stage5Invoke called without a target' };
  }
  const meta = target.meta || target;
  const type = meta.type || (meta.slug ? 'business' : 'squad_capability');

  let loader;
  if (type === 'business_route') {
    const escalation = meta.requires_escalation_to ? ` then escalate to ${meta.requires_escalation_to}` : '';
    loader = `businesses skill (load ${meta.slug}, dispatch directly to employee ${meta.route_to}${escalation})`;
  } else if (type === 'business') {
    loader = 'businesses skill (load business.yaml lazily, dispatch to brief_intake employee)';
  } else {
    loader = 'squads skill (load capability provider squad, route to capability_id)';
  }

  const plan = {
    target_type: type,
    target_id: meta.slug || meta.capability_id || target.id,
    capability_id: meta.capability_id || null,
    squad: meta.squad || null,
    business_slug: meta.slug || null,
    employee: meta.route_to || null,
    pattern: meta.pattern || null,
    requires_escalation_to: meta.requires_escalation_to || null,
    manifest_path: meta.manifest_path || null,
    invoke: meta.invoke || null,
    fidelity_status: meta.fidelity_status || null,
    operation_mode: meta.operation_mode || null,
    adapter_hint: ctx && ctx.runtime ? ctx.runtime : 'claude-code',
    loader,
    inherit_context: true,
    handoff_artifact_required: true,
    max_handoff_tokens: 800,
    brief,
  };
  return plan;
}

/**
 * Stage 0 — Business auto_route pattern matching (pre-BM25 short-circuit).
 *
 * Runs BEFORE BM25 (Stage 2) when a businesses registry is present.
 * For each business + auto_route in `_business_routing`, computes the fraction
 * of pattern keywords (split from `type:X-Y_Z` patterns) found in the brief.
 *
 * If the best match meets `STAGE0_KEYWORD_THRESHOLD` (default 1.0), Stage 0
 * returns a synthetic match with that route — bypassing BM25 entirely. This
 * solves the problem where business_route docs lose BM25 scoring against
 * keyword-rich squad capability docs even though the brief explicitly
 * mentions a routable type (refund, conclave, security, billing, etc.).
 *
 * @param {string} brief
 * @param {object} businessesRegistry registry with `_business_routing`
 * @param {{threshold?: number, scoreFloor?: number}} opts
 * @returns {?object} synthetic match (same shape as stage2Match entries) or null
 */
const STAGE0_KEYWORD_THRESHOLD = 1.0;

// Objetos genéricos que QUALQUER negócio entrega. Um business_route cujo pattern
// só contém estes termos não carrega sinal de TEMA/domínio — deixá-lo curto-
// circuitar antes do BM25 faz "landing page para X" cair sempre no mesmo
// business, seja X cafeteria, turismo ou bitcoin (Stage-0 cego a domínio). Nesse
// caso o Stage-0 se abstém e deixa o BM25/denso decidir pelo domínio.
const GENERIC_OBJECT_KEYWORDS = new Set([
  'landing', 'page', 'pagina', 'página', 'copy', 'post', 'posts', 'video', 'vídeo',
  'brand', 'site', 'website', 'app', 'texto', 'ads', 'anuncio', 'anúncio',
  'conteudo', 'conteúdo', 'pdf', 'banner', 'email', 'newsletter',
]);

function stage0BusinessRouteMatch(brief, businessesRegistry, opts) {
  if (!businessesRegistry || !businessesRegistry._business_routing) return null;
  const threshold = (opts && typeof opts.threshold === 'number') ? opts.threshold : STAGE0_KEYWORD_THRESHOLD;

  const briefLc = (brief || '').toLowerCase();
  if (briefLc.length === 0) return null;

  let best = null;
  let bestScore = 0;
  let bestKeywordCount = 0;

  for (const [slug, routes] of Object.entries(businessesRegistry._business_routing)) {
    if (!Array.isArray(routes)) continue;
    const businessEntry = (businessesRegistry.businesses || {})[slug] || {};

    for (const route of routes) {
      if (!route || typeof route.pattern !== 'string' || typeof route.route_to !== 'string') continue;
      // Extract pattern keywords. "type:refund-request" -> ["refund","request"].
      const keywords = route.pattern
        .replace(/^type:/, '')
        .split(/[-_:.]/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length >= 3);
      if (keywords.length === 0) continue;
      // Abstém-se de patterns só de objeto genérico — sem sinal de domínio,
      // o BM25/denso decide (Stage-0 cego a domínio).
      if (keywords.every((k) => GENERIC_OBJECT_KEYWORDS.has(k))) continue;
      let matched = 0;
      for (const k of keywords) {
        if (briefLc.includes(k)) matched++;
      }
      const score = matched / keywords.length;
      // Tiebreaker: prefer routes with more keywords matched (more specific)
      if (score >= threshold && (score > bestScore || (score === bestScore && matched > bestKeywordCount))) {
        bestScore = score;
        bestKeywordCount = matched;
        best = {
          id: `business_route:${slug}:${route.route_to}:${route.pattern}`,
          score: matched,
          normalized: score,
          score_adjusted: score,
          meta: {
            type: 'business_route',
            slug,
            route_to: route.route_to,
            pattern: route.pattern,
            requires_escalation_to: route.requires_escalation_to || null,
            confidence_threshold: typeof route.confidence_threshold === 'number'
              ? route.confidence_threshold : null,
            manifest_path: businessEntry.manifest_path || null,
            stage0_keywords_total: keywords.length,
            stage0_keywords_matched: matched,
          },
        };
      }
    }
  }

  return best;
}

/**
 * Como stage0BusinessRouteMatch, mas retorna a LISTA de todos os business_route
 * cuja cobertura de keywords >= threshold, ordenada desc por cobertura. Usada como
 * uma TERCEIRA lista ranqueada no RRF do Stage 2 — dá aos business_route um boost
 * por RANK (moderado, escala-agnóstico) em vez do normalized=1.0 que sequestrava
 * briefs de squad (achado #4d).
 * @returns {Array<{id: string, coverage: number}>}
 */
function businessRouteCoverageRanked(brief, businessesRegistry, opts) {
  if (!businessesRegistry || !businessesRegistry._business_routing) return [];
  const threshold = (opts && typeof opts.threshold === 'number') ? opts.threshold : STAGE0_KEYWORD_THRESHOLD;
  const briefLc = (brief || '').toLowerCase();
  if (!briefLc) return [];
  const out = [];
  for (const [slug, routes] of Object.entries(businessesRegistry._business_routing)) {
    if (!Array.isArray(routes)) continue;
    for (const route of routes) {
      if (!route || typeof route.pattern !== 'string' || typeof route.route_to !== 'string') continue;
      const keywords = route.pattern.replace(/^type:/, '').split(/[-_:.]/)
        .map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 3);
      if (keywords.length === 0) continue;
      if (keywords.every((k) => GENERIC_OBJECT_KEYWORDS.has(k))) continue;
      let matched = 0;
      for (const k of keywords) if (briefLc.includes(k)) matched++;
      const coverage = matched / keywords.length;
      if (coverage >= threshold) {
        out.push({ id: `business_route:${slug}:${route.route_to}:${route.pattern}`, coverage });
      }
    }
  }
  out.sort((a, b) => b.coverage - a.coverage);
  return out;
}

/**
 * Stage -1 — Meta-intent detection (pre-Stage-0 short-circuit for orchestrators).
 *
 * Runs BEFORE Stage 0. Detects briefs that are:
 *   - Multi-domain (3+ distinct action verbs OR 2+ explicit domain mentions)
 *   - Meta-orchestration (keywords: orchestrate, portfolio, multi-business, lance, completo, tudo, projeto inteiro, etc.)
 *   - Multi-step decomposition (3+ "+", "," or " e " separators)
 *
 * When detected, routes directly to a squad capability matching the meta-pattern
 * (default: `business.project.orchestrate` if business-nirvana-maestro indexed).
 *
 * Solves NQ8: Stage 0 was preferring business specialists over the meta-orchestrator
 * even for briefs that explicitly require multi-business coordination.
 *
 * @param {string} brief
 * @param {object} registries (full {squads, businesses})
 * @param {{minActionVerbs?: number, minSeparators?: number}} opts
 * @returns {?object} synthetic match (same shape as stage2Match entries) or null
 */
const META_INTENT_KEYWORDS = [
  // EN
  'orchestrate', 'orchestration', 'multi-business', 'portfolio', 'across businesses',
  'full project', 'entire project', 'all businesses', 'audit portfolio', 'create business',
  'create squad', 'consolidate outputs', 'across teams', 'launch product with', 'full operation',
  'end to end', 'end-to-end', 'whole project',
  // PT-BR
  'multi empresa', 'multi-empresa', 'orquestrar', 'orquestracao',
  'todo o projeto', 'projeto inteiro', 'projeto completo',
  'audita portfolio', 'audita o portfolio', 'auditar portfolio',
  'cria empresa', 'criar business', 'cria business', 'criar squad', 'criar uma business',
  'preciso de uma business', 'preciso de uma squad', 'preciso de business',
  'tudo o que', 'completo com', 'consolidar outputs',
  'lance um produto', 'lance produto', 'lance o produto', 'lança produto',
  'operacao completa', 'operação completa', 'projeto multi',
  // user dizendo "use suas melhores empresas" → Maestro deve interceptar
  'use suas melhores', 'use as melhores', 'use o melhor',
  'use sua melhor', 'use seu melhor',
  'best businesses', 'best squads', 'use the best',
  'faça o melhor', 'faca o melhor', 'do your best',
  // NOTA (E1): removidas as entradas de ARTEFATO ÚNICO ("crie uma landing",
  // "preciso de copy", "quero ads"…) e as 3 regex mortas ('landing.*copy' etc.,
  // tratadas como substring literal — nunca casavam). Meta-intent é multi-projeto/
  // orquestração; pedido de um único artefato é o que o BM25/denso roteia bem —
  // interceptá-lo aqui mandava tudo para o squad-forge indevidamente.
];

const META_ACTION_VERBS = [
  // EN
  'create', 'launch', 'audit', 'monitor', 'orchestrate', 'consolidate',
  'plan', 'execute', 'synthesize', 'research', 'design', 'build',
  // PT-BR
  'criar', 'cria', 'lance', 'lancar', 'lança', 'audita', 'auditar',
  'monitora', 'orquestrar', 'orquestra', 'consolida', 'consolidar',
  'planeja', 'executa', 'sintetiza', 'pesquisa', 'desenha', 'constroi',
  'monta', 'montar', 'gerencia', 'gerenciar', 'opera', 'operar',
];

function stageMinusOneMetaIntentDetect(brief, registries, opts) {
  if (!brief || typeof brief !== 'string') return null;
  const briefLc = brief.toLowerCase();
  const minActionVerbs = (opts && typeof opts.minActionVerbs === 'number') ? opts.minActionVerbs : 3;
  const minSeparators = (opts && typeof opts.minSeparators === 'number') ? opts.minSeparators : 2;

  // Signal 1: meta keywords
  const metaKeywordHits = META_INTENT_KEYWORDS.filter((k) => briefLc.includes(k));
  const hasMetaKeyword = metaKeywordHits.length > 0;

  // Signal 2: action verbs count
  const verbHits = new Set();
  for (const v of META_ACTION_VERBS) {
    const re = new RegExp(`\\b${v}\\b`, 'i');
    if (re.test(brief)) verbHits.add(v);
  }
  const enoughVerbs = verbHits.size >= minActionVerbs;

  // Signal 3: list separators
  const sepCount = (brief.match(/[+,]|\be\b|\band\b/gi) || []).length;
  const enoughSeparators = sepCount >= minSeparators;

  // Decision: meta-intent if ≥1 meta keyword OR (≥3 distinct action verbs AND ≥2 separators)
  const isMetaIntent = hasMetaKeyword || (enoughVerbs && enoughSeparators);
  if (!isMetaIntent) return null;

  // Find a squad capability that handles meta-orchestration. Prefer
  // `business.project.orchestrate`; fallback to first capability whose id
  // includes `orchestrate`.
  const squadsRegistry = registries && registries.squads;
  if (!squadsRegistry || !squadsRegistry.capabilities) return null;
  const capId = 'business.project.orchestrate';
  let providers = squadsRegistry.capabilities[capId];
  if (!providers || providers.length === 0) {
    // Fallback: first capability with 'orchestrate' substring
    const fallback = Object.entries(squadsRegistry.capabilities).find(([id]) => id.includes('orchestrate'));
    if (!fallback) return null;
    providers = fallback[1];
  }
  const provider = Array.isArray(providers) ? providers[0] : providers;
  if (!provider) return null;

  return {
    id: `squad_capability:${provider.squad}:${capId}`,
    score: verbHits.size + metaKeywordHits.length,
    normalized: 1.0,
    score_adjusted: 1.0,
    meta: {
      type: 'squad_capability',
      capability_id: capId,
      squad: provider.squad,
      description: provider.description || 'Meta-orchestration via business-nirvana-maestro',
      domains: provider.domains || [],
      invoke: provider.invoke || null,
      via_stage_minus_1: true,
      stage_minus_1_signals: {
        meta_keyword_hits: metaKeywordHits,
        action_verb_hits: [...verbHits],
        separators_count: sepCount,
      },
    },
  };
}

// Normaliza para matching: minúsculas + remove acentos (NFD), preservando hífens
// como parte do token. Assim "revisão-cruzada" e "revisao cruzada" convergem.
function _normForMatch(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const _TARGET_CUE = /\b(?:use|usa|usando|utilize|utilizando|rode|rodando|execute|executando|despache|despacha|chame|chama|acione|aciona|via|pelo|pela|com\s+o|com\s+a|no|na|use\s+the|via\s+the|through|run\s+(?:it\s+)?on|dispatch)\b/;
const _TARGET_KIND = /\b(?:squad|empresa|business|company)\b/;

/**
 * Stage 0.5 — Menção explícita a um alvo (squad OU empresa) pelo slug.
 *
 * Espelho de detectRuntimeMention (runtime-rules.ts): quando o usuário NOMEIA um
 * squad/empresa do registry, isso é um COMANDO, não uma pista de retrieval — deve
 * curto-circuitar antes de qualquer scoring/business-first. Guardas anti-falso-
 * positivo: o slug tem que aparecer como token inteiro (hífen/acento normalizados)
 * E ser distintivo (multi-token, ex. "code-review") OU ter um cue instrumental
 * adjacente ("use o squad X"). Slug de palavra-comum ("research") exige o cue.
 * Dispara SÓ com exatamente 1 alvo distinto; 0 ou ≥2 → null (deixa o BM25/agêntico).
 *
 * @returns {?{slug: string, type: 'squad'|'business', mention: string}}
 */
function detectTargetMention(brief, registries) {
  if (!brief || !brief.trim() || !registries) return null;
  const squadSlugs = new Set();
  try {
    for (const d of buildMatchDocs(registries.squads, registries.businesses)) {
      if (d.meta && d.meta.type === 'squad_capability' && d.meta.squad) squadSlugs.add(d.meta.squad);
    }
  } catch { /* registries malformados — sem menção */ }
  const businessSlugs = new Set(Object.keys((registries.businesses && registries.businesses.businesses) || {}));

  const briefN = _normForMatch(brief);
  const found = new Map(); // slug -> {slug, type, mention}
  const consider = (slug, type) => {
    if (found.has(slug)) return;
    const slugN = _normForMatch(slug);
    if (!slugN) return;
    const esc = slugN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^a-z0-9-])(${esc})([^a-z0-9-]|$)`);
    const m = re.exec(briefN);
    if (!m) return;
    const distinctive = slugN.includes('-'); // multi-token slug é distintivo por si
    const before = briefN.slice(Math.max(0, m.index - 40), m.index + m[1].length);
    const hasCue = _TARGET_CUE.test(before) || _TARGET_KIND.test(before);
    if (distinctive || hasCue) found.set(slug, { slug, type, mention: m[2] });
  };
  for (const s of squadSlugs) consider(s, 'squad');
  for (const b of businessSlugs) consider(b, 'business');

  if (found.size !== 1) return null;
  return [...found.values()][0];
}

/**
 * Constrói um match sintético (shape de stage2Match) para um alvo NOMEADO.
 * Squad → melhor capability do squad (maior score_boost). Empresa → doc business.
 * Marca explicit_mention e força score máximo (é comando, não score).
 * @returns {?object}
 */
function buildTargetMatch(mention, registries) {
  let docs;
  try { docs = buildMatchDocs(registries.squads, registries.businesses); } catch { return null; }
  let base = null;
  if (mention.type === 'squad') {
    const caps = docs.filter(d => d.meta && d.meta.type === 'squad_capability' && d.meta.squad === mention.slug);
    if (!caps.length) return null;
    caps.sort((a, b) => (Number(b.meta.score_boost) || 1) - (Number(a.meta.score_boost) || 1));
    base = caps[0];
  } else {
    base = docs.find(d => d.meta && d.meta.type === 'business' && d.meta.slug === mention.slug) || null;
    if (!base) return null;
  }
  return {
    ...base,
    score: 999,
    normalized: 1.0,
    score_adjusted: 1.0,
    meta: { ...base.meta, explicit_mention: true, explicit_slug: mention.slug },
  };
}

/**
 * Full 6-stage pipeline (Stage -1 + Stage 0 + 1-5).
 * Idempotent given the same inputs + registries.
 * Does NOT execute the invocation — produces a complete decision JSON.
 *
 * @param {string} brief
 * @param {{registries?: object, thresholds?: object, budget?: object, runtime?: string, classifier?: function, knownDomains?: string[], stage0Threshold?: number, disableStageMinus1?: boolean}} ctx
 * @returns {Promise<object>}
 */
// ─────────────────────────────────────────────────────────────────────
// Stage -2 — Brief strength classifier (deterministic, zero LLM)
// ─────────────────────────────────────────────────────────────────────

const STRONG_ACTION_VERBS = [
  // PT-BR
  'criar', 'crie', 'gerar', 'gere', 'analisar', 'analise', 'auditar', 'audite',
  'desenvolver', 'desenvolva', 'planejar', 'planeje', 'lançar', 'lance',
  'escrever', 'escreva', 'desenhar', 'desenhe', 'rodar', 'rode', 'executar',
  'executa', 'validar', 'valide', 'sintetizar', 'sintetize', 'pesquisar',
  'pesquise', 'mapear', 'mapeie', 'medir', 'meça', 'avaliar', 'avalie',
  'classificar', 'classifique', 'comparar', 'compare', 'otimizar', 'otimize',
  // EN
  'create', 'generate', 'analyze', 'analyse', 'audit', 'develop', 'plan',
  'launch', 'write', 'design', 'run', 'execute', 'validate', 'synthesize',
  'research', 'map', 'measure', 'evaluate', 'classify', 'compare', 'optimize',
  'build', 'ship', 'deploy', 'review', 'fix', 'refactor',
];
const VAGUE_MARKERS = [
  'aquilo', 'aquela coisa', 'isso aí', 'tipo assim', 'a gente falou',
  'sabe', 'sei lá', 'meio que', 'que nem aquilo', 'tipo aquele',
  'that thing', 'you know', 'whatever', 'kinda', 'sort of', 'something like',
];

/**
 * Pure heuristic — returns "WEAK" | "NORMAL" | "STRONG" without any LLM call.
 * Signals tracked: token count, action verb density, vagueness markers,
 * specificity markers (URLs, handles, numbers, named entities).
 */
function classifyBriefStrength(brief) {
  const text = (brief || '').toLowerCase().trim();
  if (text.length === 0) {
    return { strength: 'WEAK', score: -10, signals: { reason: 'empty_brief' } };
  }
  const tokens = text.split(/\s+/).filter(Boolean);
  const tokenCount = tokens.length;

  let score = 0;
  const signals = { token_count: tokenCount };

  if (tokenCount >= 30) score += 3;
  else if (tokenCount >= 15) score += 1;
  else if (tokenCount < 5) score -= 3;

  const verbHits = STRONG_ACTION_VERBS.filter((v) => new RegExp(`\\b${v}\\b`).test(text)).length;
  signals.action_verb_hits = verbHits;
  score += Math.min(verbHits, 3);

  const vagueHits = VAGUE_MARKERS.filter((m) => text.includes(m)).length;
  signals.vague_marker_hits = vagueHits;
  score -= vagueHits * 2;

  const hasHandleOrUrl = /https?:\/\/|www\.|@\w{3,}|\.com\b|\.br\b|\.org\b|\.io\b/.test(text);
  if (hasHandleOrUrl) { score += 2; signals.has_handle_or_url = true; }

  const hasNumbers = /\d{2,}/.test(text);
  if (hasNumbers) { score += 1; signals.has_numbers = true; }

  // Capitalized named entities (proper nouns) in the original brief
  const namedEntityCount = (brief.match(/\b[A-Z][a-zà-ÿ]{2,}/g) || []).length;
  signals.named_entity_count = namedEntityCount;
  if (namedEntityCount >= 2) score += 1;

  let strength;
  if (score >= 4) strength = 'STRONG';
  else if (score >= 1) strength = 'NORMAL';
  else strength = 'WEAK';

  return { strength, score, signals };
}

// ─────────────────────────────────────────────────────────────────────
// Stage -1.5 — Brief amplifier (graceful: built-in or maestro persona)
// ─────────────────────────────────────────────────────────────────────

const MAESTRO_INTERPRETER_PATH_GUESSES = [
  // Project scope first (per scope-aware paths)
  () => path.join(process.cwd(), '.nirvana', 'squads', 'business-nirvana-maestro', 'agents', 'brief-interpreter.md'),
  // Global scope (default install)
  () => path.join(os.homedir(), 'squads', 'business-nirvana-maestro', 'agents', 'brief-interpreter.md'),
];

function loadMaestroPersona() {
  for (const guess of MAESTRO_INTERPRETER_PATH_GUESSES) {
    const p = guess();
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, 'utf8');
        // Strip frontmatter; pass body as persona.
        const body = raw.replace(/^---\n[\s\S]+?\n---\n?/, '').trim();
        return { persona: body.slice(0, 8000), path: p };
      } catch {}
    }
  }
  return null;
}

const BUILTIN_AMPLIFIER_PERSONA = [
  'You are a brief interpreter and amplifier for an autonomous multi-agent system.',
  'When the user gives a fragmentary, vague, or under-specified request, you rewrite it into',
  'an explicit brief that downstream agents (squads / businesses / mind-clones) can execute.',
  '',
  'Your output MUST contain, when inferable from the original:',
  '  • Goal — what outcome the user wants',
  '  • Scope — bounds, what is in/out',
  '  • Success criteria — how we know it worked',
  '  • Constraints — time, budget, format, language, tone',
  '  • Deliverables — concrete artifacts expected',
  '  • Domain hints — keywords pointing at the right business or capability',
  '',
  'Mirror the user\'s language (PT-BR, EN, etc.). Do NOT invent facts the user did not state.',
  'When uncertain, write "[infer: …]" rather than fabricating.',
  '',
  'Output ONLY the amplified brief as Markdown. No preamble, no explanation, no JSON.',
].join('\n');

/**
 * Amplify a weak brief. Uses maestro's brief-interpreter persona when the
 * maestro squad is installed; falls back to built-in persona otherwise.
 * Both paths use the same callHostAgentAsync, so the system works without
 * any squad installed (framework-only deployment).
 */
async function amplifyBrief(brief, opts) {
  const driver = getHostDriver();
  if (!driver || !driver.callHostAgentAsync) {
    return { ok: false, reason: 'host-agent-driver-not-loadable' };
  }
  const host = driver.detectHost?.();
  if (!host) {
    return { ok: false, reason: 'no-host-runtime-detected' };
  }
  const preferAmplifier = opts && opts.preferAmplifier;
  let persona = BUILTIN_AMPLIFIER_PERSONA;
  let via = 'builtin';
  if (preferAmplifier !== 'builtin') {
    const maestro = loadMaestroPersona();
    if (maestro) {
      persona = maestro.persona;
      via = 'maestro';
    }
  }
  const userMessage = [
    'Original user brief (verbatim):',
    '"""',
    brief,
    '"""',
    '',
    'Rewrite it as an explicit, executable brief. Mirror the user\'s language.',
  ].join('\n');
  const r = await driver.callHostAgentAsync(persona, userMessage, { timeoutMs: opts?.timeoutMs || 180_000 });
  if ('error' in r) {
    return { ok: false, reason: r.error.slice(0, 200), via };
  }
  const amplified = (r.text || '').trim();
  if (amplified.length < 30) {
    return { ok: false, reason: 'amplified_too_short', via };
  }
  return { ok: true, amplified, via };
}

async function route(brief, ctx) {
  const context = ctx || {};
  const registries = context.registries || registryLoader.loadAll();
  const originalBrief = brief;
  let workingBrief = brief;
  let amplification = null;

  // Stage -2 — Brief strength classifier (zero LLM)
  const strengthReport = classifyBriefStrength(brief);

  // Stage -1.5 — Optional amplification when WEAK (or --force-amplify)
  // Disabled by --no-amplify (context.amplify === false).
  const shouldAmplify =
    context.amplify !== false &&
    (context.forceAmplify === true || strengthReport.strength === 'WEAK');
  if (shouldAmplify) {
    const amp = await amplifyBrief(brief, {
      preferAmplifier: context.preferAmplifier,
      timeoutMs: context.amplifyTimeoutMs,
    });
    if (amp.ok) {
      workingBrief = amp.amplified;
      amplification = {
        amplifier_used: amp.via,
        amplified_brief: amp.amplified,
        original_brief: originalBrief,
        strength: strengthReport,
      };
    } else {
      amplification = {
        amplifier_used: 'failed',
        reason: amp.reason,
        original_brief: originalBrief,
        strength: strengthReport,
      };
    }
  } else {
    amplification = {
      amplifier_used: 'skipped',
      reason: context.amplify === false
        ? 'amplify_disabled'
        : `strength=${strengthReport.strength}_above_threshold`,
      original_brief: originalBrief,
      strength: strengthReport,
    };
  }

  // From here on, downstream stages run on the working (possibly amplified) brief
  brief = workingBrief;

  // Stage 1 — async only if classifier provided
  let intent;
  if (typeof context.classifier === 'function') {
    intent = await context.classifier(brief, context);
  } else {
    intent = stage1IntentClassify(brief, {
      knownDomains: context.knownDomains || Object.keys(registries.squads.domains || {}),
    });
  }

  // Stage 0.5 — Explicit target mention (pre-everything short-circuit).
  // Nomear um squad/empresa é um COMANDO do usuário — vence meta-intent, Stage 0
  // e business-first. Roda no brief ORIGINAL (a amplificação pode diluir a menção).
  // Desligável via context.disableExplicitMention (paridade com --no-* flags).
  if (!context.disableExplicitMention) {
    const mention = detectTargetMention(originalBrief, registries);
    if (mention) {
      const targetMatch = buildTargetMatch(mention, registries);
      if (targetMatch) {
        const decision = {
          signal: 'HIGH',
          target: targetMatch,
          alternatives: [],
          reason: `explicit mention: você nomeou o ${mention.type === 'squad' ? 'squad' : 'a empresa'} "${mention.slug}"`,
          thresholds: DEFAULT_THRESHOLDS,
          route_tier: 'explicit_mention',
        };
        return {
          brief,
          original_brief: originalBrief,
          timestamp: new Date().toISOString(),
          stage_minus_2: amplification,
          stage1: intent,
          stage_explicit_mention: { matched: true, slug: mention.slug, type: mention.type },
          stage2: { skipped: true, reason: 'explicit_target_mention_short_circuit' },
          stage3: decision,
          stage4: stage4BudgetCheck(targetMatch, context.budget),
          stage5: stage5Invoke(targetMatch, brief, context),
          context_budget: contextBudget.estimateContextBudget(),
          warnings: registries.warnings || [],
        };
      }
    }
  }

  // Stage -1 — Meta-intent detection (pre-Stage-0 short-circuit for orchestrators)
  if (!context.disableStageMinus1) {
    const metaMatch = stageMinusOneMetaIntentDetect(brief, registries, {
      minActionVerbs: context.metaActionVerbsThreshold,
      minSeparators: context.metaSeparatorsThreshold,
    });
    if (metaMatch) {
      const decision = {
        signal: 'HIGH',
        target: metaMatch,
        alternatives: [],
        reason: `stage-1 meta-intent: ${metaMatch.meta.stage_minus_1_signals.meta_keyword_hits.length} meta keyword(s) + ${metaMatch.meta.stage_minus_1_signals.action_verb_hits.length} action verb(s)`,
        thresholds: DEFAULT_THRESHOLDS,
        via_stage_minus_1: true,
        route_tier: 'stage_minus_1_meta',
      };
      return {
        brief,
        original_brief: originalBrief,
        timestamp: new Date().toISOString(),
        stage_minus_2: amplification,
        stage1: intent,
        stage_minus_1: { matched: true, signals: metaMatch.meta.stage_minus_1_signals },
        stage2: { skipped: true, reason: 'stage_minus_1_meta_orchestrator_short_circuit' },
        stage3: decision,
        stage4: stage4BudgetCheck(metaMatch, context.budget),
        stage5: stage5Invoke(metaMatch, brief, context),
        context_budget: contextBudget.estimateContextBudget(),
        warnings: registries.warnings || [],
      };
    }
  }

  // Stage 0 — Business auto_route short-circuit
  // IMPORTANT: skip Stage 0 short-circuit when brief contains premium-quality
  // keywords. These signal that user wants a premium squad (awwwards, cinematic,
  // etc.) and would otherwise be hijacked by generic business routes.
  const PREMIUM_BRIEF_KEYWORDS = [
    'awwwards', 'singularity', 'cinematic', 'webgl', 'gsap', 'three.js',
    'scroll-driven', 'parallax', 'award-winning', 'award winning',
    'production-ready', 'premium quality', 'agency-grade', 'agency grade',
    'high-fidelity', 'pixel-perfect',
  ];
  const briefLcForPremium = (brief || '').toLowerCase();
  const isPremiumBrief = PREMIUM_BRIEF_KEYWORDS.some((k) => briefLcForPremium.includes(k));

  // Stage 0 — Business auto_route. Antes CURTO-CIRCUITAVA antes do BM25: um match de
  // PADRÃO DE ARTEFATO ("modelos"→ml-model) sequestrava briefs que casavam um squad
  // por CONTEÚDO (achado #4d). Agora os business_route entram como uma TERCEIRA lista
  // ranqueada por cobertura, FUNDIDA no RRF do Stage 2 (rank-based, escala-agnóstica)
  // — ganham boost por rank, mas um squad que casa por conteúdo continua vencendo.
  const businessRouteRanked = isPremiumBrief
    ? []
    : businessRouteCoverageRanked(brief, registries.businesses, {
        threshold: context.stage0Threshold,
      });

  // Stage 2 — Capability matching (BM25 + denso opcional + business_route, RRF)
  const matches = await stage2MatchHybrid(intent, registries, { brief, topK: 10, businessRouteRanked });

  // Stage 2.5 — Business-first preference.
  // Rationale: a business is a compositional unit (CEO + employees + org-chart
  // + audit trail) that can dispatch to internal squads. A bare squad is an
  // atomic capability. For most user briefs, going through the business gives
  // richer orchestration, observability, and humanization. We prefer business
  // when one is viable; we fall back to squads when no business clears the bar
  // (e.g. system-only capabilities like squad audits or registry tooling).
  //
  // Override per-call with `context.prefer = 'squad' | 'business' | 'auto'`.
  // Default 'business'. 'auto' = legacy behavior (no preference).
  const prefer = context.prefer || 'business';
  const businessFirstThreshold = typeof context.businessFirstThreshold === 'number'
    ? context.businessFirstThreshold
    : 0.45;
  let routeTier = 'stage2_combined';
  let orderedMatches = matches;
  if (prefer === 'business' && matches.length > 0) {
    const isBusinessLike = (m) => {
      const t = m && m.meta && m.meta.type;
      return t === 'business' || t === 'business_route';
    };
    // A PROMOÇÃO business-first só vale para business GENUÍNO (type 'business',
    // casado por conteúdo). Um 'business_route' (match de PADRÃO DE ARTEFATO) tem
    // score numa escala diferente (cobertura de keywords, quase sempre ~1.0) e NÃO
    // deve ser promovido acima de um squad que casa por conteúdo — ele compete só
    // pelo próprio score no pool. Isso mata o sequestro do achado #4d.
    const businesses = matches.filter((m) => m && m.meta && m.meta.type === 'business');
    const squads = matches.filter((m) => !isBusinessLike(m));
    const bestBusiness = businesses[0];
    const bestSquad = squads[0];
    // Business-first é um DESEMPATE, não um override. Só promove o melhor business
    // ao topo se ele estiver competitivo com o melhor squad (dentro de um delta).
    // Antes: o piso ABSOLUTO 0.45 promovia o business mesmo quando um squad pontuava
    // MUITO mais alto — o "sequestro business-first" reportado (achado #4d). Agora um
    // squad materialmente melhor (> delta acima) vence; empate → business tem a vez.
    const businessTiebreakDelta = typeof context.businessTiebreakDelta === 'number'
      ? context.businessTiebreakDelta
      : 0.08;
    const businessCompetitive = bestBusiness &&
      (!bestSquad || bestBusiness.normalized >= bestSquad.normalized - businessTiebreakDelta);
    if (bestBusiness && bestBusiness.normalized >= businessFirstThreshold && businessCompetitive) {
      // Promove APENAS o melhor business ao topo, preservando o resto ordenado
      // por score (E7). `matches` já vem ordenado por score_adjusted.
      orderedMatches = [bestBusiness, ...matches.filter((m) => m !== bestBusiness)];
      routeTier = 'stage2_business';
    } else {
      // Business bar not met — fall through to combined ranking, mark tier as squad.
      orderedMatches = matches;
      routeTier = bestBusiness ? 'stage2_squad_fallback' : 'stage2_squad';
    }
  } else if (prefer === 'squad') {
    routeTier = 'stage2_squad_forced';
  }

  // Stage 3
  const decision = stage3Decide(orderedMatches, { thresholds: context.thresholds });
  decision.route_tier = routeTier;
  decision.prefer = prefer;

  // Stage 4 — budget only when we have a candidate target (HIGH or AMBIGUOUS top)
  let budgetCheck = null;
  let invocationPlan = null;
  if (decision.signal === 'HIGH' && decision.target) {
    budgetCheck = stage4BudgetCheck(decision.target, context.budget);
    invocationPlan = stage5Invoke(decision.target, brief, context);
  } else if (decision.signal === 'AMBIGUOUS' && decision.alternatives && decision.alternatives.length > 0) {
    // Use the leading alternative for a tentative budget estimate
    budgetCheck = stage4BudgetCheck(decision.alternatives[0], context.budget);
  }

  return {
    brief,
    original_brief: originalBrief,
    timestamp: new Date().toISOString(),
    stage_minus_2: amplification,
    stage1: intent,
    stage2: { candidates_count: matches.length, top: matches.slice(0, 3) },
    stage3: decision,
    stage4: budgetCheck,
    stage5: invocationPlan,
    context_budget: contextBudget.estimateContextBudget(),
    warnings: registries.warnings || [],
  };
}

module.exports = {
  route,
  classifyBriefStrength,
  amplifyBrief,
  stageMinusOneMetaIntentDetect,
  stage0BusinessRouteMatch,
  stage1IntentClassify,
  stage2Match,
  stage2MatchHybrid,
  stage3Decide,
  stage4BudgetCheck,
  stage5Invoke,
  buildMatchDocs,
  DEFAULT_THRESHOLDS,
  STAGE0_KEYWORD_THRESHOLD,
  META_INTENT_KEYWORDS,
  META_ACTION_VERBS,
};

// ─── CLI dispatch ──────────────────────────────────────────────────────
// Invoked as `node router.js <command> [--json] <brief...>`. Used by
// harness/scripts/{find,route}.ts to drive routing from any agent runtime.
// Without this block the wrappers exit silently — agents then fall back
// to spawning generic Claude subagents instead of using the squad/business
// fabric, which defeats the whole point of the harness.
if (require.main === module) {
  const audit = require('./audit');
  (async () => {
    const argv = process.argv.slice(2);
    const cmd = argv[0];
    const rest = argv.slice(1);
    const wantJson = rest.includes('--json');
    // --prefer <business|squad|auto>
    let prefer = 'business';
    const preferIdx = rest.indexOf('--prefer');
    if (preferIdx !== -1 && rest[preferIdx + 1]) {
      const val = rest[preferIdx + 1];
      if (['business', 'squad', 'auto'].includes(val)) prefer = val;
    }
    // --no-amplify | --force-amplify | --prefer-amplifier <builtin|maestro>
    const noAmplify = rest.includes('--no-amplify');
    const forceAmplify = rest.includes('--force-amplify');
    const noStageMinus1 = rest.includes('--no-stage-minus-1'); // E1 — desliga o meta short-circuit
    let preferAmplifier = null;
    const preferAmpIdx = rest.indexOf('--prefer-amplifier');
    if (preferAmpIdx !== -1 && rest[preferAmpIdx + 1]) {
      const val = rest[preferAmpIdx + 1];
      if (['builtin', 'maestro'].includes(val)) preferAmplifier = val;
    }
    const briefParts = rest.filter((a, i) => {
      if (a === '--json') return false;
      if (a === '--prefer') return false;
      if (rest[i - 1] === '--prefer') return false;
      if (a === '--no-amplify') return false;
      if (a === '--force-amplify') return false;
      if (a === '--no-stage-minus-1') return false;
      if (a === '--prefer-amplifier') return false;
      if (rest[i - 1] === '--prefer-amplifier') return false;
      return true;
    });
    const brief = briefParts.join(' ').trim();

    if (!cmd || (cmd !== 'find' && cmd !== 'route')) {
      console.error("usage: node router.js <find|route> [--json] <brief...>");
      process.exit(4);
    }
    if (!brief) {
      console.error(`router.js ${cmd}: brief is empty`);
      process.exit(4);
    }
    try {
      // Audit: brief received (always written when CLI is invoked)
      try { audit.emit('brief_received', { brief, command: cmd }); } catch {}
      const result = await route(brief, {
        prefer,
        amplify: !noAmplify,
        forceAmplify,
        preferAmplifier,
        disableStageMinus1: noStageMinus1,
      });
      // Audit: brief amplification (only if it ran)
      try {
        const amp = result.stage_minus_2;
        if (amp && amp.amplifier_used !== 'skipped' && amp.amplifier_used !== 'failed') {
          audit.emit('brief_amplified', {
            amplifier_used: amp.amplifier_used,
            strength: amp.strength?.strength,
            score: amp.strength?.score,
            original_brief_chars: (amp.original_brief || '').length,
            amplified_brief_chars: (amp.amplified_brief || '').length,
          });
        }
      } catch {}
      // Audit: context budget warning (only when crossing threshold)
      try {
        const cb = result.context_budget;
        if (cb && (cb.warning || cb.critical)) {
          audit.emit('context_budget_warning', {
            threshold_pct: cb.threshold_pct,
            estimated_tokens: cb.estimated_tokens,
            window_tokens: cb.window_tokens,
            warning: cb.warning,
            critical: cb.critical,
            recommendation: cb.recommendation,
          });
        }
      } catch {}
      // Audit: routing decision
      try {
        const s3 = result.stage3 || {};
        audit.emit('routing_decision', {
          signal: s3.signal,
          target_id: s3.target?.id,
          target_slug: s3.target?.slug,
          route_tier: s3.route_tier,
          prefer: s3.prefer,
          alternatives: (s3.alternatives || []).slice(0, 5).map(a => ({ slug: a.slug || a.id, score: a.score })),
        });
      } catch {}
      if (wantJson) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        // Human-readable summary
        const s1 = result.stage1 || {};
        const s3 = result.stage3 || {};
        const amp = result.stage_minus_2 || {};
        process.stdout.write(`brief:    ${brief}\n`);
        process.stdout.write(`strength: ${amp.strength?.strength || '?'} (score ${amp.strength?.score ?? '?'})\n`);
        process.stdout.write(`amplify:  ${amp.amplifier_used || '?'}${amp.amplifier_used === 'failed' ? ` (${amp.reason || ''})` : ''}\n`);
        process.stdout.write(`intent:   ${s1.intent || s1.kind || '?'} (${(s1.confidence ?? 0).toFixed?.(2) ?? '?'})\n`);
        process.stdout.write(`signal:   ${s3.signal || '?'}\n`);
        if (s3.route_tier) process.stdout.write(`tier:     ${s3.route_tier} (prefer=${s3.prefer || 'auto'})\n`);
        const cb = result.context_budget;
        if (cb) {
          const pct = (cb.threshold_pct * 100).toFixed(1);
          const flag = cb.critical ? ' ⚠ CRITICAL' : (cb.warning ? ' ⚠ WARNING' : '');
          process.stdout.write(`context:  ${pct}% of ${cb.window_tokens} tokens (${cb.estimated_tokens} estimated, threshold=${(cb.threshold_warning_pct * 100).toFixed(0)}%)${flag}\n`);
          if (cb.recommendation) process.stdout.write(`recommend: ${cb.recommendation}\n`);
        }
        if (s3.target) {
          const tk = s3.target.meta?.type || s3.target.kind || 'target';
          const ts = s3.target.slug || s3.target.id || '?';
          process.stdout.write(`target:   ${tk} · ${ts}\n`);
        }
        if (Array.isArray(s3.alternatives) && s3.alternatives.length > 0) {
          process.stdout.write(`alternatives:\n`);
          for (const a of s3.alternatives.slice(0, 5)) {
            process.stdout.write(`  - ${a.meta?.type || a.kind || 'target'} · ${a.slug || a.id || '?'} (score=${(a.score ?? 0).toFixed?.(3) ?? '?'})\n`);
          }
        }
      }
      process.exit(0);
    } catch (e) {
      try { audit.emit('validation_failed', { error: e.message, brief }); } catch {}
      console.error(`router.js ${cmd}: ${e.message}`);
      console.error(e.stack);
      process.exit(1);
    }
  })();
}
