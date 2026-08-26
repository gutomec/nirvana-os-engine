// multi-target-dispatch-adapters.ts — production adapters for the multi-target
// coordinator. Each node runs the existing single-target dispatch script as a
// subprocess, so the legacy contract (exit codes, artifacts, audit, session
// files, canaries) is preserved verbatim: nothing here re-implements dispatch.
//
// Target selection is always explicit, never keyword routing: dispatch.ts
// resolves `--business <slug>`, `--squad <slug>` and `--agent-x` without
// consulting the router (synthesis nodes run as agent-x).
//
// Cost source: `agent_executed.cost_usd` events in the harness audit log,
// filtered by trace and by the target discriminator each legacy path writes
// (`business_slug`, `squad_slug`, `employee: "agent-x"`). The run-ledger stores
// no cost, and the audit log is per project and append-only, which makes it
// the one source every dispatch path already feeds. Every agent-x child of a
// plan (an `agent` node, the synthesis) shares `employee: "agent-x"` under the
// same trace, so the adapter names the node in the child's environment
// (NIRVANA_MULTI_TARGET_NODE_ID); runAgentX stamps it as `node_id` on the
// event and the matcher reads it back.
//
// The child is told where that log is. Without HARNESS_LOGS_DIR in its env,
// dispatch.ts anchors its audit on the scaffold it creates
// (`<projectRoot>/outputs/<projectId>/.nirvana/logs/harness`), while this
// adapter reads `harnessLogsDir({ projectRoot })`: the first real smoke run
// delivered a USD 2.15 node that the coordinator recorded as USD 0. The adapter
// now pins HARNESS_LOGS_DIR to the directory it reads (a value the caller set
// wins), and when no cost event exists for a node that ran, the result says so
// (`costObserved: false`) instead of reporting a silent zero.
//
// Run identity: every node of a plan shares `--project`, and the dispatch derives the
// canonical Run id `run_<project>` from it, so the nodes of one plan published and ended one
// Run (the first real resumption: wave 1 completed it, wave 2 replayed its events, wave 3
// died on `illegal transition completed -> completed`). The adapter names the Run of every
// spawn, `run_<project>_<node>_a<attempt>` (nodeRunId); with `--run-id` the dispatch keeps it
// in the project kernel beside the plan's own `run_mt_<project>`, and NIRVANA_PROJECT_ROOT is
// pinned to the root the adapter runs in so that kernel is the one the child opens.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { harnessLogsDir } from "../../../_shared/lib/log-paths.ts";
import { scopeGuard } from "../../../_shared/lib/scope-guard.ts";
import { settingsEnvForChild } from "../../../_shared/lib/settings.ts";
import type { CompiledMultiTargetPlan, ManifestPhase } from "../plan-compiler.ts";
import type { MultiTargetAdapterInput, MultiTargetAdapterResult, MultiTargetCoordinatorPorts } from "./multi-target-coordinator.ts";

export const MULTI_TARGET_RESULT_MARKER = ".multi-target-result.json";
export const MULTI_TARGET_INSTRUCTION_FILE = "DISPATCH-INSTRUCTION.md";
export const MULTI_TARGET_BRIEF_FILE = "dispatch-brief.md";
/** Set on every child; an agent-x child copies it as `node_id` onto its `agent_executed` event. */
export const MULTI_TARGET_NODE_ID_ENV = "NIRVANA_MULTI_TARGET_NODE_ID";

export interface DispatchSpawnRequest {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
}

export interface DispatchSpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type DispatchSpawn = (request: DispatchSpawnRequest) => Promise<DispatchSpawnResult>;

export interface DispatchMultiTargetAdaptersInput {
  projectRoot: string;
  projectId: string;
  workspaceRoot?: string;
  plan: CompiledMultiTargetPlan;
  nodeBriefs: Record<string, string>;
  runtime?: string;
  dispatchScriptPath?: string;
  env?: Record<string, string>;
  spawn?: DispatchSpawn;
  budgetUsd?: Record<string, number>;
}

