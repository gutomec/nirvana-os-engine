/**
 * workflow-reader.ts — one canonical graph for every workflow the library holds.
 *
 * A squad's workflow is the only artifact of the protocol with no single shape.
 * Measured on the installed library (204 squads, 619 workflow files, 2026-08-26):
 * `steps[]` 51.5%, `workflow:` + `sequence[]` 26.8%, `agent_sequence[]` 16.6%,
 * plus `flow.steps`, `flow.phases`, bare `sequence[]`, `pipeline.steps`,
 * `event_routes` and three Markdown files. Only 40% express a dependency at
 * all. Every reader in the engine — validator, auditor, fixer, surface, body
 * index — re-derived its own subset of those shapes, and each one derived a
 * different subset.
 *
 * This module is the single derivation. `readWorkflow` accepts both encodings
 * (v5 YAML, v6 Markdown = frontmatter graph + prose body), `normalizeWorkflow`
 * maps every legacy dialect onto the canonical `steps[]` shape of Squad
 * Protocol 6.0 §28.1, and `lintWorkflow` names what is broken.
 *
 * Two rules make the normalization safe to run over content nobody has read:
 *
 *   1. **Nothing is dropped.** An unknown top-level key lands in `extensions`,
 *      an unknown step key lands in `step.meta`. A dialect round-trips through
 *      `normalizeWorkflow` → `renderCanonicalMarkdown` without losing a field.
 *   2. **Nothing is invented.** Prose that lived in `task: |` or `action:` is
 *      moved to the body under `## <step.id>`, verbatim. The reader never
 *      writes a sentence, and never fabricates a missing reference — a `task:`
 *      that points at no file becomes a finding, never a stub.
 *
 * Severity is decided by the manifest's protocol, not by the shape: what is an
 * error under `protocol: "6.0"` is a warning under `"5.0"`, so the 204 installed
 * squads keep validating exactly as they do today while a v6 squad enters
 * clean. The body ceiling and the orphan workflow are advice under either
 * protocol, and an `event_routes` document is not a finding against the squad
 * at all: it is a router, and a router has no step order to withhold.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { planDag } from "../../harness/lib/dag-planner.ts";
import { LIMITS } from "../../_shared/validators/limits.ts";

/** Workflow encodings, in precedence order: the `.md` wins a stem collision
 *  (the same order `surface.ts` uses to key a workflow entry). */
export const WORKFLOW_EXTS = [".md", ".yaml", ".yml"] as const;
const WORKFLOW_EXT_RE = /\.(ya?ml|md)$/i;
const COMPONENT_EXT_RE = /\.(ya?ml|md|markdown)$/i;

/** The component directory an author writes into a step reference. */
const COMPONENT_DIR_RE = /^(?:agents|tasks)\//i;

/** `^[a-z][a-z0-9_-]*$` — the canonical form of a workflow name and a step id. */
export const CANONICAL_ID = /^[a-z][a-z0-9_-]*$/;

/** A `task:` value that is a reference and not a paragraph. */
const REF_SHAPED = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;

/** Step keys with a canonical home; everything else goes to `step.meta`. */
const STEP_CONSUMED = new Set([
  "id", "step_id", "step", "name", "agent", "owner", "role", "task", "action", "prompt",
  "requires", "depends_on", "deps", "after", "creates", "outputs", "output",
  "on_failure", "on_fail", "parallel_safe", "meta",
]);

/** Top-level keys with a canonical home; everything else goes to `extensions`. */
const TOP_CONSUMED = new Set([
  "name", "workflow_name", "description", "version",
  "steps", "flow", "pipeline", "phases", "stages", "sequence", "agent_sequence", "workflow",
  "success_indicators", "success_criteria", "on_failure", "on_fail", "event_routes", "extensions",
]);

/** Agent placeholders the la-bottega Markdown workflows use for "whoever fits". */
const AGENT_PLACEHOLDERS = new Set(["all-as-needed", "all", "as-needed", "any"]);

// ── file discovery ──────────────────────────────────────────────────────────

export interface WorkflowFile {
  /** Lowercased file stem — the identity a capability binds to. */
  stem: string;
  /** File name that wins the stem (`.md` first, then `.yaml`, then `.yml`). */
  file: string;
  path: string;
  /** Other files sharing this stem, in the same precedence order. */
  twins: string[];
}

