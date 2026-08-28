// kinds/squad.ts — the squad catalog of the admission gate.
//
// Facts that shaped it (installed library, 204 squads, 2026-08-26): the
// manifests are sound (0 of 5,774 declared components missing, 705/705
// `invoke.ref` resolve) and the workflows are not — 160 of 1,740 `task:` and
// 180 of 2,786 `agent:` references point at no file, 56 steps carry the prompt
// inline instead of referencing a task, 15 workflows are orphans, and the graph
// is written in eight dialects of which only `steps[]` is in the spec.
//
// **Severity follows the manifest's protocol.** Under `protocol: "6.0"` the
// workflow rules are errors; under `"5.0"` the same rules are warnings, so the
// 204 installed squads keep the verdict they have today and a v6 squad enters
// clean. Two rules are advice under either protocol (the body ceiling, the
// orphan workflow) and one is a fact about packaging, never about the contract
// (`distribution_artifacts`). The catalog declares the v6 severity — the target
// state — and each finding carries the severity that actually applies.
//
// **Fixers never invent.** They rename, relocate and reshape what is already
// there: an extension dropped from a ref, prose moved from `task: |` to the
// body under `## <step.id>` verbatim, a `depends_on` that named an output
// rewritten to the step that creates it, a singular `output` promoted to
// `outputs[]`. A reference that resolves to nothing stays a finding — writing
// the missing task would be fabricating the squad's method. The one exception
// is `components_files_stub`, which predates the gate and is what the audit
// scorer already calls.
//
// The catalog ids map onto the program plan's S01–S13 / W01–W13; several S
// entries check more than one thing and get one id per thing, because a
// finding the report cannot name is a finding nobody fixes.

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { parse as parseYaml } from "yaml";
import { SquadManifestSchema } from "../../../validators/validators.ts";
import { LIMITS } from "../../../validators/limits.ts";
import {
  bodyWordCount, componentStems, lintWorkflow, normalizeWorkflow, readSquadWorkflows, readWorkflow,
  renderCanonicalMarkdown, renderProseBody, resolveWorkflowRef, splitFrontmatter, stripWorkflowExt,
  WORKFLOW_LINT_IDS, type SquadWorkflow,
} from "../../../../squads/lib/workflow-reader.ts";
import { checkPortability } from "../../../../squads/lib/squad-doctor.ts";
import { classify } from "../../../lib/corpus-language.ts";
import { editYaml, fixResult, listEntities, resolveEntityDir, surfaceFindings, surfaceRegenFixer } from "../common.ts";
import type { CheckContext, Criterion, Finding, FixResult, Fixer, KindModule, Severity } from "../types.ts";

const require_ = createRequire(import.meta.url);
const SQUAD_LIB = path.join(import.meta.dir, "..", "..", "..", "..", "squads", "lib");
const outputsLint = require_(path.join(import.meta.dir, "..", "..", "outputs-lint.js")) as {
  lintDir(dir: string): { errors: string[]; warnings: string[] };
};
const mechanical = require_(path.join(SQUAD_LIB, "mechanical-fixers.js")) as {
  applyMechanicalFixes(dir: string, diff: { patches: Array<Record<string, unknown>> }): Array<{ kind: string; result: any }>;
};