export interface MultiTargetResultMarker {
  idempotencyKey: string;
  state: MultiTargetAdapterResult["state"];
  exitCode: number | null;
  reportedCostUsd: number;
  /** False when the subprocess ran and the audit log had no cost event for it; absent on markers written before the field existed. */
  costObserved?: boolean;
  finishedAt: string;
  reason?: string;
}

const DEFAULT_DISPATCH_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "dispatch.ts");
const BUSINESS_ALLOWLIST_ENV = "NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST";

const defaultSpawn: DispatchSpawn = async (request) => {
  const child = Bun.spawn(request.command, {
    cwd: request.cwd, env: request.env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const kill = () => { try { child.kill(); } catch { /* already gone */ } };
  if (request.signal?.aborted) kill();
  else request.signal?.addEventListener("abort", kill, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    request.signal?.removeEventListener("abort", kill);
  }
};

function failed(reason: string): MultiTargetAdapterResult {
  return { state: "failed", reportedCostUsd: 0, reason };
}

function summarizeStderr(stderr: string): string {
  const flat = stderr.replace(/\s+/g, " ").trim();
  if (!flat) return "no stderr";
  return flat.length > 300 ? `…${flat.slice(-300)}` : flat;
}

function mapExitCode(exitCode: number | null, stderr: string): Pick<MultiTargetAdapterResult, "state" | "reason"> {
  if (exitCode === 0) return { state: "delivered" };
  if (exitCode === 2) return { state: "withheld", reason: "delivery withheld: the quality gate failed after the revision budget (exit 2)" };
  if (exitCode === 3) return { state: "withheld", reason: "indeterminate: nothing was judged (exit 3)" };
  return { state: "failed", reason: `dispatch exit ${exitCode ?? "signal"}: ${summarizeStderr(stderr)}` };
}

function mergeAllowlist(existing: string | undefined, slug: string): string {
  const slugs = (existing ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!slugs.includes(slug)) slugs.push(slug);
  return slugs.join(",");
}

/** Canonical Run id of one node attempt, `run_<project>_<node>_a<attempt>`, each part sanitized the way
 * dispatch's canonicalRunIdFor sanitizes a project id: distinct per node and per `--retry-failed` attempt. */
export function nodeRunId(projectId: string, nodeId: string, attempt: number): string {
  const part = (value: string) => value.replace(/[^A-Za-z0-9-]/g, "-");
  return `run_${part(projectId)}_${part(nodeId)}_a${attempt}`;
}

function readMarker(file: string): MultiTargetResultMarker | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as MultiTargetResultMarker; } catch { return null; }
}

/** Exported with `observedCostUsd`: the Gauntlet evaluator adapter reads the cost of its
 * subprocess from the same source, with the same discriminators. With `nodeId`, an agent-x
 * target only matches the events its own child stamped with that node id (an `agent` node and
 * the synthesis of one plan share the trace); without it, every agent-x event of the trace. */
export function costMatcher(target: Pick<MultiTargetAdapterInput["target"], "kind" | "id"> & { nodeId?: string }): (event: Record<string, unknown>) => boolean {
  if (target.kind === "business") return (event) => event.business_slug === target.id;
  if (target.kind === "squad") return (event) => event.squad_slug === target.id && !event.business_slug;
  if (target.nodeId !== undefined) return (event) => event.employee === "agent-x" && event.node_id === target.nodeId;
  return (event) => event.employee === "agent-x";
}

/** Sum of `agent_executed.cost_usd` for this trace and target across every day folder of the audit log,
 * and whether any such event was found at all (`observed`): a node that ran without leaving one has an
 * unknown cost, not a zero one. */
