// evidence.ts — what is actually proven about a squad, a business or a mind-clone.
//
// `nrv validate` answers one question: is the entity well formed. That is not
// the same as "it delivered", "it has not changed since", "this machine has
// what it needs" or "it is on a host". Each of those is a different kind of
// proof with a different source, so each is reported on its own, and "not
// measured" is an answer in its own right: it never counts as a pass.
//
// Everything here only reads. Nothing is written, no audit event is emitted,
// and every function answers "not measured" instead of throwing when the
// entity or the audit is missing.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { Database } from "bun:sqlite";
import { paths } from "../../_shared/lib/bun-helpers.ts";
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
import { nirvanaHome } from "../../_shared/lib/deps-home.ts";
import { hermesProfileDir, hermesSoulFile } from "../../_shared/lib/hermes-bots.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { listOpenBotAgents, openBotAgentLabels, openBotInstructionFile } from "../../_shared/lib/openbot.ts";
import { squadPreflight } from "../../_shared/lib/squad-preflight.ts";
import { GENERATED_FILES, extractSurface } from "../../_shared/lib/surface.ts";
import { recordedFlows } from "../../_shared/lib/team-flow.ts";
import { hermesMemberId, teamOfText } from "../../_shared/lib/team-hosts.ts";
import { loadTeam, scopeLibrary, teamFileOf, type TeamSpec } from "../../_shared/lib/team.ts";
import {
  MODULES, applyBaseline, defaultBaselinePath, exitCodeFor, findingKey, VERIFY_EXIT,
  type Baseline, type Finding, type Kind, type KindModule, type VerifyReport,
} from "../../_shared/lib/verify/index.ts";
import { resolveLedgerDbPath } from "./run-ledger.ts";

export type { Kind } from "../../_shared/lib/verify/index.ts";

export const ANSWERS = ["verified", "failed", "stale", "not measured", "does not apply"] as const;
export type Answer = typeof ANSWERS[number];

export const DIMENSIONS = ["structure", "delivered", "changed_since", "dependencies", "on_host"] as const;
export type Dimension = typeof DIMENSIONS[number];

export const DIMENSION_TITLE: Record<Dimension, string> = {
  structure: "structure",
  delivered: "delivered",
  changed_since: "changed since",
  dependencies: "dependencies",
  on_host: "on a host",
};

export interface Evidence {
  dimension: Dimension;
  answer: Answer;
  /** When the proof was produced (ISO), or null. */
  date: string | null;
  /** What produced the proof: a file, an audit event, a live check. */
  proof: string | null;
  /** One plain sentence a reader can act on. */
  detail: string;
  /** What to run to measure or repair it, when there is something to run. */
  action: string | null;
  /** The numbers and items behind the sentence, for `--json`. */
  data?: Record<string, unknown>;
}

export interface EntityEvidence {
  schema: "nirvana.evidence/v1";
  kind: Kind;
  slug: string;
  /** The entity folder, or null when the library has no such entity. */
  dir: string | null;
  checked_at: string;
  evidence: Record<Dimension, Evidence>;
}

export interface EvidenceOptions {
  /** The entity folder; resolved from the library when absent. */
  dir?: string | null;
  /** Where `verify.json` and `activated.json` live (`<stateDir>/<slug>/`). */
  stateDir?: string;
  /** Audit roots to read (`<root>/<YYYY-MM-DD>/audit.jsonl`). */
  auditRoots?: string[];
  /** The admission gate's debt baseline; null reads none. */
  baselinePath?: string | null;
  /** false: never run the admission checks here, only read what was recorded. */
  live?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Folders holding a `.nirvana/team.yaml`. */
  teamDirs?: string[];
  /** Resolves a program on PATH (a test seam). */
  which?: (tool: string) => string | null;
  /** Resolves a slug to its folder (a test seam; the library's scope when absent). */
  resolve?: (kind: Kind, slug: string) => string | null;
  /** Stands in for the kind's admission checks (a test seam). */
  module?: KindModule;
}

const answer = (dimension: Dimension, a: Answer, detail: string, rest: Partial<Evidence> = {}): Evidence =>
  ({ dimension, answer: a, date: null, proof: null, detail, action: null, ...rest });

const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "an unknown date");
const cliKind = (kind: Kind): string => (kind === "mind-clone" ? "clone" : kind);

/** Never throws: a dimension that cannot be read is not measured, with the reason. */
function guarded<T extends Evidence | Promise<Evidence>>(dimension: Dimension, fn: () => T): T {
  const failed = (e: unknown) => answer(dimension, "not measured", `this could not be read: ${(e as Error)?.message ?? e}`);
  try {
    const r = fn();
    return (r instanceof Promise ? r.catch(failed) : r) as T;
  } catch (e) { return failed(e) as T; }
}

