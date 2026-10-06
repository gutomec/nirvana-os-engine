/**
 * services.ts — third-party services on the cockpit, declared by a manifest.
 *
 * The engine row (subsystems.ts) can only show what this file knows about; a
 * service the operator runs beside the engine (a backup, a mirror, a watcher)
 * had no way into the cockpit short of editing the server. Here it gets one
 * without touching code: a `service.yaml` that says who it is and a status file
 * the service itself writes to say how it is. Glance reads both.
 *
 * Contract `nirvana.glance.service/v1`. Two scopes, project first:
 *
 *   <projectRoot>/.nirvana/glance/services/<slug>/service.yaml
 *   ~/.nirvana/glance/services/<slug>/service.yaml
 *
 * The same three rules as subsystems.ts bind every reading:
 *
 *   1. NO INVENTED GREEN. A service is `up` only when IT wrote a valid status
 *      recently. No status, a stale one or an invalid one answers `null`.
 *   2. NO SIDE EFFECTS. Nothing is created; a missing directory is an empty list.
 *   3. NO NETWORK, NO SPAWN, NO CODE. The manifest's `url` is a link the view
 *      shows, never something Glance fetches; nothing under the service's
 *      directory is executed or served.
 *
 * Everything that reaches the view is plain text, truncated to a bound.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Subsystem, SubsystemStatus } from "./subsystems.ts";

export const SERVICE_SCHEMA = "nirvana.glance.service/v1";
export const STATUS_SCHEMA = "nirvana.glance.service-status/v1";

/** Bounds of the contract; a file past its bound is not read to the end. */
export const LIMITS = {
  servicesPerScope: 50,
  manifestBytes: 64 * 1024,
  statusBytes: 16 * 1024,
  label: 24,
  detail: 200,
  description: 200,
  owner: 120,
  ttlDefaultSeconds: 300,
  ttlMinSeconds: 10,
  ttlMaxSeconds: 86_400,
} as const;

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type ServiceScope = "project" | "global";

/** One cell on the services row: a Subsystem plus what the manifest declared. */
export interface Service extends Subsystem {
  scope: ServiceScope;
  description: string | null;
  owner: string | null;
  /** http(s) only, shown as a link; anything else is dropped at parse time. */
  url: string | null;
  /** A path relative to the service directory, shown as text. */
  docs: string | null;
}

interface Manifest {
  slug: string;
  label: string;
  description: string | null;
  owner: string | null;
  statusFile: string;
  ttlSeconds: number;
  url: string | null;
  docs: string | null;
}

const NIRVANA_HOME = () => process.env.NIRVANA_HOME || os.homedir();

