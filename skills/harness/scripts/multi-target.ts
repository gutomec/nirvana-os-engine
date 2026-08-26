#!/usr/bin/env bun
// multi-target.ts — `nrv multi-target plan|run|status`: the scripted entry of
// the multi-target engine.
//
// A plan declared in a file (schema nirvana.multi-target-plan/v1alpha1, by
// convention at .nirvana/plans/<trace_id>.json) is compiled into the manifest,
// the Gauntlet policy and the aggregate reservation, then executed by
// coordinateMultiTargetPlan over the Run Kernel ports and the production
// dispatch adapters. Nothing here re-implements dispatch: every node still runs
// scripts/dispatch.ts as a subprocess with its own exit codes, audit chain and
// canaries, and no existing dispatch route changes.
//
//   nrv multi-target plan   <file> [--project <id>]                       compile and print, no execution
//   nrv multi-target run    <file> [--project <id>] [--runtime <rt>] [--owner <id>] [--retry-failed] [--json]
//   nrv multi-target status <file|runId> [--project <id>] [--json]        read-only projection
//
// `run` is on by default: the `multi_target.enabled` setting (settings.ts).
// NIRVANA_MULTI_TARGET_KILL_SWITCH=1|true|on turns it off, and so does
// NIRVANA_MULTI_TARGET_ENGINE=0|false|off (the opt-in flag of the first
// releases; `=1` is still accepted and changes nothing), or
// `multi_target.enabled: false` in the project or global config. A refusal
// names what switched it off, audits `x_multi_target_disabled`, exits 4 and
// touches neither the kernel nor the workspace. Repeating `run` with the same plan
// resumes: the coordinator is idempotent, completed nodes never spawn twice,
// and a terminal Run answers without executing anything.
//
// `--retry-failed` reopens a plan whose Run ended `failed` or `withheld` once
// its cause was fixed. The Run state machine (lib/run-kernel/lifecycle.ts) has
// no transition out of a terminal state, so the retry is a NEW canonical Run
// chained to the previous one by `parentRunId`: `run_mt_<projectId>`, then
// `run_mt_<projectId>_r2`, `_r3`... The new Run starts from the previous
// coordinator snapshot with `delivered` nodes preserved (outputs and result
// markers untouched) and every other terminal node back to `pending`, so only
// what is missing executes. `run` and `status` always address the latest Run
// of that chain.
//
// Exit codes: 0 delivered · 1 failed · 2 withheld · 4 invalid plan, invalid
// arguments, engine switched off, or a retry refused (plan or reservation
// changed, Run not terminal, nothing to reopen).
//
// i18n-user-facing: file — what the user reads is PT-BR by contract; code,
// identifiers and comments stay English.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";
import type { DependencyGraph } from "../../_shared/lib/dependency-graph.ts";
import { compileMultiTargetGauntletPolicy, type CompiledMultiTargetPlan, type MultiTargetGauntletPolicy } from "../lib/plan-compiler.ts";
import { reserveAggregateGauntletBudget, type AggregateGauntletBudgetReservation } from "../lib/gauntlet/aggregate-budget.ts";
import { coordinateMultiTargetPlan, retryMultiTargetSnapshot, type MultiTargetCoordinatorSnapshot, type MultiTargetNodeProjection } from "../lib/gauntlet/multi-target-coordinator.ts";
import { createRunKernelMultiTargetPorts, type RunKernelMultiTargetPorts } from "../lib/gauntlet/run-kernel-multi-target-ports.ts";
import { createDispatchMultiTargetAdapters } from "../lib/gauntlet/multi-target-dispatch-adapters.ts";
import { projectMultiTargetRun } from "../lib/gauntlet/multi-target-projection.ts";
import { appendEvent, createRun, getRun, openKernel, transitionRun, type KernelHandle } from "../lib/run-kernel/store.ts";
import { canonicalJson } from "../lib/run-kernel/canonical-json.ts";
import { TERMINAL_RUN_STATES } from "../lib/run-kernel/lifecycle.ts";
import type { CanonicalRunState, RunProjection } from "../lib/run-kernel/types.ts";
import { detectExecutionRuntime } from "../lib/control-plane/execution-runner.ts";
import { canonicalRuntimeName } from "../lib/runtime-rules.ts";
import { freezeExecutionSnapshot } from "../lib/runtime-snapshot.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { MULTI_TARGET_ENGINE_ENV, MULTI_TARGET_KILL_SWITCH_ENV } from "../../_shared/lib/settings-schema.ts";
import { resolveSetting } from "../../_shared/lib/settings.ts";

