#!/usr/bin/env bun
/**
 * migrate-squad.ts — `nrv migrate <slug|path> --to 6`, the v5 → v6 conversion.
 *
 *   nrv migrate <slug|path> --to 6 [--apply] [--map-refs] [--force]
 *   nrv migrate squad --all --to 6 [--apply] [--root <dir>]
 *   nrv migrate <slug|path> --rollback <ts>
 *
 * **Dry-run is the default.** Without `--apply` nothing is written: not the
 * squad, not the backup, not the report. That is the convention `fix-squad
 * --apply` set, and it is the only safe default for a command that rewrites
 * every workflow of a squad at once.
 *
 * What it does, per workflow:
 *   1. `normalizeWorkflow` maps the legacy dialect onto the canonical graph.
 *   2. Prose that lived in `task: |` / `action:` moves out of the graph —
 *      into `tasks/<workflow>-<step>.md` when the step carries a real prompt
 *      (>= 40 words and no task reference), into the body under `## <step.id>`
 *      otherwise. **Verbatim, always.** The migration never writes a sentence
 *      of its own into a workflow body; the only text it authors is the task
 *      scaffold's frontmatter and its `## Acceptance Criteria` placeholder.
 *   3. The canonical document is written to `workflows/<stem>.md`, and the
 *      `.yaml` is removed ONLY after the `.md` has been read back and matched
 *      against `WorkflowSchema`.
 *   4. A twin (`x.md` + `x.yaml`) becomes one file: the YAML's graph, the
 *      Markdown's body (v6 §28.5).
 *   5. `event_routes` is a router, not a DAG. Without `--force` the squad is
 *      refused whole and nothing is written; with `--force` that one document
 *      is left in place, untouched, and the rest of the squad migrates.
 *
 * And, in the manifest: `protocol: "6.0"`, `invoke.ref` and
 * `components.workflows` without the encoding (§28.6), and `acceptance[]`
 * derived from the invoked workflow's `success_indicators` with
 * `blocking: false` (§29) — an author's checklist becoming the judge's, which
 * is the one thing in the conversion that changes what a run is graded on.
 *
 * Safety: `fs.cpSync` for the backup, never rsync (the CI matrix runs Windows);
 * the backup lives in `~/squads-legacy-v5/<slug>.<ts>/` and the JSON report in
 * the engine's squad state dir — never inside the squad, which would put a
 * migration artifact into every pack built from it. `--rollback <ts>` restores
 * the backup and refuses when the squad changed after the migration.
 *
 * Exit: 0 migrated (or nothing to do) · 1 refused / failed · 4 usage.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";
import { paths, EXIT } from "../../_shared/lib/bun-helpers.ts";
import { RUN_STATE_EXCLUDES, isRunStatePath } from "../../_shared/lib/run-state.ts";
import { snapshotTree } from "../../_shared/lib/tree-digest.ts";
import { extractSurface, readSurface, writeSurface } from "../../_shared/lib/surface.ts";
import { diffSurfaces } from "../../_shared/lib/surface-diff.ts";
import { WorkflowSchema } from "../../_shared/validators/validators.ts";
import { editYaml, listEntities, resolveEntityDir } from "../../_shared/lib/verify/common.ts";
import { verifyEntity } from "../../_shared/lib/verify/index.ts";
import {
  CANONICAL_ID, componentStems, listWorkflowFiles, normalizeWorkflow, readWorkflow,
  renderCanonicalMarkdown, stripWorkflowExt,
  type CanonicalWorkflow, type NormalizeResult, type WorkflowFile,
} from "../lib/workflow-reader.ts";

/** A step whose prompt reaches this many words is a task, not a body note. */
export const TASK_EXTRACTION_WORDS = 40;
/** `CapabilitySchema.acceptance` caps the array at 12 (v6 §29). */
const ACCEPTANCE_MAX = 12;

// ── report ──────────────────────────────────────────────────────────────────

export interface FileReport {
  from: string;
  to: string | null;
  dialect_detected: string[];
  steps_before: number;
  steps_after: number;
  unresolved_refs: string[];
  inline_prompts_extracted: number;
  prose_words_moved: number;
  /** Tasks this file's prose became, as `tasks/<stem>.md`. */
  tasks_extracted: string[];
  /** The twin whose graph or body was merged in, when there was one. */
  twin_merged?: string;
  /** Why the file was left alone (`event_routes`, a parse error). */
  refused?: string;
}

export interface MigrateReport {
  schema: "nirvana.squad-migrate/v1";
  slug: string;
  dir: string;
  to: string;
  mode: "dry-run" | "apply";
  at: string;
  backup: string | null;
  files: FileReport[];
  manifest: {
    protocol_before: string;
    protocol_after: string;
    refs_rewritten: string[];
    components_rewritten: string[];
    acceptance_derived: Array<{ capability: string; ids: string[] }>;
  };
  refs_mapped: string[];
  tasks_created: string[];
  surface_diff: { bump: string; breaking: number; changes: number } | null;
  gate: { verdict: string; errors: number; warnings: number; exit_code: number } | null;
  digest_before: string;
  digest_after: string | null;
  refusals: string[];
  changed: boolean;
  /** Already 6.0 and already canonical: the run had nothing to write. */
  noop: boolean;
}

