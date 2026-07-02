/**
 * data-loader.ts — scope-aware data access for Nirvana Glance.
 *
 * All reads are derived from the scope-aware paths.js + scope.ts. The
 * visualizer never writes anything outside the OS temp dir (and not even
 * that, in read-only mode).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { paths } from "../../../_shared/lib/bun-helpers.ts";
import { resolveScope, enumerate } from "../../../_shared/lib/scope.ts";

// Neutral skills-tree root. Resolves to ~/.nirvana/skills when present so the
// tree survives ~/.claude removal; falls back to the legacy ~/.claude/skills.
const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));

// Lazy state-db handle. SQLite-backed; falls back to empty when unavailable.
let _stateDb: any = null;
function getStateDb() {
  if (_stateDb !== null) return _stateDb;
  try {
    const sdb = require(path.join(SKILLS_ROOT, "_shared", "lib", "state-db.js"));
    const scope = resolveScope();
    const handle = sdb.openDb(scope.projectRoot);
    _stateDb = handle.available ? { sdb, handle } : false;
  } catch { _stateDb = false; }
  return _stateDb;
}

export interface ScopeSnapshot {
  mode: "global" | "project" | "merge";
  projectRoot: string | null;
  squadDirs: string[];
  businessDirs: string[];
  mindCloneDirs: string[];
  globalInclude: string[] | null;
  globalExclude: string[];
  registries: {
    squads: string;
    businesses: string;
  };
  state: {
    squads: string;
  };
  logs: {
    harness: string;
    maestro: string;
  };
}

export function getScope(): ScopeSnapshot {
  const scope = resolveScope();
  return {
    mode: scope.mode,
    projectRoot: scope.projectRoot,
    squadDirs: scope.squadDirs,
    businessDirs: scope.businessDirs,
    mindCloneDirs: scope.mindCloneDirs,
    globalInclude: scope.globalInclude ? [...scope.globalInclude] : null,
    globalExclude: [...scope.globalExclude],
    registries: {
      squads: paths.SQUADS_REGISTRY_PATH,
      businesses: paths.BUSINESSES_REGISTRY_PATH,
    },
    state: {
      squads: paths.SQUADS_STATE_DIR,
    },
    logs: {
      harness: paths.HARNESS_LOGS_DIR,
      maestro: paths.MAESTRO_LOGS_DIR,
    },
  };
}

function readJson<T = any>(p: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

export function listSquads() {
  const scope = resolveScope();
  const entries = enumerate(scope, "squads").filter(e => !e.overridden);
  const reg = readJson<any>(paths.SQUADS_REGISTRY_PATH, { squads: {} });
  return entries.map(e => {
    const meta = reg.squads?.[e.slug] ?? {};
    return {
      slug: e.slug,
      source: e.source,
      dir: e.dir,
      version: meta.version ?? "?",
      protocol: meta.protocol ?? "?",
      capabilities: meta.capabilities ?? [],
      domains: meta.domains ?? [],
      manifest_path: meta.manifest_path ?? path.join(e.dir, "squad.yaml"),
      manifest_hash: meta.manifest_hash ?? null,
    };
  }).sort((a, b) => a.slug.localeCompare(b.slug));
}

export function getSquadDetail(slug: string) {
  const scope = resolveScope();
  const match = enumerate(scope, "squads").find(e => e.slug === slug && !e.overridden);
  if (!match) return null;
  const reg = readJson<any>(paths.SQUADS_REGISTRY_PATH, { squads: {} });
  const meta = reg.squads?.[slug] ?? {};
  const manifestPath = meta.manifest_path ?? path.join(match.dir, "squad.yaml");
  const manifestRaw = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, "utf8") : null;

  // Activation state (per scope-aware STATE_DIR)
  const stateFile = path.join(paths.SQUADS_STATE_DIR, slug, "activated.json");
  const state = fs.existsSync(stateFile) ? readJson<any>(stateFile, null) : null;

  // README (first 4KB)
  const readmePath = path.join(match.dir, "README.md");
  const readme = fs.existsSync(readmePath)
    ? fs.readFileSync(readmePath, "utf8").slice(0, 4096)
    : null;

  // Agents/tasks/workflows file lists (just names, not contents)
  const ls = (sub: string) => {
    const dir = path.join(match.dir, sub);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => !f.startsWith(".")).sort();
  };

  return {
    slug,
    source: match.source,
    dir: match.dir,
    meta: {
      version: meta.version ?? "?",
      protocol: meta.protocol ?? "?",
      domains: meta.domains ?? [],
      capabilities: meta.capabilities ?? [],
      manifest_hash: meta.manifest_hash,
    },
    manifest_path: manifestPath,
    manifest_raw: manifestRaw,
    readme,
    files: {
      agents: ls("agents"),
      tasks: ls("tasks"),
      workflows: ls("workflows"),
      checklists: ls("checklists"),
    },
    activation_state: state,
  };
}

export function listBusinesses() {
  const scope = resolveScope();
  const entries = enumerate(scope, "businesses").filter(e => !e.overridden);
  const reg = readJson<any>(paths.BUSINESSES_REGISTRY_PATH, { businesses: {} });
  return entries.map(e => {
    const meta = reg.businesses?.[e.slug] ?? {};
    return {
      slug: e.slug,
      source: e.source,
      dir: e.dir,
      version: meta.version ?? "?",
      domains: meta.domains ?? [],
      employee_count: meta.employee_count ?? 0,
      business_type: meta.business_type ?? "?",
      manifest_path: meta.manifest_path ?? path.join(e.dir, "business.yaml"),
    };
  }).sort((a, b) => a.slug.localeCompare(b.slug));
}

export function getBusinessDetail(slug: string) {
  const scope = resolveScope();
  const match = enumerate(scope, "businesses").find(e => e.slug === slug && !e.overridden);
  if (!match) return null;
  const reg = readJson<any>(paths.BUSINESSES_REGISTRY_PATH, { businesses: {} });
  const meta = reg.businesses?.[slug] ?? {};
  const manifestPath = meta.manifest_path ?? path.join(match.dir, "business.yaml");
  const manifestRaw = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, "utf8") : null;

  const orgChartPath = path.join(match.dir, "org-chart.yaml");
  const orgChartRaw = fs.existsSync(orgChartPath) ? fs.readFileSync(orgChartPath, "utf8") : null;

  const routingPath = path.join(match.dir, "routing.yaml");
  const routingRaw = fs.existsSync(routingPath) ? fs.readFileSync(routingPath, "utf8") : null;

  const memoryPath = path.join(match.dir, "memory", "permanent.md");
  const memoryPreview = fs.existsSync(memoryPath)
    ? fs.readFileSync(memoryPath, "utf8").slice(0, 4096)
    : null;

  const employeesDir = path.join(match.dir, "employees");
  const employees = fs.existsSync(employeesDir)
    ? fs.readdirSync(employeesDir).filter(f => f.endsWith(".md")).map(f => f.replace(/\.md$/, "")).sort()
    : [];

  return {
    slug,
    source: match.source,
    dir: match.dir,
    meta,
    manifest_path: manifestPath,
    manifest_raw: manifestRaw,
    org_chart_raw: orgChartRaw,
    routing_raw: routingRaw,
    memory_preview: memoryPreview,
    employees,
  };
}

// ──────────────────────── Runs (audit-derived) ────────────────────────
// A "run" is a group of audit events sharing the same trace_id. Unlike
// listProjects() (which scans MAESTRO_LOGS_DIR for orchestrator metadata),
// buildRuns() works for ANY agent that emits audit events — Claude Code,
// Gemini-CLI, Codex, the auto-emit hook, anything. This is what powers
// the Projects/Runs tab in Glance with paperclip-style command-center UX.

interface Run {
  trace_id: string;
  project_id: string | null;
  cwd: string | null;
  brief: string | null;             // first brief_received text
  business_slug: string | null;
  squad_name: string | null;
  status: "running" | "delivered" | "gate_failed" | "no_match" | "unknown";
  started_at: string;               // ISO of first event
  last_event_at: string;             // ISO of last event
  event_count: number;
  artifact_paths: string[];          // unique artifacts touched
  events: any[];                    // full timeline (truncated to last 200)
  suspicious: boolean;              // fabrication detector verdict
  suspicion_score: number;
  suspicion_evidence: string[];
  hosts: string[];                  // distinct hosts seen (for UI hint)
}

export function buildRuns(opts: { since?: string; limit?: number; days?: number } = {}): { runs: Run[]; total: number } {
  // Lazy require to avoid circular import chain at startup.
  let detectFabrication: any;
  try { detectFabrication = require("../../../_shared/lib/audit-fabrication.ts").detectFabrication; }
  catch { detectFabrication = (_: any) => ({ suspicious: false, score: 0, evidence: [] }); }

  const { harnessLogsDir } = require(path.join(SKILLS_ROOT, "_shared", "lib", "log-paths.ts"));
  const HARNESS_LOGS_ROOT = harnessLogsDir();
  if (!fs.existsSync(HARNESS_LOGS_ROOT)) return { runs: [], total: 0 };

  // Walk last N days of audit logs (default 7)
  const days = opts.days ?? 7;
  const cutoffMs = Date.now() - days * 86_400_000;
  const dirs = fs.readdirSync(HARNESS_LOGS_ROOT)
    .filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .filter(n => new Date(n + "T00:00:00Z").getTime() >= cutoffMs)
    .sort();

  const runs = new Map<string, Run>();

  for (const d of dirs) {
    const f = path.join(HARNESS_LOGS_ROOT, d, "audit.jsonl");
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      const tid = ev.trace_id || "no-trace";
      if (opts.since && ev.ts < opts.since) continue;

      let r = runs.get(tid);
      if (!r) {
        r = {
          trace_id: tid,
          project_id: ev.project_id || null,
          cwd: ev.cwd || null,
          brief: null,
          business_slug: null,
          squad_name: null,
          status: "unknown",
          started_at: ev.ts,
          last_event_at: ev.ts,
          event_count: 0,
          artifact_paths: [],
          events: [],
          suspicious: false,
          suspicion_score: 0,
          suspicion_evidence: [],
          hosts: [],
        };
        runs.set(tid, r);
      }
      // Track distinct hosts (for fabrication detector + UI hint)
      if (ev.host && !r.hosts.includes(ev.host)) r.hosts.push(ev.host);
      r.event_count++;
      if (ev.ts < r.started_at) r.started_at = ev.ts;
      if (ev.ts > r.last_event_at) r.last_event_at = ev.ts;
      if (!r.project_id && ev.project_id) r.project_id = ev.project_id;
      if (!r.cwd && ev.cwd) r.cwd = ev.cwd;
      if (!r.business_slug && ev.business_slug) r.business_slug = ev.business_slug;
      if (!r.squad_name && ev.squad_name) r.squad_name = ev.squad_name;
      // Capture brief from first brief_received
      if (ev.event === "brief_received" && !r.brief) {
        r.brief = ev.brief || ev.user_input || ev.payload?.brief || null;
      }
      // Status precedence: gate_failed > delivered > no_match > running
      if (ev.event === "delivered") r.status = "delivered";
      else if (ev.event === "gate_failed" && r.status !== "delivered") r.status = "gate_failed";
      else if (ev.event === "no_match" && r.status === "unknown") r.status = "no_match";
      else if (r.status === "unknown") r.status = "running";
      // Track artifact paths
      const artifact = ev.artifact_path || (ev.event === "artifact_touched" ? ev.file_path : null);
      if (artifact && !r.artifact_paths.includes(artifact)) r.artifact_paths.push(artifact);
      // Append to event timeline (cap at 200 per run for safety)
      if (r.events.length < 200) r.events.push(ev);
    }
  }

  // Stale heartbeat: a "running" run with no event in the last 10 min is stale.
  // Distinguishes live agents from crashed/abandoned ones (was a known bug:
  // runs displayed as "running 7h ago" forever).
  const STALE_THRESHOLD_MS = 10 * 60 * 1000;
  const nowMs = Date.now();
  for (const r of runs.values()) {
    if (r.status === "running") {
      const lastMs = new Date(r.last_event_at).getTime();
      if (nowMs - lastMs > STALE_THRESHOLD_MS) {
        r.status = "stale";
        (r as any).stale_since_ms = nowMs - lastMs;
      }
    }
  }

  // Apply fabrication detector to each run's full event list
  for (const r of runs.values()) {
    const verdict = detectFabrication(r.events);
    r.suspicious = verdict.suspicious;
    r.suspicion_score = verdict.score;
    r.suspicion_evidence = verdict.evidence;
  }

  const arr = Array.from(runs.values()).sort((a, b) => b.last_event_at.localeCompare(a.last_event_at));
  const sliced = opts.limit ? arr.slice(0, opts.limit) : arr;
  return { runs: sliced, total: arr.length };
}

export function getRun(trace_id: string): Run | null {
  const { runs } = buildRuns({ days: 30 });
  return runs.find(r => r.trace_id === trace_id) || null;
}

export function listProjects() {
  const dir = paths.MAESTRO_LOGS_DIR;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => !f.startsWith(".") && fs.statSync(path.join(dir, f)).isDirectory())
    .map(id => {
      const full = path.join(dir, id);
      const stat = fs.statSync(full);
      const planPath = path.join(full, "project-plan.json");
      const dagPath = path.join(full, "dag-state.json");
      const briefPath = path.join(full, "brief.md");
      return {
        id,
        path: full,
        modified: stat.mtimeMs,
        has_plan: fs.existsSync(planPath),
        has_dag: fs.existsSync(dagPath),
        brief_preview: fs.existsSync(briefPath)
          ? fs.readFileSync(briefPath, "utf8").slice(0, 500)
          : null,
      };
    })
    .sort((a, b) => b.modified - a.modified);
}

export function getProjectDag(id: string) {
  const dir = path.join(paths.MAESTRO_LOGS_DIR, id);
  if (!fs.existsSync(dir)) return null;
  const dagPath = path.join(dir, "dag-state.json");
  const planPath = path.join(dir, "project-plan.json");
  const briefPath = path.join(dir, "brief.md");
  return {
    id,
    dir,
    dag: fs.existsSync(dagPath) ? readJson(dagPath, null) : null,
    plan: fs.existsSync(planPath) ? readJson(planPath, null) : null,
    brief: fs.existsSync(briefPath) ? fs.readFileSync(briefPath, "utf8") : null,
    waves: fs.readdirSync(dir).filter(f => f.startsWith("wave-") && fs.statSync(path.join(dir, f)).isDirectory()).sort(),
  };
}

/**
 * Read the last N audit events across the most recent day file(s).
 * Used as a fallback for /api/activity/stream when state-db is empty
 * or unavailable (was a known bug: activity sidebar showed nothing
 * until SQLite was populated).
 *
 * Returns events in newest-first order with synthetic numeric `id` so
 * the SSE delta logic upstream can de-duplicate.
 */
