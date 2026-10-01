// squad-exec.ts — the squad headless runner (routing-360 Phase 4.1).
//
// A squad dispatched on its own: the router (or the user) decided a squad
// delivers the object alone. A business never dispatches a squad; it works
// from the squad's card (business-solo.ts).
//
// Emits dispatch_squad, agent_executed, squad_run_failed and
// mind_clone_missing_degraded, plus the session_resumed /
// session_resume_failed pair from the session-store reuse.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { type Runtime } from "./host-agent-driver.ts";
import { runFolderOf } from "../../_shared/lib/run-workspace.ts";
import { LEGACY_CAPABILITY_ID } from "./capability-resolver.ts";
import {
  normalizeWorkflow, readWorkflow, referencedComponents, resolveWorkflowRef, type CanonicalStep,
} from "../../squads/lib/workflow-reader.ts";
import { stamp } from "../../_shared/lib/audit-provenance.ts";
import { LIMITS } from "../../_shared/validators/limits.ts";
import { runWithCascade } from "./cascade-runner.ts";
import { sessionKey, getSession, putSession, dropSession } from "./session-store.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { briefExcerpt } from "../../_shared/lib/brief-excerpt.ts";
import { resolveClonePersona, loadCloneRegistry } from "../../_shared/lib/clone-resolver.ts";
import { layersForPhase } from "../../_shared/lib/dna-layer-policy.ts";
import { findCloneForTask } from "../../_shared/lib/clone-search.ts";
import { paths } from "../../_shared/lib/bun-helpers.ts";
import { scopeBoundary, scopeGuard } from "../../_shared/lib/scope-guard.ts";
import { renderResourceMap } from "../../_shared/lib/entity-resource-map.ts";
import { resolveSetting } from "../../_shared/lib/settings.ts";
import { preflightWarnings, squadPreflight } from "../../_shared/lib/squad-preflight.ts";

export interface SquadExecArgs {
  squadSlug: string;
  brief: string;
  projectId: string;
  projectDir: string;
  projectRoot: string;
  /** Where THIS squad writes its files. */
  outputsDir: string;
  runtime: Runtime;
  /** Capability this dispatch runs (capability-resolver.ts). It builds the
   *  prompt and travels on `dispatch_squad`; absent keeps the historical prompt. */
  capabilityId?: string | null;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  /** User USE_* rules block, appended to the AUTONOMOUS_DIRECTIVE. */
  rulesDirective?: string;
  /** AUTONOMOUS_DIRECTIVE (kept as a param so the caller owns the directive
   * text; dispatch passes host-agent-driver's constant). */
  autonomousDirective: string;
  /** Ledger heartbeat for supervised squad-only runs. */
  ledger?: { runId: string; watchDir?: string };
  /** Squads root override (tests). */
  squadsRoot?: string;
  /** Test seam: canned cascade runner (zero-token tests). */
  runWithCascadeImpl?: typeof runWithCascade;
}

export interface SquadExecResult {
  ok: boolean;
  squadSlug: string;
  sessionId: string | null;
  costUsd: number | null;
  durationMs: number;
  outputsDir: string;
  error?: string;
}

function appendAudit(payload: Record<string, any>, projectRoot?: string): void {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(harnessLogsDir({ cwd: projectRoot }), today);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify(stamp({ ts: new Date().toISOString(), ...payload })) + "\n");
  } catch { /* non-fatal */ }
}

/** Resolve mind-clones for a squad sub-task by the canonical order:
 *  SOLICITADO (brief names a clone) → BUSCA (task→clone search) → PADRÃO (none).
 *  Squads have no assigned_mind_clones, so the order is request-or-search. Every
 *  clone is resolved from the single library (full embodiment) — closing the gap
 *  where squad agents got zero DNA. */