// ── the plan (pure: nothing here touches disk) ──────────────────────────────

interface PlannedWorkflow {
  file: WorkflowFile;
  target: string;               // `workflows/<stem>.md`, relative to the squad
  removes: string[];            // encodings to delete once the .md validates
  canonical: CanonicalWorkflow;
  body: string;
  tasks: Array<{ rel: string; content: string }>;
  report: FileReport;
}

interface Plan {
  slug: string;
  dir: string;
  workflows: PlannedWorkflow[];
  refusals: string[];
  /** Stem renames the manifest has to follow (`Main.yaml` → `main`). */
  stemByBasename: Map<string, string>;
  refsMapped: string[];
  protocolBefore: string;
}

const isMapping = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const words = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** Raw step entries the source document declared, before normalization. */
function rawStepCount(doc: unknown): number {
  if (!isMapping(doc)) return 0;
  const flow = isMapping(doc.flow) ? doc.flow : null;
  const pipeline = isMapping(doc.pipeline) ? doc.pipeline : null;
  const wf = isMapping(doc.workflow) ? doc.workflow : null;
  for (const list of [
    doc.steps, flow?.steps, pipeline?.steps, doc.sequence, doc.agent_sequence,
    wf?.steps, wf?.agents, Array.isArray(doc.workflow) ? doc.workflow : undefined,
  ]) {
    if (Array.isArray(list)) return list.length;
  }
  for (const groups of [flow?.phases, doc.phases, doc.stages]) {
    if (Array.isArray(groups)) {
      return groups.reduce((n: number, p: unknown) => {
        if (!isMapping(p)) return n + 1;
        if (Array.isArray(p.steps)) return n + p.steps.length;
        if (Array.isArray(p.tasks)) return n + p.tasks.length;
        return n + 1;
      }, 0);
    }
  }
  return 0;
}

/** `snake_case` / case-folded index of the components on disk, for `--map-refs`. */
function foldIndex(stems: Set<string>): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const s of stems) {
    const key = s.toLowerCase().replace(/_/g, "-");
    m.set(key, [...(m.get(key) ?? []), s]);
  }
  return m;
}

const TASK_SCAFFOLD_AC = "## Acceptance Criteria";

function taskDocument(stem: string, workflow: string, step: string, prose: string): string {
  return [
    "---",
    `name: ${stem}`,
    `description: "Step \`${step}\` of the ${workflow} workflow"`,
    "---",
    "",
    `# ${workflow} · ${step}`,
    "",
    prose.trim(),
    "",
    TASK_SCAFFOLD_AC,
    "",
    "- [ ] TODO: state the binary check that proves this step is done",
    "",
  ].join("\n");
}

/**
 * The whole conversion, decided before a byte is written. `apply` then only
 * replays it — which is what makes the dry-run a true preview instead of a
 * second implementation of the same rules.
 */