export function tailJsonlEvents(limit = 50): Array<any> {
  const baseDir = paths.HARNESS_LOGS_DIR;
  if (!fs.existsSync(baseDir)) return [];
  const dates = fs.readdirSync(baseDir)
    .filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .sort()
    .reverse();
  const out: any[] = [];
  for (const d of dates) {
    const f = path.join(baseDir, d, "audit.jsonl");
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    // Walk newest→oldest just for the cap, but record the original file
    // index in `_ord` so consumers can break sub-millisecond ties using
    // the actual append order (Pre fires before Post, etc.).
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        out.push({ ...ev, id: new Date(ev.ts).getTime(), _ord: i });
      } catch {}
    }
    if (out.length >= limit) break;
  }
  // Return chronological (oldest→newest) so naive consumers iterate in time order.
  out.reverse();
  return out;
}

export function tailLogs(opts: { type: "harness" | "maestro"; date?: string; limit?: number }) {
  const limit = opts.limit ?? 200;
  const baseDir = opts.type === "harness" ? paths.HARNESS_LOGS_DIR : paths.MAESTRO_LOGS_DIR;
  if (!fs.existsSync(baseDir)) return { events: [], source: baseDir, type: opts.type };

  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const dayDir = path.join(baseDir, date);
  if (!fs.existsSync(dayDir)) return { events: [], source: dayDir, type: opts.type };

  const files = fs.readdirSync(dayDir).filter(f => f.endsWith(".jsonl")).sort();
  const events: any[] = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dayDir, f), "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try { events.push({ ...JSON.parse(line), _file: f }); } catch {}
    }
  }
  return {
    events: events.slice(-limit),
    total_in_day: events.length,
    source: dayDir,
    date,
    type: opts.type,
  };
}

