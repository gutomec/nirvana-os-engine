#!/usr/bin/env bun
// employee-prompt.ts — Build a complete, DNA-loaded prompt for spawning an
// employee subagent via Agent tool.
//
// Closes F8 from NIRVANA-OS-CORRECTION-REPORT. Previously, the maestro
// concatenated persona descriptions in prose, but never actually loaded
// the canonical employee.md content nor the mind-clone DNA symlinks.
// Output read as generic Claude, not as the declared employee.
//
// This helper:
//   1. Reads employees/<name>.md (full persona content)
//   2. Walks dna/ symlinks and includes the resolved mind-clone files
//   3. Embeds business.yaml manifest for context
//   4. Embeds HANDOFF.json current state (so the agent knows where to advance)
//   5. Appends the user's brief
//   6. Prepends a "PROTOCOL COMPLIANCE (HARD)" section telling the agent to
//      call updateHandoffPhase() and emit dispatch_squad events
//
// Also emits a `mind_clone_injected` audit event per DNA file loaded — so
// `nrv validate-trace` can verify the invariant.
//
// Usage (TypeScript):
//   import { buildEmployeePrompt } from "~/.nirvana/skills/businesses/lib/employee-prompt.ts";
//   const prompt = buildEmployeePrompt({
//     business_slug: "ads-intelligence",
//     employee: "ads-ceo",
//     project_dir: "/path/to/project",
//     brief: "Build a campaign...",
//     include_dna: true,
//     include_handoff: true,
//     outputs_root: "~/nirvana-os-launch/04-ads/",
//     trace_id: "<uuid>"
//   });
//
// Usage (CLI):
//   bun employee-prompt.ts <business_slug> <employee> <project_dir> <brief_file> [outputs_root]

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";
const requireCjs = createRequire(import.meta.url);
import { resolveScope, enumerate } from "../../_shared/lib/scope.ts";

export type BuildArgs = {
  business_slug: string;
  employee: string;
  project_dir: string;
  brief: string;
  include_dna?: boolean;
  include_handoff?: boolean;
  outputs_root?: string;
  trace_id?: string;
  /** Clones the USER explicitly asked for (highest priority). Slugs or names. */
  requested_clones?: string[];
};

import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { resolveRoutingMode } from "../../_shared/lib/routing-mode.ts";
import { listMindClones } from "../../harness/lib/glance/data-loader.ts";
import { resolveClonePersona, loadCloneRegistry } from "../../_shared/lib/clone-resolver.ts";
import { layersForPhase } from "../../_shared/lib/dna-layer-policy.ts";
import { hookForPhase } from "../../_shared/lib/hooks.ts";
import { collectContributions, orderContributions, renderHookBlock, cloneContributionSource } from "../../_shared/lib/contributions.ts";

// Untrusted-input boundary (P0-1 / Batch 3 item 7): security preamble injected
// into every employee prompt — fetched/read content is data, not instructions.
const SECURITY_CONTEXT = (() => {
  try { return fs.readFileSync(path.join(import.meta.dir, "../../_shared/fragments/security-context.md"), "utf8").trim(); }
  catch { return ""; }
})();
import { findCloneForTask, type CloneHit } from "../../_shared/lib/clone-search.ts";

const BUSINESSES_ROOT = path.join(os.homedir(), "businesses");

/** Resolve a business directory scope-aware. In scope=project|merge a
 *  project-local business overrides the global same-slug one; the global join
 *  is only the fallback when no scoped hit is found. Walks up from project_dir
 *  to find the project root (same strategy as the squad catalog resolution). */
function resolveBusinessDir(business_slug: string, project_dir: string): string {
  try {
    const hit = enumerate(resolveScope({ cwd: project_dir }), "businesses")
      .find(e => e.slug === business_slug && !e.overridden);
    if (hit) return hit.dir;
  } catch {
    // fall through to global join
  }
  return path.join(BUSINESSES_ROOT, business_slug);
}

function appendAuditEvent(project_dir: string, event: Record<string, unknown>): void {
  const today = new Date().toISOString().slice(0, 10);
  const dir = path.join(harnessLogsDir({ cwd: project_dir }), today);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "audit.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n"
    );
  } catch {
    // non-fatal
  }
}