/** `not_for` fires as a substring at or below this length; above it needs token overlap. */
export const NOT_FOR_MAX_CHARS = 25;
const MIN_CONTENT_TOKENS = 2;
const TOKEN_OVERLAP_MIN = 0.6;
/** Files a per-buyer copy carries and a source never does. */
const DISTRIBUTION_FILES = ["SQUAD-DOCTOR-REPORT.md", "PROVENANCE.json", "LICENSE.txt"];
const WATERMARK_RE = /^(\/\/[A-Za-z0-9_-]{22}|\[\/\/\]: # \([A-Za-z0-9_-]{22}\)|#[A-Za-z0-9_-]{22})$/;
/** Contract-surface paths a fixer touches; the digest that decides `changed_files`. */
const TRACKED = ["squad.yaml", "agents", "tasks", "workflows", "README.md", "dependencies.yaml"];

export const criteria: Criterion[] = [
  // ── S01–S04: the manifest ─────────────────────────────────────────────────
  { id: "manifest_parse", severity: "error", autofix: "none", baselineable: false, title: "squad.yaml parses" },
  { id: "manifest_schema", severity: "error", autofix: "none", baselineable: false, title: "squad.yaml matches SquadManifestSchema for its protocol" },
  { id: "capabilities_missing", severity: "error", autofix: "none", baselineable: false, title: "a v5/v6 squad declares at least one capability" },
  { id: "capability_outputs_shape", severity: "error", autofix: "mechanical", baselineable: false, title: "capabilities use outputs[] with the declared keys", fixer: "outputs_shape_repair" },
  { id: "capability_examples_missing", severity: "error", autofix: "mechanical", baselineable: false, title: "every capability declares examples[] the schema accepts", fixer: "caps_examples_not_for" },
  { id: "not_for_too_long", severity: "error", autofix: "agentic", baselineable: false, title: `every not_for entry is at most ${NOT_FOR_MAX_CHARS} chars (v6 §33)` },
  { id: "invoke_ref_unresolved", severity: "error", autofix: "none", baselineable: false, title: "every capability's invoke.ref resolves on disk" },
  { id: "invoke_ref_extension", severity: "error", autofix: "mechanical", baselineable: false, title: "v6 refs a workflow without its extension (§28.6)", fixer: "invoke_ref_extension" },
  { id: "components_missing", severity: "error", autofix: "mechanical", baselineable: false, title: "every components.* entry exists on disk", fixer: "components_files_stub" },

  // ── S05–S09: the workflow graph (severity follows the protocol) ───────────
  { id: "workflow_parse", severity: "error", autofix: "none", baselineable: false, title: "every workflow document parses" },
  { id: "workflow_twin", severity: "error", autofix: "mechanical", baselineable: false, title: "no stem carries two encodings (§28.5)", fixer: "twin_merge" },
  { id: "workflow_inline_prose", severity: "error", autofix: "mechanical", baselineable: false, title: "no step carries the prompt inline (`task: |`)", fixer: "workflow_inline_prose_to_body" },
  { id: "workflow_ref_unresolved", severity: "error", autofix: "mechanical", baselineable: false, title: "every step's agent and task resolve on disk", fixer: "workflow_refs_repair" },
  { id: "workflow_step_id_duplicate", severity: "error", autofix: "none", baselineable: false, title: "step ids are unique inside a workflow" },
  { id: "workflow_dangling_requires", severity: "error", autofix: "none", baselineable: false, title: "every `requires` entry names a step" },
  { id: "workflow_requires_by_output", severity: "error", autofix: "mechanical", baselineable: false, title: "dependencies name step ids, never outputs", fixer: "requires_by_output_name" },
  { id: "workflow_cycle", severity: "error", autofix: "none", baselineable: false, title: "the step graph is acyclic" },
  { id: "workflow_shape_legacy", severity: "error", autofix: "mechanical", baselineable: false, title: "the graph is written in the canonical shape (§28.1)", fixer: "workflow_normalize_shape" },
  { id: "workflow_stem_case", severity: "error", autofix: "none", baselineable: false, title: "workflow stems are `^[a-z][a-z0-9_-]*$`" },

  // ── S10–S12 ───────────────────────────────────────────────────────────────
  { id: "surface_missing", severity: "error", autofix: "mechanical", baselineable: false, title: ".nirvana-surface.json present", fixer: "surface_regen" },
  { id: "outputs_pollution", severity: "error", autofix: "none", baselineable: false, title: "no run-output directory inside the squad" },

  // ── S13 + W01–W13: advice ─────────────────────────────────────────────────
  { id: "evaluator_missing", severity: "error", autofix: "agentic", baselineable: false, title: "an evaluator capability declares its `evaluator` block (v6 §30)" },
  { id: "surface_stale", severity: "warning", autofix: "mechanical", baselineable: false, title: ".nirvana-surface.json matches the files on disk", fixer: "surface_regen" },
  // Never counted: a router is a shape, not a defect. See ALWAYS_INFO in
  // squads/lib/workflow-reader.ts for why this one is `info` and not advice.
  { id: "workflow_event_router", severity: "info", autofix: "none", baselineable: false, title: "an `event_routes` document is read as a router, and its empty graph is explained" },
  { id: "workflow_orphan", severity: "warning", autofix: "none", baselineable: false, title: "every workflow is invoked by a capability" },
  { id: "workflow_body_too_long", severity: "warning", autofix: "none", baselineable: false, title: "the workflow body stays under the word ceiling" },
  { id: "produces_untyped", severity: "warning", autofix: "none", baselineable: false, title: "produces reaches a rubric or the capability types its outputs" },
  { id: "fidelity_validated_unproven", severity: "warning", autofix: "none", baselineable: false, title: "fidelity.validated is backed by ground truth on disk" },
  { id: "portability", severity: "warning", autofix: "none", baselineable: false, title: "no machine-local path leaks out of the squad" },
  { id: "routing_metadata_incomplete", severity: "warning", autofix: "agentic", baselineable: true, title: "keywords, example_briefs (≥3, EN and PT) and not_for declared" },
  { id: "requires_no_provider", severity: "warning", autofix: "none", baselineable: false, title: "every requires/consumes entry names a provider that exists" },
  { id: "agent_frontmatter_incomplete", severity: "warning", autofix: "mechanical", baselineable: false, title: "every agent declares frontmatter with maxTurns and tools", fixer: "agents_frontmatter_repair" },
  { id: "task_acceptance_missing", severity: "warning", autofix: "mechanical", baselineable: false, title: "every task declares acceptance criteria or outputs", fixer: "tasks_acceptance_criteria" },
  { id: "dependencies_missing", severity: "warning", autofix: "mechanical", baselineable: false, title: "dependencies are declared", fixer: "dependencies_synth" },
  { id: "readme_missing", severity: "warning", autofix: "mechanical", baselineable: false, title: "README.md present", fixer: "readme_scaffold" },
  { id: "not_for_dead", severity: "warning", autofix: "none", baselineable: true, title: "every not_for entry can fire against a real brief" },
  { id: "distribution_artifacts", severity: "warning", autofix: "none", baselineable: false, title: "no per-buyer distribution artifact inside the source" },
  { id: "protocol_below_6", severity: "warning", autofix: "none", baselineable: false, title: "protocol is 6.0" },
];

const BY_ID = new Map(criteria.map((c) => [c.id, c]));

function mk(id: string, message: string, evidence: string, where?: string, severity?: Severity): Finding {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`unknown squad criterion: ${id}`);
  return {
    id, severity: severity ?? c.severity, autofix: c.autofix, message, evidence,
    ...(where ? { where } : {}), baselined: false, ...(c.fixer ? { fixer: c.fixer } : {}),
  };
}

// ── measurements ────────────────────────────────────────────────────────────

const isMapping = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const manifestOf = (dir: string) => path.join(dir, "squad.yaml");

export interface SquadRead {
  manifest: Record<string, unknown> | null;
  parseError: string | null;
  protocol: string;
  capabilities: Array<Record<string, unknown>>;
  workflows: SquadWorkflow[];
  agents: Set<string>;
  tasks: Set<string>;
}

export function readSquad(dir: string): SquadRead {
  let manifest: Record<string, unknown> | null = null;
  let parseError: string | null = null;
  try {
    const doc = parseYaml(fs.readFileSync(manifestOf(dir), "utf8"));
    if (isMapping(doc)) manifest = doc;
    else parseError = `squad.yaml is not a YAML mapping (${Array.isArray(doc) ? "array" : typeof doc})`;
  } catch (e: any) {
    parseError = String(e?.message ?? e).split("\n")[0];
  }
  const capabilities = Array.isArray(manifest?.capabilities) ? (manifest!.capabilities as Array<Record<string, unknown>>).filter(isMapping) : [];
  return {
    manifest, parseError,
    protocol: String(manifest?.protocol ?? "").trim(),
    capabilities,
    workflows: readSquadWorkflows(dir),
    agents: componentStems(dir, "agents"),
    tasks: componentStems(dir, "tasks"),
  };
}

