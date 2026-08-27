// kinds/mind-clone.ts — the mind-clone catalog of the admission gate.
//
// Facts that shaped the catalog (library of 555 clones, 2026-08-26): 54 have
// no `routing:` block, 58 no verdict, 22 a verdict outside the enum (three
// live values now admitted), 59 no `dna_layers`, 357 not a single `^[FONTE:`
// tag, 6 fewer than three DNA layers. Hard errors are what a text edit fixes
// in a minute (manifest shape, the four artifacts, the surface); what the
// validation pipeline produces (verdict, sources, FONTE density, routing
// block) is a warning, and baselineable, so existing debt is recorded and
// may only shrink while a NEW clone enters complete.
//
// Layer item counting, in order of precedence: the layer's `### ` headings
// (frameworks and methodologies are written as sub-sections), else its
// top-level list items, else the rows of a Markdown table (the original
// template writes L2 as a 4-row table), else paragraphs opening with a bold
// run (`**H1 — ...**`). Measured against the library this matches the
// authored `dna_layers` counts far better than any single rule; the naive
// count of every list line matched 5 of 490 clones.

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { parse as parseYaml } from "yaml";
import { parseDnaSchema, type LayerKey } from "../../dna-schema-parser.ts";
import { validateMindCloneFile } from "../../mindclone-validator.ts";
import { MIND_CLONE_VALIDATION_VERDICTS, MindCloneManifestSchema } from "../../../validators/validators.ts";
import { editYaml, fixResult, listEntities, resolveEntityDir, surfaceFindings, surfaceRegenFixer } from "../common.ts";
import type { CheckContext, Criterion, Finding, Fixer, KindModule } from "../types.ts";

export const CANONICAL_ARTIFACTS = ["agent/AGENT.md", "agent/SOUL.md", "agent/DNA-CONFIG.yaml", "dna/dna-schema.md"] as const;
/** Flat fallbacks index-clones.ts tolerates for the persona files. */
const FLAT_FALLBACK: Record<string, string> = { "agent/AGENT.md": "AGENT.md", "agent/SOUL.md": "SOUL.md" };

export const LAYER_FIELD: Record<LayerKey, string> = {
  L1: "L1_philosophies", L2: "L2_mental_models", L3: "L3_heuristics", L4: "L4_frameworks", L5: "L5_methodologies",
};
/** Minimum items per layer (mind-clone.schema.json documentation values). */
export const LAYER_MIN: Record<LayerKey, number> = { L1: 3, L2: 4, L3: 5, L4: 3, L5: 1 };