// `cwd` anchors the clone registry to the DISPATCH's project scope — without it
// the registry resolves from process.cwd(), and the two halves of one dispatch
// can read different scopes (the exact leak fixed in the business loader on
// 2026-08-18: a test run from the engine repo picked up the repo's derived
// registry and injected clones its fixture never wrote).
export function squadCloneInjection(brief: string, cwd?: string): { block: string; decision: string; missingClones: string[]; mode?: "reference" | "full" | "fragments"; personaDirs?: string[] } {
  const MAX = 2;
  const picked: Array<{ slug: string; reason: string }> = [];
  // 1. SOLICITADO — brief names a clone (slug or display name)
  const reg = loadCloneRegistry();
  const low = (brief || "").toLowerCase();
  for (const [slug, c] of Object.entries(reg)) {
    if (picked.length >= MAX) break;
    const name = String((c as any).display_name || "").toLowerCase();
    if (low.includes(slug) || low.includes(slug.replace(/-/g, " ")) || (name.length > 3 && low.includes(name))) {
      picked.push({ slug, reason: "requested" });
    }
  }
  let decision = picked.length ? "REQUESTED by the user" : "";
  // 2. BUSCA — only if nothing requested
  if (!picked.length) {
    let hits: any[] = [];
    try { hits = findCloneForTask(brief, { limit: MAX, cwd }); } catch { hits = []; }
    for (const h of hits) {
      if (picked.length >= MAX) break;
      // Coverage gate (routing-360 Phase 3.3), not normalized>=0.5: normalized
      // is max-normalized, so the top hit is 1.0 by construction even for an
      // out-of-domain brief ("consertar a bomba hidráulica do trator") — a
      // vacuous gate. `below_gate` mirrors the router's Stage 3 coverage bands.
      if (h.below_gate === false) picked.push({ slug: h.slug, reason: `search coverage ${h.coverage?.matched}/${h.coverage?.total}` });
    }
    decision = picked.length ? "found by SEARCH" : "DEFAULT, no useful clone";
  }
  if (!picked.length) return { block: "", decision, missingClones: [] };
  // The execution.dna_injection setting:
  // reference (the default) = a card naming the persona files, read on demand;
  // fragments = SOUL + phase layers (squads execute → execute layers) with a
  // byte budget; full = the whole persona.
  const dnaMode: "reference" | "full" | "fragments" = resolveSetting("execution.dna_injection").value;
  const fragLayers = layersForPhase("execute");
  const parts: string[] = [];
  const missingClones: string[] = [];
  // A card names files the executor opens on demand, so each clone's folder is
  // granted to the run: a runtime that refuses an ungranted path would otherwise
  // hold a card it cannot read.
  const personaDirs: string[] = [];
  for (const p of picked) {
    const persona = dnaMode === "fragments"
      ? resolveClonePersona(p.slug, { depth: "fragments", layers: fragLayers, byteBudget: 16000, cwd })
      : resolveClonePersona(p.slug, { depth: dnaMode, cwd });
    if (persona) {
      parts.push(`--- MIND-CLONE: ${p.slug} — ${persona.display_name} (${p.reason}) ---\n\n${persona.content}`);
      if (persona.source) personaDirs.push(persona.source);
    } else missingClones.push(p.slug);
  }

  // A requested but nonexistent clone does not take down the squad — but
  // degrading in SILENCE would be worse than failing: the squad would produce
  // without the DNA and nobody would know. Same policy as dispatch.ts: the
  // degradation is NOISY — explicit block in the prompt itself, field in the
  // return value (the caller emits the audit event) and an order to the agent
  // to report the absence in the deliverable.
  if (missingClones.length) {
    parts.push(
      `--- MIND-CLONE MISSING: ${missingClones.join(", ")} ---\n\n` +
      `# Expert without a clone in the library\n\n` +
      `The following experts were requested and are NOT installed as a mind-clone: ` +
      `**${missingClones.join(", ")}**.\n\n` +
      `You are NOT loading these people's DNA. Work from your own ` +
      `knowledge of their method, and treat it for what it is: an approximation, ` +
      `not the persona.\n\n` +
      `Two obligations:\n` +
      `1. **Do not claim** that you applied that person's method with clone fidelity. ` +
      `Say that you worked from general knowledge.\n` +
      `2. **Record in the deliverable** which experts were missing, so the owner ` +
      `can decide whether to create the mind-clone (the \`fabrica-de-genios\` squad does this ` +
      `through the \`knowledge_management.mind_clone_generation_pipeline.execute\` capability).\n`
    );
  }
  return { block: parts.join("\n\n"), decision, missingClones, mode: dnaMode, personaDirs };
}

// ── the manifest an executor reads ──────────────────────────────────────────

/** Capability fields the router and the admission gate read, never the squad
 *  that executes: they were 40–53% of a real squad.yaml, pasted whole into every
 *  dispatch. */
const ROUTING_ONLY_CAPABILITY_KEYS = ["keywords", "example_briefs", "examples", "not_for", "domains", "score_boost", "fidelity"];
const ROUTING_ONLY_TOP_KEYS = ["tags", "experimental_domains"];