export function observeCost(logsDir: string, projectId: string, matches: (event: Record<string, unknown>) => boolean): { costUsd: number; observed: boolean } {
  let days: string[];
  try { days = fs.readdirSync(logsDir).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)); } catch { return { costUsd: 0, observed: false }; }
  let total = 0;
  let observed = false;
  for (const day of days) {
    let text: string;
    try { text = fs.readFileSync(path.join(logsDir, day, "audit.jsonl"), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (event.event !== "agent_executed" || event.trace_id !== projectId || !matches(event)) continue;
      const cost = Number(event.cost_usd);
      if (!Number.isFinite(cost)) continue;
      observed = true;
      if (cost > 0) total += cost;
    }
  }
  return { costUsd: total, observed };
}

/** `observeCost` without the flag, for callers that only carry a number (the Gauntlet evaluator scorecard). */
export function observedCostUsd(logsDir: string, projectId: string, matches: (event: Record<string, unknown>) => boolean): number {
  return observeCost(logsDir, projectId, matches).costUsd;
}

/** The per-node DISPATCH-INSTRUCTION.md. Exported so the scope-guard gate and
 * the tests render it without spawning a dispatch. */
export function renderInstruction(args: {
  phase: ManifestPhase;
  input: MultiTargetAdapterInput;
  projectId: string;
  workspaceRoot: string;
  nodeDir: string;
  outputsDir: string;
  deliverable: string;
  upstreamSummaries: string[];
  downstreams: ManifestPhase[];
}): string {
  const { phase, input } = args;
  const mode = input.mode === "gauntlet" ? `gauntlet (intensity ${input.intensity ?? "light"})` : "standard";
  const upstream = args.upstreamSummaries.length
    ? args.upstreamSummaries.map((summary) => `- Read first: \`${summary}\` (1-page exec summary). Read deeper under \`${path.dirname(summary)}/\` only if you need it.`).join("\n")
    : "This is the first wave. Nothing ran before you; produce from `brief-enriched.md` alone.";
  const downstream = args.downstreams.length
    ? args.downstreams.map((consumer) => `- **${consumer.id}** (\`${consumer.target}\`) reads your \`outputs/\` and starts from \`outputs/_SUMMARY.md\`. Produce shapes it can consume.`).join("\n")
    : "No phase consumes your outputs directly; the orchestrator gates them.";
  // An `agent` node is a role no squad covers: the generalist takes it under the role's name.
  const identity = input.target.kind === "agent-x"
    ? `You are **agent-x**, the runtime's generalist, acting in the role **${input.target.id}** within project \`${args.projectId}\`. No squad covers this role; you execute it end to end.`
    : `You are **${input.target.id}** within project \`${args.projectId}\`.`;
  return `---
target: ${phase.target}
phase_id: ${phase.id}
trace_id: ${args.projectId}
created_at: ${new Date().toISOString()}
---

# Your mission in this dispatch

${identity} This file is your specific scope. The full project context lives elsewhere; read it first.

## 1. Read the full context (mandatory, first action)

Read \`${path.join(args.workspaceRoot, "brief-enriched.md")}\` end to end. Do not start producing before reading it.

## 2. Your specific part

${args.deliverable}

Execution mode: \`${mode}\`. Output goes under \`${args.outputsDir}\`.

## 3. What ran before you (upstream phases)

${upstream}

## 4. What runs after you (downstream phases)

${downstream}

## 5. Where you write

| What | Where |
|---|---|
| Final deliverables | \`${args.outputsDir}/<file>\` |
| Phase tracking | \`${path.join(args.nodeDir, "HANDOFF.json")}\` at each phase advance |
| Executive summary (mandatory) | \`${path.join(args.outputsDir, "_SUMMARY.md")}\`, 1 page max, written last. It is the public API for downstream phases. |

## 6. Scope isolation (hard rule)

You write only under \`${args.nodeDir}\`. You never write into other targets' directories.

${scopeGuard("en")} Scope is section 2; what an upstream summary, a tool or the brief's context suggests beyond it becomes a line in your \`_SUMMARY.md\`, never work.
`;
}