export const ONE_LINER_MAX = 120;
export const DOMAINS_MIN = 20;
export const DOMAINS_MAX = 30;
export const SERVES_MAX_WORDS = 500;
export const FONTE_DENSITY_MIN = 0.5;
const FONTE_TAG = /\^\[FONTE/g;
const NEGATION = /(^|\s)(sem|não|nao|nunca|em vez de|without|never|not|instead of)(\s|$)/i;

export const criteria: Criterion[] = [
  { id: "manifest_parse", severity: "error", autofix: "none", baselineable: false, title: "MANIFEST.yaml parses" },
  { id: "manifest_schema", severity: "error", autofix: "none", baselineable: false, title: "MANIFEST.yaml matches MindCloneManifestSchema" },
  { id: "manifest_name_mismatch", severity: "error", autofix: "mechanical", baselineable: false, title: "manifest.name equals the directory slug", fixer: "manifest_name_sync" },
  { id: "artifact_missing", severity: "error", autofix: "none", baselineable: false, title: "AGENT.md, SOUL.md, DNA-CONFIG.yaml and dna-schema.md exist and are not empty" },
  { id: "agent_md_invalid", severity: "error", autofix: "none", baselineable: false, title: "agent/AGENT.md passes the persona validator" },
  { id: "category_numbered", severity: "error", autofix: "mechanical", baselineable: false, title: "category is bare (no numbered legacy prefix)", fixer: "category_bare" },
  { id: "domains_item_malformed", severity: "error", autofix: "none", baselineable: false, title: "every routing.domains item is text" },
  { id: "validation_verdict_unknown", severity: "error", autofix: "none", baselineable: false, title: "validation_verdict is one of the known verdicts" },
  { id: "dna_schema_layers_incomplete", severity: "error", autofix: "none", baselineable: false, title: "dna-schema.md has at least three layers" },
  { id: "surface_missing", severity: "error", autofix: "mechanical", baselineable: false, title: ".nirvana-surface.json present", fixer: "surface_regen" },

  { id: "artifacts_status_wrong", severity: "warning", autofix: "mechanical", baselineable: false, title: "artifacts[].status matches the disk", fixer: "artifacts_status_sync" },
  { id: "routing_block_missing", severity: "warning", autofix: "agentic", baselineable: true, title: "routing: block present (MIND_CLONE_ROUTING_CONTRACT.md)" },
  { id: "one_liner_missing", severity: "warning", autofix: "agentic", baselineable: true, title: "routing.one_liner present" },
  { id: "one_liner_too_long", severity: "warning", autofix: "none", baselineable: false, title: `routing.one_liner within ${ONE_LINER_MAX} chars` },
  { id: "domains_count", severity: "warning", autofix: "agentic", baselineable: false, title: `routing.domains has ${DOMAINS_MIN}–${DOMAINS_MAX} items` },
  { id: "domains_negation", severity: "warning", autofix: "none", baselineable: false, title: "no domain is phrased as a negation (rule 3a)" },
  { id: "domains_slash", severity: "warning", autofix: "none", baselineable: false, title: "no domain carries a slash (PT and EN are separate items)" },
  { id: "domains_refuses_conflict", severity: "warning", autofix: "none", baselineable: false, title: "no domain is also in refuses" },
  { id: "serves_missing", severity: "warning", autofix: "agentic", baselineable: false, title: "routing.serves present (when_to_use is legacy)" },
  { id: "serves_too_long", severity: "warning", autofix: "none", baselineable: false, title: `routing.serves within ${SERVES_MAX_WORDS} words (rule 3e)` },
  { id: "not_for_missing", severity: "warning", autofix: "agentic", baselineable: false, title: "routing.not_for present" },
  { id: "delegates_to_present", severity: "warning", autofix: "mechanical", baselineable: false, title: "routing.delegates_to absent (retired 2026-08-18)", fixer: "delegates_to_strip" },
  { id: "validation_verdict_missing", severity: "warning", autofix: "none", baselineable: true, title: "validation_verdict present" },
  { id: "source_material_missing", severity: "warning", autofix: "none", baselineable: true, title: "source_material.primary present (never fabricated)" },
  { id: "dna_layers_missing", severity: "warning", autofix: "mechanical", baselineable: true, title: "dna_layers block present", fixer: "dna_layers_sync" },
  { id: "dna_layers_below_min", severity: "warning", autofix: "none", baselineable: false, title: "every layer reaches its minimum item count" },
  { id: "dna_layers_count_drift", severity: "warning", autofix: "mechanical", baselineable: false, title: "dna_layers counts match dna-schema.md", fixer: "dna_layers_sync" },
  { id: "fonte_density_low", severity: "warning", autofix: "none", baselineable: true, title: `at least ${FONTE_DENSITY_MIN} ^[FONTE:] tags per layer item` },
  { id: "source_coverage_unsupported", severity: "warning", autofix: "none", baselineable: false, title: "scores.source_coverage is backed by ^[FONTE:] tags" },
  { id: "surface_stale", severity: "warning", autofix: "mechanical", baselineable: false, title: ".nirvana-surface.json matches the files on disk", fixer: "surface_regen" },
  { id: "self_retrieval_miss", severity: "warning", autofix: "agentic", baselineable: true, title: "routing.one_liner retrieves the clone first (self-retrieval gate)" },
  { id: "registry_absent", severity: "info", autofix: "none", baselineable: false, title: "self-retrieval skipped: clone not in the registry" },
];

const BY_ID = new Map(criteria.map((c) => [c.id, c]));

function mk(id: string, message: string, evidence: string, where?: string): Finding {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`unknown mind-clone criterion: ${id}`);
  return { id, severity: c.severity, autofix: c.autofix, message, evidence, ...(where ? { where } : {}), baselined: false, ...(c.fixer ? { fixer: c.fixer } : {}) };
}