/** Where each scope keeps its services. Exported so the tests build the same tree. */
export function servicesDir(scope: ServiceScope, projectRoot: string): string {
  const base = scope === "project" ? projectRoot : NIRVANA_HOME();
  return path.join(base, ".nirvana", "glance", "services");
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/**
 * A path the manifest names must stay inside the service's own directory:
 * relative, no `..`, no absolute form, and — once resolved on disk — no symlink
 * that leads out. Returns the resolved path or null when the rule is broken.
 */
function insideDir(dir: string, relative: unknown): string | null {
  if (typeof relative !== "string" || !relative.trim()) return null;
  if (path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) return null;
  const segments = relative.split(/[\\/]+/);
  if (segments.some(s => s === "..")) return null;
  const candidate = path.resolve(dir, relative);
  const rel = path.relative(dir, candidate);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return candidate;
}

/** The same check after following symlinks, for a file that exists. */
function realInsideDir(dir: string, file: string): boolean {
  try {
    const realDir = fs.realpathSync.native(dir);
    const realFile = fs.realpathSync.native(file);
    const rel = path.relative(realDir, realFile);
    return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/** Reads at most `max` bytes; a file larger than that answers null, unread. */
function readBounded(file: string, max: number): string | null {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > max) return null;
  return fs.readFileSync(file, "utf8");
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Parses one manifest; the string is the reason it is invalid. */
function parseManifest(dir: string, dirSlug: string): Manifest | string {
  const file = path.join(dir, "service.yaml");
  if (!fs.existsSync(file)) return "service.yaml not found";
  let raw: string | null;
  try { raw = readBounded(file, LIMITS.manifestBytes); } catch (e: any) { return `service.yaml unreadable: ${e?.message || e}`; }
  if (raw === null) return `service.yaml larger than ${LIMITS.manifestBytes} bytes`;
  let doc: any;
  try { doc = parseYaml(raw); } catch (e: any) { return `service.yaml is not valid YAML: ${e?.message || e}`; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return "service.yaml is not a mapping";
  if (doc.schema !== SERVICE_SCHEMA) return `schema must be ${SERVICE_SCHEMA}`;
  if (typeof doc.slug !== "string" || !SLUG.test(doc.slug)) return "slug must match ^[a-z0-9][a-z0-9-]{0,63}$";
  if (doc.slug !== dirSlug) return `slug "${doc.slug}" differs from directory "${dirSlug}"`;
  const label = text(doc.label, LIMITS.label);
  if (!label) return "label is required";
  const status = doc.status && typeof doc.status === "object" ? doc.status : null;
  if (!status || !insideDir(dir, status.file)) return "status.file must be a relative path inside the service directory";
  let ttlSeconds: number = LIMITS.ttlDefaultSeconds;
  if (status.ttl_seconds !== undefined) {
    const n = Number(status.ttl_seconds);
    if (!Number.isInteger(n) || n < LIMITS.ttlMinSeconds || n > LIMITS.ttlMaxSeconds) {
      return `status.ttl_seconds must be an integer from ${LIMITS.ttlMinSeconds} to ${LIMITS.ttlMaxSeconds}`;
    }
    ttlSeconds = n;
  }
  return {
    slug: doc.slug,
    label,
    description: text(doc.description, LIMITS.description),
    owner: text(doc.owner, LIMITS.owner),
    statusFile: status.file,
    ttlSeconds,
    url: httpUrl(doc.url),
    docs: doc.docs !== undefined && insideDir(dir, doc.docs) ? String(doc.docs) : null,
  };
}

interface Reading { status: SubsystemStatus; detail: string; source: string | null }

/** The status file, judged: written, valid, recent — or an honest null with the reason. */
function readStatus(dir: string, manifest: Manifest, now: number): Reading {
  const file = insideDir(dir, manifest.statusFile)!;
  if (!fs.existsSync(file)) return { status: null, detail: "no status written yet", source: file };
  if (!realInsideDir(dir, file)) return { status: null, detail: "invalid status: file resolves outside the service directory", source: file };
  let raw: string | null;
  try { raw = readBounded(file, LIMITS.statusBytes); } catch (e: any) { return { status: null, detail: `invalid status: ${e?.message || e}`, source: file }; }
  if (raw === null) return { status: null, detail: `invalid status: larger than ${LIMITS.statusBytes} bytes`, source: file };
  let doc: any;
  try { doc = JSON.parse(raw); } catch { return { status: null, detail: "invalid status: not valid JSON", source: file }; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { status: null, detail: "invalid status: not an object", source: file };
  if (doc.schema !== STATUS_SCHEMA) return { status: null, detail: `invalid status: schema must be ${STATUS_SCHEMA}`, source: file };
  if (doc.status !== "up" && doc.status !== "down") return { status: null, detail: "invalid status: status must be \"up\" or \"down\"", source: file };
  const updated = typeof doc.updated_at === "string" ? Date.parse(doc.updated_at) : NaN;
  if (!Number.isFinite(updated)) return { status: null, detail: "invalid status: updated_at must be an ISO 8601 timestamp", source: file };
  const ageMs = now - updated;
  if (ageMs > manifest.ttlSeconds * 1000) {
    return { status: null, detail: `stale: last update ${Math.floor(ageMs / 60_000)} min ago`, source: file };
  }
  return { status: doc.status, detail: text(doc.detail, LIMITS.detail) || doc.status, source: file };
}

function readScope(scope: ServiceScope, projectRoot: string, now: number): Service[] {
  const root = servicesDir(scope, projectRoot);
  let entries: string[];
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
    entries = fs.readdirSync(root).filter(name => {
      try { return fs.statSync(path.join(root, name)).isDirectory(); } catch { return false; }
    });
  } catch {
    return [];
  }
  entries.sort();
  return entries.slice(0, LIMITS.servicesPerScope).map((dirSlug): Service => {
    const dir = path.join(root, dirSlug);
    const key = `${scope}:${dirSlug}`;
    const base = { key, scope, description: null, owner: null, url: null, docs: null };
    const manifest = parseManifest(dir, dirSlug);
    if (typeof manifest === "string") {
      return { ...base, label: dirSlug.toUpperCase().slice(0, LIMITS.label), status: null, detail: `invalid manifest: ${manifest}`, source: path.join(dir, "service.yaml") };
    }
    const reading = readStatus(dir, manifest, now);
    return {
      ...base,
      label: manifest.label,
      status: reading.status,
      detail: reading.detail,
      source: reading.source,
      description: manifest.description,
      owner: manifest.owner,
      url: manifest.url,
      docs: manifest.docs,
    };
  });
}

/**
 * Every declared service, project scope first, then global, each alphabetical
 * by slug. A slug present in both scopes shows once, the project one, and its
 * detail says so.
 * @param projectRoot the root this Glance currently serves.
 * @param now injectable clock for the staleness rule.
 */
export function readServices(projectRoot: string, now: number = Date.now()): Service[] {
  const slugOf = (s: Service) => s.key.slice(s.scope.length + 1);
  const project = readScope("project", projectRoot, now);
  const global = readScope("global", projectRoot, now);
  const inProject = new Set(project.map(slugOf));
  const inGlobal = new Set(global.map(slugOf));
  for (const service of project) {
    if (inGlobal.has(slugOf(service))) service.detail = `${service.detail} · overrides global`;
  }
  return [...project, ...global.filter(s => !inProject.has(slugOf(s)))];
}