function workflowRank(file: string): number {
  const i = WORKFLOW_EXTS.findIndex((e) => file.toLowerCase().endsWith(e));
  return i === -1 ? WORKFLOW_EXTS.length : i;
}

export function stripWorkflowExt(name: string): string {
  return name.replace(WORKFLOW_EXT_RE, "");
}

function safeReaddir(dir: string): string[] {
  try { return fs.readdirSync(dir).filter((n) => !n.startsWith(".")); } catch { return []; }
}

/**
 * Every workflow of a squad, deduped by lowercased stem. The scope is the
 * first level of `workflows/` — the nested `<squad>/<sub>/workflows/` trees a
 * few squads carry are not part of the protocol surface.
 */
export function listWorkflowFiles(squadDir: string): WorkflowFile[] {
  const dir = path.join(squadDir, "workflows");
  const byStem = new Map<string, string[]>();
  for (const f of safeReaddir(dir)) {
    if (!WORKFLOW_EXT_RE.test(f)) continue;
    try { if (!fs.statSync(path.join(dir, f)).isFile()) continue; } catch { continue; }
    const stem = stripWorkflowExt(f).toLowerCase();
    byStem.set(stem, [...(byStem.get(stem) ?? []), f]);
  }
  const out: WorkflowFile[] = [];
  for (const [stem, files] of byStem) {
    const ranked = [...files].sort((a, b) => workflowRank(a) - workflowRank(b) || a.localeCompare(b));
    out.push({ stem, file: ranked[0], path: path.join(dir, ranked[0]), twins: ranked.slice(1) });
  }
  return out.sort((a, b) => a.stem.localeCompare(b.stem));
}

/**
 * A workflow reference → the file it names. Tried in order: the ref verbatim,
 * the ref plus each encoding, then the same two under `workflows/`. Mirrors
 * `body-index.js resolveRefPath` so the index and the gate never disagree
 * about which file a capability invokes.
 */
export function resolveWorkflowRef(squadDir: string, ref: string): string | null {
  if (typeof ref !== "string" || !ref.trim()) return null;
  const cleaned = ref.trim();
  const bases = [cleaned];
  if (!cleaned.includes("/") && !cleaned.includes("\\")) bases.push(path.join("workflows", cleaned));
  for (const base of bases) {
    for (const ext of ["", ...WORKFLOW_EXTS]) {
      const p = path.join(squadDir, base + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* next candidate */ }
    }
  }
  return null;
}

// ── reading ─────────────────────────────────────────────────────────────────

export interface RawWorkflow {
  path: string;
  file: string;
  stem: string;
  format: "yaml" | "frontmatter";
  /** The graph: the whole document for YAML, the frontmatter for Markdown. */
  doc: Record<string, unknown> | null;
  /** The prose body — empty for YAML, everything after the frontmatter for Markdown. */
  body: string;
  error: string | null;
}

/** BOM- and CRLF-tolerant, the same frontmatter split `asset-meta.js` uses. */
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const m = FRONTMATTER.exec(text);
  return m ? { frontmatter: m[1], body: m[2] } : { frontmatter: null, body: text };
}

export function readWorkflow(file: string): RawWorkflow {
  const base = path.basename(file);
  const out: RawWorkflow = {
    path: file, file: base, stem: stripWorkflowExt(base).toLowerCase(),
    format: /\.md$/i.test(base) ? "frontmatter" : "yaml",
    doc: null, body: "", error: null,
  };
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e: any) { out.error = `unreadable: ${String(e?.message ?? e)}`; return out; }

  let graph = text;
  if (out.format === "frontmatter") {
    const { frontmatter, body } = splitFrontmatter(text);
    if (frontmatter === null) { out.error = "no frontmatter block — a Markdown workflow opens with `---`"; out.body = text; return out; }
    graph = frontmatter;
    out.body = body;
  } else if (text.charCodeAt(0) === 0xFEFF) {
    graph = text.slice(1);
  }
  try {
    const doc = parseYaml(graph);
    if (doc === null || doc === undefined) { out.error = "empty document"; return out; }
    if (typeof doc !== "object" || Array.isArray(doc)) { out.error = `not a mapping (${Array.isArray(doc) ? "array" : typeof doc})`; return out; }
    out.doc = doc as Record<string, unknown>;
  } catch (e: any) {
    out.error = String(e?.message ?? e).split("\n")[0];
  }
  return out;
}