// ── measurements ────────────────────────────────────────────────────────────

export function countLayerItems(raw: string): number {
  const lines = raw.split("\n");
  const h3 = lines.filter((l) => /^###\s+\S/.test(l)).length;
  if (h3 > 0) return h3;
  const items = lines.filter((l) => /^(\d+[.)]|[-*])\s+/.test(l)).length;
  if (items > 0) return items;
  // a table: rows minus the header row; the |---| separator never counts
  const rows = lines.filter((l) => /^\|/.test(l) && !/^\|\s*:?-+/.test(l)).length;
  if (rows > 1) return rows - 1;
  return lines.filter((l) => /^\*\*\S/.test(l)).length;
}

export interface DnaMeasure {
  ok: boolean;
  layers: number;
  counts: Partial<Record<LayerKey, number>>;
  items: number;
  fonte: number;
}

export function measureDnaSchema(md: string): DnaMeasure {
  const parsed = parseDnaSchema(md);
  const counts: Partial<Record<LayerKey, number>> = {};
  let items = 0;
  for (const [k, layer] of Object.entries(parsed.layers) as Array<[LayerKey, { raw: string }]>) {
    const n = countLayerItems(layer.raw);
    counts[k] = n;
    items += n;
  }
  return { ok: parsed.ok, layers: Object.keys(parsed.layers).length, counts, items, fonte: (md.match(FONTE_TAG) || []).length };
}

function artifactPath(dir: string, rel: string): { path: string; present: boolean } {
  const canonical = path.join(dir, rel);
  const fallback = FLAT_FALLBACK[rel] ? path.join(dir, FLAT_FALLBACK[rel]) : null;
  for (const p of [canonical, fallback]) {
    if (!p) continue;
    try { if (fs.statSync(p).isFile() && fs.readFileSync(p, "utf8").trim().length > 0) return { path: p, present: true }; } catch { /* absent */ }
  }
  return { path: canonical, present: false };
}

function fileIsPresent(dir: string, rel: string): boolean {
  try { return fs.statSync(path.join(dir, rel)).isFile() && fs.readFileSync(path.join(dir, rel), "utf8").trim().length > 0; } catch { return false; }
}

const norm = (s: unknown) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

// ── check ───────────────────────────────────────────────────────────────────