/** Stems every capability invokes as a workflow — what makes a workflow an orphan. */
function invokedStems(dir: string, capabilities: Array<Record<string, unknown>>): Set<string> {
  const out = new Set<string>();
  for (const cap of capabilities) {
    const invoke = cap.invoke;
    if (!isMapping(invoke) || invoke.type !== "workflow" || typeof invoke.ref !== "string") continue;
    const resolved = resolveWorkflowRef(dir, invoke.ref);
    out.add(stripWorkflowExt(path.basename(resolved ?? invoke.ref)).toLowerCase());
  }
  return out;
}

/** router.js `notForFires`, judged against the entity's own example_briefs. The
 *  CLI gate (`check-not-for-fires`) judges against the whole library; here the
 *  corpus is what the squad itself ships, so the verdict is per entity and the
 *  finding is baselineable. */
function deadFences(capabilities: Array<Record<string, unknown>>): string[] {
  const briefs: Array<{ lc: string; tokens: Set<string> }> = [];
  for (const c of capabilities) {
    for (const b of (Array.isArray(c.example_briefs) ? c.example_briefs : []) as unknown[]) {
      if (typeof b === "string") briefs.push({ lc: b.toLowerCase(), tokens: new Set(tokenize(b)) });
    }
  }
  const dead: string[] = [];
  for (const c of capabilities) {
    for (const nf of (Array.isArray(c.not_for) ? c.not_for : []) as unknown[]) {
      if (typeof nf !== "string") continue;
      if (nf.length <= NOT_FOR_MAX_CHARS) { if (nf.length <= 2) dead.push(nf); continue; }
      const tokens = [...new Set(tokenize(nf))];
      if (tokens.length < MIN_CONTENT_TOKENS) { dead.push(nf); continue; }
      const fires = briefs.some((b) => tokens.filter((t) => b.tokens.has(t)).length / tokens.length >= TOKEN_OVERLAP_MIN);
      if (!fires) dead.push(nf);
    }
  }
  return dead;
}

/** The router's tokenizer, minus its stopword table: enough for the overlap ratio. */
function tokenize(s: string): string[] {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter((t) => t.length > 2);
}

// ── check ───────────────────────────────────────────────────────────────────