const requireCjs = createRequire(import.meta.url);
const auditLib = requireCjs("../lib/audit.js") as {
  emit(event: string, payload: Record<string, unknown>, ctx?: Record<string, unknown>): unknown;
};

export const PLAN_SCHEMA_VERSION = "nirvana.multi-target-plan/v1alpha1";
export const ENGINE_FLAG = MULTI_TARGET_ENGINE_ENV;
export const KILL_SWITCH = MULTI_TARGET_KILL_SWITCH_ENV;
const DISPATCH_SCRIPT_ENV = "NIRVANA_DISPATCH_SCRIPT";
const EXIT = { delivered: 0, failed: 1, withheld: 2, invalid: 4 } as const;
const TERMINAL_NODE_STATES = new Set<MultiTargetNodeProjection["state"]>(["delivered", "withheld", "failed", "skipped", "stalled"]);

// ── plan file ───────────────────────────────────────────────────────────────

const NodeSchema = z.strictObject({
  id: z.string().min(1),
  type: z.enum(["company", "squad", "agent", "deliverable", "brief"]),
  payload: z.record(z.string(), z.unknown()).optional(),
});
const EdgeSchema = z.strictObject({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  type: z.string().min(1),
  meta: z.record(z.string(), z.unknown()).optional(),
});
const PlanFileSchema = z.strictObject({
  schemaVersion: z.literal(PLAN_SCHEMA_VERSION),
  projectId: z.string().min(1).optional(),
  brief: z.string().min(1),
  briefs: z.record(z.string(), z.string().min(1)),
  graph: z.strictObject({ nodes: z.array(NodeSchema), edges: z.array(EdgeSchema) }),
  // Handed to the policy compiler untouched: it owns every semantic check.
  policy: z.record(z.string(), z.unknown()).optional(),
  runtime: z.string().min(1).optional(),
  budgetUsd: z.record(z.string(), z.number().nonnegative()).optional(),
});
export type MultiTargetPlanFile = z.infer<typeof PlanFileSchema>;

export interface PlanIssue { path: string; message: string }
export interface LoadedPlan {
  file: MultiTargetPlanFile;
  compiled: CompiledMultiTargetPlan;
  reservation: AggregateGauntletBudgetReservation | null;
}

/** Shape and cross-reference checks of the plan file; graph semantics belong to the compiler. */
export function validatePlanFile(raw: unknown): { plan: MultiTargetPlanFile | null; issues: PlanIssue[] } {
  const parsed = PlanFileSchema.safeParse(raw);
  if (!parsed.success) {
    return { plan: null, issues: parsed.error.issues.map((issue) => ({ path: `/${issue.path.join("/")}`, message: issue.message })) };
  }
  const plan = parsed.data;
  const issues: PlanIssue[] = [];
  const nodeIds = new Set(plan.graph.nodes.map((node) => node.id));
  for (const id of Object.keys(plan.briefs)) if (!nodeIds.has(id)) issues.push({ path: `/briefs/${id}`, message: "node not found in graph" });
  for (const node of plan.graph.nodes) {
    if ((node.type === "company" || node.type === "squad" || node.type === "agent") && !plan.briefs[node.id]) {
      issues.push({ path: `/briefs/${node.id}`, message: `executable node ${node.id} has no brief` });
    }
  }
  for (const id of Object.keys(plan.budgetUsd ?? {})) if (!nodeIds.has(id)) issues.push({ path: `/budgetUsd/${id}`, message: "node not found in graph" });
  return { plan: issues.length ? null : plan, issues };
}

export function compilePlanFile(plan: MultiTargetPlanFile): { loaded: LoadedPlan | null; issues: PlanIssue[] } {
  const compiled = compileMultiTargetGauntletPolicy(plan.graph as DependencyGraph, plan.policy as MultiTargetGauntletPolicy | undefined);
  if (!compiled.plan) return { loaded: null, issues: compiled.issues };
  const reserved = reserveAggregateGauntletBudget(compiled.plan);
  if (reserved.issues.length) return { loaded: null, issues: reserved.issues };
  if (reserved.reservation?.status === "rejected") {
    return { loaded: null, issues: [{ path: "/policy/limits/maxCostUsd", message: `reservation rejected: ${reserved.reservation.reason}` }] };
  }
  return { loaded: { file: plan, compiled: compiled.plan, reservation: reserved.reservation }, issues: [] };
}

