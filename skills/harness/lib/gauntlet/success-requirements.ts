// success-requirements.ts — the judge's contract, built from what the target declared.
//
// `compiler.ts` has always been able to compile N requirements into N gauntlets;
// it never received more than one, because no caller passed `requirements` and
// the compiler's own fallback is the single `brief-conformance` line. Every
// Gauntlet in the system therefore judged the same one question ("does this
// satisfy the brief?") with a threshold taken from the intensity profile, while
// the manifests carried `capabilities[].acceptance[]` and
// `capabilities[].fidelity.threshold` that nothing read.
//
// This module turns a declared acceptance contract into `SuccessRequirement[]`.
// `brief-conformance` always comes first — the brief is the contract even when a
// capability adds its own — and the rest is the first rung of this ladder that
// answers (Squad Protocol v6 §29):
//
//   acceptance                 `capabilities[].acceptance[]`, the declared contract.
//   success_indicators         the invoked workflow's `success_indicators[]`, read
//                              through the v6 reader so every legacy dialect
//                              normalizes to the same list.
//   task_acceptance_criteria   the `## Acceptance Criteria` section of the invoked
//                              task, the scaffold `task.md.tmpl` has always written.
//   brief-conformance          nothing declared: exactly today's single requirement.
//
// A derived rung (the last two) is non-blocking: an indicator a human wrote as
// prose was never promised as a gate, and turning it into one would withhold
// deliveries nobody agreed to withhold. Only `acceptance[]` blocks by default,
// and only because §29 says a declared criterion blocks unless the author says
// otherwise.
//
// Ids are namespaced (`acceptance.<id>`, `indicator.<n>`, `criterion.<n>`) so a
// capability that literally declares `brief-conformance` cannot shadow the brief,
// and so a scorecard dimension names which rung it came from.

import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeWorkflow, readWorkflow, resolveWorkflowRef } from "../../../squads/lib/workflow-reader.ts";
import { PROFILES } from "./compiler.ts";
import type { GauntletIntensity, SuccessRequirement } from "./types.ts";

/** The requirement every Gauntlet carries, whatever else the target declared. */
export const BRIEF_CONFORMANCE_ID = "brief-conformance";

/** The capability that judges a requirement — the evaluator's contract id. */
export const CONFORMANCE_CAPABILITY = "quality.specification_conformance";

/** Squad Protocol v6 §29: at most twelve requirements reach the judge, `brief-conformance` included. */
export const REQUIREMENTS_MAX = 12;

/** Which rung of the ladder answered. */
export type RequirementsOrigin = "brief-conformance" | "acceptance" | "success_indicators" | "task_acceptance_criteria";

/** `gauntlet.requirements_source`: `brief` keeps the compiler's own single requirement. */
export type RequirementsSource = "brief" | "capability";

export interface AcceptanceEntry {
  id: string;
  description: string;
  blocking?: boolean;
  minimumScore?: number;
}

/** The slice of a capability record (manifest or registry) this module reads. */
export interface CapabilityContract {
  id?: string;
  acceptance?: AcceptanceEntry[];
  fidelity?: { threshold?: number };
  invoke?: { type?: string; ref?: string };
}

export interface RequirementsForInput {
  /** Root of the squad, for the workflow and task rungs; absent skips both. */
  squadDir?: string | null;
  capability?: CapabilityContract | null;
  intensity?: GauntletIntensity;
}

export interface RequirementsResult {
  requirements: SuccessRequirement[];
  origin: RequirementsOrigin;
  /** Entries the ceiling of `REQUIREMENTS_MAX` dropped. */
  truncated: number;
}

/** The intensity profile's passing score — the floor a requirement inherits when nothing declares one. */
export function profileScore(intensity: GauntletIntensity = "balanced"): number {
  return PROFILES[intensity].score;
}

/** The single requirement today's compiler builds on its own. */
export function briefConformance(intensity: GauntletIntensity = "balanced"): SuccessRequirement {
  return {
    id: BRIEF_CONFORMANCE_ID,
    description: "The candidate satisfies the explicit brief",
    capability: CONFORMANCE_CAPABILITY,
    blocking: true,
    minimumScore: profileScore(intensity),
  };
}