export async function check(ctx: CheckContext): Promise<Finding[]> {
  const { dir, slug } = ctx;
  const out: Finding[] = [];
  const manifestFile = path.join(dir, "MANIFEST.yaml");

  let doc: any = null;
  try { doc = parseYaml(fs.readFileSync(manifestFile, "utf8")); }
  catch (e: any) { out.push(mk("manifest_parse", "MANIFEST.yaml does not parse", String(e?.message ?? e).split("\n")[0])); }
  if (doc !== null && (typeof doc !== "object" || Array.isArray(doc))) {
    out.push(mk("manifest_parse", "MANIFEST.yaml is not a YAML mapping", typeof doc));
    doc = null;
  }

  // artifacts — independent of the manifest
  for (const rel of CANONICAL_ARTIFACTS) {
    const a = artifactPath(dir, rel);
    if (!a.present) out.push(mk("artifact_missing", `${rel} is absent or empty`, a.path, rel));
  }
  const agentMd = artifactPath(dir, "agent/AGENT.md");
  if (agentMd.present) {
    const v = validateMindCloneFile(agentMd.path);
    if (!v.ok) {
      out.push(mk("agent_md_invalid", `agent/AGENT.md fails the persona validator: ${v.errors.map((e) => e.code).join(", ")}`, v.errors.map((e) => e.message).join(" · ").slice(0, 400)));
    }
  }

  // dna schema — independent of the manifest
  let dna: DnaMeasure | null = null;
  const schemaFile = artifactPath(dir, "dna/dna-schema.md");
  if (schemaFile.present) {
    dna = measureDnaSchema(fs.readFileSync(schemaFile.path, "utf8"));
    if (!dna.ok) out.push(mk("dna_schema_layers_incomplete", `dna-schema.md has ${dna.layers} of 5 layers (minimum 3)`, `layers found: ${Object.keys(dna.counts).join(", ") || "none"}`));
  }

  if (doc) {
    const man = (doc.manifest ?? {}) as Record<string, unknown>;
    // schema — issues at paths with their own criterion are mapped to it
    const parsed = MindCloneManifestSchema.safeParse(doc);
    if (!parsed.success) {
      const generic: string[] = [];
      for (const issue of parsed.error.issues) {
        const p = issue.path.map(String);
        const joined = p.join(".");
        if (joined === "validation_verdict") {
          out.push(mk("validation_verdict_unknown", `validation_verdict "${String(doc.validation_verdict)}" is not a known verdict`, `known: ${MIND_CLONE_VALIDATION_VERDICTS.join(", ")}`));
        } else if (joined === "manifest.category" && /^\d\d-/.test(String(man.category ?? ""))) {
          out.push(mk("category_numbered", `numbered legacy category "${String(man.category)}" — the library is bare-form`, "manifest.category"));
        } else if (p[0] === "routing" && p[1] === "domains" && p.length === 3) {
          const item = (doc.routing?.domains ?? [])[Number(p[2])];
          out.push(mk("domains_item_malformed", `routing.domains[${p[2]}] is not text (${JSON.stringify(item).slice(0, 60)}) — use a comma, not a colon`, joined, `domains[${p[2]}]`));
        } else {
          generic.push(`${joined || "(root)"}: ${issue.message}`);
        }
      }
      if (generic.length) out.push(mk("manifest_schema", `MANIFEST.yaml violates the schema (${generic.length} issue${generic.length === 1 ? "" : "s"})`, generic.slice(0, 6).join(" · ")));
    }
    // `category` is authored in two places across the live library: under
    // `manifest:` (canonical, and the only one the schema sees) and at the top
    // level (older compilations). The numbered legacy form has to be caught in
    // both — `category_bare` has always repaired both — otherwise a clone that
    // writes it at the top level walks past a bar the fixer would have fixed.
    const topCategory = String((doc as Record<string, unknown>).category ?? "");
    if (/^\d\d-/.test(topCategory) && !out.some((f) => f.id === "category_numbered")) {
      out.push(mk("category_numbered", `numbered legacy category "${topCategory}" — the library is bare-form`, "category"));
    }
    if (typeof man.name === "string" && man.name !== slug) {
      out.push(mk("manifest_name_mismatch", `manifest.name "${man.name}" differs from the directory slug "${slug}"`, "manifest.name"));
    }

    // artifacts[].status
    if (Array.isArray(doc.artifacts)) {
      const wrong: string[] = [];
      for (const a of doc.artifacts) {
        if (!a || typeof a.path !== "string" || !a.status || a.status === "pending") continue;
        const present = fileIsPresent(dir, a.path);
        if ((a.status === "present") !== present) wrong.push(`${a.path}: declared ${a.status}, disk ${present ? "present" : "missing"}`);
      }
      if (wrong.length) out.push(mk("artifacts_status_wrong", `${wrong.length} artifacts[].status entr${wrong.length === 1 ? "y" : "ies"} disagree with the disk`, wrong.slice(0, 4).join(" · ")));
    }

    // routing block
    const routing = doc.routing;
    if (!routing || typeof routing !== "object") {
      out.push(mk("routing_block_missing", "no routing: block — invisible to semantic dispatch (MRR 0.05 vs 1.00)", "MIND_CLONE_ROUTING_CONTRACT.md"));
    } else {
      const ol = routing.one_liner;
      if (typeof ol !== "string" || !ol.trim()) out.push(mk("one_liner_missing", "no routing.one_liner — the definition of an enriched clone", "routing.one_liner"));
      else if (ol.length > ONE_LINER_MAX) out.push(mk("one_liner_too_long", `routing.one_liner has ${ol.length} chars (max ${ONE_LINER_MAX})`, ol.slice(0, 80) + "…"));
      const domains: unknown[] = Array.isArray(routing.domains) ? routing.domains : [];
      const texts = domains.filter((d): d is string => typeof d === "string");
      if (domains.length < DOMAINS_MIN || domains.length > DOMAINS_MAX) out.push(mk("domains_count", `routing.domains has ${domains.length} items (expected ${DOMAINS_MIN}–${DOMAINS_MAX})`, "routing.domains"));
      const neg = texts.filter((d) => NEGATION.test(d));
      if (neg.length) out.push(mk("domains_negation", `${neg.length} domain(s) phrased as a negation — BM25 indexes the negated term as a vote for it`, neg.slice(0, 3).join(" · ")));
      const slash = texts.filter((d) => d.includes("/"));
      if (slash.length) out.push(mk("domains_slash", `${slash.length} domain(s) carry a slash — PT and EN belong in separate items`, slash.slice(0, 3).join(" · ")));
      const refuses = new Set((Array.isArray(routing.refuses) ? routing.refuses : []).map(norm));
      const conflict = texts.filter((d) => refuses.has(norm(d)));
      if (conflict.length) out.push(mk("domains_refuses_conflict", `${conflict.length} domain(s) also listed in refuses`, conflict.slice(0, 3).join(" · ")));
      if (typeof routing.serves !== "string" || !routing.serves.trim()) {
        out.push(mk("serves_missing", routing.when_to_use ? "routing.serves absent (legacy when_to_use present — still indexed, but new blocks write serves)" : "routing.serves absent", "routing.serves"));
      } else {
        const words = routing.serves.trim().split(/\s+/).length;
        if (words > SERVES_MAX_WORDS) out.push(mk("serves_too_long", `routing.serves has ${words} words (above ~${SERVES_MAX_WORDS} it dilutes the block)`, "rule 3e"));
      }
      if (typeof routing.not_for !== "string" || !routing.not_for.trim()) out.push(mk("not_for_missing", "routing.not_for absent — the orchestrator has no boundary map after retrieval", "routing.not_for"));
      if (routing.delegates_to !== undefined) out.push(mk("delegates_to_present", "routing.delegates_to is retired (2026-08-18) and ignored — name the neighbour in not_for prose", `${Array.isArray(routing.delegates_to) ? routing.delegates_to.length : 1} entr${Array.isArray(routing.delegates_to) && routing.delegates_to.length !== 1 ? "ies" : "y"}`));
    }

    // pipeline-produced metadata (debt)
    const verdict = doc.validation_verdict ?? man.validation_verdict;
    if (!verdict) out.push(mk("validation_verdict_missing", "no validation_verdict — produced by the validation pipeline, never by a text edit", "validation_verdict"));
    const src = doc.source_material ?? man.source_material;
    // `primary_works` is the same list under an older name (3 of 527 live
    // clones write it). The bar is that the sources are DECLARED; refusing a
    // clone that declares them under the older key would invent a failure the
    // pack build has never had, and no source is fabricated either way.
    const primary = src && typeof src === "object" ? ((src as any).primary ?? (src as any).primary_works) : undefined;
    if (!src || !Array.isArray(primary) || primary.length === 0) out.push(mk("source_material_missing", "no source_material.primary — the gate never fabricates a source", "source_material.primary"));

    // dna_layers vs the schema file
    if (dna && dna.ok) {
      const layers = doc.dna_layers;
      const below = (Object.entries(dna.counts) as Array<[LayerKey, number]>).filter(([k, n]) => n < LAYER_MIN[k]);
      if (below.length) out.push(mk("dna_layers_below_min", `${below.length} layer(s) below the minimum item count`, below.map(([k, n]) => `${k}: ${n} < ${LAYER_MIN[k]}`).join(" · ")));
      if (!layers || typeof layers !== "object") {
        out.push(mk("dna_layers_missing", "no dna_layers block — counts are measured from dna-schema.md", Object.entries(dna.counts).map(([k, n]) => `${k}=${n}`).join(" ")));
      } else {
        const drift: string[] = [];
        for (const [k, n] of Object.entries(dna.counts) as Array<[LayerKey, number]>) {
          const declared = Number((layers as any)[LAYER_FIELD[k]]);
          if (Number.isFinite(declared) && declared !== n) drift.push(`${LAYER_FIELD[k]}: declared ${declared}, measured ${n}`);
        }
        if (drift.length) out.push(mk("dna_layers_count_drift", `${drift.length} dna_layers count(s) differ from dna-schema.md`, drift.slice(0, 5).join(" · ")));
      }
      if (dna.items > 0) {
        const density = dna.fonte / dna.items;
        if (density < FONTE_DENSITY_MIN) {
          const hint = dna.fonte === 0 ? " — with no sources at all, consider validation_verdict ARCHETYPE_PERSONA rather than adding citations" : "";
          out.push(mk("fonte_density_low", `${dna.fonte} ^[FONTE:] tag(s) for ${dna.items} layer items (${density.toFixed(2)} < ${FONTE_DENSITY_MIN})${hint}`, "dna/dna-schema.md"));
        }
      }
      const cov = doc.scores && typeof doc.scores === "object" ? Number((doc.scores as any).source_coverage) : NaN;
      if (Number.isFinite(cov) && cov > 0 && dna.fonte === 0) out.push(mk("source_coverage_unsupported", `scores.source_coverage ${cov} declared, but dna-schema.md carries no ^[FONTE:] tag`, "scores.source_coverage"));
    }
  }

  out.push(...surfaceFindings(dir, "mind-clone", (id, m, e) => mk(id, m, e)));

  if (ctx.retrieval && doc?.routing?.one_liner) out.push(...await selfRetrieval(ctx));
  return out;
}