// ── the canonical shape ─────────────────────────────────────────────────────

export interface CanonicalStep {
  id: string;
  agent: string;
  task?: string;
  requires: string[];
  creates: string[];
  on_failure?: string;
  parallel_safe?: boolean;
  /** Legacy step keys, preserved verbatim: `validation`, `inputs`, `phase`, `gates`… */
  meta: Record<string, unknown>;
}

export interface CanonicalWorkflow {
  name: string;
  description?: string;
  version?: string;
  steps: CanonicalStep[];
  success_indicators?: string[];
  on_failure?: string;
  /** Legacy top-level keys, preserved verbatim: `harness`, `retry_policy`, `triggers`… */
  extensions: Record<string, unknown>;
}

export interface NormalizeResult {
  canonical: CanonicalWorkflow;
  /** `legacy-dialect:<name>` per shape matched, in match order. */
  dialects: string[];
  /** Step id → prose lifted out of `task: |` / `action:`, verbatim. */
  prose: Record<string, string>;
  /** Ids of the steps that carried inline prose (what the `task: |` lint reads). */
  inlineProse: string[];
  /** `event_routes`: a router, not a DAG. Reported, never guessed at. */
  unnormalizable: boolean;
  notes: string[];
}

const isMapping = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function slugify(s: string): string {
  return String(s).trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "step";
}

function isRefShaped(v: unknown): v is string {
  return typeof v === "string" && !v.includes("\n") && REF_SHAPED.test(v.trim());
}

function stringList(v: unknown): string[] | null {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (!Array.isArray(v)) return null;
  return v.every((x) => typeof x === "string") ? (v as string[]).map((x) => x.trim()).filter(Boolean) : null;
}

function pushUnique(into: string[], values: string[]): void {
  for (const v of values) if (!into.includes(v)) into.push(v);
}

interface StepDraft { step: CanonicalStep; index: number; }

/** One raw step (mapping, or a bare agent name) → one canonical step. */
function normalizeStep(raw: unknown, index: number, out: NormalizeResult): CanonicalStep {
  const src: Record<string, unknown> = isMapping(raw) ? { ...raw } : {};
  if (typeof raw === "string") src.agent = raw;

  const agentRaw = src.agent ?? src.owner ?? src.role;
  const agent = typeof agentRaw === "string" ? agentRaw.trim() : "";

  const idRaw = src.id ?? src.step_id ?? src.name ?? (typeof src.step === "string" ? src.step : undefined);
  const id = slugify(typeof idRaw === "string" && idRaw.trim() ? idRaw : (agent || `step-${index + 1}`));

  const step: CanonicalStep = { id, agent, requires: [], creates: [], meta: {} };

  // task: a reference, never a paragraph. Prose moves to the body verbatim.
  const proseParts: string[] = [];
  if (typeof src.task === "string") {
    if (isRefShaped(src.task)) step.task = componentStem(src.task.trim());
    else { proseParts.push(src.task); out.inlineProse.push(id); }
  } else if (src.task !== undefined) {
    step.meta.task = src.task;
  }
  for (const key of ["action", "prompt"] as const) {
    const v = src[key];
    if (typeof v === "string" && v.trim()) {
      if (key === "action" && isRefShaped(v) && !step.task) { step.task = componentStem(v.trim()); continue; }
      proseParts.push(v);
      if (v.includes("\n")) out.inlineProse.push(id);
    } else if (v !== undefined) {
      step.meta[key] = v;
    }
  }
  if (proseParts.length) out.prose[id] = (out.prose[id] ? out.prose[id] + "\n\n" : "") + proseParts.join("\n\n").trim();

  for (const key of ["requires", "depends_on", "deps", "after"] as const) {
    const list = stringList(src[key]);
    if (list) pushUnique(step.requires, list);
    else if (src[key] !== undefined) step.meta[key] = src[key];
  }
  for (const key of ["creates", "outputs", "output"] as const) {
    const list = stringList(src[key]);
    if (list) pushUnique(step.creates, list);
    else if (src[key] !== undefined) step.meta[key] = src[key];
  }
  const onFailure = src.on_failure ?? src.on_fail;
  if (typeof onFailure === "string" && onFailure.trim()) step.on_failure = onFailure.trim();
  else if (onFailure !== undefined) step.meta.on_failure = onFailure;
  if (typeof src.parallel_safe === "boolean") step.parallel_safe = src.parallel_safe;

  // A canonical step re-read: its own `meta` merges in, so normalizing twice is
  // the same as normalizing once (what makes `--fix` idempotent).
  if (isMapping(src.meta)) for (const [k, v] of Object.entries(src.meta)) step.meta[k] = v;
  for (const [k, v] of Object.entries(src)) if (!STEP_CONSUMED.has(k)) step.meta[k] = v;
  return step;
}