/** A declared acceptance entry blocks unless the author said otherwise (§29); a derived one never does. */
function requirement(id: string, description: string, blocking: boolean, minimumScore: number): SuccessRequirement {
  return { id, description, capability: CONFORMANCE_CAPABILITY, blocking, minimumScore };
}

function trimmedLines(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.map(value => String(value ?? "").trim()).filter(Boolean);
}

/** `## Acceptance Criteria` of a task file: its `-`/`*` bullets, up to the next heading. */
export function acceptanceCriteriaOf(markdown: string): string[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const heading = lines.findIndex(line => /^#{1,6}\s+acceptance\s+criteria\s*$/i.test(line.trim()));
  if (heading === -1) return [];
  const out: string[] = [];
  for (let index = heading + 1; index < lines.length; index++) {
    const line = lines[index];
    if (/^#{1,6}\s/.test(line)) break;
    const bullet = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
    if (bullet) out.push(bullet[1].trim());
  }
  return out;
}

/** The invoked workflow's `success_indicators[]`, through the v6 reader so every dialect yields one list. */
function workflowIndicators(squadDir: string, ref: string): string[] {
  try {
    const file = resolveWorkflowRef(squadDir, ref);
    if (!file) return [];
    const raw = readWorkflow(file);
    if (!raw.doc) return [];
    return trimmedLines(normalizeWorkflow(raw.doc, { stem: raw.stem }).canonical.success_indicators);
  } catch { return []; }
}

/** The invoked task's `## Acceptance Criteria`. */
function taskCriteria(squadDir: string, ref: string): string[] {
  for (const base of [ref, path.join("tasks", ref)]) {
    for (const ext of ["", ".md"]) {
      const file = path.join(squadDir, base + ext);
      try {
        if (!fs.statSync(file).isFile()) continue;
        const found = acceptanceCriteriaOf(fs.readFileSync(file, "utf8"));
        if (found.length) return found;
      } catch { /* next candidate */ }
    }
  }
  return [];
}

/**
 * The judge's contract for one capability: `brief-conformance` plus whatever the
 * capability declared, capped at `REQUIREMENTS_MAX` and scored against
 * `acceptance[].minimumScore`, then `fidelity.threshold`, then the profile.
 */
export function requirementsFor(input: RequirementsForInput): RequirementsResult {
  const intensity = input.intensity ?? "balanced";
  const capability = input.capability ?? null;
  const floor = capability?.fidelity?.threshold ?? profileScore(intensity);
  const head = briefConformance(intensity);
  const room = REQUIREMENTS_MAX - 1;

  const declared = Array.isArray(capability?.acceptance) ? capability!.acceptance!.filter(entry => entry?.id && entry?.description) : [];
  if (declared.length) {
    const kept = declared.slice(0, room);
    return {
      requirements: [head, ...kept.map(entry => requirement(`acceptance.${entry.id}`, entry.description,
        entry.blocking ?? true, entry.minimumScore ?? floor))],
      origin: "acceptance",
      truncated: declared.length - kept.length,
    };
  }

  const squadDir = input.squadDir ?? null;
  const ref = capability?.invoke?.ref ?? "";
  const kind = capability?.invoke?.type ?? "";
  if (squadDir && ref) {
    const indicators = kind === "task" ? [] : workflowIndicators(squadDir, ref);
    if (indicators.length) {
      const kept = indicators.slice(0, room);
      return {
        requirements: [head, ...kept.map((text, index) => requirement(`indicator.${index + 1}`, text, false, floor))],
        origin: "success_indicators",
        truncated: indicators.length - kept.length,
      };
    }
    const criteria = kind === "workflow" ? [] : taskCriteria(squadDir, ref);
    if (criteria.length) {
      const kept = criteria.slice(0, room);
      return {
        requirements: [head, ...kept.map((text, index) => requirement(`criterion.${index + 1}`, text, false, floor))],
        origin: "task_acceptance_criteria",
        truncated: criteria.length - kept.length,
      };
    }
  }
  return { requirements: [head], origin: "brief-conformance", truncated: 0 };
}