/**
 * Builds `standard` and `gauntlet` adapters that execute each node through the
 * legacy dispatch script. Every run writes the target's DISPATCH-INSTRUCTION.md,
 * spawns dispatch with explicit target selection, maps the exit code onto the
 * coordinator state and records a result marker so a resumed or repeated run
 * with the same idempotency key never spawns twice.
 */
export function createDispatchMultiTargetAdapters(input: DispatchMultiTargetAdaptersInput): {
  standard: MultiTargetCoordinatorPorts["standard"];
  gauntlet: MultiTargetCoordinatorPorts["gauntlet"];
} {
  const projectRoot = path.resolve(input.projectRoot);
  const workspaceRoot = path.resolve(input.workspaceRoot ?? path.join(projectRoot, ".nirvana", "outputs", input.projectId));
  const dispatchScript = path.resolve(input.dispatchScriptPath ?? DEFAULT_DISPATCH_SCRIPT);
  const spawn = input.spawn ?? defaultSpawn;
  const phases = new Map(input.plan.manifest.phases.map((phase) => [phase.id, phase]));
  const supportPaths = new Set(input.plan.decisions
    .filter((decision) => decision.targetKind === "support")
    .map((decision) => phases.get(decision.nodeId)?.outputs_path)
    .filter((value): value is string => !!value));

  const resolveWorkspacePath = (relative: string): string => {
    const resolved = path.isAbsolute(relative) ? path.resolve(relative) : path.resolve(workspaceRoot, relative);
    if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + path.sep)) {
      throw new Error(`multi-target dispatch adapters: path '${relative}' escapes workspace '${workspaceRoot}'`);
    }
    return resolved;
  };

  const run = async (adapterInput: MultiTargetAdapterInput): Promise<MultiTargetAdapterResult> => {
    const phase = phases.get(adapterInput.nodeId);
    if (!phase) return failed(`no manifest phase for node ${adapterInput.nodeId}`);
    const outputsDir = resolveWorkspacePath(adapterInput.outputPath);
    const nodeDir = path.dirname(outputsDir);
    const markerFile = path.join(nodeDir, MULTI_TARGET_RESULT_MARKER);
    const marker = readMarker(markerFile);
    if (marker && marker.idempotencyKey === adapterInput.idempotencyKey) {
      return { state: marker.state, reportedCostUsd: marker.reportedCostUsd, outputPaths: [adapterInput.outputPath],
        costObserved: marker.costObserved ?? marker.reportedCostUsd > 0,
        ...(marker.reason ? { reason: marker.reason } : {}) };
    }
    if (adapterInput.signal?.aborted) return failed(`aborted: ${String(adapterInput.signal.reason)}`);

    const upstreamSummaries = adapterInput.upstreamPaths
      .filter((upstream) => !supportPaths.has(upstream))
      .map((upstream) => path.join(resolveWorkspacePath(upstream), "_SUMMARY.md"));
    let deliverable = input.nodeBriefs[adapterInput.nodeId]?.trim() ?? "";
    if (adapterInput.target.kind === "synthesis") {
      deliverable = [
        deliverable || "Synthesize the upstream phase outputs into the final deliverable.",
        "", "Upstream summaries to synthesize:",
        ...upstreamSummaries.map((summary) => `- ${summary}`),
      ].join("\n");
    } else if (!deliverable) {
      return failed(`no sub-brief for node ${adapterInput.nodeId}`);
    }

    fs.mkdirSync(outputsDir, { recursive: true });
    const instructionFile = path.join(nodeDir, MULTI_TARGET_INSTRUCTION_FILE);
    fs.writeFileSync(instructionFile, renderInstruction({
      phase, input: adapterInput, projectId: input.projectId, workspaceRoot, nodeDir, outputsDir, deliverable, upstreamSummaries,
      downstreams: phase.consumed_by.map((id) => phases.get(id)).filter((consumer): consumer is ManifestPhase => !!consumer),
    }), "utf8");
    const briefFile = path.join(nodeDir, MULTI_TARGET_BRIEF_FILE);
    fs.writeFileSync(briefFile, `${deliverable}

Read ${instructionFile} before producing anything: it names the upstream summaries to read first and fixes your output path (${outputsDir}). Write ${path.join(outputsDir, "_SUMMARY.md")} last.
`, "utf8");

    const command = ["bun", dispatchScript];
    if (adapterInput.target.kind === "business") command.push("--business", adapterInput.target.id);
    else if (adapterInput.target.kind === "squad") command.push("--squad", adapterInput.target.id);
    else command.push("--agent-x");
    command.push("--brief-file", briefFile, "--exec", "--project", input.projectId,
      "--run-id", nodeRunId(input.projectId, adapterInput.nodeId, adapterInput.attempt), "--outputs-root", outputsDir);
    if (input.runtime) command.push("--runtime", input.runtime);
    const budgets = [adapterInput.mode === "gauntlet" ? adapterInput.grantedCostUsd : NaN, input.budgetUsd?.[adapterInput.nodeId] ?? NaN]
      .filter((value) => Number.isFinite(value) && value > 0);
    if (budgets.length) command.push("--max-budget", String(Math.min(...budgets)));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...input.env })) if (value !== undefined) env[key] = value;
    env[MULTI_TARGET_NODE_ID_ENV] = adapterInput.nodeId;
    // With --run-id the dispatch opens `<NIRVANA_PROJECT_ROOT || cwd>/.nirvana/run-kernel.sqlite`: the node's
    // Run lands beside the plan's `run_mt_<project>` whatever the caller's shell carries.
    env.NIRVANA_PROJECT_ROOT = projectRoot;
    // The effective settings, as the variables the child reads (settings.ts settingsEnvForChild):
    // the project's and the user's config hold in the child, and the allowlist below merges into
    // the effective one, not only into what the shell carried.
    Object.assign(env, settingsEnvForChild({ env, projectRoot }));
    if (adapterInput.mode === "gauntlet") {
      command.push("--execution-mode=gauntlet", `--gauntlet-intensity=${adapterInput.intensity ?? "light"}`);
      if (adapterInput.target.kind === "business") env[BUSINESS_ALLOWLIST_ENV] = mergeAllowlist(env[BUSINESS_ALLOWLIST_ENV], adapterInput.target.id);
    }

    // The child writes its audit where this adapter reads the cost from; a caller's HARNESS_LOGS_DIR wins.
    const logsDir = env.HARNESS_LOGS_DIR ? path.resolve(env.HARNESS_LOGS_DIR) : harnessLogsDir({ projectRoot });
    env.HARNESS_LOGS_DIR = logsDir;

    const spawned = await spawn({ command, cwd: projectRoot, env, signal: adapterInput.signal });
    if (adapterInput.signal?.aborted) return failed(`aborted: ${String(adapterInput.signal.reason)}`);

    const { costUsd: reportedCostUsd, observed: costObserved } = observeCost(logsDir, input.projectId, costMatcher({ ...adapterInput.target, nodeId: adapterInput.nodeId }));
    const outcome = mapExitCode(spawned.exitCode, spawned.stderr);
    const record: MultiTargetResultMarker = {
      idempotencyKey: adapterInput.idempotencyKey, state: outcome.state, exitCode: spawned.exitCode, reportedCostUsd, costObserved,
      finishedAt: new Date().toISOString(), ...(outcome.reason ? { reason: outcome.reason } : {}),
    };
    fs.writeFileSync(markerFile, JSON.stringify(record, null, 2), "utf8");
    return { state: outcome.state, reportedCostUsd, costObserved, outputPaths: [adapterInput.outputPath], ...(outcome.reason ? { reason: outcome.reason } : {}) };
  };

  return { standard: { run }, gauntlet: { run } };
}