/** The squad.yaml a dispatched capability needs: identity, components and
 *  runtime requirements, the dispatched capability in full minus its routing
 *  fields, and every other capability by id and description. The raw file when
 *  it does not parse or does not declare the capability. */
export function executorManifest(raw: string, capabilityId: string): string {
  let doc: any;
  try { doc = parseYaml(raw); } catch { return raw; }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.capabilities)) return raw;
  if (!doc.capabilities.some((c: any) => c && c.id === capabilityId)) return raw;
  const out: Record<string, unknown> = { ...doc };
  for (const k of ROUTING_ONLY_TOP_KEYS) delete out[k];
  out.capabilities = doc.capabilities.map((c: any) => {
    if (!c || typeof c !== "object") return c;
    if (c.id !== capabilityId) return { id: c.id, description: c.description };
    const kept: Record<string, unknown> = { ...c };
    for (const k of ROUTING_ONLY_CAPABILITY_KEYS) delete kept[k];
    return kept;
  });
  return stringifyYaml(out, { lineWidth: 0 });
}

// ── the capability a dispatch runs, as prompt sections ──────────────────────

export interface SquadCapabilityAcceptance { id: string; description: string; blocking?: boolean; minimumScore?: number }

export interface SquadCapabilityPromptContext {
  capabilityId: string;
  description: string;
  produces: string[];
  acceptance: SquadCapabilityAcceptance[];
  /** The capability's `invoke.ref`, resolved and normalized; null when the ref
   *  names no readable workflow (the manifest still describes the capability).
   *  `file` is squad-relative with POSIX separators on every platform. */
  workflow: { ref: string; file: string; steps: CanonicalStep[]; body: string } | null;
  /** Agent and task documents the workflow runs, in step order, in full — the
   *  byte ceiling is a target flagged in a trailing note, never a reason to
   *  drop one. Null when the workflow named none — the caller keeps the top-3
   *  blocks. */
  components: { agents: string; tasks: string } | null;
}

const componentsBytesMax = (): number => Number(LIMITS.squad_prompt_components_bytes_max ?? 65536);

/**
 * A path as the prompt shows it: POSIX separators on every platform, so the
 * workflow reference the squad reads is the one its `invoke.ref` declares
 * (`workflows/guided-analysis.md`) and not a Windows `path.relative` result
 * (`workflows\guided-analysis.md`). Same idiom as `verify/kinds/squad.ts`,
 * plus the literal backslash, which makes the normalization provable off
 * Windows instead of only on it.
 */
export function promptPath(p: string): string {
  return p.split(path.sep).join("/").replace(/\\/g, "/");
}

/** Component documents in step order, every one of them whole: the byte ceiling
 *  is a target reported by the caller, never a reason to lose content. The only
 *  note this adds is per-section and knowable here — a reference with no file. */
function renderComponents(squadDir: string, sub: "agents" | "tasks", stems: string[]): string {
  const parts: string[] = [];
  let missing = 0;
  for (const stem of stems) {
    const file = path.join(squadDir, sub, `${stem}.md`);
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch { missing++; continue; }
    parts.push(`--- ${stem}.md ---\n${text}`);
  }
  if (missing) parts.push(`[${missing} reference(s) without a file in ${sub}/]`);
  return parts.join("\n\n");
}

/** The ceiling note, measured on BOTH rendered sections.
 *
 *  It has to live here, not inside `renderComponents`: that function sees one
 *  section, so a note emitted from it reports a partial total. A running tally
 *  shared between the two calls got the number wrong on every squad whose agents
 *  crossed the ceiling on their own — that call reported its own overage and
 *  silenced the tasks call that would have counted the rest, understating by
 *  more than 3x where the agents half was large. Nothing is ever omitted either
 *  way; a diagnostic that understates is still a diagnostic that lies. */
function ceilingNote(agentDocs: string, taskSection: string): string {
  const max = componentsBytesMax();
  const total = Buffer.byteLength(agentDocs, "utf8") + Buffer.byteLength(taskSection, "utf8");
  if (total <= max) return "";
  // "nothing was cut by the ceiling", not "nothing was omitted": the sibling note from
  // renderComponents can be reporting a reference with no file on disk, and an
  // absolute about omission would read as contradicting it. This note answers
  // for the ceiling only — the one thing it measures.
  return `\n\n[components (agents + tasks) total ${total} bytes, ${total - max} above the ceiling of ${max}; nothing was cut by the ceiling]`;
}