// One BM25 index per registry object: a batch over 555 clones must not
// rebuild the corpus 555 times (the shared gate builds it per call).
const INDEX_CACHE = new WeakMap<object, unknown>();

async function selfRetrieval(ctx: CheckContext): Promise<Finding[]> {
  const injected = !!ctx.cloneRegistry;
  let cloneRegistry = ctx.cloneRegistry;
  if (!cloneRegistry) {
    try {
      const { loadCloneRegistry } = await import("../../clone-resolver.ts");
      cloneRegistry = loadCloneRegistry();
    } catch { cloneRegistry = {}; }
  }
  if (!cloneRegistry || !Object.prototype.hasOwnProperty.call(cloneRegistry, ctx.slug)) {
    return [mk("registry_absent", "self-retrieval skipped: the clone is not in the mind-clone registry (run nrv index)", ".mind-clones-registry.json")];
  }
  const oneLiner = String((cloneRegistry as any)[ctx.slug]?.match?.one_liner ?? "").trim();
  if (!oneLiner) return [];

  let rank: number | null = null;
  let top3: Array<{ id: string; normalized: number }> = [];
  if (!injected) {
    // The shared creation gate (ROUTING_METADATA_CONTRACT.md §9), one entity at a time.
    const { runGate } = await import("../../../scripts/self-retrieval-gate.ts");
    const r = await runGate(ctx.slug, {
      kind: "clone",
      reindex: false,
      cloneRegistry: cloneRegistry as Record<string, any>,
      registries: ctx.registries ?? { squads: { capabilities: {}, _v4_inferred_capabilities: {} }, businesses: { businesses: {} } },
    });
    if (r.reason || r.passed) return [];
    rank = r.briefs[0]?.rank ?? null;
    top3 = r.briefs[0]?.top3 ?? [];
  } else {
    // Same construction as the gate's clone branch (eval-clone-routing axis 1), index cached per registry.
    const bm25 = createRequire(import.meta.url)(path.join(import.meta.dir, "..", "..", "..", "..", "harness", "lib", "bm25.js"));
    const { buildCloneDocForTest } = await import("../../clone-search.ts");
    let idx = INDEX_CACHE.get(cloneRegistry as object);
    if (!idx) { idx = bm25.buildIndex(Object.values(cloneRegistry as Record<string, any>).map(buildCloneDocForTest as any)); INDEX_CACHE.set(cloneRegistry as object, idx); }
    const hits: any[] = bm25.query(idx, oneLiner, { topK: 3 });
    for (let i = 0; i < hits.length; i++) if (hits[i]?.doc?.slug === ctx.slug) { rank = i + 1; break; }
    if (rank === 1) return [];
    top3 = hits.slice(0, 3).map((h: any) => ({ id: `clone:${h.doc.slug}`, normalized: h.normalized }));
  }
  const top = top3.map((t) => `${t.id} (${t.normalized.toFixed(2)})`).join(", ") || "no candidates";
  return [mk("self_retrieval_miss", `routing.one_liner does not retrieve the clone first (rank ${rank ?? "-"})`, `top: ${top}`)];
}

