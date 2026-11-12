// auto-parts-plan.ts — a request the router split into parts, as a multi-target plan.
//
// `nrv dispatch --auto` used to run one target whatever the request held: "launch
// my game on Steam and design its token" went to one business, and the other
// part was never delivered (measured 2026-10-13: 0 of 6 multi-business requests
// reached every business they needed). The router now names each part and the
// parts it waits for; this module turns that into the plan file the
// multi-target engine already executes (scripts/multi-target.ts): one node per
// target, `depends_on` edges for the order, one six-section brief per node.
//
// Pure: no fs, no env. The dispatch writes the file and runs the engine.

import type { RoutedPart } from "./agentic-router.ts";
import { PLAN_SCHEMA_VERSION, type MultiTargetPlanFile } from "../scripts/multi-target.ts";

export interface PartsPlanInput {
  /** The user's request, verbatim: every part's brief carries it whole. */
  request: string;
  parts: RoutedPart[];
  projectId: string;
  /** The router's primary target: its support squads and voices ride on its part only. */
  primary: string | null;
  supportSquads?: string[];
  suggestedClones?: string[];
  runtime?: string;
}

/** The node id the multi-target engine dispatches: the slug itself (a squad may carry `:<capability>`). */
const nodeId = (p: RoutedPart) => p.slug;

/** One part's brief: the whole request, what this part delivers, and who delivers the rest. */
export function partBrief(input: PartsPlanInput, part: RoutedPart): string {
  const isPrimary = part.slug === input.primary;
  const decisions = [
    ...(part.kind === "business" && isPrimary ? (input.supportSquads ?? []).map((s) => `- squad ${s}`) : []),
    ...(isPrimary ? (input.suggestedClones ?? []).map((c) => `- clone ${c}`) : []),
  ];
  const others = input.parts.filter((p) => p !== part)
    .map((p) => `- ${p.kind} ${p.slug}: ${p.part || "its part of the request"}${p.after.includes(part.slug) ? " (it reads what you deliver)" : ""}`);
  const waits = part.after.length ? `\n\nYou start after ${part.after.join(", ")}: read their _SUMMARY.md first.` : "";
  return [
    "## Request (verbatim)", input.request.trim(), "",
    "## Decisions", decisions.join("\n") || "- None.", "",
    "## Your part", `${part.part || "Your part of the request."}${waits}`, "",
    "Delivered by others, not by you:", others.join("\n") || "- None.", "",
    "## Inputs", "- None.", "",
    "## Done when", `- What "Your part" names is delivered, consistent with the request. (blocking)`, "",
    "## Output", "What your part is made of, in the formats the request implies.", "",
  ].join("\n");
}

/** The plan file: a brief node feeding the parts that wait for nothing, `depends_on` for the rest. */
export function partsToPlan(input: PartsPlanInput): MultiTargetPlanFile {
  const ids = new Set(input.parts.map(nodeId));
  const nodes: MultiTargetPlanFile["graph"]["nodes"] = [{ id: "brief-main", type: "brief" }];
  const edges: MultiTargetPlanFile["graph"]["edges"] = [];
  const briefs: Record<string, string> = {};
  for (const p of input.parts) {
    nodes.push({ id: nodeId(p), type: p.kind === "business" ? "company" : "squad" });
    briefs[nodeId(p)] = partBrief(input, p);
    const after = p.after.filter((a) => ids.has(a) && a !== p.slug);
    if (!after.length) edges.push({ id: `brief-${p.slug}`, source: "brief-main", target: nodeId(p), type: "briefs" });
    for (const a of after) edges.push({ id: `${p.slug}-after-${a}`, source: nodeId(p), target: a, type: "depends_on" });
  }
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    projectId: input.projectId,
    brief: input.request.trim(),
    briefs,
    graph: { nodes, edges },
    ...(input.runtime ? { runtime: input.runtime } : {}),
  } as MultiTargetPlanFile;
}
