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
const nrvPaths = require('../../_shared/lib/paths.js');
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
// Only VERBS/adverbs of MANAGING an organization over time.
// Business-context nouns ("empresa", "cliente", "business", "agência",
// "campanha", "conta", "organização", "conglomerado") were removed from here (E2):
// they described the brief's TOPIC/object ("landing para a empresa do meu cliente"),
// not an order to manage an organization of the system — and made the intent gate
// hide ALL squad_capabilities. Such a noun should only signal RUN_ORG when
// accompanied by a management verb, which these verbs already cover.
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

// ─────────────────────────────────────────────────────────────────────
// Business auto_route patterns -> indexable literals
// ─────────────────────────────────────────────────────────────────────
// A business `auto_route.pattern` is written as an activation REGEX. The
// document that has to retrieve it is a bag of words. Handing the regex
// source to the tokenizer looks like it works — the tokenizer already drops
// punctuation — and it does not, in three ways measured over the 686 routes
// of the live library:
//
//   `seguran[çc]a`  -> ["seguran","cc"]   a brief says "seguranca"; neither is it
//   `\bLCP\b`       -> ["blcp"]           the guard glues onto the acronym
//   `.{0,24}?`      -> ["0","24"]         a gap width becomes vocabulary
//
// The first is the one that matters: PT-BR routes spell every accented word
// as a character class, so the class sits INSIDE the word and splits it. 101
// of the 400 regex-shaped routes carry at least one such wound.
//
// So we read the pattern as a regex and emit the literal phrases it can match.
// The tokenizer then folds `segurança` and `seguranca` onto the same token,
// which is why expanding `[çc]` into both spellings costs one token, not two:
// the class exists because the author wanted both, and folding makes them one.
//
// Scope of the parser: alternation, groups (`(...)`, `(?:...)`), character
// classes, escapes, and quantifiers. Measured on the live library: zero
// lookarounds, zero backreferences, zero named groups, one negated class, two
// ranges — all four of those degrade to a separator rather than a guess.
const ROUTE_LITERAL_VARIANT_CAP = 24;

// `\s` is a separator; `\b` `\w` `\d` and friends carry no literal at all.
// Both become a space: the tokenizer splits there, and a phrase that loses a
// boundary loses nothing a bag of words was going to use.
const REGEX_CLASS_ESCAPES = new Set(['s', 'S', 'w', 'W', 'd', 'D', 'b', 'B', 'A', 'Z', 'z', 'n', 't', 'r', 'f', 'v']);
// Members that a character class uses as glue rather than as a letter.
const CLASS_SEPARATOR_MEMBERS = new Set([' ', '-', '_', '/', '\\s', '\\/', '\\-', '\\.']);

/**
 * Literal phrases a business auto_route pattern can match.
 *
 * @param {string} pattern raw `auto_routes[].pattern`
 * @param {{multiply?: boolean}} [opts] `multiply` crosses a group's branches
 *   with the prefix that precedes them (`security (review|audit)` ->
 *   "security review", "security audit") instead of listing them side by side.
 *   Default ON — see the measurement in routePatternIndexText.
 * @returns {string[]} deduped, non-empty literal phrases
 */