// ── fixers ──────────────────────────────────────────────────────────────────

const manifestOf = (dir: string) => path.join(dir, "MANIFEST.yaml");

const manifestNameSync: Fixer = ({ dir, slug, finding }) => {
  const changed = editYaml(manifestOf(dir), (doc) => {
    if (doc.getIn(["manifest", "name"]) === slug) return false;
    doc.setIn(["manifest", "name"], slug);
    return true;
  });
  return fixResult("manifest_name_sync", finding, changed, ["MANIFEST.yaml"]);
};

const categoryBare: Fixer = ({ dir, finding }) => {
  const changed = editYaml(manifestOf(dir), (doc) => {
    let touched = false;
    for (const p of [["manifest", "category"], ["category"]]) {
      const v = doc.getIn(p);
      if (typeof v === "string" && /^\d\d-/.test(v)) { doc.setIn(p, v.replace(/^\d\d-/, "")); touched = true; }
    }
    return touched;
  });
  return fixResult("category_bare", finding, changed, ["MANIFEST.yaml"]);
};

const artifactsStatusSync: Fixer = ({ dir, finding }) => {
  const changed = editYaml(manifestOf(dir), (doc) => {
    const arts = doc.get("artifacts") as any;
    if (!arts || !Array.isArray(arts.items)) return false;
    let touched = false;
    arts.items.forEach((item: any, i: number) => {
      const rel = doc.getIn(["artifacts", i, "path"]);
      const status = doc.getIn(["artifacts", i, "status"]);
      if (typeof rel !== "string" || !status || status === "pending") return;
      const actual = fileIsPresent(dir, rel) ? "present" : "missing";
      if (status !== actual) { doc.setIn(["artifacts", i, "status"], actual); touched = true; }
    });
    return touched;
  });
  return fixResult("artifacts_status_sync", finding, changed, ["MANIFEST.yaml"]);
};