/**
 * A component reference → the stem the graph names.
 *
 * The directory and the encoding are how an author writes a path; the step
 * names the component, the same way §28.6 has a capability name the workflow
 * and not its file. The executor already reads a reference this way —
 * `squad-exec.ts` strips `^(agents|tasks)/` and the extension before loading
 * the document — so a lint that compared the raw value against the stems on
 * disk reported a file it could open as missing. Nine workflows of brandcraft
 * wrote `task: tasks/inspect-quality.md`, every file present, and the gate
 * called thirteen references dangling.
 *
 * Accepting the written form is not making it canonical: `workflow_refs_repair`
 * still writes the bare stem back whenever it renames.
 */
function componentStem(s: string): string {
  return s.replace(COMPONENT_DIR_RE, "").replace(COMPONENT_EXT_RE, "");
}

/**
 * Every legacy dialect measured in the library, onto one shape.
 *
 * The dialect names are the ones the lint reports (`legacy-dialect:<name>`) and
 * the ones `nrv migrate` will name in its report, so they are part of the
 * contract, not an implementation detail.
 */
export function normalizeWorkflow(doc: unknown, opts: { stem?: string } = {}): NormalizeResult {
  const out: NormalizeResult = {
    canonical: { name: opts.stem ?? "", steps: [], extensions: {} },
    dialects: [], prose: {}, inlineProse: [], unnormalizable: false, notes: [],
  };
  const dialect = (name: string) => { const t = `legacy-dialect:${name}`; if (!out.dialects.includes(t)) out.dialects.push(t); };

  if (!isMapping(doc)) {
    out.notes.push(`workflow document is not a mapping (${Array.isArray(doc) ? "array" : typeof doc})`);
    return out;
  }
  const top: Record<string, unknown> = { ...doc };
  const ext = out.canonical.extensions;

  // ── the `workflow:` key wears three hats in the library ────────────────────
  let agentsList: unknown[] | null = null;
  let headerPresent = false;
  let stepsFromWorkflowKey: unknown[] | null = null;
  if (isMapping(top.workflow)) {
    const w: Record<string, unknown> = { ...top.workflow };
    if (Array.isArray(w.agents)) { agentsList = w.agents; delete w.agents; dialect("workflow_agents"); }
    if (typeof w.command === "string") { ext.command = w.command; delete w.command; }
    if (Array.isArray(w.steps)) { stepsFromWorkflowKey = w.steps; delete w.steps; }
    for (const [k, v] of Object.entries(w)) {
      if (TOP_CONSUMED.has(k)) { if (top[k] === undefined) top[k] = v; }
      else ext[k] = v;
    }
    headerPresent = true;
    delete top.workflow;
  } else if (Array.isArray(top.workflow)) {
    stepsFromWorkflowKey = top.workflow;
    dialect("workflow_steps");
    delete top.workflow;
  }

  // ── top-level names ───────────────────────────────────────────────────────
  if (typeof top.workflow_name === "string" && !top.name) { top.name = top.workflow_name; dialect("workflow_name"); }
  out.canonical.name = typeof top.name === "string" && top.name.trim() ? top.name.trim() : (opts.stem ?? "");
  if (typeof top.description === "string") out.canonical.description = top.description;
  if (top.version !== undefined) out.canonical.version = String(top.version);

  const indicators = stringList(top.success_indicators) ?? stringList(top.success_criteria);
  if (indicators && indicators.length) out.canonical.success_indicators = indicators;
  else if (top.success_indicators !== undefined) ext.success_indicators = top.success_indicators;
  else if (top.success_criteria !== undefined) ext.success_criteria = top.success_criteria;
  if (top.success_criteria !== undefined && top.success_indicators === undefined) dialect("success_criteria");

  const wfOnFailure = top.on_failure ?? top.on_fail;
  if (typeof wfOnFailure === "string" && wfOnFailure.trim()) out.canonical.on_failure = wfOnFailure.trim();
  else if (wfOnFailure !== undefined) ext.on_failure = wfOnFailure;
  if (top.on_fail !== undefined && top.on_failure === undefined) dialect("on_fail");

  // ── the graph ─────────────────────────────────────────────────────────────
  const flow = isMapping(top.flow) ? top.flow : null;
  const pipeline = isMapping(top.pipeline) ? top.pipeline : null;
  if (flow && typeof flow.type === "string") ext.flow_type = flow.type;

  let rawSteps: unknown[] | null = null;
  let phaseGroups: Array<{ label: string; steps: unknown[] }> | null = null;

  if (Array.isArray(top.steps)) {
    rawSteps = top.steps;
    if (top.steps.some((s) => isMapping(s) && ("depends_on" in s || "deps" in s || "after" in s))) dialect("steps_depends_on");
  } else if (flow && Array.isArray(flow.steps)) {
    rawSteps = flow.steps; dialect("flow_steps");
  } else if (pipeline && Array.isArray(pipeline.steps)) {
    rawSteps = pipeline.steps; dialect("pipeline_steps");
  } else if (flow && Array.isArray(flow.phases)) {
    phaseGroups = groupPhases(flow.phases); dialect("flow_phases");
  } else if (Array.isArray(top.phases)) {
    phaseGroups = groupPhases(top.phases); dialect("phases");
  } else if (Array.isArray(top.stages)) {
    phaseGroups = groupPhases(top.stages); dialect("stages");
  } else if (Array.isArray(top.sequence)) {
    rawSteps = top.sequence; dialect(headerPresent ? "workflow_sequence" : "sequence");
  } else if (Array.isArray(top.agent_sequence)) {
    rawSteps = top.agent_sequence.map((a) => (isMapping(a) ? a : { agent: a }));
    dialect("agent_sequence");
  } else if (agentsList) {
    rawSteps = agentsList.filter((a) => !(typeof a === "string" && AGENT_PLACEHOLDERS.has(a.trim().toLowerCase())))
      .map((a) => (isMapping(a) ? a : { agent: a }));
    if (agentsList.length !== rawSteps.length) out.notes.push("dropped the `all-as-needed` agent placeholder: it names no step");
  } else if (stepsFromWorkflowKey) {
    rawSteps = stepsFromWorkflowKey;
  } else if (top.event_routes !== undefined) {
    out.unnormalizable = true;
    out.notes.push("`event_routes` is a router, not a DAG: no step order can be derived from it");
    ext.event_routes = top.event_routes;
    dialect("event_routes");
  }

  // Every dialect whose steps carry no dependency at all becomes a chain: the
  // author wrote a sequence, and a sequence is a DAG with one edge per step.
  const linear = out.dialects.some((d) => d.endsWith(":agent_sequence") || d.endsWith(":workflow_agents") || d.endsWith(":sequence") || d.endsWith(":workflow_sequence"));

  const drafts: StepDraft[] = [];
  if (phaseGroups) {
    let previousLayer: string[] = [];
    for (const group of phaseGroups) {
      const layer: string[] = [];
      for (const raw of group.steps) {
        const step = normalizeStep(raw, drafts.length, out);
        if (group.label) step.meta.phase = group.label;
        if (step.requires.length === 0) pushUnique(step.requires, previousLayer);
        drafts.push({ step, index: drafts.length });
        layer.push(step.id);
      }
      if (layer.length) previousLayer = layer;
    }
  } else if (rawSteps) {
    for (const raw of rawSteps) {
      const step = normalizeStep(raw, drafts.length, out);
      if (linear && step.requires.length === 0 && drafts.length > 0) step.requires.push(drafts[drafts.length - 1].step.id);
      drafts.push({ step, index: drafts.length });
    }
  }

  // Disambiguate ids the dialects collide on (two steps of the same agent).
  const seen = new Map<string, number>();
  for (const d of drafts) {
    const n = seen.get(d.step.id) ?? 0;
    seen.set(d.step.id, n + 1);
    if (n > 0 && (linear || phaseGroups)) {
      const renamed = `${d.step.id}-${n + 1}`;
      for (const other of drafts) {
        const i = other.step.requires.indexOf(d.step.id);
        if (i !== -1 && other.index > d.index) other.step.requires[i] = renamed;
      }
      d.step.id = renamed;
    }
  }

  out.canonical.steps = drafts.map((d) => d.step);

  // `depends_on` naming another step's OUTPUT instead of its id (la-bottega):
  // remapped when exactly one step creates it, reported when ambiguous.
  const ids = new Set(out.canonical.steps.map((s) => s.id));
  const byCreation = new Map<string, string[]>();
  for (const s of out.canonical.steps) {
    for (const c of s.creates) {
      const key = c.trim();
      byCreation.set(key, [...(byCreation.get(key) ?? []), s.id]);
    }
  }
  for (const s of out.canonical.steps) {
    s.requires = s.requires.map((r) => {
      if (ids.has(r)) return r;
      const owners = byCreation.get(r) ?? byCreation.get(r.trim()) ?? [];
      const distinct = [...new Set(owners.filter((o) => o !== s.id))];
      if (distinct.length === 1) { dialect("requires_by_output"); return distinct[0]; }
      return r;
    });
  }

  // Everything else keeps its bytes. A canonical document re-read merges its
  // own `extensions` back in place, so normalization is idempotent.
  if (isMapping(top.extensions)) for (const [k, v] of Object.entries(top.extensions)) ext[k] = v;
  for (const [k, v] of Object.entries(top)) {
    if (TOP_CONSUMED.has(k)) continue;
    ext[k] = v;
  }
  if (flow) for (const [k, v] of Object.entries(flow)) if (k !== "steps" && k !== "phases" && k !== "type") ext[k] = v;
  if (pipeline) for (const [k, v] of Object.entries(pipeline)) if (k !== "steps") ext[k] = v;
  if (isMapping(top.workflow)) { /* already consumed above */ }

  out.inlineProse = [...new Set(out.inlineProse)];
  return out;
}