// ── the entity on disk ───────────────────────────────────────────────

export function entityDir(kind: Kind, slug: string, opts: EvidenceOptions = {}): string | null {
  if (opts.dir !== undefined) return opts.dir && fs.existsSync(opts.dir) ? path.resolve(opts.dir) : null;
  return resolveSlug(kind, slug, opts);
}

function resolveSlug(kind: Kind, slug: string, opts: EvidenceOptions): string | null {
  try { return opts.resolve ? opts.resolve(kind, slug) : MODULES[kind].resolveDir(slug); } catch { return null; }
}

const SKIP_DIRS = new Set(["node_modules", "__pycache__"]);
const GENERATED = new Set<string>(GENERATED_FILES);

/**
 * The newest file of the entity, by modification time. Generated files, dot
 * entries (a Finder or Explorer visit rewrites some of them) and links are
 * left out: none of them is the entity changing.
 */
export function newestFile(dir: string): { file: string; mtimeMs: number } | null {
  let newest: { file: string; mtimeMs: number } | null = null;
  const walk = (d: string) => {
    let names: string[] = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const name of names) {
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      const abs = path.join(d, name);
      let st: fs.Stats;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { walk(abs); continue; }
      if (GENERATED.has(name)) continue;
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { file: abs, mtimeMs: st.mtimeMs };
    }
  };
  walk(dir);
  return newest;
}

function readJson(file: string): any | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

const stateDirOf = (opts: EvidenceOptions): string => opts.stateDir ?? (paths as Record<string, string>).SQUADS_STATE_DIR;

// ── 1. structure ─────────────────────────────────────────────────────

function findingsLine(findings: Finding[]): string {
  const errors = findings.filter((f) => f.severity === "error" && !f.baselined);
  const shown = errors.slice(0, 3).map((f) => `${findingKey(f)} (${f.message})`).join("; ");
  return `${errors.length} error(s): ${shown}${errors.length > 3 ? "; ..." : ""}`;
}

/**
 * The admission gate, for the entity as it is on disk now. A verdict that
 * `nrv validate` recorded counts only while no file is newer than it. With no
 * current record the same checks run here, reading only: no fixer, no state
 * file, no audit event, and the baseline is read without the one-time import
 * of legacy files that `nrv validate` performs.
 */
export async function structureEvidence(kind: Kind, slug: string, opts: EvidenceOptions = {}): Promise<Evidence> {
  return guarded("structure", async () => {
    const command = `nrv validate ${kind} ${slug}`;
    const dir = entityDir(kind, slug, opts);
    if (!dir) return answer("structure", "not measured", `no ${kind} named ${slug} was found in the library.`, { action: `nrv list-${kind === "mind-clone" ? "clones" : kind === "business" ? "businesses" : "squads"}` });

    const file = path.join(stateDirOf(opts), slug, "verify.json");
    const recorded = readJson(file) as VerifyReport | null;
    const record = recorded && recorded.kind === kind && typeof recorded.checked_at === "string" && recorded.dir && path.resolve(recorded.dir) === dir ? recorded : null;
    const newest = newestFile(dir);
    const current = !!record && (!newest || newest.mtimeMs <= Date.parse(record.checked_at));

    if (record && current) {
      // A --strict run rejects on warnings alone; the gate itself admits those.
      const admitted = record.verdict === "ADMITTED" || (record.strict && record.summary?.errors === 0);
      return admitted
        ? answer("structure", "verified", `the admission gate admitted it on ${day(record.checked_at)}, and no file changed after that.`, { date: record.checked_at, proof: `${command}, recorded in ${file}`, data: { verdict: record.verdict, summary: record.summary } })
        : answer("structure", "failed", `the admission gate rejected it on ${day(record.checked_at)} with ${findingsLine(record.findings ?? [])}.`, { date: record.checked_at, proof: `${command}, recorded in ${file}`, action: `${command} --fix`, data: { verdict: record.verdict, summary: record.summary } });
    }

    if (opts.live === false) {
      return record
        ? answer("structure", "stale", `the admission gate last ran on ${day(record.checked_at)} and ${path.relative(dir, newest!.file)} changed after that.`, { date: record.checked_at, proof: file, action: command })
        : answer("structure", "not measured", "no admission gate result is recorded for it.", { action: command });
    }

    const module = opts.module ?? MODULES[kind];
    const findings = await module.check({ kind, slug, dir, retrieval: false });
    const baselineFile = opts.baselinePath === undefined ? defaultBaselinePath() : opts.baselinePath;
    const baseline = baselineFile ? (readJson(baselineFile) as Baseline | null) : null;
    applyBaseline(kind, slug, findings, new Set(module.criteria.filter((c) => c.baselineable).map((c) => c.id)), baseline?.entities ? baseline : null);
    const now = new Date().toISOString();
    const proof = "the admission checks, run here just now without writing anything";
    const why = record ? `the recorded result of ${day(record.checked_at)} predates a file change, so the checks ran again` : "nothing was recorded, so the checks ran here";
    return exitCodeFor(findings, false) === VERIFY_EXIT.ADMITTED
      ? answer("structure", "verified", `the admission gate admits it as it is on disk now (${why}).`, { date: now, proof })
      : answer("structure", "failed", `the admission gate rejects it as it is on disk now with ${findingsLine(findings)}.`, { date: now, proof, action: `${command} --fix` });
  });
}