export function planMigration(dir: string, opts: { mapRefs: boolean; extractTasks: boolean; force: boolean }): Plan {
  const slug = path.basename(dir);
  const agents = componentStems(dir, "agents");
  const tasks = componentStems(dir, "tasks");
  const agentFold = foldIndex(agents);
  const taskFold = foldIndex(tasks);
  const plan: Plan = {
    slug, dir, workflows: [], refusals: [], stemByBasename: new Map(), refsMapped: [],
    protocolBefore: "",
  };
  try {
    const manifest = parseYaml(fs.readFileSync(path.join(dir, "squad.yaml"), "utf8"));
    plan.protocolBefore = isMapping(manifest) ? String(manifest.protocol ?? "") : "";
  } catch { /* the gate reports an unparseable manifest; migration just records it as empty */ }

  for (const file of listWorkflowFiles(dir)) {
    const winner = readWorkflow(file.path);
    const twinPaths = file.twins.map((t) => path.join(dir, "workflows", t));

    // §28.5: one stem, one file. The YAML holds the graph, the Markdown the
    // prose — merging is the only reading in which neither is thrown away.
    let graphSource = winner;
    let bodyText = winner.format === "frontmatter" ? winner.body : "";
    let twinMerged: string | undefined;
    if (file.twins.length) {
      const twins = twinPaths.map(readWorkflow);
      const yamlTwin = twins.find((t) => t.format === "yaml" && t.doc);
      const mdTwin = twins.find((t) => t.format === "frontmatter");
      const winnerHasGraph = !!winner.doc && rawStepCount(winner.doc) > 0;
      if (winner.format === "frontmatter" && yamlTwin && !winnerHasGraph) {
        graphSource = yamlTwin; twinMerged = yamlTwin.file;
      } else if (winner.format === "yaml" && mdTwin) {
        bodyText = mdTwin.body; twinMerged = mdTwin.file;
      } else if (yamlTwin && yamlTwin !== winner) {
        // Both carry a graph: the YAML's wins and the Markdown's body stays.
        graphSource = yamlTwin; twinMerged = yamlTwin.file;
      }
    }

    const base: FileReport = {
      from: `workflows/${file.file}`, to: null, dialect_detected: [],
      steps_before: 0, steps_after: 0, unresolved_refs: [],
      inline_prompts_extracted: 0, prose_words_moved: 0, tasks_extracted: [],
      ...(twinMerged ? { twin_merged: `workflows/${twinMerged}` } : {}),
    };

    if (!graphSource.doc) {
      base.refused = graphSource.error ?? "does not parse as a workflow document";
      plan.refusals.push(`workflows/${file.file}: ${base.refused}`);
      plan.workflows.push({ file, target: "", removes: [], canonical: { name: file.stem, steps: [], extensions: {} }, body: "", tasks: [], report: base });
      continue;
    }

    const normalized = normalizeWorkflow(graphSource.doc, { stem: file.stem });
    base.dialect_detected = normalized.dialects.map((d) => d.replace(/^legacy-dialect:/, ""));
    base.steps_before = rawStepCount(graphSource.doc);
    base.steps_after = normalized.canonical.steps.length;

    // Three documents the migration refuses to convert, for the same reason:
    // writing the missing piece would be inventing the squad's method.
    const refusal =
      normalized.unnormalizable ? "`event_routes` is a router, not a DAG: no step order can be derived from it"
      : normalized.canonical.steps.length === 0 ? "no step could be derived from this document"
      : !CANONICAL_ID.test(file.stem) ? `stem \`${file.stem}\` is not \`^[a-z][a-z0-9_-]*$\` — rename the file first`
      : null;
    if (refusal) {
      base.refused = refusal;
      plan.refusals.push(`workflows/${file.file}: ${refusal}`);
      plan.workflows.push({ file, target: "", removes: [], canonical: normalized.canonical, body: "", tasks: [], report: base });
      continue;
    }

    // §28.1: `name` is the file stem. An authored title that is not a stem is
    // relocated, never dropped — `extensions.title` is a key no dialect owns,
    // so it survives every later round trip through the reader untouched.
    if (normalized.canonical.name !== file.stem) {
      if (normalized.canonical.name && normalized.canonical.extensions.title === undefined) {
        normalized.canonical.extensions.title = normalized.canonical.name;
      }
      normalized.canonical.name = file.stem;
    }

    if (opts.mapRefs) mapStepRefs(normalized.canonical, { agents, tasks, agentFold, taskFold }, plan.refsMapped, file.stem);

    const { body, extracted } = splitProse(normalized, file.stem, opts.extractTasks, tasks);
    base.inline_prompts_extracted = normalized.inlineProse.length;
    base.tasks_extracted = extracted.map((e) => e.rel);
    base.prose_words_moved = Object.values(normalized.prose).reduce((n, p) => n + words(p), 0);

    for (const s of normalized.canonical.steps) {
      if (!s.agent) base.unresolved_refs.push(`${s.id}: no agent`);
      else if (agents.size && !agents.has(s.agent)) base.unresolved_refs.push(`${s.id}: agent ${s.agent}`);
      if (s.task && tasks.size && !tasks.has(s.task) && !extracted.some((e) => e.stem === s.task)) {
        base.unresolved_refs.push(`${s.id}: task ${s.task}`);
      }
    }

    const target = path.posix.join("workflows", `${file.stem}.md`);
    base.to = target;
    const removes = [file.file, ...file.twins]
      .filter((f) => path.posix.join("workflows", f) !== target)
      .map((f) => path.posix.join("workflows", f));
    for (const f of [file.file, ...file.twins]) plan.stemByBasename.set(f.toLowerCase(), file.stem);

    plan.workflows.push({
      file, target, removes, canonical: normalized.canonical,
      body: [bodyText.trim(), body.trim()].filter(Boolean).join("\n\n"),
      tasks: extracted.map((e) => ({ rel: e.rel, content: e.content })),
      report: base,
    });
  }
  return plan;
}

/** `--map-refs`: a reference that matches exactly one component by case or by
 *  `_`/`-` is renamed to it. Anything ambiguous stays a finding. */