function groupPhases(phases: unknown[]): Array<{ label: string; steps: unknown[] }> {
  const out: Array<{ label: string; steps: unknown[] }> = [];
  phases.forEach((p, i) => {
    if (!isMapping(p)) { out.push({ label: `phase-${i + 1}`, steps: [p] }); return; }
    const label = String(p.phase ?? p.name ?? p.id ?? `phase-${i + 1}`);
    if (Array.isArray(p.steps)) out.push({ label, steps: p.steps });
    else if (Array.isArray(p.tasks)) out.push({ label, steps: p.tasks });
    else out.push({ label, steps: [p] });
  });
  return out;
}

// ── components a workflow references ────────────────────────────────────────

export function referencedComponents(canonical: CanonicalWorkflow): { agents: string[]; tasks: string[] } {
  const agents: string[] = [];
  const tasks: string[] = [];
  for (const s of canonical.steps) {
    if (s.agent && !agents.includes(s.agent)) agents.push(s.agent);
    if (s.task && !tasks.includes(s.task)) tasks.push(s.task);
  }
  return { agents, tasks };
}

// ── rendering ───────────────────────────────────────────────────────────────

/** The canonical document as `nrv migrate` will write it: frontmatter graph,
 *  prose body. Empty collections are omitted so a clean graph stays short. */