export async function check(ctx: CheckContext): Promise<Finding[]> {
  const { dir } = ctx;
  const out: Finding[] = [];
  const squad = readSquad(dir);
  const v6 = squad.protocol === "6.0";
  /** Errors under 6.0, advice under 5.0 — see the header. */
  const byProtocol: "error" | "warning" = v6 ? "error" : "warning";

  if (squad.parseError) {
    out.push(mk("manifest_parse", "squad.yaml does not parse", squad.parseError));
    out.push(...surfaceFindings(dir, "squad", mk));
    return out;
  }
  const manifest = squad.manifest!;

  // ── S01: the schema of the declared protocol ──────────────────────────────
  const parsed = SquadManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);
    out.push(mk("manifest_schema", `squad.yaml violates the schema (${issues.length} issue${issues.length === 1 ? "" : "s"})`, issues.slice(0, 6).join(" · ")));
  }

  // ── S02: capabilities ─────────────────────────────────────────────────────
  const declaresCapabilities = squad.protocol === "5.0" || squad.protocol === "6.0";
  if (declaresCapabilities && squad.capabilities.length === 0) {
    out.push(mk("capabilities_missing", `protocol ${squad.protocol} without a single capability — invisible to routing and to dispatch`, "capabilities[]"));
  }
  const badOutputs: string[] = [];
  const missingExamples: string[] = [];
  const longFences: string[] = [];
  for (const cap of squad.capabilities) {
    const id = String(cap.id ?? "(unnamed)");
    if ("output" in cap && !Array.isArray(cap.outputs)) badOutputs.push(`${id}: singular \`output\``);
    for (const o of (Array.isArray(cap.outputs) ? cap.outputs : []) as unknown[]) {
      if (typeof o === "string") badOutputs.push(`${id}: outputs entry is a bare string`);
      else if (isMapping(o) && ("humanize" in o || "kind" in o)) badOutputs.push(`${id}: outputs entry carries ${"humanize" in o ? "`humanize`" : "`kind`"}`);
    }
    const examples = Array.isArray(cap.examples) ? (cap.examples as unknown[]) : [];
    if (examples.length === 0 || examples.some((e) => typeof e !== "string" || e.trim().length < 5)) missingExamples.push(id);
    for (const nf of (Array.isArray(cap.not_for) ? cap.not_for : []) as unknown[]) {
      if (typeof nf === "string" && nf.length > NOT_FOR_MAX_CHARS) longFences.push(`${id}: ${nf.slice(0, 40)}…`);
    }
  }
  if (badOutputs.length) out.push(mk("capability_outputs_shape", `${badOutputs.length} capability output declaration(s) the schema rejects`, badOutputs.slice(0, 4).join(" · ")));
  if (missingExamples.length) out.push(mk("capability_examples_missing", `${missingExamples.length} capabilit${missingExamples.length === 1 ? "y" : "ies"} without usable examples[]`, missingExamples.slice(0, 5).join(", ")));
  if (longFences.length) {
    out.push(mk("not_for_too_long", `${longFences.length} not_for entr${longFences.length === 1 ? "y is" : "ies are"} longer than ${NOT_FOR_MAX_CHARS} chars — above that BM25 needs 60% token overlap and the fence stops firing`,
      longFences.slice(0, 3).join(" · "), undefined, byProtocol));
  }

  // ── S03: invoke.ref ───────────────────────────────────────────────────────
  for (const cap of squad.capabilities) {
    const invoke = cap.invoke;
    if (!isMapping(invoke) || typeof invoke.ref !== "string") continue;
    const id = String(cap.id ?? "(unnamed)");
    const ref = invoke.ref;
    if (invoke.type === "workflow") {
      const resolved = resolveWorkflowRef(dir, ref);
      if (!resolved) out.push(mk("invoke_ref_unresolved", `capability \`${id}\` invokes a workflow that is not on disk`, ref, id));
      else if (v6 && /\.(ya?ml|md)$/i.test(ref)) out.push(mk("invoke_ref_extension", `capability \`${id}\` binds to the encoding, not the workflow (v6 §28.6)`, ref, id));
    } else if (invoke.type === "task" || invoke.type === "agent") {
      const sub = invoke.type === "task" ? "tasks" : "agents";
      const tries = [ref, `${ref}.md`, path.join(sub, ref), path.join(sub, `${ref}.md`)];
      if (!tries.some((t) => { try { return fs.statSync(path.join(dir, t)).isFile(); } catch { return false; } })) {
        out.push(mk("invoke_ref_unresolved", `capability \`${id}\` invokes a ${invoke.type} that is not on disk`, ref, id));
      }
    }
  }

  // ── S04: components ───────────────────────────────────────────────────────
  const components = isMapping(manifest.components) ? manifest.components : {};
  const missingComponents: string[] = [];
  const declaredWorkflowStems = new Set<string>();
  for (const [bucket, sub] of [["agents", "agents"], ["tasks", "tasks"], ["workflows", "workflows"], ["schemas", "schemas"]] as const) {
    for (const entry of (Array.isArray(components[bucket]) ? components[bucket] : []) as unknown[]) {
      if (typeof entry !== "string") continue;
      if (bucket === "workflows") {
        declaredWorkflowStems.add(stripWorkflowExt(path.basename(entry)).toLowerCase());
        if (!resolveWorkflowRef(dir, entry.includes("/") ? entry : path.join("workflows", entry))) missingComponents.push(`${bucket}: ${entry}`);
        continue;
      }
      const exts = bucket === "schemas" ? ["", ".json"] : ["", ".md"];
      const bases = entry.includes("/") ? [entry] : [path.join(sub, entry)];
      const found = bases.some((b) => exts.some((e) => { try { return fs.statSync(path.join(dir, b + e)).isFile(); } catch { return false; } }));
      if (!found) missingComponents.push(`${bucket}: ${entry}`);
    }
  }
  if (missingComponents.length) {
    out.push(mk("components_missing", `${missingComponents.length} declared component${missingComponents.length === 1 ? "" : "s"} not on disk`, missingComponents.slice(0, 5).join(" · ")));
  }

  // ── S05–S09 + W01/W02: one pass over the graphs ───────────────────────────
  const invoked = invokedStems(dir, squad.capabilities);
  for (const stem of declaredWorkflowStems) invoked.add(stem);
  const bodyMax = typeof LIMITS.workflow_body_words_max === "number" ? LIMITS.workflow_body_words_max : 2500;
  for (const w of squad.workflows) {
    if (!w.normalized) {
      out.push(mk("workflow_parse", `workflows/${w.file.file} does not parse as a workflow document`, w.raw.error ?? "unknown", w.file.file));
      continue;
    }
    const lint = lintWorkflow(w.normalized.canonical, {
      protocol: squad.protocol,
      file: w.file.file,
      stem: w.file.stem,
      twins: w.file.twins,
      agents: squad.agents,
      tasks: squad.tasks,
      dialects: w.normalized.dialects,
      unnormalizable: w.normalized.unnormalizable,
      inlineProse: w.normalized.inlineProse,
      bodyWords: bodyWordCount(w.raw.body),
      orphan: !invoked.has(w.file.stem),
      bodyWordsMax: bodyMax,
    });
    for (const f of lint) out.push(mk(f.id, f.message, f.evidence, f.where, f.severity));
  }

  // ── S10 / S11 ─────────────────────────────────────────────────────────────
  out.push(...surfaceFindings(dir, "squad", mk));
  for (const e of outputsLint.lintDir(dir).errors) out.push(mk("outputs_pollution", e, dir));

  // ── S12: per-buyer artifacts ──────────────────────────────────────────────
  const distribution: string[] = [];
  for (const f of DISTRIBUTION_FILES) { try { if (fs.statSync(path.join(dir, f)).isFile()) distribution.push(f); } catch { /* absent */ } }
  const marked = watermarkedFiles(dir);
  if (marked.length) distribution.push(`${marked.length} watermarked file(s): ${marked.slice(0, 2).join(", ")}`);
  if (distribution.length) {
    out.push(mk("distribution_artifacts", "per-buyer distribution artifacts are present — correct in an installed copy, never in a pack source", distribution.join(" · ")));
  }

  // ── S13: the evaluator contract ───────────────────────────────────────────
  for (const cap of squad.capabilities) {
    if (String(cap.id ?? "") !== "quality.specification_conformance") continue;
    if (!isMapping(cap.evaluator)) {
      out.push(mk("evaluator_missing", "the evaluator capability declares no `evaluator` block: the judge cannot know its scorecard or rubric", String(cap.id), undefined, byProtocol));
    }
  }

  // ── W03–W07, W12, W13 ─────────────────────────────────────────────────────
  out.push(...(await producesFindings(squad.capabilities)));
  for (const cap of squad.capabilities) {
    const fid = isMapping(cap.fidelity) ? cap.fidelity : null;
    if (fid?.status !== "validated") continue;
    const proof = [fid.ground_truth_dir, fid.eval_results].filter((p): p is string => typeof p === "string");
    const onDisk = proof.some((p) => fs.existsSync(path.isAbsolute(p) ? p : path.join(dir, p)));
    if (!onDisk) out.push(mk("fidelity_validated_unproven", `capability \`${String(cap.id)}\` claims fidelity validated with no ground truth on disk`, proof.join(", ") || "no ground_truth_dir / eval_results"));
  }
  for (const f of checkPortability(dir)) {
    if (f.severity !== "error" && f.severity !== "warn") continue;
    out.push(mk("portability", f.message, f.where ?? dir, f.where));
  }
  out.push(...routingMetadataFindings(squad.capabilities));
  out.push(...providerFindings(dir, squad.capabilities));

  const dead = deadFences(squad.capabilities);
  if (dead.length) out.push(mk("not_for_dead", `${dead.length} not_for entr${dead.length === 1 ? "y fires" : "ies fire"} against none of this squad's own example_briefs`, dead.slice(0, 3).map((d) => d.slice(0, 50)).join(" · ")));

  // ── W08–W11 ───────────────────────────────────────────────────────────────
  out.push(...componentQualityFindings(dir, squad));

  if (squad.protocol !== "6.0") {
    out.push(mk("protocol_below_6", `protocol ${squad.protocol || "(missing)"} — migrate with \`nrv migrate ${path.basename(dir)} --to 6\``, "squad.yaml#protocol"));
  }
  return out;
}

function watermarkedFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > 2 || out.length >= 5) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(r, depth + 1); continue; }
      if (!/\.(ts|js|md|markdown|ya?ml)$/i.test(e.name)) continue;
      try {
        const lines = fs.readFileSync(path.join(dir, r), "utf8").trimEnd().split("\n");
        if (WATERMARK_RE.test(lines[lines.length - 1]?.trim() ?? "")) out.push(r);
      } catch { /* unreadable */ }
      if (out.length >= 5) return;
    }
  };
  walk("", 0);
  return out;
}

/** W03: a `produces` slug reaches a rubric, or the capability types its outputs. */
async function producesFindings(capabilities: Array<Record<string, unknown>>): Promise<Finding[]> {
  let select: ((p: string[], hint?: string) => { rubrics: unknown[]; fallback_used: boolean }) | null = null;
  try {
    const mod = await import("../../../../harness/lib/rubric-selector.ts");
    select = mod.selectRubricsForProduces as any;
  } catch { return []; }
  const out: Finding[] = [];
  for (const cap of capabilities) {
    const produces = (Array.isArray(cap.produces) ? cap.produces : []).filter((p): p is string => typeof p === "string");
    if (produces.length === 0) continue;
    const typed = (Array.isArray(cap.outputs) ? cap.outputs : []).some((o) => isMapping(o) && (typeof o.schema === "string" || typeof o.format === "string"));
    if (typed) continue;
    let hit = false;
    try { hit = !select!(produces).fallback_used; } catch { hit = true; }
    if (!hit) {
      out.push(mk("produces_untyped", `capability \`${String(cap.id)}\` produces slugs no rubric covers and declares no outputs[].schema|format — the judge falls back to a generic rubric`,
        produces.slice(0, 4).join(", "), String(cap.id)));
    }
  }
  return out;
}

/** W06: the routing metadata contract, per capability. */
function routingMetadataFindings(capabilities: Array<Record<string, unknown>>): Finding[] {
  const out: Finding[] = [];
  for (const cap of capabilities) {
    const id = String(cap.id ?? "(unnamed)");
    const missing: string[] = [];
    if (!(Array.isArray(cap.keywords) && cap.keywords.length)) missing.push("keywords");
    const briefs = (Array.isArray(cap.example_briefs) ? cap.example_briefs : []).filter((b): b is string => typeof b === "string");
    if (briefs.length < 3) missing.push(`example_briefs (${briefs.length}/3)`);
    else {
      const langs = new Set(briefs.map(classify));
      if (!langs.has("en") || !langs.has("pt")) missing.push(`example_briefs in both EN and PT (found ${[...langs].sort().join("+") || "none"})`);
    }
    if (!(Array.isArray(cap.not_for) && cap.not_for.length)) missing.push("not_for");
    if (missing.length) out.push(mk("routing_metadata_incomplete", `capability \`${id}\` is missing routing metadata`, missing.join(" · "), id));
  }
  return out;
}

/** W07: `requires` / `consumes` with no provider in reach. */
function providerFindings(dir: string, capabilities: Array<Record<string, unknown>>): Finding[] {
  const own = new Set(capabilities.map((c) => String(c.id ?? "")));
  const produced = new Set<string>();
  for (const c of capabilities) for (const p of (Array.isArray(c.produces) ? c.produces : [])) if (typeof p === "string") produced.add(p);
  const out: Finding[] = [];
  const siblingCaps = (slug: string): Set<string> => {
    try {
      const doc = parseYaml(fs.readFileSync(path.join(path.dirname(dir), slug, "squad.yaml"), "utf8"));
      return new Set((isMapping(doc) && Array.isArray(doc.capabilities) ? doc.capabilities : []).map((c: any) => String(c?.id ?? "")));
    } catch { return new Set(); }
  };
  for (const cap of capabilities) {
    const id = String(cap.id ?? "(unnamed)");
    for (const entry of (Array.isArray(cap.requires) ? cap.requires : []) as unknown[]) {
      if (typeof entry !== "string") continue;
      const [maybeSlug, maybeId] = entry.includes(":") ? entry.split(":", 2) : [null, entry];
      const found = maybeSlug ? siblingCaps(maybeSlug).has(maybeId) : own.has(maybeId);
      if (!found) out.push(mk("requires_no_provider", `capability \`${id}\` requires \`${entry}\`, which no reachable squad provides`, entry, id));
    }
    for (const entry of (Array.isArray(cap.consumes) ? cap.consumes : []) as unknown[]) {
      if (typeof entry !== "string" || produced.has(entry)) continue;
      out.push(mk("requires_no_provider", `capability \`${id}\` consumes \`${entry}\`, which this squad does not produce`, entry, id));
    }
  }
  return out;
}