function mapStepRefs(
  canonical: CanonicalWorkflow,
  idx: { agents: Set<string>; tasks: Set<string>; agentFold: Map<string, string[]>; taskFold: Map<string, string[]> },
  log: string[], stem: string,
): void {
  const remap = (value: string, known: Set<string>, fold: Map<string, string[]>): string | null => {
    if (known.has(value) || known.size === 0) return null;
    const hits = fold.get(value.toLowerCase().replace(/_/g, "-")) ?? [];
    return hits.length === 1 && hits[0] !== value ? hits[0] : null;
  };
  for (const s of canonical.steps) {
    const a = s.agent ? remap(s.agent, idx.agents, idx.agentFold) : null;
    if (a) { log.push(`${stem}#${s.id}: agent ${s.agent} → ${a}`); s.agent = a; }
    const t = s.task ? remap(s.task, idx.tasks, idx.taskFold) : null;
    if (t) { log.push(`${stem}#${s.id}: task ${s.task} → ${t}`); s.task = t; }
  }
}

/**
 * Prose out of the graph, and where each piece lands. A step carrying a real
 * prompt becomes a task document and gets a `task:` reference; a short note
 * stays in the body under `## <step.id>`. Both are verbatim.
 */
function splitProse(
  normalized: NormalizeResult, stem: string, extractTasks: boolean, existingTasks: Set<string>,
): { body: string; extracted: Array<{ stem: string; rel: string; content: string }> } {
  const parts: string[] = [];
  const extracted: Array<{ stem: string; rel: string; content: string }> = [];
  for (const step of normalized.canonical.steps) {
    const prose = normalized.prose[step.id];
    if (!prose?.trim()) continue;
    if (extractTasks && !step.task && words(prose) >= TASK_EXTRACTION_WORDS) {
      const taskStem = uniqueTaskStem(`${stem}-${step.id}`, existingTasks, extracted);
      extracted.push({ stem: taskStem, rel: path.posix.join("tasks", `${taskStem}.md`), content: taskDocument(taskStem, stem, step.id, prose) });
      step.task = taskStem;
      continue;
    }
    parts.push(`## ${step.id}\n\n${prose.trim()}\n`);
  }
  return { body: parts.join("\n"), extracted };
}

function uniqueTaskStem(base: string, existing: Set<string>, taken: Array<{ stem: string }>): string {
  const clean = base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "step";
  let candidate = clean;
  let n = 1;
  while (existing.has(candidate) || taken.some((t) => t.stem === candidate)) candidate = `${clean}-${++n}`;
  return candidate;
}

// ── the manifest ────────────────────────────────────────────────────────────

function acceptanceId(text: string, taken: Set<string>): string {
  let id = text.trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  if (!/^[a-z]/.test(id)) id = `ac-${id}`;
  if (!CANONICAL_ID.test(id)) id = "acceptance";
  let out = id;
  let n = 1;
  while (taken.has(out)) out = `${id}-${++n}`;
  taken.add(out);
  return out;
}

interface ManifestEdit {
  protocol_after: string;
  refs_rewritten: string[];
  components_rewritten: string[];
  acceptance_derived: Array<{ capability: string; ids: string[] }>;
}

/**
 * The manifest half of the conversion. Runs through `editYaml`, so the file
 * keeps its comments and its byte layout everywhere the migration did not
 * touch it.
 */
