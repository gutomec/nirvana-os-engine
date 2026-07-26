// contributions.ts — gather, order, and render prompt fragments contributed by
// capabilities / mind-clones into a (role, hook) pair, at prompt-assembly time.
//
// A `contribution` injects a fragment (path|inline) into a named agent role at a
// named hook. Ordering is a tolerant topological sort over produces/consumes
// (a consumer sorts after its producer); ties and missing edges fall back to
// declaration order; a cycle degrades to declaration order with a warning.
// renderHookBlock returns "" when there is nothing — so every splice is a no-op
// until something actually declares a contribution.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Hook, Role } from "./hooks.ts";
import { isHook, isRole } from "./hooks.ts";

export type Contribution = {
  into: Role;
  at: Hook;
  fragment: { path?: string; inline?: string };
  when?: string;
  produces?: string[];
  consumes?: string[];
  _from?: string;     // id of the contributing capability/clone (label + provenance)
  _baseDir?: string;  // dir to resolve a relative fragment.path against
};

export type ContribSource = {
  id: string;
  baseDir: string;
  contributions?: Contribution[];
  context?: Record<string, unknown>; // for `when` evaluation (e.g. { domains: [...] })
};

// Minimal, fail-open `when` evaluator. Supports: absent (active), "key"
// (truthy), "!key" (falsy), "key includes value". Anything else → active + warn.
function evalWhen(when: string | undefined, ctx: Record<string, unknown> = {}): boolean {
  if (!when) return true;
  const s = when.trim();
  let m = s.match(/^!\s*([\w.]+)$/);
  if (m) return !ctx[m[1]];
  m = s.match(/^([\w.]+)\s+includes\s+(.+)$/i);
  if (m) {
    const v = ctx[m[1]];
    const needle = m[2].trim().replace(/^["']|["']$/g, "");
    if (Array.isArray(v)) return v.map(String).includes(needle);
    if (typeof v === "string") return v.includes(needle);
    return false;
  }
  m = s.match(/^([\w.]+)$/);
  if (m) return !!ctx[m[1]];
  console.warn(`[contributions] predicado 'when' não reconhecido, tratando como ativo: ${when}`);
  return true;
}

export function collectContributions(sources: ContribSource[], role: Role, hook: Hook): Contribution[] {
  const out: Contribution[] = [];
  for (const src of sources || []) {
    for (const c of src.contributions || []) {
      if (!isRole(c.into) || !isHook(c.at)) continue; // closed sets — skip unknown
      if (c.into !== role || c.at !== hook) continue;
      if (!evalWhen(c.when, src.context)) continue;
      out.push({ ...c, _from: c._from || src.id, _baseDir: c._baseDir || src.baseDir });
    }
  }
  return out;
}

export function orderContributions(items: Contribution[]): Contribution[] {
  // Topological-ish: a contribution that consumes X sorts after one that produces X.
  // Stable on declaration order; on a cycle, keep declaration order + warn.
  const n = items.length;
  if (n <= 1) return items.slice();
  const producedBy = new Map<string, number[]>();
  items.forEach((c, i) => (c.produces || []).forEach((p) => {
    if (!producedBy.has(p)) producedBy.set(p, []);
    producedBy.get(p)!.push(i);
  }));
  const adj: Set<number>[] = items.map(() => new Set<number>());
  const indeg = new Array(n).fill(0);
  items.forEach((c, i) => (c.consumes || []).forEach((x) => {
    for (const p of producedBy.get(x) || []) {
      if (p !== i && !adj[p].has(i)) { adj[p].add(i); indeg[i]++; }
    }
  }));
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) queue.push(i);
  queue.sort((a, b) => a - b); // declaration-order tiebreak
  const order: number[] = [];
  while (queue.length) {
    const i = queue.shift()!;
    order.push(i);
    const next = [...adj[i]].sort((a, b) => a - b);
    for (const j of next) { if (--indeg[j] === 0) queue.push(j); }
  }
  if (order.length !== n) {
    console.warn("[contributions] ciclo em produces/consumes — usando ordem de declaração");
    return items.slice();
  }
  return order.map((i) => items[i]);
}

function fragmentText(c: Contribution): string {
  if (c.fragment?.inline) return c.fragment.inline;
  if (c.fragment?.path) {
    const abs = c._baseDir ? path.join(c._baseDir, c.fragment.path) : c.fragment.path;
    try { return fs.readFileSync(abs, "utf8"); }
    catch { console.warn(`[contributions] fragment ilegível: ${abs}`); return ""; }
  }
  return "";
}

export function renderHookBlock(role: Role, hook: Hook, ordered: Contribution[]): string {
  const blocks: string[] = [];
  for (const c of ordered) {
    const text = fragmentText(c).trim();
    if (!text) continue;
    blocks.push(`<contribution from="${c._from || "?"}">\n${text}\n</contribution>`);
  }
  if (!blocks.length) return "";
  return `<contributions hook="${hook}" role="${role}">\n${blocks.join("\n")}\n</contributions>`;
}

// Build a contribution source from a mind-clone's MANIFEST.yaml (top-level or
// nested under `manifest:`). Returns null when the clone declares none — so the
// channel stays a no-op until a clone opts in. `dir` is the clone root (resolves
// relative fragment paths).
export function cloneContributionSource(slug: string, dir: string): ContribSource | null {
  try {
    const mf = ["MANIFEST.yaml", "manifest.yaml"].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
    if (!mf) return null;
    const doc: any = parseYaml(fs.readFileSync(mf, "utf8")) || {};
    const contribs = doc.contributions || doc.manifest?.contributions;
    if (!Array.isArray(contribs) || contribs.length === 0) return null;
    return { id: slug, baseDir: dir, contributions: contribs as Contribution[] };
  } catch {
    return null;
  }
}
