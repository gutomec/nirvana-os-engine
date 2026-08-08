#!/usr/bin/env bun
/**
 * build-routing-digest.ts — compact routing digest + cross-language keyword aliases.
 *
 * Routing-360 Phase 3.1. The agentic router used to tell its headless subagent
 * to Read the three raw registries (2MB+ ≈ 600k tokens). This script distills
 * them into ONE pipe-delimited English file (`.routing-digest.md`, written next
 * to the registries, scope-aware via ROUTING_DIGEST_PATH) that a router LLM can
 * read whole: every business, squad, capability collision and mind-clone, one
 * line each, under a hard <50k-token budget (chars/4 heuristic).
 *
 * Budget degradation ladder (entries are NEVER dropped):
 *   L0  full format (2 example briefs, capability one-liners, 160c descriptions)
 *   L1  drop the 2nd example brief (businesses + squads keep 1)
 *   L2  additionally drop capability one-liners in the squads section (ids only)
 *   L3  additionally truncate all descriptions to 100c (incl. clone one-liners,
 *       which are the clone's description field)
 * The applied level is reported in the digest header.
 *
 * Also emits `.keyword-aliases.json` (same directory): cross-language alias
 * groups mined from business + capability `keywords` arrays, following the
 * ROUTING_METADATA_CONTRACT keyword-group convention — each concept ships as a
 * consecutive group (EN form, PT form, accented AND unaccented spellings), so
 * within one entity's list a keyword continues the current group when it is a
 * spelling variant (accent/hyphen-folded equal) or a new-language form; a
 * repeat of a language already in the group starts a new concept. Accent-folded
 * duplicates are ALSO merged across entities (union on the folded form).
 * Format (the contract with the amplification bridge): JSON array of string
 * arrays — each inner array is one alias set, e.g.
 *   [["ebook","e-book","livro digital"],["code review","revisão de código","revisao de codigo"]]
 *
 * Usage:
 *   bun build-routing-digest.ts                 # build + write digest + aliases
 *   bun build-routing-digest.ts --check-budget  # dry-run; exit 1 if over budget
 *   bun build-routing-digest.ts --quiet | --json
 *   # test seams: --businesses/--squads/--clones/--out/--aliases-out <path>
 *
 * Standalone by design: index.ts stays untouched; the agentic router
 * regenerates the digest when it is stale (lib/agentic-router.ts).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { paths as nrvPaths, parseArgs, EXIT } from "../../_shared/lib/bun-helpers.ts";
import { resolveScope } from "../../_shared/lib/scope.ts";

// ─────────────────────────────────────────────────────────────────────
// Paths — where the registries and the digest live (scope-aware)
// ─────────────────────────────────────────────────────────────────────

export interface RoutingArtifactPaths {
  businessesRegistry: string;
  squadsRegistry: string;
  mindClonesRegistry: string;
  digest: string;
  aliases: string;
}

/**
 * Resolve the three registry paths + the digest/aliases paths for the current
 * scope. Falls back to deriving the digest path from the mind-clones registry
 * directory when the loaded paths.js predates ROUTING_DIGEST_PATH (installed
 * copies lag the repo).
 */