export function renderCanonicalMarkdown(canonical: CanonicalWorkflow, body = ""): string {
  const graph: Record<string, unknown> = { name: canonical.name };
  if (canonical.description) graph.description = canonical.description;
  if (canonical.version) graph.version = canonical.version;
  graph.steps = canonical.steps.map((s) => {
    const o: Record<string, unknown> = { id: s.id, agent: s.agent };
    if (s.task) o.task = s.task;
    if (s.requires.length) o.requires = s.requires;
    if (s.creates.length) o.creates = s.creates;
    if (s.on_failure) o.on_failure = s.on_failure;
    if (s.parallel_safe !== undefined) o.parallel_safe = s.parallel_safe;
    if (Object.keys(s.meta).length) o.meta = s.meta;
    return o;
  });
  if (canonical.success_indicators?.length) graph.success_indicators = canonical.success_indicators;
  if (canonical.on_failure) graph.on_failure = canonical.on_failure;
  if (Object.keys(canonical.extensions).length) graph.extensions = canonical.extensions;
  const front = stringifyYaml(graph, { lineWidth: 0 });
  const prose = body.trim();
  return `---\n${front}---\n${prose ? `\n${prose}\n` : ""}`;
}

/** The body a migration would write from the prose lifted out of the graph. */
export function renderProseBody(result: NormalizeResult): string {
  const parts: string[] = [];
  for (const s of result.canonical.steps) {
    const text = result.prose[s.id];
    if (text?.trim()) parts.push(`## ${s.id}\n\n${text.trim()}\n`);
  }
  return parts.join("\n");
}