export function listAvailableLogDates(type: "harness" | "maestro"): string[] {
  const baseDir = type === "harness" ? paths.HARNESS_LOGS_DIR : paths.MAESTRO_LOGS_DIR;
  if (!fs.existsSync(baseDir)) return [];
  return fs.readdirSync(baseDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f))
    .sort()
    .reverse();
}

// Locale-variant filename pattern, e.g. "alex-hormozi.en.md", "naval.pt-BR.md".
// Canonical mind-clones use bare ".md"; translated variants are skipped from
// listings so the same persona doesn't appear twice in Glance/registries.
const LOCALE_VARIANT_RE = /\.[a-z]{2}(-[A-Z]{2})?\.md$/;

export function listMindClones() {
  const scope = resolveScope();
  const out: Array<{ slug: string; category: string; source: string; dir: string; format: "flat" | "canonical" }> = [];
  const seen = new Set<string>();
  const isCanonicalCloneDir = (p: string): boolean => {
    return fs.existsSync(path.join(p, "MANIFEST.yaml"))
        || fs.existsSync(path.join(p, "manifest.yaml"));
  };
  for (const root of scope.mindCloneDirs) {
    if (!fs.existsSync(root)) continue;
    const isProject = scope.mode === "project" || (scope.mode === "merge" && root === scope.mindCloneDirs[0]);
    const source = isProject ? "project" : "global";
    for (const top of fs.readdirSync(root)) {
      if (top.startsWith(".")) continue;
      const topPath = path.join(root, top);
      let topIsDir = false;
      try { topIsDir = fs.statSync(topPath).isDirectory(); } catch { continue; }
      if (!topIsDir) {
        if (top.endsWith(".md") && !LOCALE_VARIANT_RE.test(top)) {
          const slug = top.replace(/\.md$/, "");
          const key = `_root/${slug}`;
          if (!seen.has(key)) { seen.add(key); out.push({ slug, category: "_root", source, dir: root, format: "flat" }); }
        }
        continue;
      }

      // Case A: persona at top level (e.g. dna/steve-jobs/MANIFEST.yaml)
      if (isCanonicalCloneDir(topPath)) {
        const key = `_root/${top}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ slug: top, category: "_root", source, dir: topPath, format: "canonical" });
        }
        continue;
      }

      // Case B: top is a category — walk one level deeper
      for (const entry of fs.readdirSync(topPath)) {
        if (entry.startsWith(".")) continue;
        const entryPath = path.join(topPath, entry);
        let entryIsDir = false;
        try { entryIsDir = fs.statSync(entryPath).isDirectory(); } catch { continue; }

        if (entryIsDir) {
          if (!isCanonicalCloneDir(entryPath)) continue;
          const key = `${top}/${entry}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ slug: entry, category: top, source, dir: entryPath, format: "canonical" });
        } else if (entry.endsWith(".md")) {
          if (LOCALE_VARIANT_RE.test(entry)) continue;
          const slug = entry.replace(/\.md$/, "");
          const key = `${top}/${slug}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ slug, category: top, source, dir: topPath, format: "flat" });
        }
      }
    }
  }
  return out;
}

/**
 * Diagnose mind-clones library health. Detects:
 *   - missing dirs
 *   - broken symlinks (point to unmounted volumes / deleted targets)
 *   - empty categories
 *
 * Used by Glance setup mode to explain why mind-clones list is empty.
 */
export function diagnoseMindClones() {
  const scope = resolveScope();
  const issues: Array<{ kind: string; path: string; detail?: string }> = [];
  const categories: Array<{ category: string; dir: string; broken: boolean; mind_clone_count: number; target?: string }> = [];
  for (const dir of scope.mindCloneDirs) {
    if (!fs.existsSync(dir)) {
      issues.push({ kind: "missing_dir", path: dir });
      continue;
    }
    let entries: string[];
    try { entries = fs.readdirSync(dir); }
    catch (e: any) { issues.push({ kind: "unreadable_dir", path: dir, detail: e.message }); continue; }
    for (const cat of entries) {
      const catPath = path.join(dir, cat);
      let broken = false;
      let target: string | undefined;
      try {
        const lst = fs.lstatSync(catPath);
        if (lst.isSymbolicLink()) {
          target = fs.readlinkSync(catPath);
          try { fs.statSync(catPath); }
          catch { broken = true; issues.push({ kind: "broken_symlink", path: catPath, detail: `→ ${target}` }); }
        }
        if (!broken && !fs.statSync(catPath).isDirectory()) continue;
      } catch { broken = true; issues.push({ kind: "broken_path", path: catPath }); }
      let count = 0;
      if (!broken) {
        try {
          for (const f of fs.readdirSync(catPath)) {
            if (f.endsWith(".md") && !f.startsWith(".") && !LOCALE_VARIANT_RE.test(f)) count++;
          }
        } catch { broken = true; }
      }
      categories.push({ category: cat, dir: catPath, broken, mind_clone_count: count, target });
    }
  }
  const total = categories.reduce((s, c) => s + c.mind_clone_count, 0);
  return {
    library_dirs: scope.mindCloneDirs,
    total_mind_clones: total,
    categories,
    issues,
    healthy: issues.length === 0 && total > 0,
  };
}

/**
 * Look up a mind-clone with optional locale preference.
 * Tries `<slug>.<locale>.md` and `<slug>.<lang>.md` first, falling back to
 * the canonical `<slug>.md`. Returns the canonical when no translation exists.
 */
// Walk a directory recursively and return a flat list of files relative to base.
// Filters out hidden files, locale variants (.en.md, .pt-BR.md), and binaries.
function walkMindCloneFiles(baseDir: string): Array<{ rel: string; abs: string; bytes: number }> {
  const out: Array<{ rel: string; abs: string; bytes: number }> = [];
  const TEXT_EXT = /\.(md|markdown|yaml|yml|json|txt|toml|ini|cfg)$/i;
  const walk = (dir: string, prefix: string) => {
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e.startsWith(".")) continue;
      const abs = path.join(dir, e);
      let stat: fs.Stats;
      try { stat = fs.statSync(abs); } catch { continue; }
      if (stat.isDirectory()) {
        walk(abs, prefix ? `${prefix}/${e}` : e);
      } else if (stat.isFile() && TEXT_EXT.test(e)) {
        if (LOCALE_VARIANT_RE.test(e)) continue;     // skip translated variants
        out.push({ rel: prefix ? `${prefix}/${e}` : e, abs, bytes: stat.size });
      }
    }
  };
  walk(baseDir, "");
  // Sort canonical files first (AGENT.md > SOUL.md > MANIFEST.yaml > everything else alphabetical)
  const priority = (rel: string): number => {
    if (rel === "agent/AGENT.md") return 0;
    if (rel === "agent/SOUL.md")  return 1;
    if (rel === "MANIFEST.yaml" || rel === "manifest.yaml") return 2;
    if (rel === "agent/DNA-CONFIG.yaml") return 3;
    if (rel.startsWith("dna/"))      return 4;
    if (rel.startsWith("playbooks/")) return 5;
    if (rel.startsWith("dossiers/"))  return 6;
    if (rel.startsWith("memory/"))    return 7;
    return 8;
  };
  out.sort((a, b) => {
    const dp = priority(a.rel) - priority(b.rel);
    if (dp !== 0) return dp;
    return a.rel.localeCompare(b.rel);
  });
  return out;
}

export function getMindClone(category: string, slug: string, locale?: string) {
  const scope = resolveScope();

  // Prefix with category, unless the synthetic `_root` category which means
  // the persona lives directly under the mind-clones root (no category dir).
  const baseFor = (root: string) => category === "_root" ? root : path.join(root, category);

  // Filename candidates for the FLAT legacy format (locale-aware).
  const flatCandidates: string[] = [];
  if (locale) {
    const lang = locale.split("-")[0];
    flatCandidates.push(`${slug}.${locale}.md`);
    if (lang && lang !== locale) flatCandidates.push(`${slug}.${lang}.md`);
  }
  flatCandidates.push(`${slug}.md`);

  for (const root of scope.mindCloneDirs) {
    const base = baseFor(root);

    // 1. CANONICAL format: <base>/<slug>/{agent,dna,playbooks,dossiers,memory,…}
    const canonicalDir = path.join(base, slug);
    if (fs.existsSync(canonicalDir) && fs.statSync(canonicalDir).isDirectory()) {
      const tree = walkMindCloneFiles(canonicalDir);
      if (tree.length === 0) continue;

      // Build a `files` array with content for every file.
      // Cap individual file size to 256 KB so we don't blow the JSON response
      // for unusually large memory/playbook entries; truncated files include
      // a `truncated_at_bytes` marker so the UI can show "preview only".
      const MAX_BYTES = 256 * 1024;
      const files = tree.map(f => {
        let content = "";
        let truncated = false;
        try {
          if (f.bytes <= MAX_BYTES) {
            content = fs.readFileSync(f.abs, "utf8");
          } else {
            const fd = fs.openSync(f.abs, "r");
            const buf = Buffer.alloc(MAX_BYTES);
            fs.readSync(fd, buf, 0, MAX_BYTES, 0);
            fs.closeSync(fd);
            content = buf.toString("utf8");
            truncated = true;
          }
        } catch { /* leave content empty */ }
        // Categorize by top-level directory for UI grouping
        const top = f.rel.includes("/") ? f.rel.split("/")[0] : "_root";
        const language =
          /\.(yaml|yml)$/i.test(f.rel) ? "yaml" :
          /\.json$/i.test(f.rel)        ? "json" :
          /\.(md|markdown)$/i.test(f.rel) ? "markdown" :
          "text";
        return {
          path: f.rel,
          abs_path: f.abs,
          bytes: f.bytes,
          truncated,
          category: top,    // "agent" | "dna" | "playbooks" | "dossiers" | "memory" | "_root"
          language,
          content,
        };
      });

      // Concatenated content (the legacy field — kept for callers that
      // injectMindClones() into a single prompt).
      const sections: string[] = [];
      const agent = files.find(f => f.path === "agent/AGENT.md" || f.path === "AGENT.md");
      const soul  = files.find(f => f.path === "agent/SOUL.md");
      const manifest = files.find(f => f.path === "MANIFEST.yaml" || f.path === "manifest.yaml");
      if (agent)    sections.push(`# ${agent.path}\n\n${agent.content}`);
      if (soul)     sections.push(`\n\n---\n\n# ${soul.path}\n\n${soul.content}`);
      if (manifest) sections.push(`\n\n---\n\n# ${manifest.path}\n\n\`\`\`yaml\n${manifest.content}\n\`\`\``);

      return {
        category, slug,
        content: sections.join(""),                 // legacy concatenation (used by injectMindClones)
        path: agent?.abs_path || manifest?.abs_path || canonicalDir,
        format: "canonical",
        locale: null,
        is_translation: false,
        // NEW — full file tree for the UI
        dir: canonicalDir,
        files,
        total_bytes: files.reduce((s, f) => s + f.bytes, 0),
        file_count: files.length,
      };
    }

    // 2. FLAT legacy format: <base>/<slug>.md (with optional locale variants)
    for (const filename of flatCandidates) {
      const full = category === "_root" ? path.join(root, filename) : path.join(root, category, filename);
      if (fs.existsSync(full)) {
        const isCanonical = filename === `${slug}.md`;
        const content = fs.readFileSync(full, "utf8");
        return {
          category, slug,
          content,
          path: full,
          format: "flat",
          locale: isCanonical ? null : (filename.match(LOCALE_VARIANT_RE)?.[0]?.replace(/^\./, "").replace(/\.md$/, "") || null),
          is_translation: !isCanonical,
          dir: path.dirname(full),
          files: [{
            path: filename, abs_path: full,
            bytes: Buffer.byteLength(content, "utf8"),
            truncated: false, category: "_root", language: "markdown",
            content,
          }],
          total_bytes: Buffer.byteLength(content, "utf8"),
          file_count: 1,
        };
      }
    }
  }
  // Fallback: employees declare category-prefixed slugs (e.g.
  // "21-media-moguls/jane-friedman"), but the canonical library is often FLAT
  // (clones live directly under the mind-clones root, no category dir). If the
  // prefixed lookup missed, retry against the flat root so the DNA still
  // resolves. The recursive call uses "_root", so it cannot recurse again.
  if (category !== "_root") return getMindClone("_root", slug, locale);
  return null;
}