function emitMindCloneInjected(args: { trace_id?: string; project_dir: string; business_slug: string; employee: string; clone_path: string; bytes: number }): void {
  appendAuditEvent(args.project_dir, {
    event: "mind_clone_injected",
    trace_id: args.trace_id || null,
    project_id: path.basename(path.dirname(path.dirname(args.project_dir))),
    business_slug: args.business_slug,
    employee: args.employee,
    mind_clone_path: args.clone_path,
    bytes: args.bytes,
  });
}

/** A requested-but-missing clone does NOT take the employee down — but SILENT
 *  degradation would be worse than failing: the employee would produce without
 *  the DNA and nobody would know. Same policy as dispatch.ts and
 *  team-orchestrator.ts: degradation is LOUD — this audit event, plus the
 *  explicit block in the prompt itself. */
function emitMindCloneMissingDegraded(args: { trace_id?: string; project_dir: string; business_slug: string; employee: string; slug: string }): void {
  appendAuditEvent(args.project_dir, {
    event: "mind_clone_missing_degraded",
    trace_id: args.trace_id || null,
    project_id: path.basename(path.dirname(path.dirname(args.project_dir))),
    business_slug: args.business_slug,
    employee: args.employee,
    reason: "mind_clone_not_found",
    slug_requested: args.slug,
  });
}

/** Best-effort minimal scan of a single squad.yaml without pulling in a YAML
 * parser dependency. Captures the fields the catalog block actually uses. */