export function loadPlanFile(file: string): { loaded: LoadedPlan | null; issues: PlanIssue[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { loaded: null, issues: [{ path: "/", message: `cannot read plan file: ${(error as Error).message}` }] };
  }
  const validated = validatePlanFile(raw);
  if (!validated.plan) return { loaded: null, issues: validated.issues };
  return compilePlanFile(validated.plan);
}

// ── identity ────────────────────────────────────────────────────────────────

/** Same root Glance uses for the kernel: NIRVANA_PROJECT_ROOT, else the cwd. */
export function resolveProjectRoot(): string {
  return path.resolve(process.env.NIRVANA_PROJECT_ROOT || process.cwd());
}

/** --project, else the plan's projectId, else the plan file name (`.nirvana/plans/<trace_id>.json`). */
export function resolveProjectId(file: string, plan: MultiTargetPlanFile | null, flagValue: string | undefined): string {
  return flagValue || plan?.projectId || path.basename(file, path.extname(file));
}

/** `run_mt_<projectId>` for the first attempt; `_r<attempt>` appended for every retry of the plan. */
export function multiTargetRunId(projectId: string, attempt = 1): string {
  const base = `run_mt_${projectId.replace(/[^A-Za-z0-9-]/g, "-")}`;
  return attempt > 1 ? `${base}_r${attempt}` : base;
}

/** The latest Run of the plan's chain: attempt 1, then every `_r<n>` that exists, in order. */
export function resolveMultiTargetRun(kernel: KernelHandle, projectId: string): { run: RunProjection | null; runId: string; attempt: number } {
  let attempt = 1;
  let run = getRun(kernel, projectId, multiTargetRunId(projectId, attempt));
  if (!run) return { run: null, runId: multiTargetRunId(projectId, attempt), attempt };
  for (;;) {
    const next = getRun(kernel, projectId, multiTargetRunId(projectId, attempt + 1));
    if (!next) break;
    run = next;
    attempt++;
  }
  return { run, runId: run.runId, attempt };
}

export interface EngineGate {
  enabled: boolean;
  /** The variable, or the key `multi_target.enabled` when a config file switched it off. */
  variable: string | null;
  value: string | null;
  /** Where the refusal came from: `env`, `project` or `global`. */
  source: string | null;
  /** The config file, when one switched it off. */
  path: string | null;
  message: string;
}

/**
 * `run` is on unless the `multi_target.enabled` setting switches it off: the
 * kill switch variable at 1|true|on, the legacy opt-in flag at 0|false|off
 * (at `1`, or any other value, it changes nothing, so an environment set up
 * for the opt-in era keeps working), or `false` in the project or global
 * config. The message names what switched the engine off.
 */
export function engineGate(env: Record<string, string | undefined>): EngineGate {
  const enabled = resolveSetting("multi_target.enabled", { env });
  if (enabled.value) return { enabled: true, variable: null, value: null, source: null, path: null, message: "" };
  if (enabled.source === "env") {
    return {
      enabled: false, variable: enabled.variable!, value: enabled.raw!, source: "env", path: null,
      message: `O engine multi-target está desligado por ${enabled.variable}=${enabled.raw}. Remova a variável para executar; plan e status funcionam sempre.`,
    };
  }
  return {
    enabled: false, variable: "multi_target.enabled", value: "false", source: enabled.source, path: enabled.path ?? null,
    message: `O engine multi-target está desligado por multi_target.enabled=false em ${enabled.path}. Rode nrv config set multi_target.enabled true (ou nrv config unset multi_target.enabled) para executar; plan e status funcionam sempre.`,
  };
}

function exitForRunState(state: CanonicalRunState): number {
  if (state === "completed" || state === "delivered_with_reservations") return EXIT.delivered;
  if (state === "withheld") return EXIT.withheld;
  return EXIT.failed;
}

// ── audit (legacy chain, trace_id = projectId) ──────────────────────────────

let auditContext: { projectRoot: string; projectId: string } | null = null;
// Named `emit` so check-audit-parity's literal scan lists these x_ events.
function emit(event: string, payload: Record<string, unknown>): void {
  if (!auditContext) return;
  try {
    auditLib.emit(event, payload, { trace_id: auditContext.projectId, project_id: auditContext.projectId, cwd: auditContext.projectRoot });
  } catch { /* the audit must never take the run down */ }
}

// ── workspace and output ────────────────────────────────────────────────────