function rewriteManifest(
  dir: string, plan: Plan, indicatorsFor: (ref: string) => string[] | null,
  opts: { deriveAcceptance: boolean; apply: boolean },
): ManifestEdit {
  const edit: ManifestEdit = { protocol_after: "6.0", refs_rewritten: [], components_rewritten: [], acceptance_derived: [] };
  // A ref only loses its extension (§28.6). It is lowercased ONLY when this
  // migration is the thing renaming the file — guessing the case of a stem the
  // migration left alone would break the ref on a case-sensitive file system.
  const newRef = (ref: string): string | null => {
    const bare = ref.trim().split(path.sep).join("/");
    const base = path.posix.basename(bare);
    const stem = plan.stemByBasename.get(base.toLowerCase()) ?? stripWorkflowExt(base);
    const parent = path.posix.dirname(bare);
    const next = parent === "." ? stem : `${parent}/${stem}`;
    return next === bare ? null : next;
  };

  const mutate = (doc: any): boolean => {
    let touched = false;
    if (String(doc.get("protocol") ?? "") !== "6.0") { doc.set("protocol", "6.0"); touched = true; }

    const caps = doc.get("capabilities") as any;
    if (caps && Array.isArray(caps.items)) {
      caps.items.forEach((_: unknown, i: number) => {
        const id = String(doc.getIn(["capabilities", i, "id"]) ?? `capabilities[${i}]`);
        if (doc.getIn(["capabilities", i, "invoke", "type"]) === "workflow") {
          const ref = doc.getIn(["capabilities", i, "invoke", "ref"]);
          if (typeof ref === "string") {
            const next = newRef(ref);
            if (next) { doc.setIn(["capabilities", i, "invoke", "ref"], next); edit.refs_rewritten.push(`${id}: ${ref} → ${next}`); touched = true; }
          }
          if (opts.deriveAcceptance && !doc.hasIn(["capabilities", i, "acceptance"])) {
            const indicators = indicatorsFor(String(doc.getIn(["capabilities", i, "invoke", "ref"]) ?? ""));
            if (indicators?.length) {
              const taken = new Set<string>();
              const entries = indicators.slice(0, ACCEPTANCE_MAX)
                .map((text) => ({ id: acceptanceId(text, taken), description: text, blocking: false }));
              doc.setIn(["capabilities", i, "acceptance"], entries);
              edit.acceptance_derived.push({ capability: id, ids: entries.map((e) => e.id) });
              touched = true;
            }
          }
        }
      });
    }

    const wfs = doc.getIn(["components", "workflows"], true) as any;
    if (wfs && Array.isArray(wfs.items)) {
      wfs.items.forEach((_: unknown, i: number) => {
        const entry = doc.getIn(["components", "workflows", i]);
        if (typeof entry !== "string") return;
        const next = newRef(entry);
        if (next) { doc.setIn(["components", "workflows", i], next); edit.components_rewritten.push(`${entry} → ${next}`); touched = true; }
      });
    }

    // A task the migration extracted is a component of the squad from now on.
    const created = plan.workflows.flatMap((w) => w.tasks.map((t) => path.basename(t.rel, ".md")));
    if (created.length) {
      const list = doc.getIn(["components", "tasks"], true) as any;
      const have = new Set<string>((list && Array.isArray(list.items) ? list.items : [])
        .map((_: unknown, i: number) => String(doc.getIn(["components", "tasks", i]) ?? "").replace(/\.md$/i, "")));
      for (const stem of created) {
        if (have.has(stem)) continue;
        if (list && Array.isArray(list.items)) doc.addIn(["components", "tasks"], stem);
        else doc.setIn(["components", "tasks"], [stem]);
        have.add(stem);
        touched = true;
      }
    }
    return touched;
  };

  if (opts.apply) editYaml(path.join(dir, "squad.yaml"), mutate);
  else {
    // Dry run: mutate a parsed copy so the report is exact, and drop it.
    try { mutate(parseDocument(fs.readFileSync(path.join(dir, "squad.yaml"), "utf8"))); } catch { /* an unparseable manifest is the gate's finding, not the migration's */ }
  }
  return edit;
}

// ── disk ────────────────────────────────────────────────────────────────────

export function legacyBackupRoot(): string {
  return process.env.SQUADS_LEGACY_V5_DIR || path.join((paths as Record<string, string>).NIRVANA_HOME, "squads-legacy-v5");
}

function stateFileFor(slug: string, ts: string): string {
  return path.join((paths as Record<string, string>).SQUADS_STATE_DIR, slug, `migrate-${ts}.json`);
}

export function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** sha of every tracked file, run state excluded — what `--rollback` compares. */
export function squadDigest(dir: string): string {
  const snap = snapshotTree([dir], { skipDirs: new Set(RUN_STATE_EXCLUDES.squads) });
  const lines: string[] = [];
  for (const [abs, entry] of snap) {
    const rel = path.relative(dir, abs).split(path.sep).join("/");
    if (isRunStatePath(rel, "squads")) continue;
    lines.push(`${rel}:${entry.sha256}`);
  }
  lines.sort();
  return new Bun.CryptoHasher("sha256").update(lines.join("\n")).digest("hex");
}

/** `fs.cpSync`, never rsync: the CI matrix runs Windows, where rsync does not exist. */
function copyTree(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (p) => {
      const rel = path.relative(src, p).split(path.sep).join("/");
      return rel === "" || !isRunStatePath(rel, "squads");
    },
  });
}

/** Restore leaves run state alone: only what the backup covers is replaced. */
function restoreTree(backup: string, dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    if (isRunStatePath(name, "squads")) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  fs.cpSync(backup, dir, { recursive: true, verbatimSymlinks: true });
}

// ── run one squad ───────────────────────────────────────────────────────────

interface RunOptions {
  apply: boolean;
  mapRefs: boolean;
  extractTasks: boolean;
  deriveAcceptance: boolean;
  force: boolean;
}