// ── the audit ────────────────────────────────────────────────────────

interface AuditEvent { event: string; ts: number; trace: string; file: string; data: Record<string, any> }

const WANTED = /dispatch_business|dispatch_squad|mind_clone_injected|x_clone_credited|gate_passed|delivered|x_delivery_withheld/;
const WANTED_EVENTS = new Set([
  "dispatch_business", "dispatch_squad", "mind_clone_injected", "x_clone_credited",
  "gate_passed", "delivered", "x_delivered_with_reservations", "x_delivery_withheld",
]);

/** Project roots the run ledger knows: where earlier dispatches wrote their audit. */
function ledgerProjectRoots(): string[] {
  try {
    const file = resolveLedgerDbPath();
    if (!fs.existsSync(file)) return [];
    const db = new Database(file, { readonly: true });
    try {
      return (db.query("SELECT DISTINCT project_root FROM runs WHERE project_root IS NOT NULL").all() as Array<{ project_root: string }>).map((r) => r.project_root);
    } finally { db.close(); }
  } catch { return []; }
}

/**
 * Every audit root worth reading: this project's, the one used outside any
 * project, and the log of each project the run ledger has seen a dispatch in.
 * An audit is per project, so a single root would miss most deliveries.
 */
export function auditRoots(opts: EvidenceOptions = {}): string[] {
  if (opts.auditRoots) return [...new Set(opts.auditRoots.map((r) => path.resolve(r)))];
  const roots = [harnessLogsDir({ cwd: opts.cwd }), harnessLogsDir({ projectRoot: os.homedir() })];
  if (!process.env.HARNESS_LOGS_DIR) for (const root of ledgerProjectRoots()) roots.push(path.join(root, ".nirvana", "logs", "harness"));
  return [...new Set(roots.map((r) => path.resolve(r)))].filter((r) => fs.existsSync(r));
}

interface AuditIndex {
  byTrace: Map<string, AuditEvent[]>;
  /** `<kind>:<slug>` → the traces the entity took part in, with the surface hash its dispatch recorded. */
  entityTraces: Map<string, Map<string, { surfaceHash: string | null }>>;
  gatePassed: Set<string>;
}

const auditCache = new Map<string, AuditIndex>();

/** The entities an event places in its run: a dispatched business or squad, a clone whose DNA was loaded or credited. */
function entitiesOf(e: AuditEvent): string[] {
  const d = e.data;
  const keys = (kind: Kind, ...slugs: unknown[]) => slugs.filter((s): s is string => typeof s === "string" && !!s).map((s) => `${kind}:${s}`);
  if (e.event === "dispatch_business") return keys("business", d.business_slug ?? d.business);
  if (e.event === "dispatch_squad") return keys("squad", d.squad_slug ?? d.squad_name ?? d.squad);
  if (e.event === "mind_clone_injected") return keys("mind-clone", d.slug, d.resolved_slug);
  if (e.event === "x_clone_credited") return keys("mind-clone", d.clone);
  return [];
}