function workspaceRoot(projectRoot: string, projectId: string): string {
  return path.join(projectRoot, ".nirvana", "outputs", projectId);
}

function writeWorkspace(projectRoot: string, projectId: string, loaded: LoadedPlan): string {
  const ws = workspaceRoot(projectRoot, projectId);
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "manifest.json"), JSON.stringify(loaded.compiled.manifest, null, 2) + "\n", "utf8");
  const brief = loaded.file.brief;
  fs.writeFileSync(path.join(ws, "brief-enriched.md"), brief.endsWith("\n") ? brief : `${brief}\n`, "utf8");
  return ws;
}

function emitPlanCompiled(loaded: LoadedPlan, ws: string, file: string): void {
  emit("x_multi_target_plan_compiled", {
    plan_file: path.resolve(file), plan_digest: loaded.compiled.digest, reservation_digest: loaded.reservation?.digest ?? null,
    waves: loaded.compiled.manifest.parallel_waves.map((wave) => [...wave].sort()),
    node_count: loaded.compiled.manifest.phases.length, workspace: ws,
  });
}

function printPlan(projectId: string, loaded: LoadedPlan, ws: string): void {
  const { compiled, reservation } = loaded;
  console.log(`Plano multi-target: ${projectId}`);
  console.log(`  digest do plano ....... ${compiled.digest}`);
  console.log(`  digest da reserva ..... ${reservation?.digest ?? "(sem reserva: nenhuma decisão Gauntlet sob teto agregado)"}`);
  console.log("  ondas:");
  compiled.manifest.parallel_waves.forEach((wave, index) => console.log(`    ${index}: ${[...wave].sort().join(", ")}`));
  console.log("  decisões:");
  for (const decision of [...compiled.decisions, ...(compiled.synthesis ? [compiled.synthesis] : [])]) {
    const mode = decision.mode === "gauntlet" ? `gauntlet ${decision.intensity ?? "light"}` : "standard";
    console.log(`    ${decision.nodeId.padEnd(24)} ${decision.targetKind.padEnd(10)} ${mode.padEnd(18)} ${decision.reason}`);
  }
  if (reservation) {
    console.log(`  alocações (teto USD ${reservation.aggregateCapUsd} · concedido USD ${reservation.grantedUsd} · saldo USD ${reservation.balanceUsd}):`);
    for (const allocation of reservation.allocations.filter((item) => item.reason !== "standard_no_reservation")) {
      console.log(`    ${allocation.nodeId.padEnd(24)} onda ${allocation.waveIndex}  solicitado ${allocation.requestedUsd}  concedido ${allocation.grantedUsd}  ${allocation.reason}`);
    }
  }
  console.log(`  workspace: ${ws} (manifest.json, brief-enriched.md)`);
}

const COST_UNOBSERVED = "custo não observado";

function costUnobservedNodes(projection: MultiTargetCoordinatorSnapshot | null): string[] {
  return projection?.nodes.filter((node) => node.costObserved === false).map((node) => node.nodeId) ?? [];
}

function printStatus(run: RunProjection, projection: MultiTargetCoordinatorSnapshot | null): void {
  console.log(`Run ${run.runId} (projeto ${run.projectId}): ${run.state}${run.parentRunId ? ` · reaberto de ${run.parentRunId}` : ""}`);
  if (!projection) {
    console.log("  o coordenador ainda não salvou snapshot: nenhuma onda começou.");
    return;
  }
  const reason = projection.terminalReason ? ` · ${projection.terminalReason}` : "";
  const attempt = projection.attempt && projection.attempt > 1 ? ` · tentativa ${projection.attempt}` : "";
  console.log(`  plano ${projection.state} · onda atual ${projection.currentWave} · custo reportado USD ${projection.reportedCostUsd}${attempt}${reason}`);
  for (const node of projection.nodes) {
    const notes = [node.reason, node.blockedBy.length ? `bloqueado por ${node.blockedBy.join(", ")}` : "", node.costObserved === false ? COST_UNOBSERVED : ""]
      .filter(Boolean).join(" · ");
    console.log(`    onda ${node.waveIndex}  ${node.nodeId.padEnd(24)} ${(node.targetKind ?? "").padEnd(10)} ${node.mode.padEnd(9)} ${node.state.padEnd(10)} USD ${node.reportedCostUsd}/${node.grantedCostUsd}${notes ? `  ${notes}` : ""}`);
  }
}