export function resolveRoutingArtifactPaths(): RoutingArtifactPaths {
  const scope = resolveScope();
  const cloneDir = scope.projectRoot
    ? path.join(scope.projectRoot, ".nirvana")
    : path.join(os.homedir(), ".nirvana");
  const digest = process.env.ROUTING_DIGEST_PATH
    || nrvPaths.ROUTING_DIGEST_PATH
    || path.join(cloneDir, ".routing-digest.md");
  return {
    businessesRegistry: nrvPaths.BUSINESSES_REGISTRY_PATH,
    squadsRegistry: nrvPaths.SQUADS_REGISTRY_PATH,
    mindClonesRegistry: path.join(cloneDir, ".mind-clones-registry.json"),
    digest,
    aliases: path.join(path.dirname(digest), ".keyword-aliases.json"),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Input shape (subset of the registry schemas the digest consumes)
// ─────────────────────────────────────────────────────────────────────

export interface DigestInput {
  businesses: Record<string, any>;
  squads: Record<string, any>;
  /** capability id → provider entries ({ squad, description?, not_for?, keywords?, ... }) */
  capabilities: Record<string, any[]>;
  mindClones: Record<string, any>;
  registryPaths: { businesses: string; squads: string; mindClones: string };
}

export interface DigestResult {
  text: string;
  tokens: number;
  degradationLevel: 0 | 1 | 2 | 3 | 4;
  overBudget: boolean;
  counts: {
    businesses: number;
    squads: number;
    capabilityIds: number;
    capabilityProviders: number;
    capabilityCollisions: number;
    mindClones: number;
    mindClonesEnriched: number;
  };
}

export const TOKEN_BUDGET = 50_000;

/** chars/4 heuristic — the budget currency of the digest. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

// ─────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────

/** One-line sanitizer: pipes would break the grammar, newlines the line. */
const flat = (s: unknown): string =>
  String(s ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();

/** Truncate to n chars, ellipsis included in the budget. */
export function trunc(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)).trimEnd() + "…";
}

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];

// ─────────────────────────────────────────────────────────────────────
// Digest builder
// ─────────────────────────────────────────────────────────────────────

interface LadderKnobs {
  exampleBriefs: number;   // per entity (2 → 1 at L1)
  capOneLiners: boolean;   // squads section (dropped at L2)
  descMax: number;         // 160 → 100 at L3
  oneLinerMax: number;     // clone one_liner: 120 → 100 at L3 (it IS the clone's description)
  cloneDomains?: boolean;  // clone domain lists (dropped at L4 — the biggest compressible block)
}

const KNOBS: Record<0 | 1 | 2 | 3 | 4, LadderKnobs> = {
  0: { exampleBriefs: 2, capOneLiners: true, descMax: 160, oneLinerMax: 120 },
  1: { exampleBriefs: 1, capOneLiners: true, descMax: 160, oneLinerMax: 120 },
  2: { exampleBriefs: 1, capOneLiners: false, descMax: 160, oneLinerMax: 120 },
  3: { exampleBriefs: 1, capOneLiners: false, descMax: 100, oneLinerMax: 100 },
  // Level 4 exists because the library outgrew level 3 the moment the
  // enrichment waves landed (54.7k tokens at level 3 with 398 enriched
  // clones). Clone domains are the biggest single block in the digest and the
  // most compressible: the one_liner already states what the clone serves, and
  // the agent escalates to the manifest for finalists. Entries are still never
  // dropped — every clone keeps its line.
  4: { exampleBriefs: 1, capOneLiners: false, descMax: 90, oneLinerMax: 90, cloneDomains: false },
};

function briefsSeg(briefs: string[], count: number, maxLen: number): string {
  const picked = briefs.slice(0, count).map((b) => `"${trunc(flat(b), maxLen)}"`);
  return picked.length ? `ex: ${picked.join(" · ")}` : "";
}

function businessLine(slug: string, b: any, k: LadderKnobs): string {
  const segs: string[] = [slug, trunc(flat(b.description) || "—", k.descMax)];
  const domains = strList(b.domains).slice(0, 10);
  if (domains.length) segs.push(`domains: ${domains.join(",")}`);
  const produces = strList(b.produces).slice(0, 6);
  if (produces.length) segs.push(`produces: ${produces.join(",")}`);
  const caps = strList(b.capabilities);
  if (caps.length) {
    const shown = caps.slice(0, 8);
    const more = caps.length - shown.length;
    segs.push(`caps: ${shown.join(",")}${more > 0 ? ` +${more} more` : ""}`);
  }
  const ex = briefsSeg(strList(b.example_briefs), k.exampleBriefs, 90);
  if (ex) segs.push(ex);
  const notFor = strList(b.not_for);
  if (notFor.length) segs.push(`not: ${trunc(flat(notFor.join("; ")), 80)}`);
  return segs.join(" | ");
}