// ───────────────────────── Memory layer (state.db) ─────────────────────────
// Read-only access to SQLite-backed authoritative state: decisions_history,
// quality_gates, audit_events. Wired to ~/.nirvana/skills/_shared/lib/state-db.js.
// All helpers gracefully degrade when SQLite is unavailable (return [] or null).

export function getDecisions(filters: { project_id?: string; limit?: number } = {}) {
  const sd = getStateDb();
  if (!sd) return { available: false, decisions: [] };
  try {
    const rows = sd.sdb.listDecisions(sd.handle, filters.project_id || null, { limit: filters.limit ?? 100 });
    return { available: true, decisions: rows };
  } catch { return { available: false, decisions: [] }; }
}

export function getDecision(decisionId: string) {
  const sd = getStateDb();
  if (!sd) return null;
  try {
    const rows = sd.sdb.findDecision(sd.handle, decisionId);
    return rows ? rows : null;
  } catch { return null; }
}

export function appendDecision(decision: any) {
  const sd = getStateDb();
  if (!sd) return { ok: false, error: "state-db-unavailable" };
  try {
    const id = sd.sdb.appendDecision(sd.handle, decision);
    return { ok: true, id };
  } catch (e: any) { return { ok: false, error: e.message }; }
}

export function getGates(filters: { project_id?: string; phase?: string; verdict?: string; limit?: number } = {}) {
  const sd = getStateDb();
  if (!sd) return { available: false, gates: [] };
  try {
    const rows = sd.sdb.listGates(sd.handle, filters, filters.limit ?? 50);
    return { available: true, gates: rows };
  } catch { return { available: false, gates: [] }; }
}

