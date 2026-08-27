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
//      independent of the producer. The rule is the exact capability id, not a
//      domain: the `qa` domain squads of the library judge datasets, code or
//      landing pages, not an arbitrary deliverable against its brief. Among the
//      squads that qualify the winner is RANKED, not alphabetical (Squad
//      Protocol v6 §30): fidelity first (`validated` > `experimental` >
//      `drifted`, and `retired` is not a candidate at all), then
//      `evaluator.max_cost_usd` ascending — a capability with no `evaluator`
//      block declares no cost, so it sorts behind every one that does — and the
//      slug last, which is the only key a library that declares neither has, so
//      today's alphabetical answer is what a library with no v6 metadata still
//      gets. The chosen row's keys travel on the selection so the caller and
//      `nrv doctor` can say WHY, instead of "the first one".
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

/** `fidelity.status` of a capability; the registry defaults an absent block to `experimental`. */
export type EvaluatorFidelity = "validated" | "experimental" | "drifted" | "retired";

/** The v6 evaluator contract of one conformance capability (Squad Protocol v6 §30). */
export interface InstalledEvaluator {
  capabilityId: string;
  fidelity: EvaluatorFidelity;
  /** `evaluator.max_cost_usd`; null when the capability declares no `evaluator` block. */
  maxCostUsd: number | null;
}

export interface InstalledSquad {
  slug: string;
  capabilities: string[];
  /** Evaluator contracts this squad declares, by capability. Absent = nothing declared. */
  evaluators?: InstalledEvaluator[];
}

/** Why one squad won the registry rung. */
export interface EvaluatorRanking {
  slug: string;
  capabilityId: string;
  fidelity: EvaluatorFidelity;
  maxCostUsd: number | null;
  /** Independent candidates that declared the capability, `retired` excluded. */
  considered: number;
  /** Candidates dropped because their contract is `retired`. */
  retired: number;
}

const FIDELITY_ORDER: Record<EvaluatorFidelity, number> = { validated: 0, experimental: 1, drifted: 2, retired: 3 };

/** The evaluator contract a squad declares for a capability; nothing declared is `experimental` with no cost ceiling. */
export function evaluatorContractOf(squad: InstalledSquad, capabilityId: string): InstalledEvaluator {
  const found = squad.evaluators?.find(entry => entry.capabilityId === capabilityId);
  return found ?? { capabilityId, fidelity: "experimental", maxCostUsd: null };
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
  | { kind: "dispatch"; target: DispatchEvaluatorTarget; source: EvaluatorSelectionSource; fallbacks: EvaluatorFallback[]; ranking?: EvaluatorRanking }
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

type RegistryCapability = { squad?: unknown; fidelity?: { status?: unknown }; fidelity_status?: unknown; evaluator?: { max_cost_usd?: unknown } };

function fidelityOf(entry: RegistryCapability): EvaluatorFidelity {
  const raw = entry?.fidelity?.status ?? entry?.fidelity_status;
  return typeof raw === "string" && raw in FIDELITY_ORDER ? raw as EvaluatorFidelity : "experimental";
}

/** Installed squads, their capability ids and the evaluator contract each conformance
 *  capability declares, from the registry `nrv index` maintains. A missing or unreadable
 *  registry is an empty library; a registry from before the v6 passthrough simply carries
 *  no `evaluator`/`fidelity`, which reads as `experimental` with no declared ceiling. */
export function loadInstalledSquads(registryPath = defaultSquadsRegistryPath()): InstalledSquad[] {
  let registry: { squads?: Record<string, { capabilities?: unknown }>; capabilities?: Record<string, RegistryCapability[]> };
  try { registry = JSON.parse(fs.readFileSync(registryPath, "utf8")); } catch { return []; }
  const contracts = new Map<string, InstalledEvaluator[]>();
  for (const [capabilityId, providers] of Object.entries(registry.capabilities ?? {})) {
    for (const provider of Array.isArray(providers) ? providers : []) {
      if (typeof provider?.squad !== "string") continue;
      const maxCost = provider?.evaluator?.max_cost_usd;
      contracts.set(provider.squad, [...(contracts.get(provider.squad) ?? []), {
        capabilityId, fidelity: fidelityOf(provider),
        maxCostUsd: typeof maxCost === "number" && Number.isFinite(maxCost) ? maxCost : null,
      }]);
    }
  }
  return Object.entries(registry.squads ?? {})
    .map(([slug, entry]) => {
      const evaluators = contracts.get(slug);
      return {
        slug,
        capabilities: Array.isArray(entry?.capabilities) ? entry.capabilities.filter((id): id is string => typeof id === "string") : [],
        ...(evaluators?.length ? { evaluators } : {}),
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * The independent squads that can judge, best first: fidelity, then declared cost
 * ceiling ascending (undeclared last), then slug. `retired` is not a candidate.
 */
export function rankConformanceEvaluators(installed: InstalledSquad[], producer: TargetRef): { ranked: EvaluatorRanking[]; retired: number } {
  let retired = 0;
  const candidates: Array<{ squad: InstalledSquad; contract: InstalledEvaluator }> = [];
  for (const squad of installed) {
    if (!squad.capabilities.includes(CONFORMANCE_CAPABILITY)) continue;
    if (!targetsAreIndependent(producer, squadTarget(squad.slug, CONFORMANCE_CAPABILITY))) continue;
    const contract = evaluatorContractOf(squad, CONFORMANCE_CAPABILITY);
    if (contract.fidelity === "retired") { retired += 1; continue; }
    candidates.push({ squad, contract });
  }
  candidates.sort((left, right) =>
    FIDELITY_ORDER[left.contract.fidelity] - FIDELITY_ORDER[right.contract.fidelity]
    || (left.contract.maxCostUsd ?? Infinity) - (right.contract.maxCostUsd ?? Infinity)
    || left.squad.slug.localeCompare(right.squad.slug));
  const ranked = candidates.map(({ squad, contract }) => ({
    slug: squad.slug, capabilityId: CONFORMANCE_CAPABILITY, fidelity: contract.fidelity,
    maxCostUsd: contract.maxCostUsd, considered: candidates.length, retired,
  }));
  return { ranked, retired };
}

/** One line saying why the ranking chose this squad — what `nrv doctor` prints. */
export function describeRanking(ranking: EvaluatorRanking): string {
  const cost = ranking.maxCostUsd === null ? "no declared max_cost_usd" : `max_cost_usd USD ${ranking.maxCostUsd}`;
  const others = ranking.considered - 1;
  return `fidelity ${ranking.fidelity}, ${cost}${others > 0 ? `, ahead of ${others} other candidate(s)` : ""}`
    + `${ranking.retired > 0 ? `; ${ranking.retired} retired excluded` : ""}`;
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
  const { ranked } = rankConformanceEvaluators(installed, producer);
  const winner = ranked[0];
  if (winner) return { kind: "dispatch", target: squadTarget(winner.slug, winner.capabilityId), source: "registry", fallbacks, ranking: winner };
  fallbacks.push({ from: "registry", reason: "registry_no_match" });
  if (judge.available) return { kind: "dispatch", target: JUDGE_X, source: "default", fallbacks };
  fallbacks.push({ from: "judge-x", reason: "judge_unavailable", detail: judge.reason });
  return { kind: "unavailable", reason: judge.reason, fallbacks };
}