/**
 * The capability's own context, read from the squad on disk: its manifest entry,
 * the workflow its `invoke.ref` names (through the v6 reader, so every legacy
 * dialect normalizes to the same graph) and the components that graph runs.
 *
 * Returns null when there is nothing better than the historical prompt: the
 * legacy `squad.execute`, an unreadable manifest, or an id the squad does not
 * declare. That null is what keeps the no-capability path byte-identical.
 */
export function capabilityContext(squadDir: string, capabilityId: string): SquadCapabilityPromptContext | null {
  if (!capabilityId || capabilityId === LEGACY_CAPABILITY_ID) return null;
  let manifest: any;
  try { manifest = parseYaml(fs.readFileSync(path.join(squadDir, "squad.yaml"), "utf8")); } catch { return null; }
  const entry = Array.isArray(manifest?.capabilities)
    ? manifest.capabilities.find((c: any) => c && typeof c === "object" && c.id === capabilityId)
    : null;
  if (!entry) return null;

  const asStrings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const acceptance: SquadCapabilityAcceptance[] = Array.isArray(entry.acceptance)
    ? entry.acceptance.filter((a: any) => a && typeof a.id === "string" && typeof a.description === "string")
      .map((a: any) => ({ id: a.id, description: a.description, blocking: a.blocking, minimumScore: a.minimumScore }))
    : [];

  const ref = typeof entry.invoke?.ref === "string" ? entry.invoke.ref : "";
  const file = ref ? resolveWorkflowRef(squadDir, ref) : null;
  const raw = file ? readWorkflow(file) : null;
  const normalized = raw?.doc ? normalizeWorkflow(raw.doc, { stem: raw.stem }) : null;

  let workflow: SquadCapabilityPromptContext["workflow"] = null;
  let components: SquadCapabilityPromptContext["components"] = null;
  if (normalized && file && raw) {
    workflow = { ref, file: promptPath(path.relative(squadDir, file)), steps: normalized.canonical.steps, body: raw.body.trim() };
    const referenced = referencedComponents(normalized.canonical);
    const stem = (name: string) => name.replace(/^(?:agents|tasks)\//, "").replace(/\.(md|markdown)$/i, "");
    const agents = referenced.agents.map(stem).filter(Boolean);
    const tasks = referenced.tasks.map(stem).filter(Boolean);
    if (agents.length || tasks.length) {
      const agentDocs = renderComponents(squadDir, "agents", agents);
      const taskDocs = renderComponents(squadDir, "tasks", tasks);
      // Only take over the blocks when at least the agents resolved: a workflow
      // whose every reference is dangling must not leave the squad with nothing.
      if (agentDocs) {
        const taskSection = taskDocs || "(the workflow references no task)";
        // The note rides the LAST section the prompt shows, so the reader meets
        // it after the content it is measuring.
        components = { agents: agentDocs, tasks: taskSection + ceilingNote(agentDocs, taskSection) };
      }
    }
  }

  return {
    capabilityId,
    description: typeof entry.description === "string" ? entry.description.trim() : "",
    produces: asStrings(entry.produces),
    acceptance,
    workflow,
    components,
  };
}

const EM_DASH_CELL = "—";

/**
 * The event vocabulary a dispatched squad needs at the moment it writes an
 * event: the CLI, the attribution flag, and the `x_` escape hatch. Inlined
 * instead of a pointer to `references/03-audit.md` — that path is inside the
 * engine skill tree, and a squad's `addDirs` never guarantees it is readable;
 * the whole premise of this cut (Cut 1, #157) is that a doc read once at
 * authoring time does not reach the agent naming an event mid-run.
 *
 * Mirrors the pattern the business loader used to ship
 * (`nrv audit emit x_clone_choice --business=<slug> --trace=<trace> --json=...`),
 * which Cut 1 measured at zero rogue events — the working precedent, not a
 * new invention.
 */
function renderEventContractBlock(squadSlug: string, traceId?: string): string {
  const trace = traceId || "<trace_id>";
  return `## HOW TO REPORT EVENTS
Emit milestones of your work with \`nrv audit emit <name> --squad=${squadSlug} --trace=${trace}\`. Always pass \`--squad=${squadSlug}\`: it is what attributes the event to you in the cockpit. The name does not need to be on the engine's closed list. If it is not, write it with the \`x_\` prefix from the start (e.g. \`x_page_height_above_budget\`), so the name that reaches the log is the one you typed. The payload goes in \`--json='{...}'\` and stays short: never the whole brief, a full output or a secret, only the summary the event needs to carry.`;
}

/** The three the prompt carries in full — but only when a capability resolved
 *  and the workflow named them. On the legacy fallback it carries three files in
 *  alphabetical order, which is not the same thing at all, so the map stays on
 *  there: that is the path with most of itself missing. */
const INLINED_DIRS = ["agents", "tasks", "workflows"];

/** The capability block, plus the workflow block when the graph resolved. */
function renderCapabilityBlock(ctx: SquadCapabilityPromptContext): string {
  const lines = ["## YOUR CAPABILITY", `- **id**: \`${ctx.capabilityId}\``];
  if (ctx.description) lines.push(`- **description**: ${ctx.description}`);
  if (ctx.produces.length) lines.push(`- **produces**: ${ctx.produces.join(", ")}`);
  if (ctx.acceptance.length) {
    lines.push("- **done when** (acceptance criteria; the blocking ones are mandatory):");
    for (const a of ctx.acceptance) {
      const marks = [a.blocking ? "blocking" : "", a.minimumScore !== undefined ? `minimum score ${a.minimumScore}` : ""].filter(Boolean);
      lines.push(`  - \`${a.id}\`${marks.length ? ` (${marks.join(", ")})` : ""} — ${a.description}`);
    }
    lines.push("- Before you finish, check each done criterion yourself.");
  }
  if (!ctx.workflow) {
    lines.push("", "> This capability does not point to a readable workflow; follow the manifest and the documents below.");
    return lines.join("\n");
  }

  const table = [
    `## YOUR WORKFLOW (\`${ctx.workflow.file}\`)`,
    "| # | step | agent | task | requires | creates |",
    "| --- | --- | --- | --- | --- | --- |",
    ...ctx.workflow.steps.map((s, i) => `| ${i + 1} | \`${s.id}\` | \`${s.agent}\` | ${s.task ? `\`${s.task}\`` : EM_DASH_CELL} | ${s.requires.length ? s.requires.map(r => `\`${r}\``).join(", ") : EM_DASH_CELL} | ${s.creates.length ? s.creates.join(", ") : EM_DASH_CELL} |`),
    "",
    "This is the squad author's reference method. The dependencies in the `requires` column hold; depth, format and what to do between one step and the next are yours, as long as the criteria above come true.",
  ];
  if (ctx.workflow.body) table.push("", ctx.workflow.body);
  return `${lines.join("\n")}\n\n${table.join("\n")}`;
}

/** Build the self-contained squad prompt — its manifest, the capability it was
 * dispatched for (when one was resolved) with that capability's workflow and
 * exactly the agents and tasks the workflow runs, mind-clone injection and the
 * brief. WITHOUT a resolved capability the string is byte-identical to the
 * historical squad prompt: the capability section is empty and
 * the component blocks fall back to the historical top-3 collection, headings
 * included. `squad-exec.test.ts` pins the whole string on that path. */
export function buildSquadPrompt(args: {
  squadSlug: string;
  squadDir: string;
  brief: string;
  outDir: string;
  cloneInjection: { block: string; decision: string; mode?: "reference" | "full" | "fragments" };
  /** The capability this dispatch runs (capability-resolver.ts). Absent, or the
   *  legacy `squad.execute`, keeps the historical prompt. */
  capabilityId?: string | null;
  /** The run's trace_id, shown in the event-contract block's example command.
   *  Absent falls back to a `<trace_id>` placeholder — never omits the block. */
  traceId?: string;
}): string {
  const { squadSlug, squadDir, brief, outDir, cloneInjection: cloneInj } = args;
  const readIfExists = (p: string) => fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const rawManifest = readIfExists(path.join(squadDir, "squad.yaml")) || "(squad.yaml missing)";
  // Collect up to ~3 agents and ~3 tasks so the prompt stays bounded.
  const agentsDir = path.join(squadDir, "agents");
  const tasksDir = path.join(squadDir, "tasks");
  const collect = (dir: string, n: number) => fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => f.endsWith(".md")).slice(0, n).map(f => `--- ${f} ---\n${fs.readFileSync(path.join(dir, f), "utf8")}`).join("\n\n")
    : "";
  const agentsBlock = collect(agentsDir, 3) || "(no agents/ dir)";
  const tasksBlock = collect(tasksDir, 3) || "(no tasks/ dir)";

  // The capability sections, or "" — the whole compatibility surface of this cut.
  // The event-contract block rides the same gate: a squad without a resolved
  // capability (legacy, undeclared) keeps the historical prompt byte for byte —
  // squad-exec.test.ts pins that path. Every squad with `capabilities[]`
  // declared (mandatory since Creation Rule 5) gets the contract for free.
  const capability = args.capabilityId ? capabilityContext(squadDir, args.capabilityId) : null;
  const manifest = capability ? executorManifest(rawManifest, capability.capabilityId) : rawManifest;
  const capabilitySection = capability
    ? `${renderCapabilityBlock(capability)}\n\n${renderEventContractBlock(squadSlug, args.traceId)}\n\n`
    : "";
  const componentsHeading = capability?.components ? "" : " (top 3)";
  const agentsSection = capability?.components?.agents ?? agentsBlock;
  const tasksSection = capability?.components?.tasks ?? tasksBlock;
  // The resource map does NOT ride that gate, and it is the one addition here
  // that does not. The byte-identical guarantee protects a legacy squad from
  // behaving differently — but a legacy squad is exactly the one whose prompt
  // carries an arbitrary alphabetical "top 3" of its agents and tasks, so it is
  // the one with most of itself missing. Gating the map behind a resolved
  // capability would withhold it precisely where it is needed most. A squad that
  // ships nothing outside agents/, tasks/ and workflows/ still gets no section,
  // which is what keeps the pin meaningful for the fixtures that have none.
  const resourceMap = renderResourceMap(squadDir, {
    kind: "squads",
    inlined: capability?.components ? INLINED_DIRS : [],
    label: "THIS SQUAD",
    sourceNoun: "of the squad",
    outputsHint: "the output directory named in your sub-task",
  });
  const resourceSection = resourceMap ? `\n${resourceMap}\n` : "";

  const roleLine = `You ARE the squad "${squadSlug}", running the client's brief end to end. Your output is the FINAL DELIVERABLE for the user.`;
  const doneLine = "Finish when the work is ready to hand to the user.";

  return `${roleLine}

## YOUR IDENTITY (squad.yaml)
\`\`\`yaml
${manifest}
\`\`\`

${capabilitySection}## YOUR AGENTS${componentsHeading}
${agentsSection}

## YOUR TASKS${componentsHeading}
${tasksSection}
${resourceSection}
## MIND-CLONES YOU EMBODY (decision: ${cloneInj.decision})
> ${cloneInj.block && cloneInj.mode === "reference"
    ? "Each clone comes as a card: open its persona files when you need the method, and deliver AS IF the clone had produced it, under the squad's specialty."
    : cloneInj.block && cloneInj.mode === "fragments"
      ? "The clones come through this phase's layers; deliver AS IF the clone had produced it, under the squad's specialty."
      : "Embody it fully; deliver AS IF the clone had produced it, under the squad's specialty."}
${cloneInj.block || "(no clone for this task: operate with the squad's default specialty)"}

## CLIENT'S ORIGINAL BRIEF
${brief}

## YOUR SUB-TASK
Run YOUR specialty applied to the brief above. Write files under \`${outDir}\`, in the format your specialty calls for; an image in them is a really generated image, never a placeholder or a generic SVG. Method and tools are yours. Deliverables follow the language of the request. Do not invoke the harness skill, and do not run \`nrv run\`/\`nrv dispatch\` for this same brief (anti-loop).

If the brief mentions you by name (e.g. "use the ${squadSlug} squad"), prioritize doing EXACTLY what the user asked in that paragraph. The user decides.

${scopeGuard()} Scope is the brief above and the acceptance criteria of your sub-task. ${scopeBoundary()}

## OUTPUT
Files in the directory above. Do not print a summary: deliver files. ${doneLine}`;
}

/**
 * Run one squad headless, with session reuse and the full audit chain.
 *
 * Session policy: resume the
 * prior session of THIS squad in THIS project when one exists; on failure with
 * a resumed session, drop the id and retry ONCE cold — reuse may only ever
 * improve the result, never degrade it.
 */
export function runSquadHeadless(args: SquadExecArgs): SquadExecResult {
  // paths.SQUADS_DIR honours SQUADS_DIR and NIRVANA_HOME; os.homedir() ignored both and, on Windows,
  // reads USERPROFILE, so a squad installed under a redirected HOME was "not found".
  const squadsRoot = args.squadsRoot ?? paths.SQUADS_DIR;
  const squadDir = path.join(squadsRoot, args.squadSlug);
  const outDir = args.outputsDir;
  fs.mkdirSync(outDir, { recursive: true });

  // The slug reaches here unvalidated: the explicit-target layer of the dispatch
  // cascade returns what the caller named without a registry lookup, and the
  // target pattern admits dots and separators. `--squad=..` therefore resolved
  // to the parent of the squads root — the user's home on a default install —
  // and everything downstream treats that as the squad: the resource map would
  // enumerate it into the prompt, and `addDirs` would hand it to the agent as a
  // workspace root. Containment is checked on the RESOLVED path, so `..`,
  // an absolute slug and a symlink out of the tree all fail the same way.
  const rootReal = fs.existsSync(squadsRoot) ? fs.realpathSync(squadsRoot) : path.resolve(squadsRoot);
  const dirResolved = fs.existsSync(squadDir) ? fs.realpathSync(squadDir) : path.resolve(squadDir);
  if (dirResolved !== rootReal && !dirResolved.startsWith(rootReal + path.sep)) {
    appendAudit({ event: "squad_run_failed", project_id: args.projectId, squad_slug: args.squadSlug, reason: "squad slug escapes the squads root" }, args.projectRoot);
    return { ok: false, squadSlug: args.squadSlug, sessionId: null, costUsd: null, durationMs: 0, outputsDir: outDir, error: "squad slug escapes the squads root" };
  }

  if (!fs.existsSync(squadDir)) {
    appendAudit({ event: "squad_run_failed", project_id: args.projectId, squad_slug: args.squadSlug, reason: "squad dir not found" }, args.projectRoot);
    return { ok: false, squadSlug: args.squadSlug, sessionId: null, costUsd: null, durationMs: 0, outputsDir: outDir, error: "squad dir not found" };
  }

  // Credentials and MCP servers the squad declares of its host: a warning
  // before the run, in the terminal and in the audit, never a block.
  {
    const pre = squadPreflight(squadDir, { cwd: args.projectRoot });
    const warnings = preflightWarnings(pre, args.squadSlug);
    for (const w of warnings) console.error(`[squad-exec] WARN: ${w}`);
    if (warnings.length) {
      appendAudit({ event: "x_preflight_warning", project_id: args.projectId, squad_slug: args.squadSlug, missing_required: pre.missingRequired.map((v) => v.name), mcps_not_configured: pre.mcpsNotConfigured.map((m) => m.name) }, args.projectRoot);
    }
  }

  const cloneInj = squadCloneInjection(args.brief, args.projectDir);
  for (const slug of cloneInj.missingClones) {
    appendAudit({
      event: "mind_clone_missing_degraded", trace_id: args.projectId, project_id: args.projectId,
      squad_slug: args.squadSlug, reason: "mind_clone_not_found", slug_requested: slug,
    }, args.projectRoot);
  }

  const prompt = buildSquadPrompt({
    squadSlug: args.squadSlug, squadDir, brief: args.brief, outDir,
    cloneInjection: cloneInj, capabilityId: args.capabilityId,
    traceId: args.projectId,
  });

  appendAudit({
    event: "dispatch_squad",
    trace_id: args.projectId,
    project_id: args.projectId,
   
    squad_slug: args.squadSlug,
    squad_name: args.squadSlug,
    ...(args.capabilityId ? { capability_id: args.capabilityId } : {}),
    mode: "squad-only",
    outputs_dir: outDir,
    // How big the thing we just built actually is. The components ceiling stopped
    // cutting documents, so the prompt is now bounded only by what the workflow
    // references — and no instrument in the engine measured it: the prompt is on
    // no event, the ledger stores a path and not content, and the cost table is
    // flat per target. One integer closes that, and it is the integer that
    // matters operationally: past MAX_ARGV_PROMPT_BYTES the driver
    // silently switches delivery — stdin and grok's --prompt-file carry the
    // prompt itself, but agy, kimi and opencode fall back to a bootstrap pointer
    // the child has to go read. A number nobody logs is a fallback nobody can
    // correlate with a bad run.
    prompt_bytes: Buffer.byteLength(prompt, "utf8"),
    // The proof-of-dispatch event says which squad, and now also what it was
    // asked to do. Bounded — see brief-excerpt.ts for the measured cap.
    brief_excerpt: briefExcerpt(args.brief),
    brief_chars: args.brief.length,
  }, args.projectRoot);

  const cascadeImpl = args.runWithCascadeImpl ?? runWithCascade;
  const cascadeArgs: Parameters<typeof runWithCascade>[0] = {
    // A squad EXECUTES. The owner rule has no exception: it may open nothing,
    // and the stamp is what makes that enforceable rather than advisory.
    dispatchRole: "squad",
    // The dispatched runtime starts in its own run folder, with the project it
    // serves granted beside it (its .nirvana/, config, logs and code-base) and
    // the other runs' folders fenced off (run-workspace.ts). The scaffold and
    // the outputs dir are handed to it as additional directories so both stay
    // writable when a caller pins them elsewhere.
    workspace: runFolderOf(args.projectDir, args.projectRoot) ?? undefined,
    // squadDir is granted so the resource map in the prompt is a door and not a
    // sign: `references/`, `checklists/`, `templates/`, `schemas/`, `config/` and
    // the rest live under it, and on claude-code and agy an ungranted path is
    // simply refused.
    //
    // Be precise about what this grants. `--add-dir` adds a WORKSPACE ROOT, and
    // this call path runs with the permission bypass, so the directory is
    // writable, not merely readable. Seven of the nine runtimes already ran with
    // no path sandbox at all, so for them this only tells the agent where the
    // tree is; for claude-code and agy it is a real new grant. The squads root is
    // global and shared by every project, so a run that writes into it changes
    // what every later dispatch reads. Nothing here enforces read-only — the
    // prompt says so in words (renderResourceMap), which is the same instrument
    // the engine uses everywhere else to keep deliverables under outputs_root.
    runtime: args.runtime, prompt, cwd: args.projectRoot, addDirs: [args.projectDir, outDir, squadDir, ...(cloneInj.personaDirs ?? [])],
    appendSystemPrompt: args.autonomousDirective + (args.rulesDirective ?? ""),
    maxBudgetUsd: args.maxBudgetUsd, timeoutMs: args.timeoutMs,
    brief: args.brief, projectRoot: args.projectRoot, outputsRoot: outDir,
    taskHint: `squad-only dispatch: ${args.squadSlug}`,
    label: `squad ${args.squadSlug}`,
    projectId: args.projectId,
    ...(args.ledger ? { ledger: { runId: args.ledger.runId, watchDir: args.ledger.watchDir ?? outDir } } : {}),
  };

  // Session reuse with the one-cold-retry fallback.
  const key = sessionKey(args.runtime, "squad", args.squadSlug);
  const prior = getSession(args.projectDir, key);
  let res = cascadeImpl(prior ? { ...cascadeArgs, sessionId: prior } : cascadeArgs);
  if (!res.ok && prior) {
    appendAudit({
      event: "session_resume_failed", trace_id: args.projectId, project_id: args.projectId,
      entity: `squad:${args.squadSlug}`, runtime: args.runtime, session_id: prior,
    }, args.projectRoot);
    dropSession(args.projectDir, key);
    res = cascadeImpl(cascadeArgs);
  } else if (prior && res.ok) {
    appendAudit({
      event: "session_resumed", trace_id: args.projectId, project_id: args.projectId,
      entity: `squad:${args.squadSlug}`, runtime: args.runtime, session_id: prior,
    }, args.projectRoot);
  }
  putSession(args.projectDir, key, res.finalRuntime ?? args.runtime, res.sessionId);

  appendAudit({
    event: "agent_executed",
    trace_id: args.projectId, project_id: args.projectId,
    squad_slug: args.squadSlug, employee: `squad:${args.squadSlug}`,
    runtime: res.finalRuntime, session_id: res.sessionId,
    cost_usd: res.costUsd, duration_ms: res.durationMs,
    mode: "squad-only",
    handoffs: res.handoffs.length ? res.handoffs : undefined,
  }, args.projectRoot);

  return {
    ok: res.ok, squadSlug: args.squadSlug, sessionId: res.sessionId,
    costUsd: res.costUsd, durationMs: res.durationMs, outputsDir: outDir,
    error: res.ok ? undefined : (res.error || res.stderr || `exit ${res.exitCode}`),
  };
}