function extractRoutePatternLiterals(pattern, opts) {
  // `type:` is a routing-kind prefix, not vocabulary, and 139 live patterns
  // carry it in FRONT of an alternation (`type:conciliacao_bancaria|...`) —
  // half regex, half the old shape. Strip it once, here, for both halves.
  const src = String(pattern == null ? '' : pattern).replace(/^\(\?i\)/, '').replace(/^type:/, '');
  const multiply = !opts || opts.multiply !== false;
  let i = 0;

  const cross = (a, b) => {
    const out = [];
    for (const x of a) for (const y of b) out.push(x + y);
    return out;
  };

  const isWordChar = (ch) => !!ch && /[\p{L}\p{N}]/u.test(ch);

  /** The next literal character after any quantifier attached to the atom. */
  function peekAfterQuantifier() {
    let j = i;
    if (src[j] === '{') {
      const close = src.indexOf('}', j);
      if (close !== -1 && /^\{\d*,?\d*\}$/.test(src.slice(j, close + 1))) j = close + 1;
    }
    while (src[j] === '?' || src[j] === '*' || src[j] === '+') j++;
    return src[j];
  }

  function parseClass() {
    i++; // consume '['
    const start = i;
    let negated = false;
    if (src[i] === '^') { negated = true; i++; }
    const members = [];
    while (i < src.length && src[i] !== ']') {
      if (src[i] === '\\' && i + 1 < src.length) { members.push(src.slice(i, i + 2)); i += 2; continue; }
      members.push(src[i]); i++;
    }
    if (src[i] === ']') i++;
    const body = src.slice(start, i - 1);
    // A range (`[a-d]`, `[1-4]`) enumerates without naming; a negation names
    // what it excludes. Neither is a keyword, so both become a boundary.
    if (negated || /[^\\]-[^\]]/.test(body)) return [' '];
    const letters = members.filter((m) => !CLASS_SEPARATOR_MEMBERS.has(m));
    // `[- ]`, `[\s-]`, `[\/ ]` — glue holding two words apart.
    if (letters.length === 0) return [' '];
    // A class inside a word is an accent variant: emit each spelling, let the
    // tokenizer fold them. Always multiplies with its prefix, `multiply` or
    // not: `seguran` and `a` are not two keywords, they are one word cut open.
    return letters.map((m) => (m.length === 2 ? m[1] : m));
  }

  // `inline: true` means the atom lives INSIDE a word and always crosses with
  // the prefix — a single character, or a class standing in for one letter.
  // Only a group's branches are ever laid side by side, and only when
  // `multiply` is off.
  function parseAtom(depth) {
    const c = src[i];
    if (c === '(') {
      i++;
      if (src[i] === '?') {
        // `(?:` groups for real; any other `(?…` (flags, lookaround) has no
        // literal of its own. The live library has neither, and a wrong guess
        // about one would be indexed forever.
        if (src[i + 1] === ':') i += 2;
        else { skipGroup(); return { variants: [' '], inline: true }; }
      }
      const inner = depth < 8 ? parseAlt(depth + 1) : [' '];
      if (src[i] === ')') i++;
      return { variants: inner, inline: inner.length <= 1 };
    }
    if (c === '[') return { variants: parseClass(), inline: true };
    if (c === '\\') {
      const e = src[i + 1];
      i += 2;
      if (e === undefined) return { variants: [' '], inline: true };
      return { variants: [REGEX_CLASS_ESCAPES.has(e) ? ' ' : e], inline: true };
    }
    if (c === '.') {
      // `.` between two word characters is a JOINER, not a gap: the author
      // writes `stress.?test` to accept "stress test", "stress-test" and
      // "stresstest" in one atom. A space only buys the first. A hyphen buys
      // all three, because the tokenizer already emits the joined form and the
      // parts for a hyphenated word ("stress-test" -> stresstest, stress,
      // test). Found by measurement: on "Stress-test our 2027 product
      // roadmap", the route that literally spells `stress-test` was ranking
      // ABOVE the one that spells `stress.?test` and means the same thing.
      // Everywhere else — `.{0,24}` gaps, `display . video 360` — it stays a
      // separator.
      i++;
      return { variants: [isWordChar(src[i - 2]) && isWordChar(peekAfterQuantifier()) ? '-' : ' '], inline: true };
    }
    if (c === '^' || c === '$') { i++; return { variants: [' '], inline: true }; }
    i++;
    // `_` and `:` join words the tokenizer will not split: `efd_icms_ipi` is
    // ONE token, and no brief writes it. The old `[-_:]` scrub is why 159
    // patterns had matchable vocabulary at all — keep that, drop the `-`,
    // which the tokenizer already repairs into both the joined and the split
    // forms (`e-?book` -> "ebook" AND "book").
    return { variants: [c === '_' || c === ':' ? ' ' : c], inline: true };
  }

  function skipGroup() {
    let open = 1;
    while (i < src.length && open > 0) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '(') open++;
      else if (src[i] === ')') open--;
      i++;
    }
  }

  // A quantifier repeats the atom we just read. Bag of words does not count,
  // so every quantifier is consumed and the atom is kept exactly once —
  // including `?`, whose optional letter is kept (`rights?` -> "rights",
  // `e-?book` -> "e-book", which the tokenizer already repairs to "ebook").
  function skipQuantifier() {
    if (src[i] === '{') {
      const close = src.indexOf('}', i);
      if (close !== -1 && /^\{\d*,?\d*\}$/.test(src.slice(i, close + 1))) i = close + 1;
    }
    while (src[i] === '?' || src[i] === '*' || src[i] === '+') i++;
  }

  function parseSeq(depth) {
    const done = [];
    let variants = [''];
    while (i < src.length && src[i] !== '|' && src[i] !== ')') {
      const atom = parseAtom(depth);
      skipQuantifier();
      // The cap is not cosmetic: a route with five two-branch groups is 32
      // phrases, and the library has patterns with nine groups.
      if (atom.inline || (multiply && variants.length * atom.variants.length <= ROUTE_LITERAL_VARIANT_CAP)) {
        variants = cross(variants, atom.variants);
      } else {
        done.push(...variants);
        variants = atom.variants.slice();
      }
    }
    return done.concat(variants);
  }

  function parseAlt(depth) {
    const branches = parseSeq(depth).slice();
    while (i < src.length && src[i] === '|') {
      i++;
      branches.push(...parseSeq(depth));
    }
    return branches;
  }

  const out = [];
  const seen = new Set();
  for (const v of parseAlt(0)) {
    const s = v.replace(/\s+/g, ' ').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * The text a business auto_route is indexed under.
 *
 * A pattern with no regex metacharacter keeps the `type:X-Y_Z` treatment it
 * has always had (286 of the 686 live routes are that shape) — the extractor
 * would give the same tokens plus a glued `metaadscampaign`, which is doc
 * length nobody queries.
 *
 * MEASURED, on the criterion brief plus the first `example_brief` of each of
 * the twelve Genesis businesses, reading the best rank of any route of the
 * expected business (lower is better; the whole live corpus in the index):
 *
 *   alternation flat, prefix not multiplied ... 4 cases in the top 4, 10 in the top 10
 *   alternation MULTIPLIED with its prefix ... 5 cases in the top 4, 10 in the top 10
 *
 * Multiplied wins two cases and loses none. voicecraft's TTS route goes rank
 * 7 -> 2 and tracking-360's rank 12 -> 10: both patterns are built from
 * `ger(ar|e|ando) (o |um |este )?(áudio|voz)`-shaped groups, where the prefix
 * is the word that carries the meaning and the branches are inflections. Flat
 * indexes `ger` once and the inflections once each; multiplied repeats the
 * prefix per branch, which is the term frequency the brief actually queries.
 * The cost is +9.8% tokens over the 686 route documents, and only 7 of them
 * have a DISTINCT token set that differs at all — the rest differ only in
 * term frequency, which is exactly the axis being bought.
 */
function routePatternIndexText(pattern) {
  const raw = String(pattern == null ? '' : pattern);
  if (!/[(\[\\|?*+{^$.]/.test(raw)) {
    return raw.replace(/^type:/, '').replace(/[-_:]/g, ' ').trim();
  }
  return extractRoutePatternLiterals(raw).join(' ');
}

/**
 * Build matchable documents from the squads + businesses registries.
 *
 * Squad capabilities -> one doc per (capability_id, provider) pair.
 * Squads            -> one doc per squad entry (name + description + domains
 *                      + capability ids + keywords; no example_briefs/produces).
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
        // keywords/example_briefs/produces are declared in the manifests for
        // discovery (capability.schema.json) but were ignored by BM25 (E6),
        // leaving narrow-vocabulary specialists invisible. Indexed with
        // field-weighting via term repetition — an idiom already used in this
        // file (business_route patternClean ×2): keywords ×3 (strong signal,
        // PT/EN synonyms), example_briefs ×2 (real briefs).
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
        // Execution fields the registry now carries (PR4). They ride in `meta`
        // and never in `text`: budget.js estimates from `estimated_cost_usd`
        // (via stage4BudgetCheck, which reads target.meta), the DAG planner and
        // the race detector schedule from `parallel_safe` / `writes_paths`, and
        // the runtime picks a model from `model_hint`. Spread, so a capability
        // that declares none of them produces the meta it produced before —
        // scoring reads none of these keys either way.
        const execMeta = {};
        if (typeof p.estimated_cost_usd === 'number') execMeta.estimated_cost_usd = p.estimated_cost_usd;
        if (typeof p.parallel_safe === 'boolean') execMeta.parallel_safe = p.parallel_safe;
        if (Array.isArray(p.writes_paths) && p.writes_paths.length > 0) execMeta.writes_paths = p.writes_paths;
        if (typeof p.model_hint === 'string') execMeta.model_hint = p.model_hint;

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
            ...execMeta,
          },
        });

        // Body document — recall, not precision.
        //
        // The metadata doc above is hand-curated and is what decides a match.
        // This one carries the task/agent/workflow text the capability actually
        // executes (extracted at index time by _shared/lib/body-index.js), so a
        // capability whose declared vocabulary missed the user's words can still
        // be FOUND. It is capped below the metadata doc at scoring time
        // (BODY_DOC_MAX_NORMALIZED) so it can surface a candidate but never
        // outrank one whose curated metadata genuinely matched.
        //
        // Weight ×1 deliberately: the body is prose for an executing agent, not
        // a signal someone tuned. Measured before this existed: description-only
        // routing trails body-aware routing by 37-44pp (arXiv:2603.22455).
        if (typeof p.body_text === 'string' && p.body_text.length > 0) {
          docs.push({
            id: `squad_capability_body:${p.squad}:${capId}`,
            text: p.body_text,
            meta: {
              type: 'squad_capability',
              via_body: true,
              capability_id: capId,
              squad: p.squad,
              description: p.description || '',
              domains: p.domains || [],
              not_for: p.not_for || [],
              fidelity_status: p.fidelity_status || null,
              score_boost: typeof p.score_boost === 'number' ? p.score_boost : 1.0,
              invoke: p.invoke || null,
              examples: p.examples || [],
              ...execMeta,
            },
          });
        }
      }
    }
  }

  // v4 inferred capabilities — squads without explicit capabilities[] but with
  // workflows/agents that become discoverable BM25 docs. Propagated by the
  // registry-loader in squadsRegistry._v4_inferred_capabilities.
  // Fixes the case of awwwards-singularity-studio (v4) being invisible to the harness.
  const v4Inferred = squadsRegistry && squadsRegistry._v4_inferred_capabilities;
  if (v4Inferred && typeof v4Inferred === 'object') {
    for (const [squadName, caps] of Object.entries(v4Inferred)) {
      if (!Array.isArray(caps)) continue;
      for (const cap of caps) {
        if (!cap || typeof cap.capability_id !== 'string') continue;
        const capId = cap.capability_id;
        const examples = Array.isArray(cap.examples) ? cap.examples.join(' ') : '';
        const domains = Array.isArray(cap.domains) ? cap.domains.join(' ') : '';
        // Same keywords/example_briefs/produces indexing as the v5 branch (E6).
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

  // Per-squad doc (routing-360 Phase 2): the registry emits a squad-level
  // `description` (Phase 2.1) that no doc consumed — briefs phrased at the
  // squad's altitude ("societário e sucessão para escritório contábil") only
  // matched if some capability happened to share the vocabulary. One doc per
  // squad entry: name + description + domains + capability ids + keywords.
  // example_briefs and produces are deliberately EXCLUDED — they already power
  // the capability docs verbatim; duplicating them here inflates squad docs
  // and dilutes business matches (the Phase 2.1 measurement showed
  // description-token dilution is real). A `squad` top hit is a squad-level
  // match: the harness dispatches the squad's best capability agentically.
  if (squadsRegistry && squadsRegistry.squads) {
    for (const [squadName, s] of Object.entries(squadsRegistry.squads)) {
      if (!s || typeof s !== 'object') continue;
      const domains = Array.isArray(s.domains) ? s.domains.join(' ') : '';
      const capIds = Array.isArray(s.capabilities)
        ? s.capabilities.map((c) => String(c).replace(/[._]/g, ' ')).join(' ')
        : '';
      const keywords = Array.isArray(s.keywords) ? s.keywords.join(' ') : '';
      const text = [
        squadName.replace(/-/g, ' '),
        (s.description || '').trim(),
        domains,
        capIds,
        keywords,
      ].filter(Boolean).join(' ');
      docs.push({
        id: `squad:${squadName}`,
        text,
        meta: {
          type: 'squad',
          squad: squadName,
          description: s.description || '',
          domains: s.domains || [],
          capabilities: s.capabilities || [],
          manifest_path: s.manifest_path || null,
        },
      });
    }
  }

  if (businessesRegistry && businessesRegistry.businesses) {
    for (const [slug, b] of Object.entries(businessesRegistry.businesses)) {
      const domains = Array.isArray(b.domains) ? b.domains.join(' ') : '';
      // example_briefs/produces/keywords go into the indexed text (2026-07-27):
      // without them the business was invisible by construction to the VERY
      // brief it declared — measured: 24/319 business example_briefs reached
      // the right destination, because the doc only indexed slug+description+domains+caps
      // while a squad capability indexes the brief verbatim. Same defect class
      // as mind-clones without a routing block (MRR 0.05).
      const exBriefs = Array.isArray(b.example_briefs) ? b.example_briefs.join(' ') : '';
      const produces = Array.isArray(b.produces) ? b.produces.join(' ') : '';
      const keywords = Array.isArray(b.keywords) ? b.keywords.join(' ') : '';
      // Capability IDs are de-dotted/de-underscored before indexing, exactly
      // like the squad docs do (see the squad branch above). Indexing them raw
      // produced tokens no query can ever match: `legal.holding_setup.execute`
      // tokenizes to ["legal","holding_setup","execute"] — the middle token
      // keeps its underscore and matches nothing, while the id still costs
      // document length, which BM25 penalizes. So filling the field that makes
      // a business dispatchable was making it harder to FIND: business top-1
      // drifted 85.75% -> 85.02% -> 84.78% as the enrichment waves populated
      // capability lists. Split into words, the same ids contribute matchable
      // terms ("legal holding setup") instead of dead weight.
      const caps = Array.isArray(b.capabilities)
        ? b.capabilities.map((c) => String(c).replace(/[._]/g, ' ')).join(' ')
        : '';
      const text = [
        slug,
        b.description || '',
        domains,
        caps,
        exBriefs,
        produces,
        keywords,
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
          // Business Protocol 2.0 §6.9. The not_for penalty in applyAdjustments
          // reads meta.not_for and has since routing-360 Phase 2; a business
          // never had one to read, because the registry dropped the field.
          // Deliberately NOT part of `text`: a fence is an exclusion signal,
          // and indexing it would make the brief it excludes match better.
          not_for: b.not_for || [],
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
        // The literals the activation regex can match — see
        // routePatternIndexText. Before it, this line read the regex source
        // itself, and the route was unreachable by any brief written in words.
        const patternClean = routePatternIndexText(route.pattern);
        // Boost matchability: include slug, employee, and pattern keywords twice
        // so BM25 favors brief→pattern matches over generic descriptions.
        //
        // ×2 is measured, and ×3 and beyond were REJECTED. Sweeping the weight
        // on the live corpus against the PT-BR criterion brief (the quoted
        // brief is data, not prose: i18n-user-facing)
        // "preciso de uma revisão de segurança no meu monorepo":
        // ×1 puts sf-security-engineer at rank 32, ×2 at 25,
        // ×3 at 24, and ×4, ×6 and ×8 all at 24-23. The term frequency
        // saturates — BM25's k1 caps what repetition buys — while the document
        // length keeps growing, so past ×2 the weight only lifts routes that
        // ALREADY matched, and on that brief the one it lifted was sf-cto
        // (rank 9 -> 2 at ×6), which matches "monorepo" and is the wrong
        // employee for a security review. Raising the weight to promote the
        // wrong route is tuning to the test.
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

/** Prepare one immutable sparse corpus for batch callers using one registry snapshot. */
function prepareMatchIndex(registries) {
  const docs = buildMatchDocs(registries && registries.squads, registries && registries.businesses);
  return Object.freeze({ docs, index: docs.length ? bm25.buildIndex(docs) : null });
}

/**
 * Content coverage: how many of the brief's content tokens the document matches.
 * Content tokens = the bm25 tokenizer's output (stopwords and scaffolding
 * verbs already removed). Feeds the coverage-based NO_MATCH gate in Stage 3.
 */
function countMatchedContentTokens(brief, docText, aliases) {
  if (!brief || !docText) return { matched: null, total: null };
  // Shared implementation (bm25.coverage) — same function the clone-search
  // gate consults. `aliases` (optional) makes alias-group siblings count as
  // matches (amplification bridge).
  return bm25.coverage(bm25.tokenize(brief), new Set(bm25.tokenize(docText)), aliases);
}

// ─────────────────────────────────────────────────────────────────────
// Keyword aliases (routing-360 Phase 3.3 — amplification bridge, arm b)
// ─────────────────────────────────────────────────────────────────────
// `.keyword-aliases.json` lives NEXT TO the squads registry (emitted by the
// registry indexer): an array of string-arrays, each a cross-language alias
// group (e.g. ["editora","livro","ebook","book","publishing","e-book"]).
// Terms are run through the canonical tokenizer so multi-word entries and
// accented spellings land on the same tokens the index holds. Absence is
// normal (partial install / indexer not run) — the bridge degrades to arm c.
//
// NOTE deliberately NOT done: re-querying BM25 with the expanded token set.
// Measured 2026-08-05 on the live corpus: appending 30-47 alias siblings to a
// 5-token query hands the ranking to IDF-rare junk from loose groups
// ("criar"→"whatsapp", "copy"→"meta") — the winner for "escreva um livro
// digital…" became tracking-360-backend. Alias groups are used ONLY to
// re-score COVERAGE of the already-retrieved candidates (bm25.coverage with
// the alias map), which is immune to that failure mode: an out-of-domain
// brief gains nothing because its tokens have no groups pointing at the
// winner's vocabulary.

let _aliasCache = null; // { path, mtimeMs, map }

/** Compile alias groups into token → Set(sibling tokens). Returns null when
 *  the input yields nothing usable. */
function buildAliasMap(groups) {
  if (!Array.isArray(groups)) return null;
  const map = new Map();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    const members = new Set();
    for (const term of group) {
      for (const t of bm25.tokenize(String(term))) members.add(t);
    }
    for (const t of members) {
      let set = map.get(t);
      if (!set) { set = new Set(); map.set(t, set); }
      for (const m of members) if (m !== t) set.add(m);
    }
  }
  return map.size > 0 ? map : null;
}

/** Load `.keyword-aliases.json` from the one path the writer also uses.
 *
 *  It used to derive the location from the squads registry's directory while
 *  build-routing-digest derived it from the digest's. Those agree in project
 *  scope and diverge in global — registry at ~/, digest at ~/.nirvana/ — so on
 *  every buyer's install the file was written where this function never looked,
 *  and arm (b) of the bridge silently did nothing. Both sides read
 *  KEYWORD_ALIASES_PATH now; `resolvePaths()` re-resolves for the current cwd
 *  rather than trusting values captured at require time.
 *
 *  Tolerates absence and malformed content (returns null). Cached by
 *  path+mtime — route() may run thousands of times per eval. */
function loadKeywordAliases(registries) {
  try {
    const src = registries && registries.squads && registries.squads.source_path;
    if (!src) return null;
    const p = nrvPaths.resolvePaths().KEYWORD_ALIASES_PATH;
    const st = fs.statSync(p); // throws when absent → null below
    if (_aliasCache && _aliasCache.path === p && _aliasCache.mtimeMs === st.mtimeMs) {
      return _aliasCache.map;
    }
    const map = buildAliasMap(JSON.parse(fs.readFileSync(p, 'utf8')));
    _aliasCache = { path: p, mtimeMs: st.mtimeMs, map };
    return map;
  } catch {
    return null;
  }
}

// not_for firing rule (routing-360 Phase 2). The old rule was a whole-string
// substring test — inert in practice: 98.9% of the 974 live not_for entries
// are >40 chars (median 77), and no real brief contains a 77-char sentence
// verbatim. Two paths now:
//   - short entries (≤ NOT_FOR_SUBSTRING_MAX_CHARS): substring fast-path,
//     unchanged — the new contract format uses short token-list entries that
//     should fire on direct mention;
//   - long entries: token overlap via the canonical tokenizer (bm25.tokenize,
//     NFD fold + PT/EN stopwords). Fires when the entry has ≥2 content tokens
//     AND ≥60% of them appear in the brief's token set. The threshold is
//     conservative on purpose: entries that end in "(use other.capability)"
//     carry extra tokens that inflate the denominator, so incidental one-word
//     overlaps ("curso", "video") never fire alone.
const NOT_FOR_SUBSTRING_MAX_CHARS = 25;
const NOT_FOR_MIN_CONTENT_TOKENS = 2;
const NOT_FOR_TOKEN_OVERLAP_MIN = 0.6;

function notForFires(entry, briefLc, briefTokenSet) {
  if (entry.length <= NOT_FOR_SUBSTRING_MAX_CHARS) {
    return entry.length > 2 && briefLc.includes(entry.toLowerCase());
  }
  const entryTokens = new Set(bm25.tokenize(entry));
  if (entryTokens.size < NOT_FOR_MIN_CONTENT_TOKENS) return false;
  let matched = 0;
  for (const t of entryTokens) if (briefTokenSet.has(t)) matched++;
  return matched / entryTokens.size >= NOT_FOR_TOKEN_OVERLAP_MIN;
}

/**
 * Apply post-BM25 boosts/penalties:
 *  - score_boost from registry entry
 *  - not_for penalty when brief mentions any not_for entry
 *  - intent filter: WORK only -> exclude businesses; RUN_ORG only -> exclude squads
 */
function applyAdjustments(results, intent, briefText) {
  const lc = (briefText || '').toLowerCase();
  const briefTokenSet = new Set(bm25.tokenize(briefText || ''));
  // Intent filter is OPT-IN (census 2026-07-27, n=2,358 example_briefs): with
  // the filter on, post-adjustment accuracy was 94.1% vs 99.8% for raw BM25, and
  // ALL 133 dropped cases were its own error (131) or boost 0 (2) — zero
  // curation. Banal verbs ("run", "rodar", "organize") classified RUN_ORG
  // and excluded capabilities by class: 81 fabricated NO_MATCH + 34 HIGH to an
  // unrelated business_route. Enable with NIRVANA_ROUTER_INTENT_FILTER=1 to
  // re-measure; the code remains intact. See ROUTER-INVESTIGACAO.md (analyst).
  const intentFilterOn = process.env.NIRVANA_ROUTER_INTENT_FILTER === '1';
  const adjusted = [];
  for (const r of results) {
    const meta = r.doc.meta;
    if (intentFilterOn) {
      if (intent === 'WORK' && meta.type === 'business') continue;
      if (intent === 'RUN_ORG' && meta.type === 'squad_capability') continue;
    }
    // business_route is dispatch-to-employee — passes through both intents
    // (a brief routing to nexus-billing-ops counts as WORK delegation).

    let score = r.normalized;
    // Cap on the applied boost: with keywords now indexed (E6), a high boost
    // (1.5) turns broad-vocabulary squads into magnets that steal other
    // squads' domains. The boost should favor curation on ties, not overcome a
    // real relevance difference. Ceiling 1.3 keeps the intent without the magnet effect.
    // Floor 1.0: a score_boost declared as 0 was accepted as a ×0 multiplier and
    // self-annihilated the capability (2 real cases in the census, omnidoc
    // automation.deps.bootstrap). Boost is an upward tiebreak, never a veto — veto
    // is not_for/refuses.
    const rawBoost = meta.score_boost != null ? meta.score_boost : 1.0;
    const boost = Math.min(Math.max(rawBoost, 1.0), 1.3);
    score *= boost;

    if (Array.isArray(meta.not_for) && meta.not_for.length > 0) {
      for (const nf of meta.not_for) {
        if (typeof nf === 'string' && notForFires(nf, lc, briefTokenSet)) {
          score *= DEFAULT_THRESHOLDS.not_for_penalty;
          break;
        }
      }
    }

    // A body document needs more evidence to count than a curated one does.
    //
    // Metadata is chosen for retrieval: every token in it was put there by
    // someone deciding this capability should answer that word. A body is prose
    // written for an executing agent, and it contains whatever prose contains —
    // greetings, example dialogue, connective tissue. A brief with one content
    // token ("bom dia, tudo bem com você?") found a course squad's task doc that
    // happened to open with a greeting, and turned an abstention into an
    // ambiguity.
    //
    // So a body document only counts when the brief shares real vocabulary with
    // it. Not a stoplist of the words that failed — that is overfitting, and the
    // routing contract forbids it — but a floor on how much evidence uncurated
    // text must show before it is allowed to compete at all.
    if (meta.via_body) {
      const cov = countMatchedContentTokens(lc, r.doc.text);
      if ((cov && cov.matched != null ? cov.matched : 0) < BODY_DOC_MIN_OVERLAP) continue;
    }

    // A body document may surface a capability, never win over a curated one.
    //
    // The body is prose written for an executing agent: long, unweighted, and
    // full of vocabulary nobody chose for retrieval. Letting it compete on equal
    // terms would hand the ranking to whoever wrote the most words. Capping it
    // keeps the division the whole design rests on — the body widens recall, the
    // curated metadata keeps deciding precision.
    //
    // The cap is a ceiling on the normalized score, not a multiplier: a body
    // match lands just below a perfect metadata match and above a weak one,
    // which is exactly where a recall arm belongs.
    if (meta.via_body) score = Math.min(score, BODY_DOC_MAX_NORMALIZED);

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
    coverage: countMatchedContentTokens(brief, r.doc.text),
    score_adjusted: r.score_adjusted,
    meta: r.doc.meta,
  }));
}

/**
 * Hybrid Stage 2 — BM25 (sparse) + optional DENSE arm (neural), fused via
 * Reciprocal Rank Fusion. When the neural backend is not active, degrades to
 * pure BM25 (identical to stage2Match) — the base product never depends on the dense arm.
 * The dense path recovers specialists that BM25 misses on vocabulary (synonym/
 * paraphrase with no token overlap), while BM25 keeps the exact matching.
 *
 * @returns {Promise<Array<{id, score, normalized, score_adjusted, meta}>>}
 */
async function stage2MatchHybrid(intent, registries, opts) {
  const brief = (opts && opts.brief) || '';
  // Coverage always against the user's ORIGINAL brief: the Stage -2
  // amplification turns 4 tokens into ~180, and any winner matches ≥3 of the
  // amplified tokens — the Stage 3 coverage gate would go blind. The census
  // measurement base (real ≥3 matched, out-of-domain ≤2) is the raw brief.
  const coverageBrief = (opts && opts.coverageBrief) || brief;
  const topK = (opts && opts.topK) || 10;
  const prepared = opts && opts.preparedMatchIndex;
  const docs = prepared ? prepared.docs : buildMatchDocs(registries.squads, registries.businesses);
  if (docs.length === 0) return [];

  const idx = prepared ? prepared.index : bm25.buildIndex(docs);
  const queryStr = brief + ' ' + ((intent && intent.domains) || []).join(' ') + ' ' + ((intent && intent.verbs) || []).join(' ');
  const bm25Full = bm25.query(idx, queryStr, { topK: docs.length });

  // NO dense arm here — the dense/BM25 RRF fusion is retired (routing-360
  // Phase 3.4). Two independent measurements condemned it:
  //
  //   2026-07 (n=41 example_briefs, top-1): BM25 alone 100%, fusion WITH the
  //   dense arm 29%, fusion without it 63%. Structural, not calibration: RRF
  //   is rank-only with k=60 over a ~1,500-doc corpus, so 1/60 vs 1/61 differ
  //   by 1.7% and a mediocre candidate present in two lists outranks the
  //   champion of one. Weight sweeps (bm25 up to 10x) never passed 40%.
  //
  //   2026-08-05 (Phase 3.4 re-evaluation on the fixed corpus): the paraphrase
  //   embedder measures SUBJECT proximity, not declared competence — the same
  //   conclusion as clone-search, re-confirmed with the neural backend active.
  //
  // The dense arm now lives ONLY in the Stage 3.5 NO_MATCH fallback slot
  // (denseNoMatchFallback below): consulted when BM25 abstains, suggestion-only.
  // NIRVANA_ROUTER_DENSE governs that slot, not any fusion.

  // business_route ranked by keyword coverage — the THIRD RRF list
  // (finding #4d): gives business_route a RANK-based boost without the normalized=1.0.
  const coverageRanked = Array.isArray(opts && opts.businessRouteRanked) ? opts.businessRouteRanked : [];

  // RRF FUSION IS OFF BY DEFAULT. `fast` mode is pure BM25.
  //
  // This path is the deterministic one; the system's default mode is agentic,
  // with an agent reading businesses, squads and clones to choose. `fast` is
  // meant to be simple and predictable — and the measurement says BM25 alone is
  // already the best we have here.
  //
  // Ground truth for free: every capability declares `example_briefs`, and the
  // brief it declared must route to it. Over n=41 of those, pipeline top-1:
  //
  //     pure BM25 ................ 100%   (41/41, right target in 1st ALWAYS)
  //     RRF with dense + coverage .  29%
  //     RRF with coverage only ....  63%
  //
  // The failure is structural, not calibration. RRF is rank-only with k=60 and
  // this corpus has ~1,100 documents: between `1/60` and `1/61` there is 1.7%, so
  // being present in a side list yields almost as much as leading the main one,
  // and a mediocre candidate in two lists beats the champion of one. Two fix
  // hypotheses were tested and discarded by measurement — weights (bm25 up to 10×
  // against dense 1×: nothing passed 40%) and moving curation to before the
  // fusion (got worse, 22%). With k=60 the constant dominates the rank
  // difference; no weight can recover it.
  //
  // The `business_route` docs lose nothing: they are in the BM25 corpus and
  // compete on their own text. What goes away is only the rank boost from finding
  // #4d — and the hijack that finding described is already prevented in Stage 3,
  // which drops a route whose declared regex does not fire.
  //
  // Enable with NIRVANA_ROUTER_FUSION=1 to re-measure the coverage list; the
  // dense arm does NOT come back via any env (Phase 3.4 — see the block above).
  const lists = [{ id: 'bm25', items: bm25Full.map((r) => ({ id: r.doc.id })) }];
  if (process.env.NIRVANA_ROUTER_FUSION === '1') {
    if (coverageRanked.length) lists.push({ id: 'coverage', items: coverageRanked.map((c) => ({ id: c.id })) });
  }

  if (lists.length === 1) {
    const adjusted = applyAdjustments(bm25Full.slice(0, Math.max(topK, 10)), intent && intent.intent, brief);
    return adjusted.slice(0, topK).map((r) => ({ id: r.doc.id, score: r.score, normalized: r.normalized, coverage: countMatchedContentTokens(coverageBrief, r.doc.text), score_adjusted: r.score_adjusted, meta: r.doc.meta }));
  }

  // RRF fusion (rank-based, scale-agnostic: BM25 0–15 × cosine 0–1 × coverage 0–1).
  const { fuse } = require('./rrf');
  const fused = fuse(lists);
  const byId = new Map(docs.map((d) => [d.id, d]));
  const bm25ById = new Map(bm25Full.map((r) => [r.doc.id, r]));
  const topRrf = fused.length ? fused[0].rrf : 0;
  // normalized = rrf/maxRrf → HIGH when one doc dominates BOTH rankings;
  // AMBIGUOUS when there is competition (correct semantics for fusion).
  const merged = fused.map((f) => {
    const doc = byId.get(f.id);
    const r = bm25ById.get(f.id);
    return { doc, score: r ? r.score : 0, normalized: topRrf > 0 ? f.rrf / topRrf : 0 };
  }).filter((x) => x.doc);

  const adjusted = applyAdjustments(merged, intent && intent.intent, brief);
  return adjusted.slice(0, topK).map((r) => ({ id: r.doc.id, score: r.score, normalized: r.normalized, coverage: countMatchedContentTokens(coverageBrief, r.doc.text), score_adjusted: r.score_adjusted, meta: r.doc.meta }));
}

/**
 * Destination a match resolves to — the SQUAD (or business) that would end up
 * doing the work. Shared by the same-destination cluster collapse in
 * stage3Decide and the Stage 3.5 dense-fallback dedupe: two candidates with
 * one destination are one suggestion, not an ambiguity.
 */
function resolveDestination(m) {
  const meta = (m && (m.meta || (m.doc && m.doc.meta))) || {};
  if (meta.type === 'business_route') return String(meta.route_to || '').split('::')[0] || null;
  if (meta.type === 'squad_capability') return meta.squad || null;
  // Per-squad doc resolves to the same destination as its capabilities, so a
  // capability + squad-doc near-tie collapses to HIGH instead of AMBIGUOUS.
  if (meta.type === 'squad') return meta.squad || null;
  if (meta.type === 'business') return meta.slug || null;
  return null;
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

  // Abstention is a decision, and decisions belong to curated metadata.
  //
  // A body document carries prose written for an executing agent, and prose
  // contains prose: "bom dia, tudo bem com você?" shares four of its five tokens
  // with an online-course task doc that opens with a greeting. No overlap floor
  // separates that from a real match — the overlap is high, the tokens are
  // empty — and a stoplist of the words that failed would be overfitting, which
  // the routing contract forbids by name.
  //
  // So the body arm may add candidates, never remove an abstention. If every
  // candidate reached the list through a body document, nothing curated
  // recognised this brief, and the honest answer is still "I don't know". The
  // body widens what can be found; it does not get to decide that something was.
  if (matches.every((m) => m && m.meta && m.meta.via_body)) {
    return { signal: 'NO_MATCH', reason: 'body_only_candidates', thresholds: thr };
  }

  // A `business_route` declares an activation regex. When that regex does NOT
  // match the brief, the route is not a candidate — it is BM25 noise: patterns of
  // the same business share almost all tokens (`ebook|livro|manual`), so
  // `format-only` and `audit-and-revise` scored 0.94 against the 1.00 of
  // `write-bestseller` on a brief only the latter accepts. Three fabricated
  // near-ties filled the ambiguity window and demoted HIGH to AMBIGUOUS,
  // with the router abstaining among alternatives it had itself already discarded.
  //
  // Filter only when someone remains: if no route matches, the list stays intact
  // and the decision keeps being made by score, as before.
  // The rule is deliberately narrow: it only filters when the LEADER ITSELF is a
  // route whose contract fires. Then, and only then, routes that demonstrably do
  // not fire are not competitors.
  //
  // The broad version (filter whenever the route did not match) was measured and
  // REJECTED: on a domain-less brief ("quanto é dois mais dois") it removed the
  // false competitor, the leader got slack and the signal turned HIGH pointing at
  // a video squad — trading safe abstention for confident error. An absolute
  // score floor would compensate, but none exists: measured on real
  // example_briefs against out-of-domain briefs, the distributions overlap (real
  // reaches 5.5, out-of-domain reaches 12.2). Without separation, any floor errs
  // on one of the two sides.
  const brief = opts && typeof opts.brief === 'string' ? opts.brief : null;
  // `(?i)` is a Python/Go inline flag; JS throws on it. Since we compile with 'i',
  // stripping the prefix preserves the semantics — 9 of the 498 routes use it.
  const routeFires = (m) => {
    const meta = (m && (m.meta || (m.doc && m.doc.meta))) || {};
    if (meta.type !== 'business_route' || !meta.pattern) return null;
    try { return new RegExp(String(meta.pattern).replace(/^\(\?i\)/, ''), 'i').test(brief); }
    catch { return null; }
  };
  if (brief && routeFires(matches[0]) === true) {
    const compatible = matches.filter((m) => routeFires(m) !== false);
    if (compatible.length > 0 && compatible.length < matches.length) matches = compatible;
  }

  const top = matches[0];
  const second = matches[1] || { normalized: 0 };

  // Coverage-based NO_MATCH (census 2026-07-27, ROUTER-INVESTIGACAO.md Part 2).
  // The normalized score does not separate a real brief from an out-of-domain
  // one — the top is always 1.0 by construction. The COUNT of matched content
  // tokens separates them with an empty band: a real brief matches ≥3 of the
  // winner's tokens (fraction ≥0.80), out-of-domain matches ≤2 (fraction ≤0.50).
  // The cut is by count AND fraction combined, never fraction alone (it would
  // kill 63% of real briefs in the honest worst case) and never count alone (a
  // legitimate short 2-token brief — "escreva o ebook" — matches 2/2 = fraction
  // 1.0 and must not be punished).
  const cov = top && top.coverage;
  if (cov && typeof cov.matched === 'number' && typeof cov.total === 'number' && cov.total > 0) {
    const frac = cov.matched / cov.total;
    if (cov.matched <= 1 && cov.total >= 3) {
      return {
        signal: 'NO_MATCH',
        reason: `coverage: vencedor casa ${cov.matched} de ${cov.total} tokens de conteúdo do brief`,
        alternatives: matches.slice(0, 3),
        thresholds: thr,
      };
    }
    if (cov.matched === 2 && cov.total >= 4 && frac <= 0.5) {
      return {
        signal: 'AMBIGUOUS',
        alternatives: matches.slice(0, 3),
        reason: `coverage: vencedor casa só 2 de ${cov.total} tokens de conteúdo — confirmação necessária`,
        thresholds: thr,
      };
    }
    // total=2 was unguarded (routing-360 Phase 2): a winner matching 1 of 2
    // content tokens ("what is two plus two" -> {two, plus}, winner matches
    // "plus" only) could still dispatch HIGH when a same-destination shadow doc
    // collapsed the cluster. By the census bands, matched<=1 is the
    // out-of-domain COUNT band while frac 0.5 is the confirm FRACTION band —
    // mixed signals resolve to AMBIGUOUS (confirm), never HIGH. A legit
    // 2-token brief whose winner matches both ("escreva o ebook", 2/2) is
    // untouched. Measured: zero golden briefs have <3 content tokens.
    if (cov.matched <= 1 && cov.total === 2) {
      return {
        signal: 'AMBIGUOUS',
        alternatives: matches.slice(0, 3),
        reason: `coverage: vencedor casa ${cov.matched} de 2 tokens de conteúdo — confirmação necessária`,
        thresholds: thr,
      };
    }
  }

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

  // A cluster that resolves to the SAME destination is not ambiguity. `escreva o
  // ebook` brings `squad_capability:ebook-maestro-nirvana` in 1st and
  // `business_route:ars-libri:ebook-maestro-nirvana::write-bestseller` in 2nd —
  // the same squad, one direct and the other through the business. The work lands
  // in the same place, and asking "qual dos dois?" is not a choice the owner can
  // make better than the router. Before this the query abstained, and it was case
  // H4a/H4b of the external validation report.
  //
  // Grouping is by destination SQUAD, not by capability: when the work reaches
  // the same squad, its dispatcher picks the capability — that decision does
  // not belong to this stage.
  if (cluster.length >= 2) {
    const destinos = new Set(cluster.map(resolveDestination));
    if (destinos.size === 1 && !destinos.has(null)) {
      return {
        signal: 'HIGH',
        target: top,
        alternatives: cluster.slice(1, 3),
        reason: `${cluster.length} candidatos, destino único ${[...destinos][0]}`,
        thresholds: thr,
      };
    }
  }

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

// ─────────────────────────────────────────────────────────────────────
// Stage 3.5 — Dense NO_MATCH fallback (routing-360 Phase 3.4)
// ─────────────────────────────────────────────────────────────────────
//
// The ONLY slot where the neural (multilingual MiniLM) arm may speak: when the
// final Stage 3 signal — after the Stage 2.7 amplification bridge — is
// NO_MATCH, the dense index is consulted and a candidate clearing a
// conservative cosine threshold is returned as an AMBIGUOUS suggestion. Never
// HIGH: a dense-only match is a suggestion for the user to confirm, not a
// dispatch. Golden briefs cannot be touched by construction (measured
// 2026-08-05: 0 of 2,963 golden cases reach NO_MATCH).
//
// DEFAULT OFF, and the threshold is where the measurement put it:
//
//   - The 22 negatives the router correctly abstains on have dense top-1
//     cosines 0.161–0.471 (max: "my dishwasher is leaking…" → a kitchen-ops
//     employee at 0.471 — subject proximity, not competence). Any threshold
//     ≤ 0.471 flips a negative to AMBIGUOUS and breaks the 73% NO_MATCH floor
//     (22/30 has zero slack).
//   - The 12 multilingual probes (es/fr/it/de/zh/ja/ko, zero corpus presence)
//     that BM25 leaves at NO_MATCH have dense top-1 cosines 0.335–0.655, and
//     the CORRECT-target ones sit at 0.371–0.655 — the bands OVERLAP the
//     negatives. There is no threshold that both recovers the majority of the
//     multilingual regime and holds the safety floor. At 0.55 (0.079 above the
//     negatives max) the fallback recovers 3/12 probes (2 with the right
//     suggestion) — real but marginal, hence opt-in rather than default.
//
// Enablement: config.yaml `routing.dense: "fallback"` (set by `nrv embeddings
// enable` after verifying the neural backend loads) or env override
// NIRVANA_ROUTER_DENSE=1; NIRVANA_ROUTER_DENSE=0 forces off. With the neural
// backend absent, denseRank returns null and the slot is a clean no-op.

/** Ceiling on a body document's normalized score. Below a strong metadata match
 *  (1.0) and above a weak one, so the body arm surfaces candidates without
 *  taking the decision away from curated metadata. Tunable via
 *  NIRVANA_BODY_DOC_MAX for the eval sweep. */
/** Minimum content-token overlap before an uncurated body document competes.
 *  Two, because one is the regime where a greeting matches example dialogue.
 *  Tunable via NIRVANA_BODY_DOC_MIN_OVERLAP for the sweep. */
const BODY_DOC_MIN_OVERLAP = Number(process.env.NIRVANA_BODY_DOC_MIN_OVERLAP) || 2;

const BODY_DOC_MAX_NORMALIZED = Number(process.env.NIRVANA_BODY_DOC_MAX) || 0.85;

const DENSE_FALLBACK_MIN_COSINE = 0.55;

/** Effective mode of the fallback slot: 'off' | 'fallback'.
 *  context.denseMode is the test hook; the routing.dense setting otherwise. */
function denseFallbackMode(context) {
  if (context && (context.denseMode === 'off' || context.denseMode === 'fallback')) {
    return context.denseMode;
  }
  try {
    // harness-config.ts resolves the setting (env > project > global > engine
    // default); requiring .ts works under Bun (same pattern as
    // host-agent-driver.ts). Failure → off, never a crash.
    const cfg = require(path.join(__dirname, 'harness-config.ts'));
    return cfg.denseRoutingMode();
  } catch {
    return 'off';
  }
}

/**
 * Consult the dense arm for a NO_MATCH brief. Returns a Stage-3-shaped
 * AMBIGUOUS decision (suggestion) when the top dense candidate clears
 * DENSE_FALLBACK_MIN_COSINE, else null (the NO_MATCH stands). Alternatives are
 * deduped by destination (resolveDestination) and capped at 3.
 *
 * context.denseRank is the test hook (same contract as dense-index.denseRank:
 * async (brief, [{id, text}]) → [{id, score}] | null).
 */
async function denseNoMatchFallback(brief, registries, context) {
  if (denseFallbackMode(context) !== 'fallback') return null;
  let rank = context && typeof context.denseRank === 'function' ? context.denseRank : null;
  if (!rank) {
    try {
      const denseIndex = require(path.join(__dirname, '..', '..', '_shared', 'lib', 'dense-index.ts'));
      rank = denseIndex.denseRank;
    } catch { return null; } // dense machinery absent → clean no-op
  }
  const docs = buildMatchDocs(registries.squads, registries.businesses);
  if (docs.length === 0) return null;
  let ranked = null;
  try {
    ranked = await rank(brief, docs.map((d) => ({ id: d.id, text: d.text })));
  } catch { ranked = null; }
  if (!Array.isArray(ranked) || ranked.length === 0) return null; // neural backend inactive
  const top = ranked[0];
  if (!top || typeof top.score !== 'number' || top.score < DENSE_FALLBACK_MIN_COSINE) return null;

  const byId = new Map(docs.map((d) => [d.id, d]));
  const alternatives = [];
  const seenDestinations = new Set();
  for (const r of ranked) {
    if (typeof r.score !== 'number' || r.score < DENSE_FALLBACK_MIN_COSINE) break;
    const doc = byId.get(r.id);
    if (!doc) continue;
    const destination = resolveDestination({ meta: doc.meta });
    if (destination && seenDestinations.has(destination)) continue;
    if (destination) seenDestinations.add(destination);
    alternatives.push({
      id: doc.id,
      score: r.score,
      normalized: top.score > 0 ? r.score / top.score : 0,
      dense_cosine: r.score,
      via_dense_fallback: true,
      meta: doc.meta,
    });
    if (alternatives.length >= 3) break;
  }
  if (alternatives.length === 0) return null;

  return {
    // Suggestion, never a dispatch: AMBIGUOUS is the ceiling of this slot.
    signal: 'AMBIGUOUS',
    alternatives,
    reason: `dense-fallback: BM25 abstained (NO_MATCH); dense top cosine ${top.score.toFixed(3)} >= ${DENSE_FALLBACK_MIN_COSINE} — confirmation required`,
    thresholds: Object.assign(
      {},
      DEFAULT_THRESHOLDS,
      (context && context.thresholds) || {},
      { dense_fallback_min_cosine: DENSE_FALLBACK_MIN_COSINE },
    ),
    via_dense_fallback: true,
    route_tier: 'dense_fallback',
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
  } else if (type === 'squad') {
    // Squad-level match (per-squad doc): no capability_id/invoke — the harness
    // loads the squad manifest and dispatches its best capability agentically.
    loader = `squads skill (load squad ${meta.squad}, dispatch its best capability for the brief agentically)`;
  } else {
    loader = 'squads skill (load capability provider squad, route to capability_id)';
  }

  const plan = {
    target_type: type,
    // For a squad-level match (type 'squad') the id is the squad slug itself.
    target_id: meta.slug || meta.capability_id || (type === 'squad' ? meta.squad : null) || target.id,
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
    // Declared execution facts, carried so the adapter that dispatches this
    // plan can act on them: cost for the budget pre-flight, parallel_safe and
    // writes_paths for scheduling, model_hint for the runtime. `null` when the
    // capability declared nothing — the same convention as the fields above.
    estimated_cost_usd: typeof meta.estimated_cost_usd === 'number' ? meta.estimated_cost_usd : null,
    parallel_safe: typeof meta.parallel_safe === 'boolean' ? meta.parallel_safe : null,
    writes_paths: Array.isArray(meta.writes_paths) ? meta.writes_paths : null,
    model_hint: meta.model_hint || null,
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

// Generic objects that ANY business delivers. A business_route whose pattern
// only contains these terms carries no TOPIC/domain signal — letting it
// short-circuit before BM25 makes "landing page para X" always land on the same
// business, whether X is cafeteria, tourism or bitcoin (Stage-0 is domain-blind).
// In that case Stage-0 abstains and lets BM25/dense decide by domain.
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
      // Abstains on generic-object-only patterns — with no domain signal,
      // BM25/dense decides (Stage-0 is domain-blind).
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
 * Like stage0BusinessRouteMatch, but returns the LIST of all business_route
 * whose keyword coverage >= threshold, sorted desc by coverage. Used as a
 * THIRD ranked list in the Stage 2 RRF — gives business_route a RANK-based
 * boost (moderate, scale-agnostic) instead of the normalized=1.0 that hijacked
 * squad briefs (finding #4d).
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
  // EN — "portfolio", "end to end" and "end-to-end" left (census 2026-07-27):
  // they were banal triggers ("portfolio" 10× was a financial portfolio;
  // "end-to-end" 23× described a common pipeline) and hijacked 56 briefs with 0 hits.
  'orchestrate', 'orchestration', 'multi-business', 'across businesses',
  'full project', 'entire project', 'all businesses', 'audit portfolio', 'create business',
  'create squad', 'consolidate outputs', 'across teams', 'launch product with', 'full operation',
  'whole project',
  // PT-BR
  'multi empresa', 'multi-empresa', 'orquestrar', 'orquestracao',
  'todo o projeto', 'projeto inteiro', 'projeto completo',
  'audita portfolio', 'audita o portfolio', 'auditar portfolio',
  'cria empresa', 'criar business', 'cria business', 'criar squad', 'criar uma business',
  'preciso de uma business', 'preciso de uma squad', 'preciso de business',
  'tudo o que', 'completo com', 'consolidar outputs',
  'lance um produto', 'lance produto', 'lance o produto', 'lança produto',
  'operacao completa', 'operação completa', 'projeto multi',
  // user saying "use suas melhores empresas" → the Maestro must intercept
  'use suas melhores', 'use as melhores', 'use o melhor',
  'use sua melhor', 'use seu melhor',
  'best businesses', 'best squads', 'use the best',
  'faça o melhor', 'faca o melhor', 'do your best',
  // NOTE (E1): removed the SINGLE-ARTIFACT entries ("crie uma landing",
  // "preciso de copy", "quero ads"…) and the 3 dead regexes ('landing.*copy' etc.,
  // treated as literal substrings — they never matched). Meta-intent is
  // multi-project/orchestration; a single-artifact request is what BM25/dense
  // routes well — intercepting it here sent everything to the squad-forge unduly.
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
  const providers = squadsRegistry.capabilities[capId];
  if (!providers || providers.length === 0) {
    // NO substring fallback: the canonical capability does not exist in the
    // current registry, and the old fallback ("first capability containing
    // 'orchestrate'") picked squad-forge's ai.squad.orchestrate — 56 briefs
    // hijacked with 0 hits in the 2026-07-27 census. Without the canonical one,
    // Stage -1 abstains and the normal pipeline routes; strictly better than a
    // 0%-correct target.
    return null;
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

// Normalizes for matching: lowercase + strip accents (NFD), keeping hyphens as
// part of the token. That way "revisão-cruzada" and "revisao cruzada" converge.
function _normForMatch(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const _TARGET_CUE = /\b(?:use|usa|usando|utilize|utilizando|rode|rodando|execute|executando|despache|despacha|chame|chama|acione|aciona|via|pelo|pela|com\s+o|com\s+a|no|na|use\s+the|via\s+the|through|run\s+(?:it\s+)?on|dispatch)\b/;
const _TARGET_KIND = /\b(?:squad|empresa|business|company)\b/;

/**
 * Stage 0.5 — Explicit mention of a target (squad OR business) by slug.
 *
 * Mirror of detectRuntimeMention (runtime-rules.ts): when the user NAMES a
 * squad/business from the registry, that is a COMMAND, not a retrieval hint — it
 * must short-circuit before any scoring/business-first. Anti-false-positive
 * guards: the slug must appear as a whole token (hyphen/accent normalized)
 * AND be distinctive (multi-token, e.g. "code-review") OR have an instrumental
 * cue adjacent ("use o squad X"). A common-word slug ("research") requires the cue.
 * Fires ONLY with exactly 1 distinct target; 0 or ≥2 → null (leave it to BM25/agentic).
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
  } catch { /* malformed registries — no mention */ }
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
    const distinctive = slugN.includes('-'); // a multi-token slug is distinctive on its own
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
 * Builds a synthetic match (stage2Match shape) for a NAMED target.
 * Squad → the squad's best capability (highest score_boost). Business → business doc.
 * Marks explicit_mention and forces max score (it is a command, not a score).
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
 * @param {{registries?: object, thresholds?: object, budget?: object, runtime?: string, classifier?: function, amplifier?: function, knownDomains?: string[], stage0Threshold?: number, disableStageMinus1?: boolean}} ctx
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
        const body = raw.replace(/^---\r?\n[\s\S]+?\r?\n---\n?/, '').trim();
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

/**
 * Stage 2.5 + Stage 3 — business-first ordering followed by the routing
 * decision. Extracted from route() (routing-360 Phase 4) so the post-amplify
 * guard can score the PRE-amplify pass through the exact same path when the
 * amplified pass has to be discarded.
 *
 * Stage 2.5 — Business-first preference.
 * Rationale: a business is a compositional unit (CEO + employees + org-chart
 * + audit trail) that can dispatch to internal squads. A bare squad is an
 * atomic capability. For most user briefs, going through the business gives
 * richer orchestration, observability, and humanization. We prefer business
 * when one is viable; we fall back to squads when no business clears the bar
 * (e.g. system-only capabilities like squad audits or registry tooling).
 *
 * Override per-call with `context.prefer = 'squad' | 'business' | 'auto'`.
 * Default 'business'. 'auto' = legacy behavior (no preference).
 */
function orderAndDecide(matches, brief, context) {
  const prefer = context.prefer || 'business';
  const businessFirstThreshold = typeof context.businessFirstThreshold === 'number'
    ? context.businessFirstThreshold
    : 0.45;
  let routeTier = 'stage2_combined';
  let orderedMatches = matches;
  if (prefer === 'business' && matches.length > 0) {
    // The business-first PROMOTION only applies to a GENUINE business (type
    // 'business', matched by content). A 'business_route' (ARTIFACT-PATTERN match)
    // has a score on a different scale (keyword coverage, almost always ~1.0) and
    // must NOT be promoted above a squad that matches by content — it competes
    // only on its own score in the pool. This kills the finding #4d hijack.
    const businesses = matches.filter((m) => m && m.meta && m.meta.type === 'business');
    // The business's rival in the tiebreak is ANY non-business — including a
    // business_route. The tiebreak used to be route-blind: with a route in 1st
    // (1.000) and a weak squad below (0.599), the business (0.65) was compared
    // only against the squad, won, and went to the top with normalized < 1.0 —
    // breaking Stage 3's top=1.0 invariant (real case "Run a Monte
    // Carlo…": came out NO_MATCH top 0.599 with a 1.000 candidate in the list).
    const rivals = matches.filter((m) => !(m && m.meta && m.meta.type === 'business'));
    const bestBusiness = businesses[0];
    const bestSquad = rivals[0];
    // Business-first is a TIEBREAK, not an override. It only promotes the best
    // business to the top if it is competitive with the best squad (within a delta).
    // Before: the ABSOLUTE floor 0.45 promoted the business even when a squad
    // scored MUCH higher — the reported "business-first hijack" (finding #4d).
    // Now a materially better squad (> delta above) wins; tie → the business gets the nod.
    const businessTiebreakDelta = typeof context.businessTiebreakDelta === 'number'
      ? context.businessTiebreakDelta
      : 0.08;
    const businessCompetitive = bestBusiness &&
      (!bestSquad || bestBusiness.normalized >= bestSquad.normalized - businessTiebreakDelta);
    if (bestBusiness && bestBusiness.normalized >= businessFirstThreshold && businessCompetitive) {
      // Promotes ONLY the best business to the top, keeping the rest ordered
      // by score (E7). `matches` already comes sorted by score_adjusted.
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
  const decision = stage3Decide(orderedMatches, { thresholds: context.thresholds, brief });
  decision.route_tier = routeTier;
  decision.prefer = prefer;
  return decision;
}

async function route(brief, ctx) {
  const context = ctx || {};
  const registries = context.registries || registryLoader.loadAll();
  // Amplifier seam: context.amplifier (same contract as amplifyBrief —
  // async (brief, opts) => {ok, amplified, via} | {ok: false, reason}) lets
  // tests and adapters stub the LLM arm; default is the host-agent amplifier.
  const amplifierFn = typeof context.amplifier === 'function' ? context.amplifier : amplifyBrief;
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
    const amp = await amplifierFn(brief, {
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
  // Naming a squad/business is a user COMMAND — it beats meta-intent, Stage 0
  // and business-first. Runs on the ORIGINAL brief (amplification can dilute the mention).
  // Can be disabled via context.disableExplicitMention (parity with --no-* flags).
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

  // Stage 0 — Business auto_route. It used to SHORT-CIRCUIT before BM25: an
  // ARTIFACT-PATTERN match ("modelos"→ml-model) hijacked briefs that matched a
  // squad by CONTENT (finding #4d). Now the business_route entries join as a
  // THIRD list ranked by coverage, FUSED into the Stage 2 RRF (rank-based,
  // scale-agnostic) — they gain a rank boost, but a squad matching by content still wins.
  const businessRouteRanked = isPremiumBrief
    ? []
    : businessRouteCoverageRanked(brief, registries.businesses, {
        threshold: context.stage0Threshold,
      });

  // Stage 2 — Capability matching (BM25 + denso opcional + business_route, RRF)
  let matches = await stage2MatchHybrid(intent, registries, {
    brief, topK: 10, businessRouteRanked, coverageBrief: originalBrief,
    preparedMatchIndex: context.preparedMatchIndex,
  });

  // Stage 2.7 — Amplification bridge (routing-360 Phase 3.3, the inversion fix).
  //
  // The OLD amplify trigger was brief STRENGTH (Stage -1.5 fires on WEAK only).
  // That measures the wrong thing: "criar um ebook sobre emagrecimento com copy
  // persuasiva" is a NORMAL-strength brief that the corpus simply cannot cover
  // (live-verified miss — the winner matched 2/5 content tokens and the router
  // abstained). What predicts "this brief needs help" is the COVERAGE PROBE:
  // the same census bands Stage 3 abstains on. So:
  //   (a) run BM25 once; top candidate's coverage clears the gate → done;
  //   (b) low coverage → zero-LLM-token alias expansion: re-score the retrieved
  //       candidates' coverage through the cross-language alias groups
  //       (`.keyword-aliases.json`, emitted next to the squads registry;
  //       absence tolerated). Adopt ONLY when the top candidate then clears the
  //       gate — an out-of-domain brief gains nothing because its tokens have
  //       no groups pointing at any winner's vocabulary (measured: all 30
  //       golden negatives keep their signal);
  //   (c) still low AND the amplifier is available under the current mode
  //       rules (amplify not disabled, no LLM run yet) → run the Stage -1.5
  //       amplifier REGARDLESS of strength class and re-run the match on the
  //       amplified brief. WEAK-brief behavior is unchanged — WEAK still
  //       amplifies upfront exactly as before.
  const bridge = { engaged: false, alias_adopted: false, amplifier_ran: false };
  // Snapshot of the pre-amplify pass — set only when the bridge's LLM arm (c)
  // actually re-runs the match, consumed by the post-amplify guards below.
  let preAmplify = null;
  if (matches.length > 0 && bm25.coverageBelowGate(matches[0].coverage)) {
    bridge.engaged = true;
    // (b) alias re-coverage (zero LLM tokens, deterministic)
    const aliasMap = Object.prototype.hasOwnProperty.call(context, 'keywordAliases')
      ? buildAliasMap(context.keywordAliases) // test/override hook
      : loadKeywordAliases(registries);
    if (aliasMap) {
      const docsById = new Map(
        (context.preparedMatchIndex?.docs || buildMatchDocs(registries.squads, registries.businesses)).map((d) => [d.id, d]),
      );
      const briefToks = bm25.tokenize(originalBrief);
      const aliasCov = matches.map((m) => {
        const d = docsById.get(m.id);
        return d ? bm25.coverage(briefToks, new Set(bm25.tokenize(d.text)), aliasMap) : m.coverage;
      });
      if (!bm25.coverageBelowGate(aliasCov[0])) {
        matches = matches.map((m, i) => ({ ...m, coverage: aliasCov[i], coverage_direct: m.coverage }));
        bridge.alias_adopted = true;
      }
    }
    // (c) amplifier — only when no LLM amplification ran yet this route() call
    // ('skipped' = strength gate did not fire; 'failed' means a run was already
    // attempted and re-trying would double the failure, so it is excluded).
    if (!bridge.alias_adopted &&
        context.amplify !== false &&
        amplification && amplification.amplifier_used === 'skipped') {
      const amp = await amplifierFn(originalBrief, {
        preferAmplifier: context.preferAmplifier,
        timeoutMs: context.amplifyTimeoutMs,
      });
      if (amp.ok) {
        bridge.amplifier_ran = true;
        preAmplify = { matches, intent };
        brief = amp.amplified;
        amplification = {
          amplifier_used: amp.via,
          amplified_brief: amp.amplified,
          original_brief: originalBrief,
          strength: strengthReport,
          via_coverage_bridge: true,
        };
        // Full re-run on the amplified brief (intent + route list + match);
        // coverage still measured against the ORIGINAL brief (census base).
        intent = typeof context.classifier === 'function'
          ? await context.classifier(brief, context)
          : stage1IntentClassify(brief, {
              knownDomains: context.knownDomains || Object.keys(registries.squads.domains || {}),
            });
        const rerankedRoutes = isPremiumBrief
          ? []
          : businessRouteCoverageRanked(brief, registries.businesses, { threshold: context.stage0Threshold });
        matches = await stage2MatchHybrid(intent, registries, {
          brief, topK: 10, businessRouteRanked: rerankedRoutes, coverageBrief: originalBrief,
          preparedMatchIndex: context.preparedMatchIndex,
        });
        // Post-amplify guard (a) — drift-to-zero (routing-360 Phase 4).
        // "Amplification is a lens, not a replacement": each candidate's
        // `coverage` above is bm25.coverage() of the ORIGINAL brief's tokens
        // vs the candidate's doc (coverageBrief = originalBrief). A winner
        // sharing ZERO tokens with the user's own words means the rewrite
        // fully displaced the brief — discard the amplified result and revert
        // to the pre-amplify pass. Guard design chosen over re-scoring the
        // re-run against original∪amplified tokens: the re-run already
        // measures coverage against the original brief, so union-scoring
        // would only reshuffle BM25 rank without bounding the damage, while
        // the two outcome guards (here and guard (b) after Stage 3) are
        // zero-cost and can never end worse than the pre-amplify pass.
        const ampTop = matches[0];
        if (!ampTop || (ampTop.coverage && ampTop.coverage.matched === 0)) {
          matches = preAmplify.matches;
          intent = preAmplify.intent;
          brief = originalBrief;
          bridge.amplified_discarded = 'winner_zero_original_coverage';
          amplification.discarded = true;
        }
      } else {
        bridge.amplifier_error = amp.reason || 'amplify_failed';
      }
    }
  }

  // Stage 2.5 + Stage 3 — business-first ordering followed by the routing
  // decision (extracted into orderAndDecide so the post-amplify guard can
  // score the pre-amplify pass through the exact same path).
  let decision = orderAndDecide(matches, brief, context);

  // Post-amplify guard (b) — routing-360 Phase 4, see the note above
  // orderAndDecide. An amplified pass that ends NO_MATCH bought nothing: the
  // rewrite displaced the user's own words without producing a dispatchable
  // outcome. Return the PRE-amplify result instead — at worst the same signal,
  // and always grounded in the original brief's tokens. (Guard (a) — winner
  // with zero original coverage — already reverted inside the bridge block.)
  if (preAmplify && !bridge.amplified_discarded && decision.signal === 'NO_MATCH') {
    matches = preAmplify.matches;
    intent = preAmplify.intent;
    brief = originalBrief;
    bridge.amplified_discarded = 'no_match_after_amplify';
    amplification.discarded = true;
    decision = orderAndDecide(matches, brief, context);
  }

  // Stage 3.5 — dense NO_MATCH fallback (Phase 3.4). Consulted ONLY when the
  // final signal is NO_MATCH; the ceiling is an AMBIGUOUS suggestion. Runs on
  // the working brief (post-bridge, identical to the original when amplify is
  // off). Off by default — see the block above denseNoMatchFallback.
  if (decision.signal === 'NO_MATCH') {
    const suggestion = await denseNoMatchFallback(brief, registries, context);
    if (suggestion) {
      suggestion.prefer = context.prefer || 'business';
      decision = suggestion;
    }
  }

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
    stage_bridge: bridge,
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
  denseNoMatchFallback,
  stage4BudgetCheck,
  stage5Invoke,
  buildMatchDocs,
  extractRoutePatternLiterals,
  routePatternIndexText,
  prepareMatchIndex,
  buildAliasMap,
  loadKeywordAliases,
  resolveDestination,
  DEFAULT_THRESHOLDS,
  DENSE_FALLBACK_MIN_COSINE,
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
    const noStageMinus1 = rest.includes('--no-stage-minus-1'); // E1 — disables the meta short-circuit
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