/** W08–W11: the component quality the audit scorer already measures. */
function componentQualityFindings(dir: string, squad: SquadRead): Finding[] {
  const out: Finding[] = [];
  const agentsDir = path.join(dir, "agents");
  const thin: string[] = [];
  for (const stem of squad.agents) {
    let text: string;
    try { text = fs.readFileSync(path.join(agentsDir, `${stem}.md`), "utf8"); } catch { continue; }
    const { frontmatter } = splitFrontmatter(text);
    if (frontmatter === null) thin.push(`${stem}: no frontmatter`);
    else if (!/^\s*maxTurns\s*:/m.test(frontmatter) || !/^\s*tools\s*:/m.test(frontmatter)) thin.push(`${stem}: no ${/^\s*maxTurns\s*:/m.test(frontmatter) ? "tools" : "maxTurns"}`);
  }
  if (thin.length) out.push(mk("agent_frontmatter_incomplete", `${thin.length} agent document(s) without complete frontmatter`, thin.slice(0, 4).join(" · ")));

  const tasksDir = path.join(dir, "tasks");
  const noAc: string[] = [];
  for (const stem of squad.tasks) {
    let text: string;
    try { text = fs.readFileSync(path.join(tasksDir, `${stem}.md`), "utf8"); } catch { continue; }
    const hasAc = /^##+\s+(Acceptance Criteria|Crit[ée]rios? de Aceita[çc][ãa]o|Success Criteria)/im.test(text)
      || /^outputs\s*:/m.test(text) || /^acceptance_criteria\s*:/m.test(text);
    if (!hasAc) noAc.push(stem);
  }
  if (noAc.length) out.push(mk("task_acceptance_missing", `${noAc.length} task document(s) declare no acceptance criteria or outputs`, noAc.slice(0, 5).join(", ")));

  if (!["dependencies.yaml", "package.json", "pyproject.toml", "requirements.txt"].some((f) => fs.existsSync(path.join(dir, f)))) {
    out.push(mk("dependencies_missing", "no dependency manifest — an installer cannot tell what this squad needs", "dependencies.yaml"));
  }
  if (!fs.existsSync(path.join(dir, "README.md"))) out.push(mk("readme_missing", "no README.md", "README.md"));
  return out;
}

// ── fixers ──────────────────────────────────────────────────────────────────

function trackedDigest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (rel: string) => {
    const full = path.join(dir, rel);
    let st: fs.Stats;
    try { st = fs.statSync(full); } catch { return; }
    if (st.isFile()) { try { out[rel] = String(Bun.hash(fs.readFileSync(full))); } catch { /* unreadable */ } return; }
    if (!st.isDirectory()) return;
    for (const name of (() => { try { return fs.readdirSync(full); } catch { return []; } })()) add(path.posix.join(rel, name));
  };
  for (const rel of TRACKED) add(rel);
  return out;
}

/** Runs `body`, then reports which tracked files it changed. */
function withDigest(dir: string, fixer: string, finding: Finding, body: () => string | void): FixResult {
  const before = trackedDigest(dir);
  const note = body() || undefined;
  const after = trackedDigest(dir);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]).sort();
  return { ...fixResult(fixer, finding, changed.length > 0, changed), ...(note ? { note } : {}) };
}

/** Delegates to the fixer library the audit scorer already uses. */
function delegate(kind: string): Fixer {
  return ({ dir, finding }) => withDigest(dir, kind, finding, () => {
    const r = mechanical.applyMechanicalFixes(dir, { patches: [{ kind }] })[0];
    if (r?.result && r.result.ok === false) return `mechanical fixer declined: ${r.result.reason ?? "no reason given"}`;
  });
}

/** S02: singular `output` → `outputs[]`, and the keys the strict schema rejects. */
const outputsShapeRepair: Fixer = ({ dir, finding }) => withDigest(dir, "outputs_shape_repair", finding, () => {
  editYaml(manifestOf(dir), (doc) => {
    const caps = doc.get("capabilities") as any;
    if (!caps || !Array.isArray(caps.items)) return false;
    let touched = false;
    caps.items.forEach((_: unknown, i: number) => {
      const singular = doc.getIn(["capabilities", i, "output"]);
      const outputs = doc.getIn(["capabilities", i, "outputs"], true) as any;
      if (singular !== undefined && !outputs) {
        const value = doc.getIn(["capabilities", i, "output"], true) as any;
        const asObject: Record<string, unknown> = typeof singular === "string" ? { type: singular } : { ...(value?.toJSON?.() ?? {}) };
        if ("kind" in asObject && !("type" in asObject)) asObject.type = asObject.kind;
        delete asObject.kind;
        delete asObject.humanize;
        doc.setIn(["capabilities", i, "outputs"], [asObject]);
        doc.deleteIn(["capabilities", i, "output"]);
        touched = true;
      }
      const list = doc.getIn(["capabilities", i, "outputs"], true) as any;
      if (!list || !Array.isArray(list.items)) return;
      list.items.forEach((entry: any, j: number) => {
        const plain = doc.getIn(["capabilities", i, "outputs", j]);
        if (typeof plain === "string") { doc.setIn(["capabilities", i, "outputs", j], { type: plain }); touched = true; return; }
        for (const dead of ["humanize", "kind"]) {
          if (doc.hasIn(["capabilities", i, "outputs", j, dead])) {
            if (dead === "kind" && !doc.hasIn(["capabilities", i, "outputs", j, "type"])) {
              doc.setIn(["capabilities", i, "outputs", j, "type"], doc.getIn(["capabilities", i, "outputs", j, "kind"]));
            }
            doc.deleteIn(["capabilities", i, "outputs", j, dead]);
            touched = true;
          }
        }
      });
    });
    return touched;
  });
});

