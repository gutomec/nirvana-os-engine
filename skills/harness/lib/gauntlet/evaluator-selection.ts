// evaluator-selection.ts — which target judges a Gauntlet round.
//
// Pure decision, shared by the three canaries of scripts/dispatch.ts:
//
//   1. NIRVANA_GAUNTLET_EVALUATOR, when set, is honoured or refused, never
//      reinterpreted: `squad:<slug>[:<capabilityId>]` names an installed squad,
//      `agent-x` the generalist, `heuristic` the offline quality gate. A value
//      that cannot be honoured (unparseable, squad not installed, capability not
//      declared, target not independent of the producer) is an error the caller
//      reports before any producer runs.
//   2. Without the variable, the installed registry is searched for a squad that
//      declares the capability `quality.specification_conformance` and is
//      independent of the producer; the first slug in alphabetical order wins.
//      The rule is the exact capability id, not a domain: the `qa` domain squads
//      of the library judge datasets, code or landing pages, not an arbitrary
//      deliverable against its brief.
//   3. Otherwise agent-x, unless the producer is agent-x (a producer never
//      evaluates its own candidate).
//   4. Otherwise the heuristic.
//
// Every step skipped is a fallback the caller audits (`x_gauntlet_evaluator_fallback`);
// the final choice is audited as `x_gauntlet_evaluator_selected`.

import * as fs from "node:fs";
import { paths } from "../../../_shared/lib/bun-helpers.ts";
import type { TargetRef } from "../run-kernel/types.ts";
import type { DispatchEvaluatorTarget } from "./evaluator-adapter.ts";
import { targetsAreIndependent } from "./evaluator-registry.ts";

export const GAUNTLET_EVALUATOR_ENV = "NIRVANA_GAUNTLET_EVALUATOR";
export const CONFORMANCE_CAPABILITY = "quality.specification_conformance";

export interface InstalledSquad {
  slug: string;
  capabilities: string[];
}

export type EvaluatorSpec =
  | { kind: "heuristic" }
  | { kind: "agent-x" }
  | { kind: "squad"; slug: string; capabilityId?: string };

export type EvaluatorSelectionSource = "env" | "registry" | "default";

export interface EvaluatorFallback {
  /** The step that could not be taken. */
  from: "env" | "registry" | "agent-x";
  reason: "unset" | "registry_no_match" | "producer_is_agent_x";
}

export type EvaluatorSelection =
  | { kind: "heuristic"; source: EvaluatorSelectionSource; fallbacks: EvaluatorFallback[] }
  | { kind: "dispatch"; target: DispatchEvaluatorTarget; source: EvaluatorSelectionSource; fallbacks: EvaluatorFallback[] };

/** Parses NIRVANA_GAUNTLET_EVALUATOR; throws on a value it cannot read. */
export function parseEvaluatorSpec(value: string): EvaluatorSpec {
  const trimmed = value.trim();
  if (trimmed === "heuristic") return { kind: "heuristic" };
  if (trimmed === "agent-x") return { kind: "agent-x" };
  const squad = /^squad:([^:\s]+)(?::([^\s]+))?$/.exec(trimmed);
  if (squad) return { kind: "squad", slug: squad[1], ...(squad[2] ? { capabilityId: squad[2] } : {}) };
  throw new Error(`${GAUNTLET_EVALUATOR_ENV}='${value}' is not squad:<slug>[:<capabilityId>], agent-x or heuristic`);
}

export function defaultSquadsRegistryPath(): string {
  return paths.SQUADS_REGISTRY_PATH as string;
}

/** Installed squads and their capability ids from the registry `nrv index` maintains; a missing or unreadable registry is an empty library. */
export function loadInstalledSquads(registryPath = defaultSquadsRegistryPath()): InstalledSquad[] {
  let registry: { squads?: Record<string, { capabilities?: unknown }> };
  try { registry = JSON.parse(fs.readFileSync(registryPath, "utf8")); } catch { return []; }
  return Object.entries(registry.squads ?? {})
    .map(([slug, entry]) => ({ slug, capabilities: Array.isArray(entry?.capabilities) ? entry.capabilities.filter((id): id is string => typeof id === "string") : [] }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

const AGENT_X: DispatchEvaluatorTarget = { kind: "agent-x", slug: "agent-x" };

function squadTarget(slug: string, capabilityId: string): DispatchEvaluatorTarget {
  return { kind: "squad", slug, capabilityId };
}

function describe(target: TargetRef): string {
  return target.kind === "squad" ? `squad:${target.slug}:${target.capabilityId}` : `${target.kind}:${target.slug}`;
}

function requireIndependent(target: DispatchEvaluatorTarget, producer: TargetRef): DispatchEvaluatorTarget {
  if (!targetsAreIndependent(producer, target)) {
    throw new Error(`${GAUNTLET_EVALUATOR_ENV} names ${describe(target)}, which cannot evaluate candidates produced by ${describe(producer)}`);
  }
  return target;
}

export function selectGauntletEvaluator(input: { envValue?: string; producer: TargetRef; installed: InstalledSquad[] }): EvaluatorSelection {
  const { producer, installed } = input;
  if (input.envValue !== undefined && input.envValue.trim() !== "") {
    const spec = parseEvaluatorSpec(input.envValue);
    if (spec.kind === "heuristic") return { kind: "heuristic", source: "env", fallbacks: [] };
    if (spec.kind === "agent-x") return { kind: "dispatch", target: requireIndependent(AGENT_X, producer), source: "env", fallbacks: [] };
    const squad = installed.find(entry => entry.slug === spec.slug);
    if (!squad) throw new Error(`${GAUNTLET_EVALUATOR_ENV} names squad '${spec.slug}', which is not in the installed registry (run nrv index after installing it)`);
    if (spec.capabilityId && !squad.capabilities.includes(spec.capabilityId)) {
      throw new Error(`${GAUNTLET_EVALUATOR_ENV} names capability '${spec.capabilityId}', which squad '${spec.slug}' does not declare (${squad.capabilities.join(", ") || "none"})`);
    }
    const capabilityId = spec.capabilityId ?? (squad.capabilities.includes(CONFORMANCE_CAPABILITY) ? CONFORMANCE_CAPABILITY : squad.capabilities[0] ?? "squad.execute");
    return { kind: "dispatch", target: requireIndependent(squadTarget(spec.slug, capabilityId), producer), source: "env", fallbacks: [] };
  }
  const fallbacks: EvaluatorFallback[] = [{ from: "env", reason: "unset" }];
  const conformant = installed.find(entry => entry.capabilities.includes(CONFORMANCE_CAPABILITY)
    && targetsAreIndependent(producer, squadTarget(entry.slug, CONFORMANCE_CAPABILITY)));
  if (conformant) return { kind: "dispatch", target: squadTarget(conformant.slug, CONFORMANCE_CAPABILITY), source: "registry", fallbacks };
  fallbacks.push({ from: "registry", reason: "registry_no_match" });
  if (targetsAreIndependent(producer, AGENT_X)) return { kind: "dispatch", target: AGENT_X, source: "default", fallbacks };
  fallbacks.push({ from: "agent-x", reason: "producer_is_agent_x" });
  return { kind: "heuristic", source: "default", fallbacks };
}