function scanSquadManifest(manifestPath: string): any | null {
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const txt = fs.readFileSync(manifestPath, "utf8");
    const name = txt.match(/^name\s*:\s*(.+?)\s*$/m)?.[1]?.trim();
    if (!name) return null;
    const dmatch = txt.match(/^domains\s*:\s*\[([^\]]*)\]/m)
      || txt.match(/^domains\s*:\s*\n((?:[ \t]*-\s.+\n?)+)/m);
    const domains = dmatch
      ? (dmatch[1].includes("-") ? dmatch[1].split("\n").map(l => l.replace(/^[ \t]*-\s*/, "").trim()) : dmatch[1].split(",").map(s => s.trim().replace(/^["']|["']$/g, "")))
        .filter(Boolean)
      : [];
    const caps: string[] = [];
    const capMatch = txt.match(/^capabilities\s*:\s*\n((?:[ \t]+-[\s\S]+?)(?=^\S|\Z))/m);
    if (capMatch) for (const idm of capMatch[1].matchAll(/^[ \t]+(?:-\s*)?(?:\{[^}]*\bid\s*:\s*["']?([^"',}]+)|id\s*:\s*["']?([^"'\s]+))/gm)) caps.push((idm[1] || idm[2] || "").trim());
    return { name, manifest_path: manifestPath, domains, capabilities: caps.filter(Boolean).map(id => ({ id })) };
  } catch { return null; }
}

/** Walk each allowed squadDir, picking up manifests directly. Robust to stale
 * or absent registry caches — what's on disk wins. */
function scanSquadDirs(dirs: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const d of dirs) {
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) continue;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const meta = scanSquadManifest(path.join(d, entry.name, "squad.yaml"));
      if (meta && !out[meta.name]) out[meta.name] = meta;
    }
  }
  return out;
}

/** Resolve squads visible to the current project's scope. Strategy:
 *   global → read cache ~/.squads-registry.json (it's authoritative; the global
 *            indexer maintains it).
 *   project → scan <projectRoot>/<.nirvana/squads | squads>/ from disk. The
 *             cache may be stale or missing in fresh projects; manifests on
 *             disk are the ground truth.
 *   merge → both: cache for global + disk scan for project (project wins).
 * The manifest_path filter against scope.squadDirs is a final guard. */
function loadSquadsRegistry(projectRoot?: string): { squads: Record<string, any>; scopeMode: string; squadDirs: string[] } {
  let scope;
  try { scope = resolveScope({ cwd: projectRoot || process.cwd() }); }
  catch { scope = { mode: "global" as const, projectRoot: null, squadDirs: [] as string[] }; }

  const readGlobalCache = (): Record<string, any> => {
    const p = path.join(os.homedir(), ".squads-registry.json");
    if (!fs.existsSync(p)) return {};
    try { return JSON.parse(fs.readFileSync(p, "utf8")).squads || {}; }
    catch { return {}; }
  };

  const projectDirs = scope.squadDirs.filter(d =>
    !d.startsWith(path.join(os.homedir(), "squads")) && !d.startsWith(path.join(os.homedir(), ".claude")));
  const projectFromDisk = scanSquadDirs(projectDirs);

  let combined: Record<string, any>;
  if (scope.mode === "project") {
    combined = projectFromDisk;
  } else if (scope.mode === "merge") {
    combined = { ...readGlobalCache(), ...projectFromDisk }; // project wins on collision
  } else {
    combined = readGlobalCache();
  }

  const allowed = scope.squadDirs.map(d => path.resolve(d));
  if (!allowed.length) return { squads: {}, scopeMode: scope.mode, squadDirs: [] };
  const filtered: Record<string, any> = {};
  for (const [slug, meta] of Object.entries(combined)) {
    const mp = path.resolve((meta as any).manifest_path || "");
    if (allowed.some(d => mp === d || mp.startsWith(d + path.sep))) filtered[slug] = meta;
  }
  return { squads: filtered, scopeMode: scope.mode, squadDirs: scope.squadDirs };
}

/** Parse the squads_authorized list from an employee's YAML frontmatter. */
function authorizedSquads(employeeContent: string): string[] {
  const fm = employeeContent.match(/^---[\s\S]*?^---/m)?.[0] || "";
  // Accept both `  - item` and `- item` indentations (YAML allows both at the
  // top of a mapping value); stop at the next top-level key.
  const m = fm.match(/^squads_authorized\s*:\s*\n((?:[ \t]*-\s.+\n?)+)/m);
  if (!m) return [];
  return m[1].split("\n").map(l => l.replace(/^[ \t]*-\s*/, "").trim()).filter(Boolean);
}

/** Parse the assigned_mind_clones list from an employee's YAML frontmatter.
 *  Same shape as squads_authorized. Refs may be category-prefixed
 *  (e.g. "21-media-moguls/jane-friedman") or flat ("alex-hormozi"). */
function assignedMindClones(employeeContent: string): string[] {
  const fm = employeeContent.match(/^---[\s\S]*?^---/m)?.[0] || "";
  const m = fm.match(/^assigned_mind_clones\s*:\s*\n((?:[ \t]*-\s.+\n?)+)/m);
  if (!m) return [];
  return m[1].split("\n").map(l => l.replace(/^[ \t]*-\s*/, "").trim()).filter(Boolean);
}

/** Split a clone ref into {category, slug}. "_root" means the clone lives
 *  directly under the mind-clones root (flat library). */
function parseCloneRef(ref: string): { category: string; slug: string } {
  const i = ref.lastIndexOf("/");
  return i === -1 ? { category: "_root", slug: ref } : { category: ref.slice(0, i), slug: ref.slice(i + 1) };
}

/** Agentic catalog of every mind-clone available in the library, grouped by
 *  category. The employee's assigned_mind_clones are marked (★) as defaults;
 *  the agent may channel others or none, deciding per the task. */
function mindCloneCatalogBlock(employeeContent: string): string {
  let clones: Array<{ slug: string; category: string }> = [];
  try { clones = listMindClones(); } catch { clones = []; }
  if (!clones.length) return "";
  const assigned = new Set(assignedMindClones(employeeContent).map(r => parseCloneRef(r).slug));
  const byCat: Record<string, string[]> = {};
  for (const c of clones) {
    const label = assigned.has(c.slug) ? `${c.slug} ★` : c.slug;
    (byCat[c.category] ||= []).push(label);
  }
  const lines: string[] = [
    "## AVAILABLE MIND-CLONES (choose agentically)",
    "",
    `> ${clones.length} mind-clones in the library. The ones marked ★ are your \`assigned_mind_clones\` (DEFAULT candidates, already channeled above). You MAY consult and channel others from the catalog, or decide no extra DNA is needed for this task — the choice is yours, per the brief.`,
    `> To inspect before using: \`nrv inspect-clone <slug>\` (or \`nrv ask <slug> "<question>"\`).`,
    "",
  ];
  for (const cat of Object.keys(byCat).sort()) {
    lines.push(`**${cat}** (${byCat[cat].length}): ${byCat[cat].sort().join(", ")}`);
  }
  return lines.join("\n");
}

/** True if `squads_authorized` was DECLARED (key present), even if empty/null.
 *  Declared-but-empty => operate with the system default WITHOUT squads.
 *  Absent (never declared) => open authorization (all squads permitted). */
function squadsAuthorizedDeclared(employeeContent: string): boolean {
  const fm = employeeContent.match(/^---[\s\S]*?^---/m)?.[0] || "";
  return /^\s*squads_authorized\s*:/m.test(fm);
}

function squadCatalogBlock(employeeContent: string, projectRoot?: string): string {
  const { squads: reg, scopeMode, squadDirs } = loadSquadsRegistry(projectRoot);
  const total = Object.keys(reg).length;
  const scopeLabel = scopeMode === "global" ? "global (general registry)"
    : scopeMode === "project" ? "project (only the project's local squads)"
    : "merge (project + global)";
  if (!total) {
    return [
      "## AVAILABLE SQUADS",
      "",
      `> Scope of this run: **${scopeLabel}**. No squad available in: ${squadDirs.join(", ") || "(none)"}.`,
      `> For local projects without their own squads, run in \`merge\` or \`global\` mode to reach the general registry, or create squads under \`<projectRoot>/.nirvana/squads/\` and run \`nrv index\`.`,
    ].join("\n");
  }
  const authorized = authorizedSquads(employeeContent).filter(s => reg[s]);
  const lines: string[] = [
    "## AVAILABLE SQUADS (dispatch the specialists — don't improvise what they do better)",
    "",
    `> Scope of this run: **${scopeLabel}**. ${total} squads available. To EXECUTE one: \`nrv dispatch --auto "use squad <slug>: <sub-task>" --exec\` (naming the squad routes straight to it). To list/inspect before deciding: \`nrv list-squads\`, or read \`~/squads/<slug>/squad.yaml\`. (These are the canonical tools — the \`squads\` skill is lifecycle-only, NOT execution.)`,
    "",
  ];

  if (authorized.length) {
    lines.push("### YOUR authorized squads (CLOSED set — use these; others are a logged violation)");
    lines.push("");
    for (const slug of authorized) {
      const s = reg[slug];
      const doms = (s.domains || []).slice(0, 4).join(", ");
      const caps = (s.capabilities || []).slice(0, 3).map((c: any) => typeof c === "string" ? c : c.id).filter(Boolean).join(" · ");
      lines.push(`- **${slug}** — ${doms || "(no domains)"}${caps ? "\n  - capabilities: " + caps : ""}`);
    }
    lines.push("");
  } else if (squadsAuthorizedDeclared(employeeContent)) {
    lines.push("> **No authorized squads:** `squads_authorized` was declared EMPTY — operate with the system default, **WITHOUT dispatching squads**. Deliver yourself (via your employees/skills), without delegating to the catalog below.");
    lines.push("");
  } else {
    lines.push("> **Open authorization:** your business declared no `squads_authorized`, so **every squad in the catalog below is permitted**. Pick the best one for the sub-task.");
    lines.push("");
  }

  lines.push(`### Catalog (${total} squads in scope ${scopeMode}, compact by category)`);
  lines.push("");
  // Group by primary domain for readability. One line per squad.
  const byDomain: Record<string, string[]> = {};
  for (const [slug, meta] of Object.entries(reg)) {
    const dom = ((meta as any).domains?.[0] || "uncategorized");
    (byDomain[dom] ||= []).push(slug);
  }
  for (const dom of Object.keys(byDomain).sort()) {
    const items = byDomain[dom].sort();
    lines.push(`**${dom}** (${items.length}): ${items.join(", ")}`);
  }
  lines.push("");
  const mode = resolveRoutingMode();
  lines.push("**How to pick a squad** (active routing mode: **" + mode + "**):");
  if (mode === "fast") {
    lines.push("- `fast` mode (zero-token): run `nrv find \"<your need>\"` and use the top permitted match. Don't deliberate — it is the economy mode.");
  } else {
    lines.push("- `agentic` mode (default): reason over the catalog above (domains + capabilities) and pick the best fit, like the maestro does. Read `~/squads/<slug>/squad.yaml` when you need detail.");
  }
  lines.push("- Don't pass the raw brief: build a **brief-context** with your role and (if you are a mind-clone) your persona, hand that to the squad, then integrate its output.");
  lines.push("");
  lines.push("**When to dispatch a squad** (hard rule):");
  lines.push("- IMAGE generation (logo, hero, portrait, illustration) → ALWAYS via an image squad (e.g. `image2-virtuoso`) or the `nano-banana-pro` skill. Never generic SVG in the final deliverable.");
  lines.push("- A sub-task outside your specialty that has a dedicated squad → DISPATCH. The harness audits `dispatch_squad` and your run gets more robust.");
  lines.push("- A small task inside your specialty → do it yourself.");
  return lines.join("\n");
}

/** Scan a free-text brief for an EXPLICIT clone request — matches a known clone
 *  slug or display name as a substring (case-insensitive). Returns matched slugs.
 *  This is the "se solicitado pelo usuário" signal when no explicit
 *  requested_clones arg was passed. */
function scanBriefForClones(brief: string): string[] {
  if (!brief) return [];
  const reg = loadCloneRegistry();
  const low = brief.toLowerCase();
  const out: string[] = [];
  for (const [slug, c] of Object.entries(reg)) {
    const name = String((c as any).display_name || "").toLowerCase();
    const slugSpace = slug.replace(/-/g, " ");
    if (low.includes(slug) || low.includes(slugSpace) || (name.length > 3 && low.includes(name))) {
      out.push(slug);
    }
  }
  return out;
}

type CloneInjection = {
  personas: Array<{ slug: string; display_name: string; content: string; reason: string; bytes: number; path: string }>;
  suggestions: CloneHit[];
  decision: string;
  /** Requested clones that do not exist as installed clones. Empty in the
   *  normal case. Before this they were dropped silently: the employee ran
   *  without the DNA and neither it nor the owner ever knew. */
  missingClones: string[];
};

/** Resolve which mind-clones to channel, in the canonical priority order:
 *   1. SOLICITADO  — clones the user explicitly asked for (arg + brief scan)
 *   2. DESIGNADO   — the employee's assigned_mind_clones / embedded dna/ list
 *   3. BUSCA       — if neither, search task→clone and inject matches above the gate
 *   4. PADRÃO      — none useful → operate as the employee persona, no clone
 *  Every clone is resolved from the SINGLE library via resolveClonePersona (full
 *  embodiment), so the embedded dna/ copies are no longer the source — the dir
 *  name is only a reference. Search suggestions are always returned for agentic
 *  override. */
function resolveClonesByPriority(args: BuildArgs, employeeContent: string, bizDir: string): CloneInjection {
  // DNA injection: "full" (whole persona, default) or "fragments" (SOUL + the
  // layers relevant to the phase). Opt-in via NIRVANA_DNA_INJECTION=fragments —
  // the default keeps every run byte-identical to today's.
  const dnaMode: "full" | "fragments" =
    (process.env.NIRVANA_DNA_INJECTION || "full").toLowerCase() === "fragments" ? "fragments" : "full";
  const MAX_INJECT = dnaMode === "fragments" ? 5 : 3; // fragments are ~3-4x smaller than the whole persona
  const PER_CLONE_BUDGET = 9000;                       // per-clone byte ceiling in fragments mode
  // Usefulness gate = the coverage gate carried on each CloneHit (below_gate),
  // mirroring the router's Stage 3 bands. The old normalized>=0.5 floor was
  // vacuous: BM25 max-normalization makes the top hit 1.0 by construction,
  // so even "consertar a bomba hidráulica do trator" injected a clone.
  // The current phase (from HANDOFF) drives layer selection in fragments mode.
  let phase = "";
  try {
    const hp = path.join(args.project_dir, "HANDOFF.json");
    if (fs.existsSync(hp)) phase = JSON.parse(fs.readFileSync(hp, "utf8")).phase || "";
  } catch { /* no handoff — layersForPhase uses the default */ }
  const layers = layersForPhase(phase);
  const personas: CloneInjection["personas"] = [];
  const missingClones: string[] = [];
  const seen = new Set<string>();
  const push = (slug: string, reason: string): boolean => {
    if (!slug || seen.has(slug) || personas.length >= MAX_INJECT) return false;
    const p = dnaMode === "fragments"
      ? resolveClonePersona(slug, { depth: "fragments", layers, byteBudget: PER_CLONE_BUDGET })
      : resolveClonePersona(slug, { depth: "full" });
    // Not resolved = a requested clone that does not exist in the library.
    // Record it instead of dropping it — the consumer turns this into a loud
    // warning. The MAX_INJECT ceiling and duplicates were filtered above, so
    // the only cause left here is absence.
    if (!p) {
      if (!missingClones.includes(slug)) missingClones.push(slug);
      return false;
    }
    seen.add(slug);
    personas.push({ slug, display_name: p.display_name, content: p.content, reason, bytes: p.bytes, path: p.source });
    return true;
  };

  // 1. REQUESTED
  const requested = new Set<string>();
  for (const r of (args.requested_clones || [])) requested.add(parseCloneRef(r).slug);
  for (const s of scanBriefForClones(args.brief)) requested.add(s);
  for (const slug of requested) push(slug, "requested");
  const hadRequested = personas.length > 0;

  // 2. ASSIGNED (assigned_mind_clones + embedded dna/ dir names, resolved from the library)
  const defaults = new Set<string>();
  for (const ref of assignedMindClones(employeeContent)) defaults.add(parseCloneRef(ref).slug);
  const dnaDir = path.join(bizDir, "dna");
  if (fs.existsSync(dnaDir)) {
    try {
      for (const f of fs.readdirSync(dnaDir, { withFileTypes: true })) {
        if (f.isDirectory() || f.isSymbolicLink()) defaults.add(f.name.replace(/\.md$/, ""));
      }
    } catch { /* unreadable dna dir — skip */ }
  }
  let hadDefaults = false;
  if (!hadRequested) {
    for (const slug of defaults) push(slug, "assigned");
    hadDefaults = personas.length > 0;
  }

  // search runs always (for suggestions); injects only when nothing above won
  let suggestions: CloneHit[] = [];
  try { suggestions = findCloneForTask(args.brief, { limit: 5 }); } catch { suggestions = []; }

  // 3. SEARCH
  if (!hadRequested && !hadDefaults) {
    for (const h of suggestions) {
      if (h.below_gate === false) push(h.slug, `search coverage ${h.coverage?.matched}/${h.coverage?.total}`);
    }
  }

  // 4. decision trace
  const decision = hadRequested ? "REQUESTED by the user"
    : hadDefaults ? "ASSIGNED to the employee"
    : personas.length ? "found by SEARCH for the task"
    : "DEFAULT — no useful clone, employee persona";

  return { personas, suggestions, decision, missingClones };
}

export function buildEmployeePrompt(args: BuildArgs): string {
  const bizDir = resolveBusinessDir(args.business_slug, args.project_dir);
  if (!fs.existsSync(bizDir)) {
    throw new Error(`Business not found: ${bizDir}`);
  }

  const employeePath = path.join(bizDir, "employees", `${args.employee}.md`);
  if (!fs.existsSync(employeePath)) {
    throw new Error(`Employee not found: ${employeePath}`);
  }
  const employeeContent = fs.readFileSync(employeePath, "utf8");
  // Let resolveScope walk up from project_dir to find the project root via
  // .env / .nirvana / .git markers. Don't hand-roll a "two levels up" rule:
  // dispatch passes <root>/businesses/<slug>, but other callers may not.
  const squadsBlock = squadCatalogBlock(employeeContent, args.project_dir);
  const mindCloneCatalog = mindCloneCatalogBlock(employeeContent);

  const bizYamlPath = path.join(bizDir, "business.yaml");
  const bizYaml = fs.existsSync(bizYamlPath) ? fs.readFileSync(bizYamlPath, "utf8") : "(business.yaml missing)";

  // Cross-session recall: inject the business's permanent memory (clamped)
  // into the prompt. It used to be written and NEVER read back by the agent —
  // this closes the loop.
  let memoryBlock = "";
  try {
    const memPath = path.join(bizDir, "memory", "permanent.md");
    if (fs.existsSync(memPath)) {
      let mem = fs.readFileSync(memPath, "utf8").trim();
      const head = mem.slice(0, 120).toLowerCase();
      const isStub = !mem || /^#?\s*permanent memory\s*$/i.test(mem) || /\(\s*(empty|vazio)/.test(head) || /_vazio_/.test(head);
      if (!isStub) {
        const MEM_BUDGET = 8000;
        if (mem.length > MEM_BUDGET) mem = mem.slice(0, MEM_BUDGET) + "\n\n…(memory truncated)";
        memoryBlock = `## PERMANENT BUSINESS MEMORY (cross-session)\n\n> Lessons, decisions and principles persisted from previous runs. Honor them.\n\n${mem}\n\n---\n\n`;
      }
    }
  } catch { /* unreadable — skip */ }

  // Temporal recall (Batch 3 / 6-temporal): the business's active facts in the
  // state-db (supersede-never-delete). Best-effort — proceeds without it when
  // sqlite is unavailable.
  try {
    const sdb = requireCjs("../../_shared/lib/state-db.js");
    const h = sdb.openDb(resolveScope().projectRoot || undefined);
    const recs = sdb.activeMemories(h, args.business_slug, 20);
    if (recs.length) {
      const lines = recs.map((r: any) => `- ${r.statement}${r.source ? ` _(${r.source})_` : ""}`).join("\n");
      memoryBlock += `## ACTIVE TEMPORAL MEMORY — ${args.business_slug}\n\n> Facts/decisions in force (supersede-never-delete). Honor the active ones.\n\n${lines}\n\n---\n\n`;
    }
  } catch { /* state-db unavailable — proceed without temporal recall */ }

  // Mind-clone resolution by priority (REQUESTED → ASSIGNED → SEARCH → DEFAULT).
  // Every clone is resolved from the SINGLE library via resolveClonePersona
  // (full embodiment: AGENT + SOUL + dna-schema), so the embedded dna/ copies
  // are no longer the source of truth — the dir name is only a reference.
  let dnaContent = "";
  let cloneDecision = "(DNA not requested)";
  let cloneSuggestions = "";
  let contributionsBlock = "";
  if (args.include_dna !== false) {
    const inj = resolveClonesByPriority(args, employeeContent, bizDir);
    cloneDecision = inj.decision;
    for (const p of inj.personas) {
      dnaContent += `\n\n--- MIND-CLONE: ${p.slug} — ${p.display_name} (${p.reason}; ${p.bytes}b; ${path.relative(os.homedir(), p.path)}) ---\n\n${p.content}`;
      emitMindCloneInjected({
        trace_id: args.trace_id,
        project_dir: args.project_dir,
        business_slug: args.business_slug,
        employee: args.employee,
        clone_path: p.path,
        bytes: p.bytes,
      });
    }
    // Loud degradation: the employee runs, but knowing (and saying) it does
    // NOT carry that person's DNA. Same policy as dispatch.ts / team-orchestrator.ts.
    if (inj.missingClones.length) {
      const list = inj.missingClones.join(", ");
      dnaContent += `\n\n--- MISSING MIND-CLONE: ${list} ---\n\n` +
        `# Expert with no clone in the library\n\n` +
        `The following experts were requested and do NOT exist as installed mind-clones: ` +
        `**${list}**.\n\n` +
        `You are NOT loading these people's DNA. Work from your own knowledge of ` +
        `their method, and treat it as what it is: an approximation, not the persona.\n\n` +
        `Two obligations:\n` +
        `1. **Do not claim** you applied that person's method with clone fidelity. ` +
        `Say you acted on general knowledge.\n` +
        `2. **Record in the deliverable** which experts were missing, so the owner ` +
        `can decide whether to create the mind-clone (the \`fabrica-de-genios\` squad does ` +
        `that via the capability \`knowledge_management.mind_clone_generation_pipeline.execute\`).\n`;
      for (const slug of inj.missingClones) {
        emitMindCloneMissingDegraded({
          trace_id: args.trace_id,
          project_dir: args.project_dir,
          business_slug: args.business_slug,
          employee: args.employee,
          slug,
        });
      }
    }
    // Contributions (P0-1): fragments the injected clones register on the
    // current phase's hook. No-op while no clone declares contributions in
    // its MANIFEST.
    try {
      let ph = "";
      const hp = path.join(args.project_dir, "HANDOFF.json");
      if (fs.existsSync(hp)) ph = JSON.parse(fs.readFileSync(hp, "utf8")).phase || "";
      const hook = hookForPhase(ph);
      const sources = inj.personas
        .map((p) => cloneContributionSource(p.slug, p.path))
        .filter((s): s is NonNullable<typeof s> => !!s);
      const block = renderHookBlock("employee", hook, orderContributions(collectContributions(sources, "employee", hook)));
      if (block) contributionsBlock = `\n\n---\n\n${block}\n\n`;
    } catch { /* contributions are best-effort */ }
    if (inj.suggestions.length) {
      cloneSuggestions = ["", "**Other candidates by search** (you may swap/add; inspect with `nrv ask <slug>` or `nrv find-clone \"<task>\"`):",
        ...inj.suggestions.slice(0, 5).map(h => `- ${h.normalized.toFixed(2)} \`${h.slug}\`${h.one_liner ? " — " + h.one_liner : ""}`)].join("\n");
    }
  }

  let handoffContent = "(no HANDOFF.json — initialize with writeHandoff before execute)";
  if (args.include_handoff !== false) {
    const handoffPath = path.join(args.project_dir, "HANDOFF.json");
    if (fs.existsSync(handoffPath)) {
      handoffContent = fs.readFileSync(handoffPath, "utf8");
    }
  }

  // Prose rules live in the project's AGENTS.md / CLAUDE.md / GEMINI.md
  // (auto-loaded by the runtime). No injection here — the runtime context
  // is the single source of truth for the writing contract.

  return `# Employee Runtime — ${args.employee}@${args.business_slug}

You are operating as the employee **${args.employee}** of the business **${args.business_slug}**. The sections below are your full operational context. **Read them carefully before acting.**

---

## PROTOCOL COMPLIANCE (HARD RULES — read first)

You operate inside Nirvana-OS. You MUST:

1. **Read \`HANDOFF.json\` on start.** The current phase tells you where to resume.
2. **Advance phases via \`updateHandoffPhase()\`:**
   - Before your first artifact write: call \`updateHandoffPhase(projectDir, "execute", {nextTaskId: "T-001"})\`.
   - After finishing all artifacts: call \`updateHandoffPhase(projectDir, "complete", {lastTaskCompleted: ...})\`.
   - The helper is at \`~/.nirvana/skills/_shared/lib/handoff.js\` — import via Node/Bun.
3. **Prefer squads — discover them mode-aware (BP §13.4).** You are an orchestrator: before doing an atomic deliverable by hand, find a squad for it (see "AVAILABLE SQUADS" below). Brief names a squad → use it. Else discover via the active routing mode: \`agentic\` → reason over the catalog; \`fast\` → \`nrv find\`. No \`squads_authorized\` declared → all squads permitted. Hand the squad a brief-context built from your role + persona, not the raw brief. Each dispatch emits a \`dispatch_squad\` audit event.
4. **After all artifacts are written**, run:
   \`bun ~/.nirvana/skills/businesses/scripts/verify-deliverable.ts <project_id> ${args.business_slug}\`
   If it returns FAIL, fix the gaps before declaring done.
5. **Write artifacts to the declared outputs_root path**, not to \`.nirvana/outputs/\` (the harness will copy them later if needed).

If you cannot complete the brief in this session (rate limit, context overflow), set \`phase: "execute"\` with \`last_task_completed\` set to the last artifact written, then stop. Next session will resume cleanly.

---

## YOUR PERSONA (from employees/${args.employee}.md)

${employeeContent}

---

## MIND-CLONES YOU EMBODY — decision: ${cloneDecision}

> System order: clone **REQUESTED** by the user → else **SEARCH** for the most useful one for the task → else **default persona**. The clones below are already embodied IN FULL (AGENT + SOUL + DNA); deliver the work AS IF the clone had produced it, under your employee instructions.${dnaContent || "\n\n(no useful clone for this task — operate as the employee's default persona, without a clone)"}${cloneSuggestions}

---

${mindCloneCatalog ? mindCloneCatalog + "\n\n---\n\n" : ""}${squadsBlock}

---

## YOUR BUSINESS MANIFEST (business.yaml)

\`\`\`yaml
${bizYaml}
\`\`\`

---

${memoryBlock}## CURRENT HANDOFF STATE

\`\`\`json
${handoffContent}
\`\`\`

---

## PROJECT PATHS

- **project_dir** (for HANDOFF.json, audit.jsonl): \`${args.project_dir}\`
- **outputs_root** (where you write artifacts the user will see): \`${args.outputs_root || args.project_dir}\`
- **trace_id**: \`${args.trace_id || "(not provided)"}\`

---

${SECURITY_CONTEXT ? SECURITY_CONTEXT + "\n\n---\n\n" : ""}${contributionsBlock}## THE BRIEF

${args.brief}

---

## REMEMBER

- You are not a generic Claude. You are ${args.employee} of ${args.business_slug}, channeling the mind-clones above.
- Honor the brief. Honor the protocol. Verify before declaring done.
- If the brief asks for N artifacts, deliver N — not "summary saying you delivered N".
`;
}

// CLI wrapper
if (import.meta.main) {
  const [, , slug, employee, projectDir, briefFile, outputsRoot] = process.argv;
  if (!slug || !employee || !projectDir || !briefFile) {
    console.error("Uso: bun employee-prompt.ts <business_slug> <employee> <project_dir> <brief_file> [outputs_root]");
    process.exit(2);
  }
  if (!fs.existsSync(briefFile)) {
    console.error(`Brief file not found: ${briefFile}`);
    process.exit(2);
  }
  const brief = fs.readFileSync(briefFile, "utf8");
  console.log(
    buildEmployeePrompt({
      business_slug: slug,
      employee,
      project_dir: projectDir,
      brief,
      include_dna: true,
      include_handoff: true,
      outputs_root: outputsRoot,
    })
  );
}