/** S03: a v6 ref names the workflow, not its encoding. */
const invokeRefExtension: Fixer = ({ dir, finding }) => withDigest(dir, "invoke_ref_extension", finding, () => {
  editYaml(manifestOf(dir), (doc) => {
    let touched = false;
    const caps = doc.get("capabilities") as any;
    if (caps && Array.isArray(caps.items)) {
      caps.items.forEach((_: unknown, i: number) => {
        if (doc.getIn(["capabilities", i, "invoke", "type"]) !== "workflow") return;
        const ref = doc.getIn(["capabilities", i, "invoke", "ref"]);
        if (typeof ref !== "string" || !/\.(ya?ml|md)$/i.test(ref)) return;
        const stripped = stripWorkflowExt(ref);
        if (!resolveWorkflowRef(dir, stripped)) return;
        doc.setIn(["capabilities", i, "invoke", "ref"], stripped);
        touched = true;
      });
    }
    const wfs = doc.getIn(["components", "workflows"], true) as any;
    if (wfs && Array.isArray(wfs.items)) {
      wfs.items.forEach((_: unknown, i: number) => {
        const entry = doc.getIn(["components", "workflows", i]);
        if (typeof entry !== "string" || !/\.(ya?ml|md)$/i.test(entry)) return;
        const stripped = stripWorkflowExt(entry);
        if (!resolveWorkflowRef(dir, stripped.includes("/") ? stripped : path.join("workflows", stripped))) return;
        doc.setIn(["components", "workflows", i], stripped);
        touched = true;
      });
    }
    return touched;
  });
});

/**
 * S05: one stem, one file. Only when it is a merge and not a choice — the YAML
 * normalizes to a graph and the Markdown carries none. The Markdown keeps its
 * prose, the YAML's graph becomes its frontmatter, the YAML is removed. Any
 * other twin (both carry a graph, or the YAML does not normalize) is left for a
 * human: picking between two graphs is not mechanical.
 */
const twinMerge: Fixer = ({ dir, finding }) => {
  const stem = finding.where ? stripWorkflowExt(finding.where).toLowerCase() : "";
  return withDigest(dir, "twin_merge", finding, () => {
    const wfDir = path.join(dir, "workflows");
    const mdPath = ["md", "MD"].map((e) => path.join(wfDir, `${stem}.${e}`)).find((p) => fs.existsSync(p));
    const yamlPath = ["yaml", "yml"].map((e) => path.join(wfDir, `${stem}.${e}`)).find((p) => fs.existsSync(p));
    if (!mdPath || !yamlPath) return "no .md + .yaml pair on disk for this stem";
    const md = readWorkflow(mdPath);
    const yaml = readWorkflow(yamlPath);
    if (!yaml.doc) return "the .yaml does not parse: the merge would lose the graph";
    if (md.doc && Array.isArray((md.doc as any).steps) && (md.doc as any).steps.length) return "both files carry a graph: choosing between them is not mechanical";
    const normalized = normalizeWorkflow(yaml.doc, { stem });
    if (normalized.unnormalizable || normalized.canonical.steps.length === 0) return "the .yaml yields no step order: nothing to merge";
    const body = [md.body.trim(), renderProseBody(normalized).trim()].filter(Boolean).join("\n\n");
    fs.writeFileSync(mdPath, renderCanonicalMarkdown(normalized.canonical, body), "utf8");
    fs.rmSync(yamlPath);
    relinkWorkflowRefs(dir, stem, path.basename(yamlPath));
  });
};

/** A merged twin leaves the manifest pointing at a file that no longer exists.
 *  Every ref to the removed encoding loses its extension and resolves to the
 *  survivor — the same form v6 §28.6 asks for. */