async function migrateOne(dir: string, opts: RunOptions): Promise<{ report: MigrateReport; code: number }> {
  const slug = path.basename(dir);
  const at = stamp();
  const digestBefore = squadDigest(dir);
  const plan = planMigration(dir, opts);

  const blocking = plan.workflows.filter((w) => w.report.refused);
  if (blocking.length && !opts.force) {
    const report = emptyReport(slug, dir, at, opts, plan, digestBefore);
    report.refusals = plan.refusals;
    return { report, code: EXIT.FAILURES };
  }

  const doable = plan.workflows.filter((w) => !w.report.refused);
  const indicatorsFor = (ref: string): string[] | null => {
    const stem = plan.stemByBasename.get(path.basename(ref).toLowerCase()) ?? stripWorkflowExt(path.basename(ref)).toLowerCase();
    return doable.find((w) => w.file.stem === stem)?.canonical.success_indicators ?? null;
  };

  // The manifest edit is computed either way; `apply` decides whether it lands.
  const manifestEdit = rewriteManifestPlanned(dir, plan, indicatorsFor, opts, false);

  const report: MigrateReport = {
    schema: "nirvana.squad-migrate/v1",
    slug, dir, to: "6.0", mode: opts.apply ? "apply" : "dry-run", at,
    backup: null,
    files: plan.workflows.map((w) => w.report),
    manifest: { protocol_before: plan.protocolBefore, ...manifestEdit },
    refs_mapped: plan.refsMapped,
    tasks_created: doable.flatMap((w) => w.tasks.map((t) => t.rel)),
    surface_diff: null,
    gate: null,
    digest_before: digestBefore,
    digest_after: null,
    refusals: plan.refusals,
    changed: false,
    noop: false,
  };

  // Idempotence, decided on bytes rather than on a heuristic: a second run is a
  // no-op exactly when every file the migration would write already holds what
  // it would write.
  const nothingToDo = plan.protocolBefore === "6.0"
    && manifestEdit.refs_rewritten.length === 0
    && manifestEdit.components_rewritten.length === 0
    && manifestEdit.acceptance_derived.length === 0
    && report.tasks_created.length === 0
    && doable.every((w) => {
      if (w.removes.length) return false;
      try { return fs.readFileSync(path.join(dir, w.target), "utf8") === renderCanonicalMarkdown(w.canonical, w.body); }
      catch { return false; }
    });

  report.noop = nothingToDo;
  if (!opts.apply || nothingToDo) {
    report.digest_after = squadDigest(dir);
    report.changed = report.digest_after !== digestBefore;
    return { report, code: EXIT.OK };
  }

  // ── apply ────────────────────────────────────────────────────────────────
  const backup = path.join(legacyBackupRoot(), `${slug}.${at}`);
  copyTree(dir, backup);
  report.backup = backup;

  try {
    for (const w of doable) {
      for (const t of w.tasks) {
        const abs = path.join(dir, t.rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, t.content, "utf8");
      }
      fs.writeFileSync(path.join(dir, w.target), renderCanonicalMarkdown(w.canonical, w.body), "utf8");
    }
    // The `.yaml` goes only after the `.md` has been read back and validated.
    for (const w of doable) {
      const raw = readWorkflow(path.join(dir, w.target));
      if (!raw.doc) throw new Error(`${w.target} did not read back as a workflow document: ${raw.error}`);
      const parsed = WorkflowSchema.safeParse(normalizeWorkflow(raw.doc, { stem: w.file.stem }).canonical);
      if (!parsed.success) {
        throw new Error(`${w.target} does not match WorkflowSchema: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).slice(0, 3).join(" · ")}`);
      }
      for (const rel of w.removes) fs.rmSync(path.join(dir, rel), { force: true });
    }
    rewriteManifestPlanned(dir, plan, indicatorsFor, opts, true);
    if (readSurface(dir)) writeSurface(dir, extractSurface(dir, "squad"));
  } catch (e: any) {
    restoreTree(backup, dir);
    report.refusals.push(`rolled back: ${String(e?.message ?? e)}`);
    report.digest_after = squadDigest(dir);
    return { report, code: EXIT.FAILURES };
  }

  report.digest_after = squadDigest(dir);
  report.changed = report.digest_after !== digestBefore;

  try {
    const d = diffSurfaces(extractSurface(backup, "squad"), extractSurface(dir, "squad"));
    report.surface_diff = { bump: d.bump, breaking: d.breaking, changes: d.changes.length };
  } catch { /* a squad with no readable surface simply has no diff */ }

  const verdict = await verifyEntity("squad", dir, { retrieval: false, emit: null });
  report.gate = { verdict: verdict.verdict, errors: verdict.summary.errors, warnings: verdict.summary.warnings, exit_code: verdict.exit_code };

  const file = stateFileFor(slug, at);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n", "utf8");

  return { report, code: verdict.summary.errors > 0 ? EXIT.FAILURES : EXIT.OK };
}

function emptyReport(slug: string, dir: string, at: string, opts: RunOptions, plan: Plan, digest: string): MigrateReport {
  return {
    schema: "nirvana.squad-migrate/v1", slug, dir, to: "6.0", mode: opts.apply ? "apply" : "dry-run", at,
    backup: null, files: plan.workflows.map((w) => w.report),
    manifest: { protocol_before: plan.protocolBefore, protocol_after: plan.protocolBefore, refs_rewritten: [], components_rewritten: [], acceptance_derived: [] },
    refs_mapped: plan.refsMapped, tasks_created: [], surface_diff: null, gate: null,
    digest_before: digest, digest_after: digest, refusals: [], changed: false, noop: false,
  };
}