// ── lint ────────────────────────────────────────────────────────────────────

export type LintSeverity = "error" | "warning" | "info";

export interface LintFinding {
  id: string;
  severity: LintSeverity;
  message: string;
  evidence: string;
  /** The workflow file the finding belongs to. */
  where: string;
}

export interface LintContext {
  /** `squad.yaml`'s `protocol`. Decides severity for everything but the three
   *  advisory rules in `ALWAYS_WARNING`. */
  protocol: string;
  file: string;
  stem: string;
  /** Other files sharing this stem. */
  twins: string[];
  /** Agent stems on disk (`agents/*.md`). Empty means "cannot check". */
  agents: Set<string>;
  /** Task stems on disk (`tasks/*.md`). Empty means "cannot check". */
  tasks: Set<string>;
  dialects: string[];
  unnormalizable: boolean;
  inlineProse: string[];
  /** Words of prose in the Markdown body. */
  bodyWords: number;
  /** No capability invokes this workflow. */
  orphan: boolean;
  bodyWordsMax?: number;
}

export const WORKFLOW_LINT_IDS = [
  "workflow_inline_prose",
  "workflow_ref_unresolved",
  "workflow_twin",
  "workflow_step_id_duplicate",
  "workflow_dangling_requires",
  "workflow_requires_by_output",
  "workflow_cycle",
  "workflow_shape_legacy",
  "workflow_stem_case",
  "workflow_event_router",
  "workflow_body_too_long",
  "workflow_orphan",
] as const;
export type WorkflowLintId = (typeof WORKFLOW_LINT_IDS)[number];

/** Advice under either protocol: a long body and an unused workflow are facts
 *  about authorship, not about the contract. */
const ALWAYS_WARNING = new Set<string>(["workflow_body_too_long", "workflow_orphan"]);

/**
 * Never counted, under any protocol. A document that declares `event_routes`
 * is a router: each route names a channel, a condition and its own chain, and
 * the routes arrive independently. There is no order between them to derive,
 * so deriving none is the correct reading of a correct file — not a defect.
 * It stays in the report because the empty `steps[]` it produces would
 * otherwise be unexplained, and it is `info` because the alternative was a
 * permanent warning against two squads that are right.
 */
const ALWAYS_INFO = new Set<string>(["workflow_event_router"]);

export function bodyWordCount(body: string): number {
  const t = body.trim();
  return t ? t.split(/\s+/).length : 0;
}

export function workflowBodyWordsMax(): number {
  const n = LIMITS.workflow_body_words_max;
  return typeof n === "number" ? n : 2500;
}