function relinkWorkflowRefs(dir: string, stem: string, removedFile: string): void {
  editYaml(manifestOf(dir), (doc) => {
    let touched = false;
    const matches = (ref: unknown): ref is string =>
      typeof ref === "string" && path.basename(ref).toLowerCase() === removedFile.toLowerCase();
    const caps = doc.get("capabilities") as any;
    if (caps && Array.isArray(caps.items)) {
      caps.items.forEach((_: unknown, i: number) => {
        const ref = doc.getIn(["capabilities", i, "invoke", "ref"]);
        if (!matches(ref)) return;
        doc.setIn(["capabilities", i, "invoke", "ref"], `${path.posix.dirname(String(ref).split(path.sep).join("/"))}/${stem}`.replace(/^\.\//, ""));
        touched = true;
      });
    }
    const wfs = doc.getIn(["components", "workflows"], true) as any;
    if (wfs && Array.isArray(wfs.items)) {
      wfs.items.forEach((_: unknown, i: number) => {
        const entry = doc.getIn(["components", "workflows", i]);
        if (!matches(entry)) return;
        const parent = path.posix.dirname(String(entry).split(path.sep).join("/"));
        doc.setIn(["components", "workflows", i], parent === "." ? stem : `${parent}/${stem}`);
        touched = true;
      });
    }
    return touched;
  });
}

/** S06: prose out of `task: |`, into the body under `## <step.id>`, verbatim. */
const workflowInlineProseToBody: Fixer = ({ dir, finding }) => withDigest(dir, "workflow_inline_prose_to_body", finding, () => {
  const file = finding.where ? path.join(dir, "workflows", finding.where) : "";
  if (!file || !fs.existsSync(file)) return "workflow file not found";
  if (!/\.md$/i.test(file)) return "a YAML workflow keeps its encoding: `nrv migrate --to 6` moves the prose";
  const raw = readWorkflow(file);
  if (!raw.doc) return "the workflow does not parse";
  const normalized = normalizeWorkflow(raw.doc, { stem: raw.stem });
  if (normalized.inlineProse.length === 0) return "no inline prose left";
  const existing = raw.body.trim();
  const lifted = renderProseBody(normalized).trim();
  const body = [existing, lifted].filter(Boolean).join("\n\n");
  fs.writeFileSync(file, renderCanonicalMarkdown(normalized.canonical, body), "utf8");
});

/** S08: a `requires` that named an output becomes the step that creates it. */
const requiresByOutputName: Fixer = ({ dir, finding }) => withDigest(dir, "requires_by_output_name", finding, () => {
  const file = finding.where ? path.join(dir, "workflows", finding.where) : "";
  if (!file || !fs.existsSync(file)) return "workflow file not found";
  const raw = readWorkflow(file);
  if (!raw.doc) return "the workflow does not parse";
  const normalized = normalizeWorkflow(raw.doc, { stem: raw.stem });
  if (!normalized.dialects.includes("legacy-dialect:requires_by_output")) return "no `requires` entry names an output of another step";
  if (!/\.md$/i.test(file)) return "a YAML workflow keeps its encoding: `nrv migrate --to 6` rewrites the graph";
  fs.writeFileSync(file, renderCanonicalMarkdown(normalized.canonical, [raw.body.trim(), renderProseBody(normalized).trim()].filter(Boolean).join("\n\n")), "utf8");
});

/** S09: the graph in the canonical shape. Markdown only — turning a `.yaml`
 *  into a `.md` is a migration, with a backup and a report, not a fixer. */
const workflowNormalizeShape: Fixer = ({ dir, finding }) => withDigest(dir, "workflow_normalize_shape", finding, () => {
  const file = finding.where ? path.join(dir, "workflows", finding.where) : "";
  if (!file || !fs.existsSync(file)) return "workflow file not found";
  if (!/\.md$/i.test(file)) return "a YAML workflow keeps its encoding: `nrv migrate --to 6` rewrites the shape";
  const raw = readWorkflow(file);
  if (!raw.doc) return "the workflow does not parse";
  const normalized = normalizeWorkflow(raw.doc, { stem: raw.stem });
  if (normalized.unnormalizable) return "`event_routes` yields no step order: `nrv migrate --to 6 --force` decides what to do";
  fs.writeFileSync(file, renderCanonicalMarkdown(normalized.canonical, [raw.body.trim(), renderProseBody(normalized).trim()].filter(Boolean).join("\n\n")), "utf8");
});

/**
 * S07: a step reference repaired by RENAME, never by a stub. When exactly one
 * component matches case-insensitively or with `_` and `-` swapped, the step is
 * rewritten to it (the enterprise-dashboard case: `snake_case` steps against
 * `kebab-case` files). A reference nothing matches stays a finding — the gate
 * does not write the squad's method.
 */
const workflowRefsRepair: Fixer = ({ dir, finding }) => withDigest(dir, "workflow_refs_repair", finding, () => {
  const file = finding.where ? path.join(dir, "workflows", finding.where) : "";
  if (!file || !fs.existsSync(file)) return "workflow file not found";
  const agents = componentStems(dir, "agents");
  const tasks = componentStems(dir, "tasks");
  const index = (set: Set<string>) => {
    const m = new Map<string, string[]>();
    for (const s of set) {
      const key = s.toLowerCase().replace(/_/g, "-");
      m.set(key, [...(m.get(key) ?? []), s]);
    }
    return m;
  };
  const byKey = { agent: index(agents), task: index(tasks) };
  const known = { agent: agents, task: tasks };
  let renamed = 0;
  const text = fs.readFileSync(file, "utf8");
  const rewritten = text.replace(/^(\s*-?\s*)(agent|task)(:\s*["']?)([\w./-]+)(["']?\s*)$/gim, (whole, lead, key, sep, value, tail) => {
    const kind = key as "agent" | "task";
    // The directory and the extension are how the path is written; the step
    // names the component. Strip both before matching, and write the bare stem
    // back — §28.6's canonical form, and the fixed point of a second `--fix`.
    const bare = value.replace(/^(?:agents|tasks)\//i, "").replace(/\.(md|markdown)$/i, "");
    if (known[kind].has(bare)) return whole;
    const candidates = byKey[kind].get(bare.toLowerCase().replace(/_/g, "-")) ?? [];
    if (candidates.length !== 1) return whole;
    renamed++;
    return `${lead}${key}${sep}${candidates[0]}${tail}`;
  });
  if (renamed === 0) return "no reference matches a single component by case or separator: nothing renamed, nothing stubbed";
  fs.writeFileSync(file, rewritten, "utf8");
});

export const squadModule: KindModule = {
  kind: "squad",
  manifestFile: "squad.yaml",
  resolveDir: (target) => resolveEntityDir("squad", target),
  listAll: (roots) => listEntities("squad", roots),
  criteria,
  check,
  fixers: {
    outputs_shape_repair: outputsShapeRepair,
    caps_examples_not_for: delegate("caps_examples_not_for"),
    invoke_ref_extension: invokeRefExtension,
    components_files_stub: delegate("components_files_stub"),
    twin_merge: twinMerge,
    workflow_inline_prose_to_body: workflowInlineProseToBody,
    workflow_refs_repair: workflowRefsRepair,
    requires_by_output_name: requiresByOutputName,
    workflow_normalize_shape: workflowNormalizeShape,
    agents_frontmatter_repair: delegate("agents_frontmatter_repair"),
    tasks_acceptance_criteria: delegate("tasks_acceptance_criteria"),
    dependencies_synth: delegate("dependencies_synth"),
    readme_scaffold: delegate("readme_scaffold"),
    surface_regen: surfaceRegenFixer("squad"),
  },
  // Structure first, then the manifest, then the files, then the surface: a
  // fixer that rewrote the manifest must not run after the surface was frozen.
  fixOrder: [
    "outputs_shape_repair", "caps_examples_not_for", "invoke_ref_extension", "components_files_stub",
    "twin_merge", "workflow_refs_repair", "requires_by_output_name", "workflow_inline_prose_to_body", "workflow_normalize_shape",
    "agents_frontmatter_repair", "tasks_acceptance_criteria", "dependencies_synth", "readme_scaffold",
    "surface_regen",
  ],
};

export { WORKFLOW_LINT_IDS };