const dnaLayersSync: Fixer = ({ dir, finding }) => {
  const schema = artifactPath(dir, "dna/dna-schema.md");
  if (!schema.present) return { ...fixResult("dna_layers_sync", finding, false, []), note: "dna-schema.md absent; nothing to measure" };
  const dna = measureDnaSchema(fs.readFileSync(schema.path, "utf8"));
  if (!dna.ok) return { ...fixResult("dna_layers_sync", finding, false, []), note: "dna-schema.md has fewer than three layers; counts not written" };
  const changed = editYaml(manifestOf(dir), (doc) => {
    let touched = false;
    for (const [k, n] of Object.entries(dna.counts) as Array<[LayerKey, number]>) {
      const p = ["dna_layers", LAYER_FIELD[k]];
      if (doc.getIn(p) !== n) { doc.setIn(p, n); touched = true; }
    }
    return touched;
  });
  return fixResult("dna_layers_sync", finding, changed, ["MANIFEST.yaml"]);
};

const delegatesToStrip: Fixer = ({ dir, finding }) => {
  const changed = editYaml(manifestOf(dir), (doc) => {
    if (!doc.hasIn(["routing", "delegates_to"])) return false;
    doc.deleteIn(["routing", "delegates_to"]);
    return true;
  });
  return fixResult("delegates_to_strip", finding, changed, ["MANIFEST.yaml"]);
};

export const mindCloneModule: KindModule = {
  kind: "mind-clone",
  manifestFile: "MANIFEST.yaml",
  resolveDir: (target) => resolveEntityDir("mind-clone", target),
  listAll: (roots) => listEntities("mind-clone", roots),
  criteria,
  check,
  fixers: {
    manifest_name_sync: manifestNameSync,
    category_bare: categoryBare,
    delegates_to_strip: delegatesToStrip,
    artifacts_status_sync: artifactsStatusSync,
    dna_layers_sync: dnaLayersSync,
    surface_regen: surfaceRegenFixer("mind-clone"),
  },
  fixOrder: ["manifest_name_sync", "category_bare", "delegates_to_strip", "artifacts_status_sync", "dna_layers_sync", "surface_regen"],
};