export function lintWorkflow(canonical: CanonicalWorkflow, ctx: LintContext): LintFinding[] {
  const v6 = String(ctx.protocol).trim() === "6.0";
  const findings: LintFinding[] = [];
  const add = (id: WorkflowLintId, message: string, evidence: string) => {
    const severity: LintSeverity = ALWAYS_INFO.has(id) ? "info"
      : ALWAYS_WARNING.has(id) || !v6 ? "warning" : "error";
    findings.push({ id, severity, message, evidence, where: ctx.file });
  };

  if (ctx.inlineProse.length) {
    add("workflow_inline_prose", `${ctx.inlineProse.length} step(s) carry the prompt inline (\`task: |\` / \`action:\`) instead of a task reference`,
      ctx.inlineProse.slice(0, 5).join(", "));
  }

  if (ctx.twins.length) {
    add("workflow_twin", `two encodings of the stem \`${ctx.stem}\` on disk — one graph, one file`,
      [ctx.file, ...ctx.twins].join(" + "));
  }

  // The real file name, not the lowercased stem the surface keys by: an
  // uppercase letter is exactly what this rule is about.
  const authored = ctx.file.replace(/\.(ya?ml|md)$/i, "");
  if (!CANONICAL_ID.test(authored)) {
    add("workflow_stem_case", `workflow stem \`${authored}\` is not \`^[a-z][a-z0-9_-]*$\` — case-insensitive file systems make it ambiguous`, ctx.file);
  }

  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const s of canonical.steps) {
    if (seen.has(s.id)) duplicates.push(s.id);
    seen.add(s.id);
  }
  if (duplicates.length) add("workflow_step_id_duplicate", `${duplicates.length} duplicate step id(s)`, [...new Set(duplicates)].slice(0, 5).join(", "));

  const unresolved: string[] = [];
  for (const s of canonical.steps) {
    if (!s.agent) unresolved.push(`${s.id}: no agent`);
    else if (ctx.agents.size > 0 && !ctx.agents.has(s.agent)) unresolved.push(`${s.id}: agent \`${s.agent}\``);
    if (s.task && ctx.tasks.size > 0 && !ctx.tasks.has(s.task)) unresolved.push(`${s.id}: task \`${s.task}\``);
  }
  if (unresolved.length) {
    add("workflow_ref_unresolved", `${unresolved.length} step reference(s) point at no file`, unresolved.slice(0, 5).join(" · "));
  }

  const ids = new Set(canonical.steps.map((s) => s.id));
  const dangling: string[] = [];
  for (const s of canonical.steps) for (const r of s.requires) if (!ids.has(r)) dangling.push(`${s.id} → ${r}`);
  if (dangling.length) add("workflow_dangling_requires", `${dangling.length} \`requires\` entr${dangling.length === 1 ? "y names" : "ies name"} no step`, dangling.slice(0, 5).join(" · "));

  if (canonical.steps.length) {
    const plan = planDag(canonical.steps.map((s) => ({ id: s.id, deps: s.requires, parallel_safe: true })));
    if (plan.has_cycle) add("workflow_cycle", `the step graph has a cycle over ${plan.cycle_nodes.length} step(s)`, plan.cycle_nodes.slice(0, 6).join(" → "));
  }

  if (ctx.dialects.includes("legacy-dialect:requires_by_output")) {
    add("workflow_requires_by_output", "a dependency names another step's OUTPUT instead of its id — the canonical graph depends on step ids", ctx.file);
  }

  if (ctx.unnormalizable) {
    const routes = canonical.extensions.event_routes;
    const n = isMapping(routes) ? Object.keys(routes).length : Array.isArray(routes) ? routes.length : 0;
    add("workflow_event_router", `an event router: ${n} \`event_routes\` entr${n === 1 ? "y" : "ies"}, each with its own channel and chain — there is no step order between them, so none is derived`, ctx.file);
  } else if (ctx.dialects.length) {
    add("workflow_shape_legacy", `${ctx.dialects.length} legacy dialect(s) — the canonical shape is \`steps[]\` with \`requires\``,
      ctx.dialects.join(", "));
  }

  const max = ctx.bodyWordsMax ?? workflowBodyWordsMax();
  if (ctx.bodyWords > max) add("workflow_body_too_long", `the prose body has ${ctx.bodyWords} words (ceiling ${max})`, ctx.file);

  if (ctx.orphan) add("workflow_orphan", "no capability invokes this workflow", ctx.file);

  return findings;
}

// ── one squad, read whole ───────────────────────────────────────────────────

export interface SquadWorkflow {
  file: WorkflowFile;
  raw: RawWorkflow;
  normalized: NormalizeResult | null;
}

/**
 * Every workflow of a squad, read and normalized once. The gate, the auditor
 * and the migration all start here so none of them can disagree about what a
 * squad's graph is.
 */
export function readSquadWorkflows(squadDir: string): SquadWorkflow[] {
  return listWorkflowFiles(squadDir).map((file) => {
    const raw = readWorkflow(file.path);
    return { file, raw, normalized: raw.doc ? normalizeWorkflow(raw.doc, { stem: file.stem }) : null };
  });
}

/** Component stems on disk, for the reference lint. */
export function componentStems(squadDir: string, sub: "agents" | "tasks"): Set<string> {
  return new Set(safeReaddir(path.join(squadDir, sub)).filter((f) => /\.md$/i.test(f)).map((f) => f.replace(/\.md$/i, "")));
}
