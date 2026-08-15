// exporters.ts — materialize a Studio graph into the engine's canonical
// artifacts: business.yaml (+ employees, org-chart.yaml), squad.yaml, and
// mind-clone MANIFEST. Every exporter writes to the STANDARD engine paths
// (~/businesses/, ~/squads/, ~/businesses/_library/dna/), so the result is
// indistinguishable from the prose factories and `nrv list-*` sees it.
//
// These are low-level writers used AFTER the lifecycle pipelines produce the
// validated content (see scripts/build-graph.ts), plus small scaffolding
// helpers so the Studio can render proposed nodes without a full build.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StudioGraph, StudioNode } from "./graph-store.ts";

export const DEFAULT_BIZ_ROOT = join(process.env.HOME ?? "/tmp", "businesses");
export const DEFAULT_SQUADS_ROOT = join(process.env.HOME ?? "/tmp", "squads");
export const DEFAULT_DNA_ROOT = join(DEFAULT_BIZ_ROOT, "_library", "dna");

export interface ExportPlan {
  businesses: Array<{ node: StudioNode; root: string }>;
  squads: Array<{ node: StudioNode; root: string }>;
  clones: Array<{ node: StudioNode; root: string }>;
  employees: Array<{ node: StudioNode; parent: StudioNode; parentType: "company" | "squad" }>;
}

/** Split the graph into exportable units (nodes already accepted by the planner). */
export function planExport(graph: StudioGraph, roots: { businesses?: string; squads?: string; dna?: string } = {}): ExportPlan {
  const bizRoot = roots.businesses ?? DEFAULT_BIZ_ROOT;
  const squadsRoot = roots.squads ?? DEFAULT_SQUADS_ROOT;
  const dnaRoot = roots.dna ?? DEFAULT_DNA_ROOT;
  const plan: ExportPlan = { businesses: [], squads: [], clones: [], employees: [] };
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const n of graph.nodes) {
    if (n.type === "company") plan.businesses.push({ node: n, root: bizRoot });
    else if (n.type === "squad") plan.squads.push({ node: n, root: squadsRoot });
    else if (n.type === "mind_clone") plan.clones.push({ node: n, root: dnaRoot });
    else if (n.type === "employee") {
      const owner = graph.edges.find((e) => e.target === n.id && e.type === "owns" && byId.get(e.source)?.type === "company");
      const squadOwner = graph.edges.find((e) => e.target === n.id && e.type === "owns" && byId.get(e.source)?.type === "squad");
      if (owner) plan.employees.push({ node: n, parent: byId.get(owner.source)!, parentType: "company" });
      else if (squadOwner) plan.employees.push({ node: n, parent: byId.get(squadOwner.source)!, parentType: "squad" });
    }
  }
  return plan;
}

// ── business.yaml scaffold (Business Protocol v1 shape) ─────────────────────

export function scaffoldBusinessYaml(node: StudioNode, extra: { employees?: string[]; mind_clones?: string[] } = {}): string {
  const p = (node.payload ?? {}) as Record<string, unknown>;
  const domains = Array.isArray(p.domains) ? p.domains : ["general"];
  const lines = [
    `schema_version: "1.0"`,
    `name: "${esc(p.description ?? node.id)}"`,
    `slug: "${esc(p.slug ?? node.id)}"`,
    `domains:`,
    ...domains.map((d) => `  - "${esc(String(d))}"`),
    `template: ${p.template ?? "custom"}`,
    `employee_count: ${extra.employees?.length ?? 0}`,
    `employees:`,
    ...(extra.employees ?? []).map((e) => `  - "${esc(e)}"`),
    `squads_authorized: []`,
    `mind_clones:`,
    ...((extra.mind_clones ?? p.mind_clones as string[] | undefined) ?? []).map((m) => `  - "${esc(String(m))}"`),
    `run_budget_usd: 0`,
    `studio:`,
    `  graph: "${esc(node.meta?.graph ?? "")}"`,
    `  node_id: "${esc(node.id)}"`,
    ``,
  ];
  return lines.join("\n");
}

// ── squad.yaml scaffold (Squad Protocol v5 shape) ──────────────────────────

export function scaffoldSquadYaml(node: StudioNode): string {
  const p = (node.payload ?? {}) as Record<string, unknown>;
  const caps = Array.isArray(p.capabilities) ? p.capabilities : [];
  const lines = [
    `schema_version: "5"`,
    `name: "${esc(p.slug ?? node.id)}"`,
    `description: "${esc(p.description ?? "")}"`,
    `domains:`,
    ...(Array.isArray(p.domains) ? p.domains : []).map((d) => `  - "${esc(String(d))}"`),
    `agents:`,
    ...(Array.isArray(p.agents) ? p.agents : []).map((a) => `  - "${esc(String(a))}"`),
    `capabilities:`,
    ...caps.map((c) => `  - id: "${esc(String(c))}"`),
    `tasks: []`,
    `workflows: []`,
    `studio:`,
    `  graph: "${esc(node.meta?.graph ?? "")}"`,
    `  node_id: "${esc(node.id)}"`,
    ``,
  ];
  return lines.join("\n");
}

// ── mind-clone MANIFEST scaffold ────────────────────────────────────────────

export function scaffoldCloneManifest(node: StudioNode): string {
  const p = (node.payload ?? {}) as Record<string, unknown>;
  const lines = [
    `schema_version: "1.0"`,
    `slug: "${esc(p.slug ?? node.id)}"`,
    `source: "${esc(p.source ?? "")}"`,
    `one_liner: "${esc(p.one_liner ?? "")}"`,
    `layers:`,
    ...((p.layers as string[] | undefined) ?? ["philosophies", "heuristics", "methodologies"]).map((l) => `  - ${l}`),
    `studio:`,
    `  graph: "${esc(node.meta?.graph ?? "")}"`,
    `  node_id: "${esc(node.id)}"`,
    ``,
  ];
  return lines.join("\n");
}

// ── employee markdown scaffold ──────────────────────────────────────────────

export function scaffoldEmployeeMd(node: StudioNode, companySlug: string): string {
  const p = (node.payload ?? {}) as Record<string, unknown>;
  return [
    "---",
    `slug: "${esc(p.slug ?? node.id)}"`,
    `title: "${esc(p.title ?? p.role ?? "")}"`,
    `role: "${esc(p.role ?? "")}"`,
    `type: ${p.type ?? "functional_specialist"}`,
    `company: "${esc(companySlug)}"`,
    ...(p.mind_clone ? [`mind_clone: "${esc(String(p.mind_clone))}"`] : []),
    "---",
    "",
    "# " + (p.title ?? p.role ?? p.slug ?? "Employee"),
    "",
    p.description ? `${p.description}\n` : "",
  ].join("\n");
}

// ── write helpers ───────────────────────────────────────────────────────────

export function ensureDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}

export function esc(value: unknown): string {
  return String(value ?? "").replace(/"/g, '\\"');
}

export function writeArtifact(file: string, content: string): string {
  ensureDir(file);
  writeFileSync(file, content);
  return file;
}

/** Attachments: resolved materials land in the graph assets folder; persona
 *  material for a clone lands under the DNA root ready for the creation
 *  pipeline. Returns the resolved absolute path. */
export function resolveAttachment(
  attachment: { name?: string; path?: string; url?: string; kind?: string; size_bytes?: number },
  opts: { dnaRoot?: string; graphAssetsDir?: string }
): string | null {
  if (attachment.path && existsSync(attachment.path)) return attachment.path;
  if (attachment.url) return attachment.url;
  return null;
}