export function getAuditEvents(filters: { event?: string; trace_id?: string; project_id?: string; since?: string; limit?: number } = {}) {
  const sd = getStateDb();
  if (!sd) return { available: false, events: [] };
  try {
    const rows = sd.sdb.listAudit(sd.handle, filters, filters.limit ?? 200);
    return { available: true, events: rows };
  } catch { return { available: false, events: [] }; }
}

export function getMemoryStats() {
  const sd = getStateDb();
  if (!sd) return { available: false };
  try {
    const decisions = sd.sdb.listDecisions(sd.handle, null, { limit: 999999 });
    const gates = sd.sdb.listGates(sd.handle, {}, 999999);
    const events = sd.sdb.listAudit(sd.handle, {}, 999999);
    return {
      available: true,
      db_path: sd.handle.path,
      decisions: decisions.length,
      gates: gates.length,
      events: events.length,
      gate_verdicts: gates.reduce((acc: any, g: any) => { acc[g.verdict] = (acc[g.verdict] || 0) + 1; return acc; }, {}),
    };
  } catch { return { available: false }; }
}


// ───────────────────────── Knowledge Graph ─────────────────────────
// buildGraph aggregates registries + scope + state.db decisions to produce
// {nodes, edges} for the D3 force-directed graph view. Each edge has a real
// source: routing.yaml, squad.yaml capabilities, dna refs, mind-clones.