/** The dispatch and delivery events of the given roots, indexed; read once per process. */
function auditIndex(roots: string[]): AuditIndex {
  const key = roots.join("\n");
  const hit = auditCache.get(key);
  if (hit) return hit;
  const events: AuditEvent[] = [];
  for (const root of roots) {
    let days: string[] = [];
    try { days = fs.readdirSync(root); } catch { continue; }
    for (const file of [path.join(root, "audit.jsonl"), ...days.map((d) => path.join(root, d, "audit.jsonl"))]) {
      let text = "";
      try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
      for (const line of text.split("\n")) {
        if (!WANTED.test(line)) continue;
        let e: Record<string, any>;
        try { e = parseAuditLine(line); } catch { continue; }
        if (!e || !WANTED_EVENTS.has(e.event)) continue;
        const ts = typeof e.ts === "number" ? e.ts : Date.parse(String(e.ts ?? ""));
        const trace = String(e.trace_id ?? e.project_id ?? "");
        if (!trace || !Number.isFinite(ts)) continue;
        events.push({ event: e.event, ts, trace, file, data: e });
      }
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  const index: AuditIndex = { byTrace: new Map(), entityTraces: new Map(), gatePassed: new Set() };
  for (const e of events) {
    if (e.event === "gate_passed") index.gatePassed.add(e.trace);
    const list = index.byTrace.get(e.trace);
    if (list) list.push(e); else index.byTrace.set(e.trace, [e]);
    const hash = typeof e.data.surface_hash === "string" ? e.data.surface_hash : null;
    for (const entity of entitiesOf(e)) {
      let traces = index.entityTraces.get(entity);
      if (!traces) index.entityTraces.set(entity, traces = new Map());
      const seen = traces.get(e.trace);
      if (!seen) traces.set(e.trace, { surfaceHash: hash });
      else if (hash) seen.surfaceHash = hash;
    }
  }
  auditCache.set(key, index);
  return index;
}

/** Forget what was read from the audit (tests write a log, then read it again). */
export function resetEvidenceCache(): void { auditCache.clear(); }

export interface DeliveryRecord {
  /** Runs dispatched with this entity in them. */
  dispatched: number;
  /** Delivered with the gate passing and no reservation. */
  passed: number;
  /** Delivered with reservations: the gate did not pass clean. */
  reservations: number;
  withheld: number;
  latestPass: { ts: string; trace: string; file: string; surfaceHash: string | null } | null;
  latestOther: { ts: string; trace: string; outcome: "reservations" | "withheld" } | null;
  roots: string[];
}

/**
 * What the audit says this entity delivered. A run belongs to the entity when
 * its trace carries the entity's dispatch (a business, a squad) or the record
 * of its DNA being loaded or credited (a mind-clone). For a squad or a clone
 * that means the run it took part in, which may be a business's run.
 */
export function deliveryRecord(kind: Kind, slug: string, opts: EvidenceOptions = {}): DeliveryRecord {
  const roots = auditRoots(opts);
  const rec: DeliveryRecord = { dispatched: 0, passed: 0, reservations: 0, withheld: 0, latestPass: null, latestOther: null, roots };
  const index = auditIndex(roots);
  const traces = index.entityTraces.get(`${kind}:${slug}`);
  if (!traces) return rec;
  rec.dispatched = traces.size;

  const events = [...traces.keys()].flatMap((t) => index.byTrace.get(t) ?? []).sort((a, b) => a.ts - b.ts);
  for (const e of events) {
    // A business is judged by its own deliveries, not by another's in the same trace.
    if (kind === "business" && e.data.business_slug && e.data.business_slug !== slug) continue;
    const ts = new Date(e.ts).toISOString();
    if (e.event === "x_delivery_withheld") {
      rec.withheld++;
      rec.latestOther = { ts, trace: e.trace, outcome: "withheld" };
    } else if (e.event === "delivered") {
      const clean = !e.data.reservations && (e.data.gate === "pass" || (e.data.gate === undefined && index.gatePassed.has(e.trace)));
      if (clean) { rec.passed++; rec.latestPass = { ts, trace: e.trace, file: e.file, surfaceHash: traces.get(e.trace)!.surfaceHash }; }
      else { rec.reservations++; rec.latestOther = { ts, trace: e.trace, outcome: "reservations" }; }
    }
  }
  return rec;
}

function dispatchCommand(kind: Kind, slug: string): string {
  if (kind === "business") return `nrv dispatch ${slug} "<brief>" --exec`;
  if (kind === "squad") return `nrv dispatch --squad ${slug} "<brief>" --exec`;
  return `nrv dispatch --auto "<a brief that names ${slug}>" --exec`;
}

// ── 2. delivered ─────────────────────────────────────────────────────

/** At least one run of the entity ended delivered with the gate passing. */
export function deliveredEvidence(kind: Kind, slug: string, opts: EvidenceOptions = {}): Evidence {
  return guarded("delivered", () => {
    const rec = deliveryRecord(kind, slug, opts);
    const action = dispatchCommand(kind, slug);
    const data = { dispatched: rec.dispatched, passed: rec.passed, with_reservations: rec.reservations, withheld: rec.withheld, latest_pass: rec.latestPass?.ts ?? null, audit_roots: rec.roots };
    const counts = `${rec.passed} delivered with the gate passing, ${rec.reservations} delivered with reservations, ${rec.withheld} withheld`;
    if (rec.latestPass) {
      return answer("delivered", "verified", `${counts}; the latest passing delivery was on ${day(rec.latestPass.ts)}.`, {
        date: rec.latestPass.ts, proof: `the delivered event of run ${rec.latestPass.trace} in ${rec.latestPass.file}`, data,
      });
    }
    if (rec.latestOther) {
      return answer("delivered", "failed", `no run passed the gate: ${counts}; the latest, on ${day(rec.latestOther.ts)}, was ${rec.latestOther.outcome === "withheld" ? "withheld" : "delivered with reservations"}.`, {
        date: rec.latestOther.ts, proof: `run ${rec.latestOther.trace} in the audit`, action, data,
      });
    }
    if (rec.dispatched) return answer("delivered", "not measured", `${rec.dispatched} run(s) were dispatched and none reached a delivery verdict in the audit.`, { action, data });
    return answer("delivered", "not measured", rec.roots.length
      ? `no run of it is in the audit that was read (${rec.roots.join(", ")}).`
      : "there is no audit log to read yet.", { action, data });
  });
}

// ── 3. changed since ─────────────────────────────────────────────────

/**
 * Whether the entity's files changed after its latest passing delivery. By
 * content when the dispatch recorded a surface hash, otherwise by file date,
 * and the answer says which.
 */
export function changedSinceEvidence(kind: Kind, slug: string, opts: EvidenceOptions = {}): Evidence {
  return guarded("changed_since", () => {
    const action = dispatchCommand(kind, slug);
    const dir = entityDir(kind, slug, opts);
    if (!dir) return answer("changed_since", "not measured", `no ${kind} named ${slug} was found in the library.`);
    const pass = deliveryRecord(kind, slug, opts).latestPass;
    if (!pass) return answer("changed_since", "not measured", "there is no passing delivery to compare the files with.", { action });

    if (pass.surfaceHash) {
      const now = extractSurface(dir, kind).surface_hash;
      const proof = `the surface hash recorded at the dispatch of run ${pass.trace}`;
      return now === pass.surfaceHash
        ? answer("changed_since", "verified", `by content hash: the entity is the one that delivered on ${day(pass.ts)}.`, { date: pass.ts, proof, data: { method: "content hash" } })
        : answer("changed_since", "stale", `by content hash: the entity is no longer the one that delivered on ${day(pass.ts)}.`, { date: pass.ts, proof, action, data: { method: "content hash" } });
    }

    const newest = newestFile(dir);
    const proof = `file dates under ${dir} against the delivery of run ${pass.trace}`;
    if (newest && newest.mtimeMs > Date.parse(pass.ts)) {
      const changed = new Date(newest.mtimeMs).toISOString();
      return answer("changed_since", "stale", `by file date: ${path.relative(dir, newest.file)} changed on ${day(changed)}, after the passing delivery of ${day(pass.ts)}.`, {
        date: changed, proof, action, data: { method: "file date", newest_file: newest.file, newest_file_at: changed, delivered_at: pass.ts },
      });
    }
    return answer("changed_since", "verified", `by file date: no file is newer than the passing delivery of ${day(pass.ts)}.`, { date: pass.ts, proof, data: { method: "file date", delivered_at: pass.ts } });
  });
}

// ── 4. dependencies ──────────────────────────────────────────────────

export interface DependencyItem {
  type: "system" | "credential" | "mcp" | "packages";
  name: string;
  required: boolean;
  /** Never a value: a credential is "set" or "not set". */
  state: "present" | "missing" | "set" | "not set" | "configured" | "not configured" | "installed" | "not installed" | "outdated";
  squad?: string;
}

const PACKAGE_KEYS = ["python", "node", "services", "custom_nodes", "models"];
const PROBE_WORDS = new Set(["command", "which", "where", "type", "-v"]);

/** The program a `system:` entry names: the entry itself, or what its `check:` runs. */
function systemTool(dep: unknown): string | null {
  if (typeof dep === "string") return dep.trim().split(/[\s<>=!~]/)[0] || null;
  if (!dep || typeof dep !== "object") return null;
  const d = dep as { name?: unknown; check?: unknown };
  const words = typeof d.check === "string" ? d.check.trim().split(/\s+/).filter((w) => !PROBE_WORDS.has(w)) : [];
  const first = words[0] && /^[\w.+-]+$/.test(words[0]) ? words[0] : null;
  return first ?? (typeof d.name === "string" && d.name.trim() ? d.name.trim() : null);
}

let activatorMemo: any = null;
function declaredDeps(squadDir: string): any {
  activatorMemo ??= createRequire(import.meta.url)(path.resolve(import.meta.dir, "..", "..", "squads", "lib", "activator.js"));
  return activatorMemo.declaredDeps(squadDir);
}

function squadDependencyItems(slug: string, dir: string, opts: EvidenceOptions): DependencyItem[] {
  const which = opts.which ?? ((tool: string) => Bun.which(tool));
  const items: DependencyItem[] = [];
  let deps: any = null;
  try { deps = declaredDeps(dir); } catch { deps = null; }
  if (deps && typeof deps === "object") {
    for (const dep of Array.isArray(deps.system) ? deps.system : []) {
      const tool = systemTool(dep);
      if (tool) items.push({ type: "system", name: tool, required: true, state: which(tool) ? "present" : "missing" });
    }
    const declared = PACKAGE_KEYS.filter((k) => deps[k] && (!Array.isArray(deps[k]) || deps[k].length) && (typeof deps[k] !== "object" || Object.keys(deps[k]).length));
    if (declared.length) {
      // Packages, services and models are installed by `nrv activate`, which
      // records when it last succeeded; probing each one here would run the
      // squad's own check commands.
      const state = readJson(path.join(stateDirOf(opts), slug, "activated.json"));
      const at = Date.parse(String(state?.activated_at ?? ""));
      let depsAt = 0;
      try { depsAt = fs.statSync(path.join(dir, "dependencies.yaml")).mtimeMs; } catch { /* synthesized from package manifests */ }
      items.push({ type: "packages", name: declared.join(", "), required: true, state: !Number.isFinite(at) ? "not installed" : depsAt > at ? "outdated" : "installed" });
    }
  }
  const pre = squadPreflight(dir, { env: opts.env, cwd: opts.cwd });
  for (const v of pre.env) items.push({ type: "credential", name: v.name, required: v.required, state: v.set ? "set" : "not set" });
  for (const m of pre.mcps) items.push({ type: "mcp", name: m.name, required: m.required, state: m.configured_in.length ? "configured" : "not configured" });
  return items;
}

/** The squads a business names in its manifest. */
function businessSquads(dir: string): string[] {
  try {
    const doc = Bun.YAML.parse(fs.readFileSync(path.join(dir, "business.yaml"), "utf8")) as any;
    const list = [...(Array.isArray(doc?.squads_authorized) ? doc.squads_authorized : []), ...(Array.isArray(doc?.squads_preferred) ? doc.squads_preferred : [])];
    return [...new Set(list.filter((s): s is string => typeof s === "string" && !!s))];
  } catch { return []; }
}

/**
 * What the entity declares it needs and whether this machine has it. A squad
 * declares it in `dependencies.yaml`; a business needs what its squads need; a
 * mind-clone is text and needs nothing.
 */
export function dependenciesEvidence(kind: Kind, slug: string, opts: EvidenceOptions = {}): Evidence {
  return guarded("dependencies", () => {
    if (kind === "mind-clone") return answer("dependencies", "does not apply", "a mind-clone is text: it declares no programs, credentials or MCP servers.");
    const dir = entityDir(kind, slug, opts);
    if (!dir) return answer("dependencies", "not measured", `no ${kind} named ${slug} was found in the library.`);

    let items: DependencyItem[] = [];
    const unknownSquads: string[] = [];
    if (kind === "squad") items = squadDependencyItems(slug, dir, opts);
    else {
      for (const squad of businessSquads(dir)) {
        const squadDir = resolveSlug("squad", squad, opts);
        if (!squadDir) { unknownSquads.push(squad); continue; }
        items.push(...squadDependencyItems(squad, squadDir, opts).map((i) => ({ ...i, squad })));
      }
    }
    const label = (i: DependencyItem) => `${i.name}${i.squad ? ` (${i.squad})` : ""}`;
    const data = { items, ...(unknownSquads.length ? { squads_not_installed: unknownSquads } : {}) };
    if (items.length === 0 && unknownSquads.length === 0) {
      return answer("dependencies", "does not apply", kind === "squad" ? "it declares no dependencies." : "the squads it names declare no dependencies.", { data });
    }

    const activate = (i: DependencyItem) => `nrv activate ${i.squad ?? slug}`;
    const missing = items.filter((i) => i.required && ["missing", "not set", "not configured"].includes(i.state));
    if (missing.length || unknownSquads.length) {
      const parts = [
        ...missing.filter((i) => i.type === "system").map((i) => `the program ${label(i)} is not on PATH`),
        ...missing.filter((i) => i.type === "credential").map((i) => `the credential ${label(i)} is not set`),
        ...missing.filter((i) => i.type === "mcp").map((i) => `no host configuration names the MCP server ${label(i)}`),
        ...unknownSquads.map((s) => `the squad ${s} is not installed`),
      ];
      const first = missing[0];
      return answer("dependencies", "failed", `${parts.join("; ")}.`, {
        date: new Date().toISOString(), proof: "PATH, the environment and the host MCP configuration of this machine, read just now",
        action: !first ? `nrv install ${unknownSquads[0]}` : first.type === "system" ? `install ${first.name}, then ${activate(first)}` : first.type === "credential" ? `set ${first.name} in the environment` : `add the MCP server ${first.name} to the host runtime's configuration`,
        data,
      });
    }
    const packages = items.filter((i) => i.type === "packages" && i.state !== "installed");
    if (packages.length) {
      const p = packages[0];
      return p.state === "outdated"
        ? answer("dependencies", "stale", `dependencies.yaml${p.squad ? ` of ${p.squad}` : ""} changed after the last activation, so the installed packages (${p.name}) may not match it.`, { action: activate(p), data })
        : answer("dependencies", "not measured", `it declares packages (${label(p)}) and no activation is recorded on this machine.`, { action: activate(p), data });
    }
    const optional = items.filter((i) => !i.required && ["not set", "not configured"].includes(i.state));
    return answer("dependencies", "verified", `all ${items.length - optional.length} declared dependencies are present on this machine${optional.length ? `; optional and absent: ${optional.map(label).join(", ")}` : ""}.`, {
      date: new Date().toISOString(), proof: "PATH, the environment, the host MCP configuration and the activation record of this machine, read just now", data,
    });
  });
}

// ── 5. on a host ─────────────────────────────────────────────────────

function teamDirs(opts: EvidenceOptions): string[] {
  if (opts.teamDirs) return opts.teamDirs;
  const dirs: string[] = [];
  const home = path.join(nirvanaHome(), "teams");
  try { for (const name of fs.readdirSync(home).sort()) dirs.push(path.join(home, name)); } catch { /* no team yet */ }
  dirs.push(opts.cwd ?? process.cwd());
  return dirs;
}

interface Placement { where: string; file: string }

/** Where the members of a team that carry this entity are written, as `nrv team status` finds them. */
function teamPlacements(kind: Kind, slug: string, dir: string, spec: TeamSpec, openbot: Array<{ id: string; name: string; file: string; team: string | null }>): { members: number; placed: Placement[] } {
  const members = spec.members.filter((m) => (kind === "business" ? m.role_from?.split("/")[0] === slug : m.clones.includes(slug)));
  const placed: Placement[] = [];
  for (const m of members) {
    for (const a of openbot) {
      if (a.team === spec.team && a.name.toLowerCase() === m.name.toLowerCase()) placed.push({ where: `OpenBot agent ${a.id} (${m.name}, team ${spec.team})`, file: a.file });
    }
    const soul = hermesSoulFile(hermesProfileDir(hermesMemberId(spec, m)));
    try { if (teamOfText(fs.readFileSync(soul, "utf8")) === spec.team) placed.push({ where: `Hermes Bot @${hermesMemberId(spec, m)} (team ${spec.team})`, file: soul }); } catch { /* no such Bot */ }
    const subagent = path.join(dir, ".claude", "agents", `${spec.team}-${m.id}.md`);
    if (m.id !== spec.orchestrator && fs.existsSync(subagent)) placed.push({ where: `Claude Code subagent ${spec.team}-${m.id} in ${dir}`, file: subagent });
  }
  return { members: members.length, placed };
}

const fileDate = (file: string): string | null => {
  try { return fs.statSync(file).mtime.toISOString(); } catch { return null; }
};

/**
 * Whether the entity is written into a bot host right now. A business or a
 * mind-clone gets there as a member of a team (`nrv team sync`); a squad gets
 * there as a workflow built from it (`nrv team flow`).
 */
export function hostEvidence(kind: Kind, slug: string, opts: EvidenceOptions = {}): Evidence {
  return guarded("on_host", () => {
    if (kind === "squad") {
      const flows = listOpenBotAgents().flatMap((a) => recordedFlows(a.id).filter((f) => f.squad === slug).map((f) => ({ agent: a.id, flow: f })));
      if (!flows.length) return answer("on_host", "does not apply", "no host workflow was built from this squad.", { action: `nrv team flow ${slug}` });
      const f = flows[0];
      return answer("on_host", "verified", `it runs as the OpenBot workflow "${f.flow.title}" (${f.flow.workflowId}) of agent ${f.agent}${flows.length > 1 ? `, and ${flows.length - 1} more` : ""}.`, {
        proof: "the workflow record `nrv team flow --created` wrote", data: { workflows: flows.map((x) => ({ agent: x.agent, workflow: x.flow.workflow, workflow_id: x.flow.workflowId })) },
      });
    }

    const labels = openBotAgentLabels();
    const openbot = listOpenBotAgents().filter((a) => a.server === null).flatMap((a) => {
      const name = labels.get(a.id)?.name;
      if (!name) return [];
      const file = openBotInstructionFile(a.dir);
      let text = "";
      try { text = fs.readFileSync(file, "utf8"); } catch { /* no instruction file */ }
      return [{ id: a.id, name, file, team: teamOfText(text) }];
    });

    const naming: string[] = [];
    const placed: Placement[] = [];
    for (const dir of teamDirs(opts)) {
      const file = teamFileOf(dir);
      if (!fs.existsSync(file)) continue;
      let spec: TeamSpec | null = null;
      try { spec = loadTeam(file, scopeLibrary(dir)).spec; } catch { /* not a team file */ }
      if (!spec) continue;
      const r = teamPlacements(kind, slug, dir, spec, openbot);
      if (r.members) naming.push(spec.team);
      placed.push(...r.placed);
    }
    if (!naming.length) return answer("on_host", "does not apply", "no team on this machine names it, so there is nothing to find on a host.", { action: 'nrv team init <slug> "<what the team is for>"' });
    if (!placed.length) {
      return answer("on_host", "failed", `the team ${naming.join(", ")} names it and no member carrying it is written into a host.`, { action: `nrv team sync --team ${naming[0]}`, data: { teams: naming } });
    }
    const dates = placed.map((p) => fileDate(p.file)).filter((d): d is string => !!d).sort();
    return answer("on_host", "verified", `it is written into ${placed.map((p) => p.where).join("; ")}.`, {
      date: dates[dates.length - 1] ?? null, proof: placed.map((p) => p.file).join(", "), data: { teams: naming, placements: placed },
    });
  });
}

// ── all five ─────────────────────────────────────────────────────────

export async function entityEvidence(kind: Kind, slug: string, opts: EvidenceOptions = {}): Promise<EntityEvidence> {
  const dir = entityDir(kind, slug, opts);
  const resolved = { ...opts, dir };
  const evidence = {
    structure: await structureEvidence(kind, slug, resolved),
    delivered: deliveredEvidence(kind, slug, resolved),
    changed_since: changedSinceEvidence(kind, slug, resolved),
    dependencies: dependenciesEvidence(kind, slug, resolved),
    on_host: hostEvidence(kind, slug, resolved),
  };
  // A delivery proves the entity that delivered. Once its files changed, the
  // proof is about an earlier entity: it is shown as stale, never as verified.
  if (evidence.delivered.answer === "verified" && evidence.changed_since.answer === "stale") {
    evidence.delivered = {
      ...evidence.delivered, answer: "stale",
      detail: `${evidence.delivered.detail} The files changed after it, so it proves an earlier version.`,
      action: dispatchCommand(kind, slug),
    };
  }
  return { schema: "nirvana.evidence/v1", kind, slug, dir, checked_at: new Date().toISOString(), evidence };
}

/** Every entity of the given kinds in the library, recorded proof only unless `live` is set. */
export async function libraryEvidence(kinds: readonly Kind[], opts: EvidenceOptions = {}): Promise<EntityEvidence[]> {
  const out: EntityEvidence[] = [];
  for (const kind of kinds) {
    let refs: Array<{ slug: string; dir: string }> = [];
    try { refs = MODULES[kind].listAll(); } catch { /* an empty library */ }
    for (const ref of refs) out.push(await entityEvidence(kind, ref.slug, { live: false, ...opts, dir: ref.dir }));
  }
  return out;
}

// ── text ─────────────────────────────────────────────────────────────

export function renderEntity(e: EntityEvidence): string {
  const lines = [`Evidence for the ${e.kind} ${e.slug}${e.dir ? ` (${e.dir})` : ""}`, ""];
  for (const d of DIMENSIONS) {
    const ev = e.evidence[d];
    lines.push(`${DIMENSION_TITLE[d]}: ${ev.answer}${ev.date && ev.answer !== "not measured" ? ` (${day(ev.date)})` : ""}`);
    lines.push(`  ${ev.detail}`);
    if (ev.proof) lines.push(`  Proof: ${ev.proof}.`);
    if (ev.action) lines.push(`  ${ev.answer === "not measured" ? "To measure it" : "Next"}: ${ev.action}`);
  }
  const open = DIMENSIONS.filter((d) => e.evidence[d].answer === "not measured");
  lines.push("", open.length
    ? `Not measured: ${open.map((d) => DIMENSION_TITLE[d]).join(", ")}. Not measured is not a pass.`
    : "Every dimension that applies was measured.");
  return lines.join("\n");
}

export function renderTable(rows: EntityEvidence[]): string {
  if (!rows.length) return "No entity was found in the library. List it with: nrv list-squads, nrv list-businesses, nrv list-clones.";
  const header = ["kind", "entity", ...DIMENSIONS.map((d) => DIMENSION_TITLE[d])];
  const body = rows.map((r) => [cliKind(r.kind), r.slug, ...DIMENSIONS.map((d) => r.evidence[d].answer)]);
  const width = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(width[i])).join("  ").trimEnd();
  const count = (a: Answer) => rows.reduce((n, r) => n + DIMENSIONS.filter((d) => r.evidence[d].answer === a).length, 0);
  return [
    line(header),
    ...body.map(line),
    "",
    `${rows.length} entities. ${ANSWERS.map((a) => `${count(a)} ${a}`).join(", ")}.`,
    "Structure here is the result `nrv validate` recorded; `nrv evidence <kind> <slug>` runs the checks and explains every answer.",
    "Not measured is not a pass.",
  ].join("\n");
}