function report(args: {
  json: boolean; projectId: string; runId: string; run: RunProjection; projection: MultiTargetCoordinatorSnapshot | null;
  ws: string; file: string; code: number;
}): number {
  if (args.json) {
    console.log(JSON.stringify({ projectId: args.projectId, runId: args.runId, run: args.run, projection: args.projection, exitCode: args.code }, null, 2));
    return args.code;
  }
  console.log("");
  if (args.code === EXIT.delivered) console.log("✓ Plano multi-target entregue.");
  else if (args.code === EXIT.withheld) console.log("⚠ Plano multi-target RETIDO: um nó foi retido ou pulado; nada foi marcado como entregue.");
  else console.log("✗ Plano multi-target falhou.");
  console.log(`  Run:        ${args.runId} (${args.run.state})${args.run.parentRunId ? ` · reaberto de ${args.run.parentRunId}` : ""}`);
  if (args.projection) {
    console.log(`  Custo:      USD ${args.projection.reportedCostUsd}${args.projection.terminalReason ? ` · ${args.projection.terminalReason}` : ""}`);
    const unobserved = costUnobservedNodes(args.projection);
    if (unobserved.length) console.log(`  Atenção:    ${COST_UNOBSERVED} em ${unobserved.length} nó(s): ${unobserved.join(", ")} (o custo real desses nós é desconhecido, não zero)`);
  }
  console.log(`  Workspace:  ${args.ws}`);
  console.log(`  Status:     nrv multi-target status ${args.file}`);
  if (args.code !== EXIT.delivered) console.log(`  Reabrir:    nrv multi-target run ${args.file} --retry-failed (depois de corrigir a causa; nós entregues não executam de novo)`);
  return args.code;
}

// ── commands ────────────────────────────────────────────────────────────────

function flag(argv: string[], name: string): string | undefined {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = argv[i];
  return a.includes("=") ? a.split("=").slice(1).join("=") : argv[i + 1];
}

function usage(code: number): never {
  console.error([
    "uso:",
    "  nrv multi-target plan   <arquivo> [--project <id>]",
    "  nrv multi-target run    <arquivo> [--project <id>] [--runtime <rt>] [--owner <id>] [--retry-failed] [--json]",
    "  nrv multi-target status <arquivo|runId> [--project <id>] [--json]",
    "",
    `  run executa sem variável; ${KILL_SWITCH}=1, ${ENGINE_FLAG}=0 ou nrv config set multi_target.enabled false desligam. plan e status funcionam sempre.`,
    "  --retry-failed reabre um Run failed ou withheld num Run novo encadeado: nós entregues ficam, o resto volta a pending.",
    "  exit: 0 entregue · 1 falhou · 2 retido · 4 plano ou argumentos inválidos, engine desligado, ou retomada recusada",
  ].join("\n"));
  process.exit(code);
}

function reportIssues(issues: PlanIssue[]): number {
  console.error(`Plano inválido (${issues.length} problema${issues.length === 1 ? "" : "s"}):`);
  for (const issue of issues) console.error(`  ${issue.path}: ${issue.message}`);
  return EXIT.invalid;
}

function transition(kernel: KernelHandle, projectId: string, runId: string, to: CanonicalRunState, actor: { kind: string; id: string }, payload?: Record<string, unknown>): RunProjection {
  return transitionRun(kernel, {
    projectId, runId, to, actor, correlationId: runId, idempotencyKey: `multi-target:${runId}:transition:${to}`,
    ...(payload ? { payload } : {}),
  });
}

function commandPlan(file: string, argv: string[]): number {
  const { loaded, issues } = loadPlanFile(file);
  if (!loaded) return reportIssues(issues);
  const projectRoot = resolveProjectRoot();
  const projectId = resolveProjectId(file, loaded.file, flag(argv, "project"));
  auditContext = { projectRoot, projectId };
  const ws = writeWorkspace(projectRoot, projectId, loaded);
  emitPlanCompiled(loaded, ws, file);
  printPlan(projectId, loaded, ws);
  console.log(`Nada foi executado. Para executar: nrv multi-target run ${file}.`);
  return EXIT.delivered;
}