function squadLine(slug: string, s: any, capsById: Record<string, any[]>, k: LadderKnobs): string {
  const segs: string[] = [slug, trunc(flat(s.description) || "—", k.descMax)];
  const capIds = strList(s.capabilities);
  if (capIds.length) {
    const rendered = capIds.map((id) => {
      if (!k.capOneLiners) return id;
      const provider = (capsById[id] || []).find((p) => p?.squad === slug);
      const one = provider?.description ? trunc(flat(provider.description), 60) : "";
      return one ? `${id} — ${one}` : id;
    });
    segs.push(`caps: ${rendered.join("; ")}`);
  }
  const ex = briefsSeg(strList(s.example_briefs), k.exampleBriefs, 90);
  if (ex) segs.push(ex);
  // Squad-level not_for does not exist in the registry; aggregate the squad's
  // capability not_for tokens instead (short entries per the metadata contract).
  const notTokens: string[] = [];
  for (const id of capIds) {
    const provider = (capsById[id] || []).find((p) => p?.squad === slug);
    for (const t of strList(provider?.not_for)) notTokens.push(flat(t));
  }
  if (notTokens.length) segs.push(`not: ${trunc(notTokens.join("; "), 80)}`);
  return segs.join(" | ");
}

function cloneLine(slug: string, c: any, k: LadderKnobs): string {
  const m = c?.match || {};
  const segs: string[] = [slug, trunc(flat(m.one_liner), k.oneLinerMax)];
  // Top 6 domains, whole segment capped at 140c — clone domains are allowed to
  // be 90c symptom phrases, and uncapped they dominate the whole token budget.
  const domains = k.cloneDomains === false ? [] : strList(m.domains).slice(0, 6);
  if (domains.length) segs.push(`domains: ${trunc(domains.map(flat).join(", "), 140)}`);
  return segs.join(" | ");
}