export function buildGraph(opts: { include_decisions?: boolean } = {}) {
  const yaml = (() => {
    try { return require("yaml"); }
    catch { return { parse: (s: string) => ({}) }; }
  })();
  const linkExtractor = require(path.join(SKILLS_ROOT, "_shared", "lib", "link-extractor.js"));

  const nodes: any[] = [];
  const edges: any[] = [];
  const seen = new Set<string>();
  const addNode = (n: any) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    nodes.push(n);
  };
  const addEdge = (e: any) => {
    if (!seen.has(e.source) || !seen.has(e.target)) return;
    edges.push(e);
  };

  // Audit scores for tier coloring
  let scoresByKind: any = { squads: {}, businesses: {}, "mind-clones": {} };
  try {
    const ar = readJson<any>(path.join(paths.CLAUDE_SKILLS_DIR, "squads", ".audit-state", "scores.json"), { scores: [] });
    for (const s of ar.scores || []) scoresByKind.squads[s.slug] = { tier: s.tier, score: s.score };
  } catch {}

  // Squads → nodes
  for (const sq of listSquads()) {
    addNode({
      id: `squad:${sq.slug}`,
      type: "squad",
      slug: sq.slug,
      label: sq.slug,
      score: scoresByKind.squads[sq.slug]?.score,
      tier: scoresByKind.squads[sq.slug]?.tier,
      domains: sq.domains,
      cap_count: (sq.capabilities || []).length,
      source: sq.source,
    });
    // Capability nodes (id format: capability:<id>)
    for (const cap of sq.capabilities || []) {
      const capId = cap.id || (typeof cap === "string" ? cap : null);
      if (!capId) continue;
      addNode({ id: `capability:${capId}`, type: "capability", slug: capId, label: capId });
      addEdge({ source: `squad:${sq.slug}`, target: `capability:${capId}`, kind: "exposes" });
    }
  }

  // Businesses → nodes + routing edges to squads
  for (const biz of listBusinesses()) {
    addNode({
      id: `business:${biz.slug}`,
      type: "business",
      slug: biz.slug,
      label: biz.slug,
      domains: biz.domains,
      employees: biz.employee_count,
      source: biz.source,
    });
    // routing.yaml → business → squad
    const routingPath = path.join(biz.dir, "routing.yaml");
    if (fs.existsSync(routingPath)) {
      try {
        const r = yaml.parse(fs.readFileSync(routingPath, "utf8")) || {};
        if (r.routes && typeof r.routes === "object") {
          for (const [capId, route] of Object.entries(r.routes)) {
            if (route && typeof route === "object" && (route as any).squad) {
              addEdge({
                source: `business:${biz.slug}`,
                target: `squad:${(route as any).squad}`,
                kind: "routes-via",
                via: capId,
              });
            }
          }
        }
      } catch {}
    }
    // dna refs (mind-clones used by employees)
    const employeesDir = path.join(biz.dir, "employees");
    if (fs.existsSync(employeesDir)) {
      for (const f of fs.readdirSync(employeesDir).filter(x => x.endsWith(".md"))) {
        try {
          const content = fs.readFileSync(path.join(employeesDir, f), "utf8");
          const links = linkExtractor.extractFromContent(content);
          for (const l of links) {
            if (l.kind === "wikilink" || l.kind === "mdlink") {
              addEdge({ source: `business:${biz.slug}`, target: `mind-clone:${l.target}`, kind: "uses-mc" });
            }
          }
        } catch {}
      }
    }
  }

  // Mind-clones → nodes (top-level only — categories not duplicated)
  for (const mc of listMindClones()) {
    const id = `mind-clone:${mc.category}/${mc.slug}`;
    addNode({
      id,
      type: "mind-clone",
      slug: `${mc.category}/${mc.slug}`,
      label: mc.slug,
      category: mc.category,
      source: mc.source,
    });
  }

  // Artifacts (briefs/handoffs/plans/dags/outputs) — "what was CREATED".
  // Decisions, projects, and artifact nodes are added before edges so the
  // produced_by / led-to / decided-in edges can reference real source/target ids.
  let artifactsList: any[] = [];
  try {
    const indexer = require(require("path").join(SKILLS_ROOT, "_shared", "lib", "artifact-indexer.js"));
    const scope2 = resolveScope();
    const logsDirs = [
      paths.MAESTRO_LOGS_DIR,
      paths.HARNESS_LOGS_DIR,
      scope2.projectRoot ? require("path").join(scope2.projectRoot, ".nirvana", "logs", "maestro") : null,
      scope2.projectRoot ? require("path").join(scope2.projectRoot, ".nirvana", "logs", "harness") : null,
    ].filter(Boolean) as string[];
    const outputsDirs = [
      scope2.projectRoot ? require("path").join(scope2.projectRoot, "outputs") : null,
      scope2.projectRoot ? require("path").join(scope2.projectRoot, ".nirvana", "outputs") : null,
    ].filter(Boolean) as string[];
    // FS activity: in global mode, also pick up loose deliverables in cwd
    // (catches Claude Code Task subagent outputs that bypass Nirvana orchestration).
    const fsRoots = (scope2.projectRoot ? [scope2.projectRoot] : [process.cwd()]).filter(Boolean) as string[];
    artifactsList = indexer.indexArtifacts({
      logsDirs,
      outputsDirs,
      fsRoots,
      fsOpts: { maxDepth: 3, maxFiles: 200, sinceMs: Date.now() - 30 * 86400_000 },
    });
  } catch { artifactsList = []; }

  // Project meta-nodes (one per unique project_id seen in artifacts/decisions)
  const projectIds = new Set<string>();
  for (const a of artifactsList) if (a.project_id) projectIds.add(a.project_id);

  const decSd = getStateDb();
  let decisionsList: any[] = [];
  if (decSd) {
    try { decisionsList = decSd.sdb.listDecisions(decSd.handle, null, { limit: 50 }); } catch {}
    for (const d of decisionsList) if (d.project_id) projectIds.add(d.project_id);
  }
  for (const pid of projectIds) {
    addNode({ id: `project:${pid}`, type: "project", slug: pid, label: pid });
  }

  // Artifact nodes
  for (const a of artifactsList) {
    addNode({
      id: `artifact:${a.id}`,
      type: a.type,        // brief | plan | dag | handoff | audit_run | output
      slug: a.id,
      label: a.title || a.id,
      created_at: a.created_at,
      project_id: a.project_id,
      path: a.path,
      size_bytes: a.size_bytes,
    });
    if (a.project_id) {
      addEdge({ source: `project:${a.project_id}`, target: `artifact:${a.id}`, kind: "produced" });
    }
    if (a.parent_id) {
      addEdge({ source: `artifact:${a.parent_id}`, target: `artifact:${a.id}`, kind: "led-to" });
    }
    if (a.produced_by?.kind && a.produced_by?.slug) {
      addEdge({ source: `${a.produced_by.kind}:${a.produced_by.slug}`, target: `artifact:${a.id}`, kind: "produced-by" });
    }
  }

  // Decision nodes (always included now). Edge: decision → project.
  for (const d of decisionsList) {
    addNode({
      id: `decision:${d.id}`,
      type: "decision",
      slug: d.decision_id,
      label: d.decision_id,
      created_at: d.recorded_at,
      project_id: d.project_id,
    });
    if (d.project_id) {
      addEdge({ source: `decision:${d.id}`, target: `project:${d.project_id}`, kind: "decided-in" });
    }
  }

  return {
    nodes,
    edges,
    totals: {
      nodes: nodes.length,
      edges: edges.length,
      by_type: nodes.reduce((acc: any, n: any) => { acc[n.type] = (acc[n.type] || 0) + 1; return acc; }, {}),
    },
  };
}