function rewriteManifestPlanned(
  dir: string, plan: Plan, indicatorsFor: (ref: string) => string[] | null, opts: RunOptions, apply: boolean,
): ManifestEdit {
  return rewriteManifest(dir, plan, indicatorsFor, { deriveAcceptance: opts.deriveAcceptance, apply });
}

// ── rollback ────────────────────────────────────────────────────────────────

async function rollbackOne(dir: string, ts: string, force: boolean): Promise<number> {
  const slug = path.basename(dir);
  const backup = path.join(legacyBackupRoot(), `${slug}.${ts}`);
  if (!fs.existsSync(backup)) {
    console.error(`nrv migrate: no backup at ${backup}`);
    const all = fs.existsSync(legacyBackupRoot()) ? fs.readdirSync(legacyBackupRoot()).filter((n) => n.startsWith(`${slug}.`)) : [];
    if (all.length) console.error(`  available: ${all.map((n) => n.slice(slug.length + 1)).join(", ")}`);
    return EXIT.FAILURES;
  }
  const reportFile = stateFileFor(slug, ts);
  let recorded: MigrateReport | null = null;
  try { recorded = JSON.parse(fs.readFileSync(reportFile, "utf8")); } catch { /* a backup with no report can still be restored with --force */ }

  if (!force) {
    if (!recorded?.digest_after) {
      console.error(`nrv migrate --rollback ${ts}: no migration report at ${reportFile}, so "unchanged since" cannot be proven. Re-run with --force to restore anyway.`);
      return EXIT.FAILURES;
    }
    const now = squadDigest(dir);
    if (now !== recorded.digest_after) {
      console.error(`nrv migrate --rollback ${ts}: ${slug} changed after the migration — restoring would discard that work.`);
      console.error(`  migrated: ${recorded.digest_after.slice(0, 16)}…   now: ${now.slice(0, 16)}…`);
      console.error("  Re-run with --force to restore anyway.");
      return EXIT.FAILURES;
    }
  }
  restoreTree(backup, dir);
  console.log(`Restored ${slug} from ${backup}`);
  return EXIT.OK;
}

// ── rendering ───────────────────────────────────────────────────────────────

function render(r: MigrateReport): string {
  const lines: string[] = [];
  const head = r.noop ? "NOTHING TO DO (already 6.0 and already canonical)"
    : r.mode === "dry-run" ? "DRY RUN (nothing written — pass --apply)" : "APPLIED";
  lines.push(`${r.slug} → protocol 6.0   ${head}`);
  lines.push(`  protocol   ${r.manifest.protocol_before || "(missing)"} → ${r.mode === "apply" ? r.manifest.protocol_after : `${r.manifest.protocol_after} (planned)`}`);
  for (const f of r.files) {
    if (f.refused) { lines.push(`  REFUSED    ${f.from} — ${f.refused}`); continue; }
    const bits = [
      `${f.steps_before}→${f.steps_after} steps`,
      f.dialect_detected.length ? `dialects: ${f.dialect_detected.join(", ")}` : "canonical",
      f.prose_words_moved ? `${f.prose_words_moved} words of prose moved` : null,
      f.tasks_extracted.length ? `${f.tasks_extracted.length} task(s) extracted` : null,
      f.twin_merged ? `twin merged: ${f.twin_merged}` : null,
      f.unresolved_refs.length ? `${f.unresolved_refs.length} unresolved ref(s)` : null,
    ].filter(Boolean);
    lines.push(`  ${f.from} → ${f.to}`);
    lines.push(`      ${bits.join(" · ")}`);
    for (const u of f.unresolved_refs.slice(0, 3)) lines.push(`      unresolved: ${u}`);
  }
  for (const m of r.refs_mapped) lines.push(`  mapped     ${m}`);
  for (const t of r.tasks_created) lines.push(`  task       ${t}`);
  for (const a of r.manifest.acceptance_derived) lines.push(`  acceptance ${a.capability}: ${a.ids.join(", ")}`);
  for (const c of r.manifest.refs_rewritten) lines.push(`  ref        ${c}`);
  for (const c of r.manifest.components_rewritten) lines.push(`  component  ${c}`);
  for (const x of r.refusals) lines.push(`  refused    ${x}`);
  if (r.backup) lines.push(`  backup     ${r.backup}`);
  if (r.surface_diff) lines.push(`  surface    bump ${r.surface_diff.bump} (${r.surface_diff.breaking} breaking, ${r.surface_diff.changes} change(s))`);
  if (r.gate) lines.push(`  gate       ${r.gate.verdict} — ${r.gate.errors} error(s), ${r.gate.warnings} warning(s)`);
  else lines.push(`  gate       not run (${r.noop ? "nothing to do" : r.mode})`);
  return lines.join("\n");
}

