// evaluator-selection.ts — which target judges a Gauntlet round.
//
// Pure decision, shared by the three canaries of scripts/dispatch.ts and by
// `nrv doctor`. The judgement is agentic by policy (`required`): the offline
// heuristic is an explicit opt-in, never a rung the ladder falls to.
//
//   1. NIRVANA_GAUNTLET_EVALUATOR, when set, is honoured or refused, never
//      reinterpreted: `squad:<slug>[:<capabilityId>]` names an installed squad,
//      `judge-x` the engine's judge, `agent-x` the generalist (accepted only when
//      the producer is not agent-x), `heuristic` the offline quality gate. A value
//      that cannot be honoured (unparseable, squad not installed, capability not
//      declared, target not independent of the producer, judge not available) is
//      an error the caller reports before any producer runs.
//   2. Without the variable, the installed registry is searched for a squad that
//      declares the capability `quality.specification_conformance` and is
//      independent of the producer; the first slug in alphabetical order wins.
//      The rule is the exact capability id, not a domain: the `qa` domain squads
//      of the library judge datasets, code or landing pages, not an arbitrary
//      deliverable against its brief.
//   3. Otherwise judge-x (lib/gauntlet/judge-x.ts), for any producer: its
//      identity `{ kind: "agent-x", slug: "judge-x" }` is independent of the
//      agent-x producer, of every squad and of every business.
//   4. Otherwise nothing: the selection is `unavailable` (no persona for the
//      runtime, or its CLI off the PATH) and the Gauntlet does not start.
//
// Every step skipped is a fallback the caller audits (`x_gauntlet_evaluator_fallback`);
// the final choice is audited as `x_gauntlet_evaluator_selected`, the heuristic
// opt-in as `x_gauntlet_evaluator_heuristic_opt_in`, and the empty ladder as
// `x_gauntlet_evaluator_unavailable`.

import * as fs from "node:fs";
import { paths } from "../../../_shared/lib/bun-helpers.ts";
import type { TargetRef } from "../run-kernel/types.ts";
import type { DispatchEvaluatorTarget } from "./evaluator-adapter.ts";
import { targetsAreIndependent } from "./evaluator-registry.ts";
import { JUDGE_X_TARGET } from "./judge-x.ts";

export const GAUNTLET_EVALUATOR_ENV = "NIRVANA_GAUNTLET_EVALUATOR";
export const CONFORMANCE_CAPABILITY = "quality.specification_conformance";

export interface InstalledSquad {
  slug: string;
  capabilities: string[];
}

export type EvaluatorSpec =
  | { kind: "heuristic" }
  | { kind: "agent-x" }
  | { kind: "judge-x" }
  | { kind: "squad"; slug: string; capabilityId?: string };

export type EvaluatorSelectionSource = "env" | "registry" | "default";

/** Whether judge-x can run for this dispatch (lib/gauntlet/judge-x.ts judgeXAvailability). */
export type JudgeAvailability = { available: true } | { available: false; reason: string };

export interface EvaluatorFallback {
  /** The step that could not be taken. */
  from: "env" | "registry" | "judge-x";
  reason: "unset" | "registry_no_match" | "judge_unavailable";
  /** Why the judge is unavailable, when it is. */
  detail?: string;
}

export type EvaluatorSelection =
  | { kind: "heuristic"; source: "env"; fallbacks: EvaluatorFallback[] }
  | { kind: "dispatch"; target: DispatchEvaluatorTarget; source: EvaluatorSelectionSource; fallbacks: EvaluatorFallback[] }
  | { kind: "unavailable"; reason: string; fallbacks: EvaluatorFallback[] };

/** Parses NIRVANA_GAUNTLET_EVALUATOR; throws on a value it cannot read. */
export function parseEvaluatorSpec(value: string): EvaluatorSpec {
  const trimmed = value.trim();
  if (trimmed === "heuristic") return { kind: "heuristic" };
  if (trimmed === "agent-x") return { kind: "agent-x" };
  if (trimmed === "judge-x") return { kind: "judge-x" };
  const squad = /^squad:([^:\s]+)(?::([^\s]+))?$/.exec(trimmed);
  if (squad) return { kind: "squad", slug: squad[1], ...(squad[2] ? { capabilityId: squad[2] } : {}) };
  throw new Error(`${GAUNTLET_EVALUATOR_ENV}='${value}' is not squad:<slug>[:<capabilityId>], judge-x, agent-x or heuristic`);
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
const JUDGE_X = JUDGE_X_TARGET as DispatchEvaluatorTarget;

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

export function selectGauntletEvaluator(input: { envValue?: string; producer: TargetRef; installed: InstalledSquad[]; judge: JudgeAvailability }): EvaluatorSelection {
  const { producer, installed, judge } = input;
  if (input.envValue !== undefined && input.envValue.trim() !== "") {
    const spec = parseEvaluatorSpec(input.envValue);
    if (spec.kind === "heuristic") return { kind: "heuristic", source: "env", fallbacks: [] };
    if (spec.kind === "agent-x") return { kind: "dispatch", target: requireIndependent(AGENT_X, producer), source: "env", fallbacks: [] };
    if (spec.kind === "judge-x") {
      if (!judge.available) throw new Error(`${GAUNTLET_EVALUATOR_ENV} names judge-x, which is not available: ${judge.reason}`);
      return { kind: "dispatch", target: requireIndependent(JUDGE_X, producer), source: "env", fallbacks: [] };
    }
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
  if (judge.available) return { kind: "dispatch", target: JUDGE_X, source: "default", fallbacks };
  fallbacks.push({ from: "judge-x", reason: "judge_unavailable", detail: judge.reason });
  return { kind: "unavailable", reason: judge.reason, fallbacks };
}