async function commandRun(file: string, argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  const retryFailed = argv.includes("--retry-failed");
  const gate = engineGate(process.env);
  if (!gate.enabled) {
    // A refusal opens no kernel and writes no workspace; the audit line is its only trace.
    auditContext = { projectRoot: resolveProjectRoot(), projectId: resolveProjectId(file, null, flag(argv, "project")) };
    emit("x_multi_target_disabled", { plan_file: path.resolve(file), variable: gate.variable, value: gate.value, source: gate.source, path: gate.path, exit: EXIT.invalid });
    console.error(gate.message);
    return EXIT.invalid;
  }
  const { loaded, issues } = loadPlanFile(file);
  if (!loaded) return reportIssues(issues);
  const projectRoot = resolveProjectRoot();
  const projectId = resolveProjectId(file, loaded.file, flag(argv, "project"));
  auditContext = { projectRoot, projectId };
  const ws = writeWorkspace(projectRoot, projectId, loaded);
  emitPlanCompiled(loaded, ws, file);
  if (!json) printPlan(projectId, loaded, ws);

  const owner = flag(argv, "owner") || `${os.hostname()}:${process.pid}`;
  const runtimeFlag = flag(argv, "runtime");
  const runtime = runtimeFlag || loaded.file.runtime;
  const policySnapshotRef = `snapshot_${loaded.compiled.digest.slice(0, 24)}`;
  const actor = { kind: "cli", id: owner };
  const logsDir = process.env.HARNESS_LOGS_DIR ? path.resolve(process.env.HARNESS_LOGS_DIR) : harnessLogsDir({ projectRoot });
  const kernel = openKernel(path.join(projectRoot, ".nirvana", "run-kernel.sqlite"));
  try {
    const chain = resolveMultiTargetRun(kernel, projectId);
    let run = chain.run;
    let runId = chain.runId;
    if (run && run.policySnapshotRef !== policySnapshotRef) {
      console.error(`✗ O Run ${runId} já existe com outro plano (${run.policySnapshotRef}; o plano atual é ${policySnapshotRef}).`);
      console.error("  Use outro --project para este plano, ou restaure o arquivo que originou o Run.");
      return EXIT.invalid;
    }
    // A retry is a new Run chained to the terminal one: the kernel state machine admits no
    // transition out of `failed` or `withheld`, so the same Run can never run again.
    let retry: { previousRunId: string; snapshot: MultiTargetCoordinatorSnapshot; resetNodes: string[] } | null = null;
    if (retryFailed) {
      const refuse = (message: string): number => { console.error(`✗ ${message}`); return EXIT.invalid; };
      if (!run) return refuse(`Nada a reabrir: o plano ${projectId} nunca executou. Use nrv multi-target run sem --retry-failed.`);
      if (!TERMINAL_RUN_STATES.has(run.state)) return refuse(`O Run ${runId} não é terminal (${run.state}); repita o comando sem --retry-failed para retomar.`);
      if (run.state !== "failed" && run.state !== "withheld") return refuse(`O Run ${runId} está ${run.state}: só um Run failed ou withheld pode ser reaberto.`);
      const previous = projectMultiTargetRun(kernel, projectId, runId);
      if (!previous) return refuse(`O Run ${runId} não tem snapshot do coordenador; nada a reabrir.`);
      let reopened: ReturnType<typeof retryMultiTargetSnapshot>;
      try {
        reopened = retryMultiTargetSnapshot({ previous, plan: loaded.compiled, reservation: loaded.reservation });
      } catch (error) {
        return refuse(`O plano ou a reserva mudaram desde o Run ${runId} (${(error as Error).message}). Restaure o arquivo que originou o Run ou use outro --project.`);
      }
      retry = { previousRunId: runId, ...reopened };
      runId = multiTargetRunId(projectId, chain.attempt + 1);
      run = null;
    } else if (run && TERMINAL_RUN_STATES.has(run.state)) {
      if (!json) {
        console.log(`Run ${runId} já é terminal (${run.state}); nada foi executado.`);
        if (run.state === "failed" || run.state === "withheld") console.log(`  Corrigida a causa, reabra só o que falta: nrv multi-target run ${file} --retry-failed`);
      }
      return report({ json, projectId, runId, run, projection: projectMultiTargetRun(kernel, projectId, runId), ws, file, code: exitForRunState(run.state) });
    }
    const resumed = !!run;
    if (!run) {
      run = createRun(kernel, {
        projectId, runId, traceId: projectId, ...(retry ? { parentRunId: retry.previousRunId } : {}),
        planId: `plan_${runId}`, target: { kind: "agent-x", slug: "agent-x" },
        policySnapshotRef, actor, correlationId: runId, idempotencyKey: `multi-target:${runId}:create`,
      });
      // The runtime every node inherits, frozen from the provider catalogs the way the
      // canaries freeze theirs: `--runtime`, else the plan's, else the session host. The
      // journal keeps this snapshot after any catalog update; a resumed Run never refreezes.
      const runtimeSource = runtimeFlag ? "flag" : loaded.file.runtime ? "plan" : "default";
      const runtimeId = runtime ? canonicalRuntimeName(runtime) : detectExecutionRuntime().runtime;
      const snapshot = freezeExecutionSnapshot({ runtimeId, runtimeSource, projectRoot });
      appendEvent(kernel, { projectId, runId, traceId: projectId, type: "runtime.selection_snapshot", actor, correlationId: runId,
        idempotencyKey: `multi-target:${runId}:execution-snapshot`,
        payload: { ref: `snapshot_${createHash("sha256").update(canonicalJson(snapshot)).digest("hex").slice(0, 24)}`, snapshot } });
      if (snapshot.errors?.length) {
        // RT-002: an incompatible runtime ends the Run before any node, reasons journaled.
        emit("x_runtime_incompatible", { run_id: runId, runtime: runtimeId, runtime_source: runtimeSource, errors: snapshot.errors, rejected: snapshot.rejected ?? [] });
        run = transition(kernel, projectId, runId, "rolled_back", actor, { reason: "runtime_incompatible", errors: snapshot.errors });
        console.error(`✗ O runtime ${runtimeId} é incompatível com o catálogo de providers; o Run ${runId} foi encerrado antes de qualquer nó.`);
        for (const error of snapshot.errors) console.error(`  ${error}`);
        return report({ json, projectId, runId, run, projection: null, ws, file, code: EXIT.failed });
      }
    }
    emit("x_multi_target_run_started", {
      run_id: runId, plan_digest: loaded.compiled.digest, reservation_digest: loaded.reservation?.digest ?? null,
      owner, runtime: runtime ?? null, resumed, retried_from: retry?.previousRunId ?? null,
    });
    if (!json) {
      if (resumed) console.log(`▶ Retomando o Run ${runId} (estado ${run.state}, owner ${owner})`);
      else if (retry) console.log(`▶ Run ${runId} criado a partir de ${retry.previousRunId} (owner ${owner}); voltam a pending: ${retry.resetNodes.join(", ")}`);
      else console.log(`▶ Run ${runId} criado (owner ${owner})`);
    }
    if (run.state === "prepared") run = transition(kernel, projectId, runId, "running", actor);

    const adapters = createDispatchMultiTargetAdapters({
      projectRoot, projectId, plan: loaded.compiled, nodeBriefs: loaded.file.briefs, runtime,
      dispatchScriptPath: process.env[DISPATCH_SCRIPT_ENV] || undefined, budgetUsd: loaded.file.budgetUsd,
    });
    const ports = createRunKernelMultiTargetPorts({ kernel, projectId, runId, ownerId: owner, actor, correlationId: runId, ...adapters });
    // Every node's terminal projection also reaches the legacy audit chain, and so does
    // a node whose cost the adapter could not observe.
    const journal: RunKernelMultiTargetPorts["journal"] = {
      persistSnapshots: ports.journal.persistSnapshots,
      emit(event) {
        ports.journal.emit(event);
        if (event.type === "multi_target.cost_unobserved") {
          const payload = event.payload as { mode?: string; state?: string } | undefined;
          emit("x_multi_target_cost_unobserved", {
            run_id: runId, node_id: event.nodeId, wave: event.waveIndex, mode: payload?.mode ?? null, state: payload?.state ?? null, logs_dir: logsDir,
          });
          return;
        }
        const node = (event.payload as { node?: MultiTargetNodeProjection } | undefined)?.node;
        if (!node || !TERMINAL_NODE_STATES.has(node.state)) return;
        emit("x_multi_target_node_terminal", {
          run_id: runId, node_id: node.nodeId, wave: node.waveIndex, target_kind: node.targetKind ?? null, mode: node.mode, state: node.state,
          cost_usd: node.reportedCostUsd, cost_observed: node.costObserved ?? null, granted_usd: node.grantedCostUsd, reason: node.reason ?? null, blocked_by: node.blockedBy,
        });
        if (!json) {
          const cost = `USD ${node.reportedCostUsd}${node.costObserved === false ? ` (${COST_UNOBSERVED})` : ""}`;
          console.log(`  · onda ${node.waveIndex} ${node.nodeId}: ${node.state}${node.reason ? ` (${node.reason})` : ""} · ${cost}`);
        }
      },
    };
    if (retry) {
      // The new Run starts from the reopened snapshot: the coordinator loads it, skips every
      // delivered node and executes the ones sent back to pending.
      journal.emit({ type: "multi_target.plan_retried", payload: { previousRunId: retry.previousRunId, resetNodes: retry.resetNodes } });
      ports.state.save(retry.snapshot);
      emit("x_multi_target_plan_retried", {
        run_id: runId, previous_run_id: retry.previousRunId, reset_nodes: retry.resetNodes, attempt: retry.snapshot.attempt ?? null, snapshot_version: retry.snapshot.version,
      });
    }

    let snapshot: MultiTargetCoordinatorSnapshot;
    try {
      snapshot = await coordinateMultiTargetPlan({ plan: loaded.compiled, reservation: loaded.reservation, ports: { ...ports, journal } });
    } catch (error) {
      const message = (error as Error).message;
      emit("x_multi_target_terminal", { run_id: runId, state: "error", error: message, exit: EXIT.failed });
      console.error(`✗ O coordenador parou com erro: ${message}`);
      console.error(`  O Run ${runId} continua em ${getRun(kernel, projectId, runId)?.state ?? "?"}; repita o comando para retomar.`);
      return EXIT.failed;
    }
    const terminal: CanonicalRunState = snapshot.state === "delivered" ? "completed" : snapshot.state === "withheld" ? "withheld" : "failed";
    let current = getRun(kernel, projectId, runId)!;
    if (current.state === "running") current = transition(kernel, projectId, runId, "verifying", actor);
    if (current.state === "verifying") {
      current = transition(kernel, projectId, runId, terminal, actor, { reason: snapshot.terminalReason ?? null, cost_usd: snapshot.reportedCostUsd });
    }
    const code = exitForRunState(current.state);
    emit("x_multi_target_terminal", {
      run_id: runId, state: snapshot.state, kernel_state: current.state, cost_usd: snapshot.reportedCostUsd,
      cost_unobserved_nodes: costUnobservedNodes(snapshot), reason: snapshot.terminalReason ?? null, exit: code,
    });
    return report({ json, projectId, runId, run: current, projection: snapshot, ws, file, code });
  } finally {
    kernel.close();
  }
}