function renderAt(input: DigestInput, level: 0 | 1 | 2 | 3 | 4, generatedAt: string): string {
  const k = KNOBS[level];
  const bizSlugs = Object.keys(input.businesses).sort();
  const squadSlugs = Object.keys(input.squads).sort();
  const capIds = Object.keys(input.capabilities);
  const providerCount = capIds.reduce((n, id) => n + (input.capabilities[id]?.length || 0), 0);
  const collisions = capIds.filter((id) => (input.capabilities[id]?.length || 0) >= 2).sort();
  const cloneSlugs = Object.keys(input.mindClones).sort();
  const enriched = cloneSlugs.filter((s) => input.mindClones[s]?.match?.one_liner);
  const bare = cloneSlugs.filter((s) => !input.mindClones[s]?.match?.one_liner);

  const lines: string[] = [
    "# Nirvana-OS routing digest",
    "# Generated by harness/scripts/build-routing-digest.ts — do not edit by hand.",
    `generated_at: ${generatedAt}`,
    `counts: businesses=${bizSlugs.length} | squads=${squadSlugs.length} | capability_ids=${capIds.length} | capability_providers=${providerCount} | capability_collisions=${collisions.length} | mind_clones=${cloneSlugs.length} (${enriched.length} with routing block)`,
    `degradation_level: ${level} (0=full · 1=single example brief · 2=+no capability one-liners · 3=+descriptions and clone one-liners at 100c · 4=+no clone domains; entries are never dropped)`,
    "escalation (finalists only — never for the survey):",
    `  businesses registry: ${input.registryPaths.businesses} (each entry's manifest_path → full business.yaml)`,
    `  squads registry: ${input.registryPaths.squads} (each entry's manifest_path → full squad.yaml)`,
    `  mind-clones registry: ${input.registryPaths.mindClones} (each entry's dir/persona_files → MANIFEST.yaml, AGENT.md)`,
    "format: pipe-delimited lines; labeled segments (domains:/produces:/caps:/ex:/not:) are omitted when empty.",
    "",
    "## businesses (slug | description | domains: | produces: top 6 | caps: ids | ex: briefs | not:)",
    ...bizSlugs.map((s) => businessLine(s, input.businesses[s], k)),
    "",
    "## squads (slug | description | caps: id — one-liner | ex: briefs | not:)",
    ...squadSlugs.map((s) => squadLine(s, input.squads[s], input.capabilities, k)),
    "",
    "## capability collisions (id → providers; disambiguate via the squads section above)",
    ...(collisions.length
      ? collisions.map((id) => `${id} → ${(input.capabilities[id] || []).map((p) => p?.squad).filter(Boolean).join(", ")}`)
      : ["(none)"]),
    "",
    "## mind-clones (slug | one_liner | domains: top 6)",
    ...enriched.map((s) => cloneLine(s, input.mindClones[s], k)),
  ];
  if (bare.length) {
    lines.push(
      "### without routing block (slug only — escalate to the mind-clones registry for details)",
      bare.join(", "),
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Build the digest text, walking the degradation ladder until it fits the
 * budget. Entries are NEVER dropped; if L3 still exceeds the budget the L3
 * text is returned with overBudget=true (the --check-budget gate turns that
 * into exit 1).
 */
export function buildDigest(input: DigestInput, opts: { budgetTokens?: number; generatedAt?: string } = {}): DigestResult {
  const budget = opts.budgetTokens ?? TOKEN_BUDGET;
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  let text = "";
  let tokens = 0;
  let level: 0 | 1 | 2 | 3 | 4 = 0;
  for (const l of [0, 1, 2, 3, 4] as const) {
    level = l;
    text = renderAt(input, l, generatedAt);
    tokens = estimateTokens(text);
    if (tokens < budget) break;
  }
  const capIds = Object.keys(input.capabilities);
  return {
    text,
    tokens,
    degradationLevel: level,
    overBudget: tokens >= budget,
    counts: {
      businesses: Object.keys(input.businesses).length,
      squads: Object.keys(input.squads).length,
      capabilityIds: capIds.length,
      capabilityProviders: capIds.reduce((n, id) => n + (input.capabilities[id]?.length || 0), 0),
      capabilityCollisions: capIds.filter((id) => (input.capabilities[id]?.length || 0) >= 2).length,
      mindClones: Object.keys(input.mindClones).length,
      mindClonesEnriched: Object.values(input.mindClones).filter((c: any) => c?.match?.one_liner).length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Keyword alias groups (.keyword-aliases.json)
// ─────────────────────────────────────────────────────────────────────

/** Accent/hyphen/case folding — the alias equivalence key. */
export const foldKey = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/-/g, "").replace(/\s+/g, " ").trim();

const PT_STOPWORDS = /(^|\s)(de|da|do|das|dos|para|por|com|sem|meu|minha|nosso|nossa|que|como|uma|um|não|nao|está|esta|são|sao|ção|preciso|quero)(\s|$)/i;

// PT content words that carry no diacritics and no stopword — without this
// hint list, "livro digital" or "tutoria adaptativa" read as ASCII → "en" and
// split their alias group (the contract's own canonical example would fail).
const PT_HINT_WORDS = new Set([
  "livro", "curso", "pagina", "paginas", "venda", "vendas", "negocio", "negocios",
  "empresa", "empresas", "criacao", "gestao", "saude", "juridico", "juridica",
  "medico", "medica", "trafego", "conteudo", "roteiro", "marca", "marcas",
  "anuncio", "anuncios", "estrategia", "relatorio", "analise", "revisao",
  "tutoria", "aula", "aulas", "ensino", "aprendizagem", "treinamento",
  "consultoria", "imobiliario", "imobiliaria", "financeiro", "financeira",
  "planejamento", "orcamento", "cobranca", "atendimento", "cliente", "clientes",
  "clinica", "advocacia", "contabilidade", "imposto", "impostos", "fiscal",
  "lancamento", "produto", "produtos", "servico", "servicos", "precificacao",
  "proposta", "propostas", "reuniao", "apresentacao", "pesquisa", "redacao",
  "escrita", "leitura", "cardapio", "receita", "receitas", "obra", "obras",
]);

/** Cheap pt/en heuristic (extends enrich-routing-metadata.ts detectLang with
 * a PT content-word hint list for diacritic-free PT keywords). */
export function detectLang(s: string): "pt" | "en" | "other" {
  const t = (s || "").toLowerCase();
  if (/[ãõáéíóúâêôàçü]/.test(t) || PT_STOPWORDS.test(t)) return "pt";
  if (foldKey(t).split(" ").some((w) => PT_HINT_WORDS.has(w))) return "pt";
  if (/^[\x00-\x7F]+$/.test(t)) return "en";
  return "other";
}

/**
 * Split ONE entity's flat keywords list into concept groups following the
 * contract convention (groups ship consecutively: one form per language plus
 * accent/hyphen spelling variants). A keyword continues the current group when
 * its folded form matches a member (spelling variant) or its language is not
 * yet present in the group (translation form); otherwise a new group starts.
 */
export function splitKeywordGroups(keywords: string[]): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let currentKeys = new Set<string>();
  let currentLangs = new Set<string>();
  const flush = () => {
    if (current.length) groups.push(current);
    current = [];
    currentKeys = new Set();
    currentLangs = new Set();
  };
  for (const raw of keywords) {
    const kw = String(raw || "").trim();
    if (!kw) continue;
    const key = foldKey(kw);
    const lang = detectLang(kw);
    if (current.length && !currentKeys.has(key) && currentLangs.has(lang)) flush();
    if (!currentKeys.has(key) || !current.includes(kw)) current.push(kw);
    currentKeys.add(key);
    currentLangs.add(lang);
  }
  flush();
  return groups;
}

/**
 * Build the cross-language alias groups from business + capability `keywords`
 * arrays. Groups from different entities that share a folded form are merged
 * (union-find), which also merges accent-folded duplicates. Only groups with
 * 2+ distinct surface forms are emitted (singletons carry no alias signal).
 */
export function buildKeywordAliases(input: Pick<DigestInput, "businesses" | "capabilities">): string[][] {
  const lists: string[][] = [];
  for (const slug of Object.keys(input.businesses).sort()) {
    const kws = strList(input.businesses[slug]?.keywords);
    if (kws.length) lists.push(kws);
  }
  for (const id of Object.keys(input.capabilities).sort()) {
    for (const provider of input.capabilities[id] || []) {
      const kws = strList(provider?.keywords);
      if (kws.length) lists.push(kws);
    }
  }

  // Union-find over group ids, linked by shared folded keys.
  const parent: number[] = [];
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

  const groupMembers: string[][] = [];
  const keyToGroup = new Map<string, number>();
  for (const list of lists) {
    for (const group of splitKeywordGroups(list)) {
      const gid = groupMembers.length;
      groupMembers.push(group);
      parent.push(gid);
      for (const member of group) {
        const key = foldKey(member);
        const existing = keyToGroup.get(key);
        if (existing === undefined) keyToGroup.set(key, gid);
        else union(existing, gid);
      }
    }
  }

  // Collect merged groups, dedupe surfaces by exact string (first seen wins).
  const merged = new Map<number, string[]>();
  const seen = new Map<number, Set<string>>();
  for (let gid = 0; gid < groupMembers.length; gid++) {
    const root = find(gid);
    if (!merged.has(root)) { merged.set(root, []); seen.set(root, new Set()); }
    const out = merged.get(root)!;
    const dedupe = seen.get(root)!;
    for (const member of groupMembers[gid]) {
      if (dedupe.has(member)) continue;
      dedupe.add(member);
      out.push(member);
    }
  }

  const result = [...merged.values()].filter((g) => g.length >= 2);
  result.sort((a, b) => a[0].localeCompare(b[0]));
  return result;
}

// ─────────────────────────────────────────────────────────────────────
// Registry loading + atomic write
// ─────────────────────────────────────────────────────────────────────

function readJsonSafe(p: string): any {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

export function loadDigestInput(p: { businessesRegistry: string; squadsRegistry: string; mindClonesRegistry: string }): DigestInput {
  const biz = readJsonSafe(p.businessesRegistry);
  const sq = readJsonSafe(p.squadsRegistry);
  const cl = readJsonSafe(p.mindClonesRegistry);
  return {
    businesses: biz?.businesses || {},
    squads: sq?.squads || {},
    capabilities: sq?.capabilities || {},
    mindClones: cl?.mind_clones || {},
    registryPaths: { businesses: p.businessesRegistry, squads: p.squadsRegistry, mindClones: p.mindClonesRegistry },
  };
}

/** Atomic write (tmp + rename): a concurrent reader never sees a torn file. */
function writeAtomic(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, p);
}

// ─────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const { flags } = parseArgs();
  const quiet = !!flags.quiet || !!flags.q;
  const jsonOut = !!flags.json;
  const checkBudget = !!flags["check-budget"];

  const resolved = resolveRoutingArtifactPaths();
  const registryPaths = {
    businessesRegistry: typeof flags.businesses === "string" ? flags.businesses : resolved.businessesRegistry,
    squadsRegistry: typeof flags.squads === "string" ? flags.squads : resolved.squadsRegistry,
    mindClonesRegistry: typeof flags.clones === "string" ? flags.clones : resolved.mindClonesRegistry,
  };
  const digestPath = typeof flags.out === "string" ? flags.out : resolved.digest;
  const aliasesPath = typeof flags["aliases-out"] === "string" ? flags["aliases-out"] : path.join(path.dirname(digestPath), ".keyword-aliases.json");

  const input = loadDigestInput(registryPaths);
  if (!Object.keys(input.businesses).length && !Object.keys(input.squads).length && !Object.keys(input.mindClones).length) {
    console.error("[build-routing-digest] no registry could be read — run `nrv index` first.");
    console.error(`  looked at: ${Object.values(registryPaths).join(" · ")}`);
    process.exit(EXIT.FAILURES);
  }

  const digest = buildDigest(input);
  const aliases = buildKeywordAliases(input);

  if (!checkBudget) {
    writeAtomic(digestPath, digest.text);
    writeAtomic(aliasesPath, JSON.stringify(aliases, null, 1) + "\n");
  }

  if (jsonOut) {
    console.log(JSON.stringify({
      ok: !digest.overBudget,
      digest_path: checkBudget ? null : digestPath,
      aliases_path: checkBudget ? null : aliasesPath,
      tokens: digest.tokens,
      budget: TOKEN_BUDGET,
      degradation_level: digest.degradationLevel,
      over_budget: digest.overBudget,
      counts: digest.counts,
      alias_groups: aliases.length,
    }, null, 2));
  } else if (!quiet) {
    const c = digest.counts;
    console.error(`[build-routing-digest] ~${digest.tokens} tokens (budget ${TOKEN_BUDGET}, chars/4) · degradation level ${digest.degradationLevel}`);
    console.error(`[build-routing-digest] businesses=${c.businesses} squads=${c.squads} capability_ids=${c.capabilityIds} providers=${c.capabilityProviders} collisions=${c.capabilityCollisions} clones=${c.mindClones} (${c.mindClonesEnriched} enriched)`);
    console.error(`[build-routing-digest] alias groups: ${aliases.length}`);
    if (!checkBudget) {
      console.error(`[build-routing-digest] digest → ${digestPath}`);
      console.error(`[build-routing-digest] aliases → ${aliasesPath}`);
    }
    if (digest.overBudget) console.error(`[build-routing-digest] OVER BUDGET even at level 3 — trim registry descriptions/briefs.`);
  }

  if (checkBudget && digest.overBudget) process.exit(EXIT.FAILURES);
  process.exit(EXIT.OK);
}