function usage(): string {
  return `nrv migrate — convert a squad to Squad Protocol 6.0

USAGE
  nrv migrate <slug|path> --to 6 [--apply] [--map-refs] [--force]
  nrv migrate squad --all --to 6 [--apply] [--root <dir>]
  nrv migrate <slug|path> --rollback <ts> [--force]

OPTIONS
  --to 6                  the only target protocol (required, except with --rollback)
  --apply                 write; without it the run is a dry run and touches nothing
  --all                   every squad in the library (or under --root)
  --root <dir>            --all: scan this root instead of the installed library (repeatable)
  --map-refs              rename a step's agent/task reference when exactly one component matches by case or by _/-
  --no-extract-tasks      keep every inline prompt in the workflow body instead of extracting tasks/<workflow>-<step>.md
  --no-derive-acceptance  do not derive capabilities[].acceptance from the workflow's success_indicators
  --force                 migrate the rest of a squad whose workflow cannot be normalized; with --rollback, restore without the unchanged-since proof
  --rollback <ts>         restore the backup taken at <ts> (refuses when the squad changed after the migration)
  --json                  the nirvana.squad-migrate/v1 report on stdout

WHAT IT WRITES
  the squad                 workflows/<stem>.md (the .yaml goes only after the .md validates), tasks/<workflow>-<step>.md, squad.yaml
  ~/squads-legacy-v5/       <slug>.<ts>/ — the pre-migration backup (fs.cpSync, run state excluded)
  the squad state dir       <slug>/migrate-<ts>.json — the report, never inside the squad

EXIT  0 migrated or nothing to do · 1 refused, failed, or the gate found an error · 4 usage`;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) { console.log(usage()); return argv.length === 0 ? EXIT.INVALID_ARGS : EXIT.OK; }

  const positional: string[] = [];
  const roots: string[] = [];
  let to: string | null = null;
  let rollback: string | null = null;
  let apply = false, all = false, mapRefs = false, force = false, json = false;
  let extractTasks = true, deriveAcceptance = true;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    const name = (eq === -1 ? a : a.slice(0, eq)).replace(/^--?/, "");
    const inline = eq === -1 ? null : a.slice(eq + 1);
    const value = () => inline ?? argv[++i];
    switch (name) {
      case "to": to = value(); break;
      case "rollback": rollback = value(); break;
      case "root": roots.push(value()); break;
      case "apply": apply = true; break;
      case "all": all = true; break;
      case "map-refs": mapRefs = true; break;
      case "no-extract-tasks": extractTasks = false; break;
      case "no-derive-acceptance": deriveAcceptance = false; break;
      case "force": force = true; break;
      case "json": json = true; break;
      default:
        console.error(`nrv migrate: unknown option ${a}`);
        console.error("");
        console.error(usage());
        return EXIT.INVALID_ARGS;
    }
  }
  // `nrv migrate squad <slug>` and `nrv migrate <slug>` are the same command.
  if (positional[0] === "squad" || positional[0] === "squads") positional.shift();

  if (!rollback) {
    if (to === null) { console.error("nrv migrate: --to 6 is required (it is the only target protocol)."); return EXIT.INVALID_ARGS; }
    if (!["6", "6.0"].includes(to)) { console.error(`nrv migrate: --to ${to} is not a protocol this command targets (6).`); return EXIT.INVALID_ARGS; }
  }

  const targets: string[] = [];
  if (all) {
    if (positional.length) { console.error(`nrv migrate: --all takes no target (got ${positional[0]}).`); return EXIT.INVALID_ARGS; }
    for (const e of listEntities("squad", roots.length ? roots : undefined)) targets.push(e.dir);
    if (!targets.length) { console.error("nrv migrate --all: no squad found."); return EXIT.FAILURES; }
  } else {
    if (positional.length !== 1) { console.error(`nrv migrate: one <slug|path> is required${positional.length > 1 ? ` (got ${positional.length})` : ""}.`); return EXIT.INVALID_ARGS; }
    const dir = resolveEntityDir("squad", positional[0]);
    if (!dir) { console.error(`nrv migrate: unknown squad: ${positional[0]}`); return EXIT.INVALID_ARGS; }
    targets.push(dir);
  }

  if (rollback) {
    if (all) { console.error("nrv migrate: --rollback takes one squad, not --all."); return EXIT.INVALID_ARGS; }
    return rollbackOne(targets[0], rollback, force);
  }

  const opts: RunOptions = { apply, mapRefs, extractTasks, deriveAcceptance, force };
  const reports: MigrateReport[] = [];
  let worst: number = EXIT.OK;
  for (const dir of targets) {
    const { report, code } = await migrateOne(dir, opts);
    reports.push(report);
    if (code !== EXIT.OK) worst = code;
    if (!json) { console.log(render(report)); console.log(""); }
  }
  if (json) console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
  return worst;
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error(`nrv migrate: ${String(e?.stack ?? e)}`);
    process.exit(EXIT.FAILURES);
  });
}