function commandStatus(target: string, argv: string[]): number {
  const json = argv.includes("--json");
  let projectId: string;
  // By plan file the status is the latest Run of the chain; a run id addresses that Run alone.
  let runId: string | null = null;
  if (fs.existsSync(target) && fs.statSync(target).isFile()) {
    const { loaded, issues } = loadPlanFile(target);
    if (!loaded) return reportIssues(issues);
    projectId = resolveProjectId(target, loaded.file, flag(argv, "project"));
  } else {
    const project = flag(argv, "project");
    if (!project) {
      console.error("status <runId> exige --project <id>; ou passe o arquivo do plano.");
      return EXIT.invalid;
    }
    projectId = project;
    runId = target;
  }
  const kernelPath = path.join(resolveProjectRoot(), ".nirvana", "run-kernel.sqlite");
  if (!fs.existsSync(kernelPath)) {
    console.error(`Nenhum Run Kernel em ${kernelPath}: nada foi executado neste projeto.`);
    return EXIT.failed;
  }
  const kernel = openKernel(kernelPath);
  let run: RunProjection | null;
  let projection: MultiTargetCoordinatorSnapshot | null = null;
  try {
    if (runId) run = getRun(kernel, projectId, runId);
    else ({ run, runId } = resolveMultiTargetRun(kernel, projectId));
    if (run) projection = projectMultiTargetRun(kernel, projectId, runId);
  } finally {
    kernel.close();
  }
  if (!run) {
    console.error(`Run ${runId} não encontrado no projeto ${projectId}.`);
    return EXIT.failed;
  }
  if (json) console.log(JSON.stringify({ projectId, runId, run, projection }, null, 2));
  else printStatus(run, projection);
  return EXIT.delivered;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") usage(sub ? 0 : EXIT.invalid);
  const target = argv[1];
  if (!target || target.startsWith("--")) usage(EXIT.invalid);
  const rest = argv.slice(2);
  let code: number;
  if (sub === "plan") code = commandPlan(target, rest);
  else if (sub === "run") code = await commandRun(target, rest);
  else if (sub === "status") code = commandStatus(target, rest);
  else usage(EXIT.invalid);
  process.exit(code);
}
