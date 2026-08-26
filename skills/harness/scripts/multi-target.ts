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
//   nrv multi-target run    <file> [--project <id>] [--runtime <rt>] [--owner <id>] [--json]
//   nrv multi-target status <file|runId> [--project <id>] [--json]        read-only projection
//
// `run` is opt-in: NIRVANA_MULTI_TARGET_ENGINE=1 enables it and
// NIRVANA_MULTI_TARGET_KILL_SWITCH=1 turns it off again. Repeating `run` with
// the same plan resumes: the coordinator is idempotent, completed nodes never
// spawn twice, and a terminal Run answers without executing anything.
//
// Exit codes: 0 delivered · 1 failed · 2 withheld · 4 invalid plan, invalid
// arguments or opt-in missing.
//
// i18n-user-facing: file — what the user reads is PT-BR by contract; code,
// identifiers and comments stay English.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";
import type { DependencyGraph } from "../../_shared/lib/dependency-graph.ts";
import { compileMultiTargetGauntletPolicy, type CompiledMultiTargetPlan, type MultiTargetGauntletPolicy } from "../lib/plan-compiler.ts";
import { reserveAggregateGauntletBudget, type AggregateGauntletBudgetReservation } from "../lib/gauntlet/aggregate-budget.ts";
import { coordinateMultiTargetPlan, type MultiTargetCoordinatorSnapshot, type MultiTargetNodeProjection } from "../lib/gauntlet/multi-target-coordinator.ts";
import { createRunKernelMultiTargetPorts, type RunKernelMultiTargetPorts } from "../lib/gauntlet/run-kernel-multi-target-ports.ts";
import { createDispatchMultiTargetAdapters } from "../lib/gauntlet/multi-target-dispatch-adapters.ts";
import { projectMultiTargetRun } from "../lib/gauntlet/multi-target-projection.ts";
import { createRun, getRun, openKernel, transitionRun, type KernelHandle } from "../lib/run-kernel/store.ts";
import { TERMINAL_RUN_STATES } from "../lib/run-kernel/lifecycle.ts";
import type { CanonicalRunState, RunProjection } from "../lib/run-kernel/types.ts";

const requireCjs = createRequire(import.meta.url);
const auditLib = requireCjs("../lib/audit.js") as {
  emit(event: string, payload: Record<string, unknown>, ctx?: Record<string, unknown>): unknown;
};

export const PLAN_SCHEMA_VERSION = "nirvana.multi-target-plan/v1alpha1";
export const ENGINE_FLAG = "NIRVANA_MULTI_TARGET_ENGINE";
export const KILL_SWITCH = "NIRVANA_MULTI_TARGET_KILL_SWITCH";
const DISPATCH_SCRIPT_ENV = "NIRVANA_DISPATCH_SCRIPT";
const EXIT = { delivered: 0, failed: 1, withheld: 2, invalid: 4 } as const;
const TERMINAL_NODE_STATES = new Set<MultiTargetNodeProjection["state"]>(["delivered", "withheld", "failed", "skipped", "stalled"]);

// ── plan file ───────────────────────────────────────────────────────────────

const NodeSchema = z.strictObject({
  id: z.string().min(1),
  type: z.enum(["company", "squad", "deliverable", "brief"]),
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
    if ((node.type === "company" || node.type === "squad") && !plan.briefs[node.id]) {
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

export function multiTargetRunId(projectId: string): string {
  return `run_mt_${projectId.replace(/[^A-Za-z0-9-]/g, "-")}`;
}

export function engineGate(env: Record<string, string | undefined>): { enabled: boolean; message: string } {
  if (env[KILL_SWITCH] === "1") {
    return { enabled: false, message: `O engine multi-target está desligado por ${KILL_SWITCH}=1. Remova a variável para executar.` };
  }
  if (env[ENGINE_FLAG] !== "1") {
    return { enabled: false, message: `O engine multi-target é opt-in: exporte ${ENGINE_FLAG}=1 para executar (plan e status funcionam sem a flag).` };
  }
  return { enabled: true, message: "" };
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

function printStatus(run: RunProjection, projection: MultiTargetCoordinatorSnapshot | null): void {
  console.log(`Run ${run.runId} (projeto ${run.projectId}): ${run.state}`);
  if (!projection) {
    console.log("  o coordenador ainda não salvou snapshot: nenhuma onda começou.");
    return;
  }
  const reason = projection.terminalReason ? ` · ${projection.terminalReason}` : "";
  console.log(`  plano ${projection.state} · onda atual ${projection.currentWave} · custo reportado USD ${projection.reportedCostUsd}${reason}`);
  for (const node of projection.nodes) {
    const notes = [node.reason, node.blockedBy.length ? `bloqueado por ${node.blockedBy.join(", ")}` : ""].filter(Boolean).join(" · ");
    console.log(`    onda ${node.waveIndex}  ${node.nodeId.padEnd(24)} ${node.mode.padEnd(9)} ${node.state.padEnd(10)} USD ${node.reportedCostUsd}/${node.grantedCostUsd}${notes ? `  ${notes}` : ""}`);
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
  console.log(`  Run:        ${args.runId} (${args.run.state})`);
  if (args.projection) {
    console.log(`  Custo:      USD ${args.projection.reportedCostUsd}${args.projection.terminalReason ? ` · ${args.projection.terminalReason}` : ""}`);
  }
  console.log(`  Workspace:  ${args.ws}`);
  console.log(`  Status:     nrv multi-target status ${args.file}`);
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
    "  nrv multi-target run    <arquivo> [--project <id>] [--runtime <rt>] [--owner <id>] [--json]",
    "  nrv multi-target status <arquivo|runId> [--project <id>] [--json]",
    "",
    `  run exige ${ENGINE_FLAG}=1 (${KILL_SWITCH}=1 desliga); plan e status funcionam sempre.`,
    "  exit: 0 entregue · 1 falhou · 2 retido · 4 plano ou argumentos inválidos",
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
  console.log(`Nada foi executado. Para executar: nrv multi-target run ${file} (exige ${ENGINE_FLAG}=1).`);
  return EXIT.delivered;
}

async function commandRun(file: string, argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  const gate = engineGate(process.env);
  if (!gate.enabled) {
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
  const runtime = flag(argv, "runtime") || loaded.file.runtime;
  const runId = multiTargetRunId(projectId);
  const policySnapshotRef = `snapshot_${loaded.compiled.digest.slice(0, 24)}`;
  const actor = { kind: "cli", id: owner };
  const kernel = openKernel(path.join(projectRoot, ".nirvana", "run-kernel.sqlite"));
  try {
    let run = getRun(kernel, projectId, runId);
    if (run && run.policySnapshotRef !== policySnapshotRef) {
      console.error(`✗ O Run ${runId} já existe com outro plano (${run.policySnapshotRef}; o plano atual é ${policySnapshotRef}).`);
      console.error("  Use outro --project para este plano, ou restaure o arquivo que originou o Run.");
      return EXIT.invalid;
    }
    if (run && TERMINAL_RUN_STATES.has(run.state)) {
      if (!json) console.log(`Run ${runId} já é terminal (${run.state}); nada foi executado.`);
      return report({ json, projectId, runId, run, projection: projectMultiTargetRun(kernel, projectId, runId), ws, file, code: exitForRunState(run.state) });
    }
    const resumed = !!run;
    if (!run) {
      run = createRun(kernel, {
        projectId, runId, traceId: projectId, planId: `plan_${runId}`, target: { kind: "agent-x", slug: "agent-x" },
        policySnapshotRef, actor, correlationId: runId, idempotencyKey: `multi-target:${runId}:create`,
      });
    }
    emit("x_multi_target_run_started", {
      run_id: runId, plan_digest: loaded.compiled.digest, reservation_digest: loaded.reservation?.digest ?? null,
      owner, runtime: runtime ?? null, resumed,
    });
    if (!json) console.log(resumed ? `▶ Retomando o Run ${runId} (estado ${run.state}, owner ${owner})` : `▶ Run ${runId} criado (owner ${owner})`);
    if (run.state === "prepared") run = transition(kernel, projectId, runId, "running", actor);

    const adapters = createDispatchMultiTargetAdapters({
      projectRoot, projectId, plan: loaded.compiled, nodeBriefs: loaded.file.briefs, runtime,
      dispatchScriptPath: process.env[DISPATCH_SCRIPT_ENV] || undefined, budgetUsd: loaded.file.budgetUsd,
    });
    const ports = createRunKernelMultiTargetPorts({ kernel, projectId, runId, ownerId: owner, actor, correlationId: runId, ...adapters });
    // Every node's terminal projection also reaches the legacy audit chain.
    const journal: RunKernelMultiTargetPorts["journal"] = {
      persistSnapshots: ports.journal.persistSnapshots,
      emit(event) {
        ports.journal.emit(event);
        const node = (event.payload as { node?: MultiTargetNodeProjection } | undefined)?.node;
        if (!node || !TERMINAL_NODE_STATES.has(node.state)) return;
        emit("x_multi_target_node_terminal", {
          run_id: runId, node_id: node.nodeId, wave: node.waveIndex, mode: node.mode, state: node.state,
          cost_usd: node.reportedCostUsd, granted_usd: node.grantedCostUsd, reason: node.reason ?? null, blocked_by: node.blockedBy,
        });
        if (!json) console.log(`  · onda ${node.waveIndex} ${node.nodeId}: ${node.state}${node.reason ? ` (${node.reason})` : ""} · USD ${node.reportedCostUsd}`);
      },
    };

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
      reason: snapshot.terminalReason ?? null, exit: code,
    });
    return report({ json, projectId, runId, run: current, projection: snapshot, ws, file, code });
  } finally {
    kernel.close();
  }
}

function commandStatus(target: string, argv: string[]): number {
  const json = argv.includes("--json");
  let projectId: string;
  let runId: string;
  if (fs.existsSync(target) && fs.statSync(target).isFile()) {
    const { loaded, issues } = loadPlanFile(target);
    if (!loaded) return reportIssues(issues);
    projectId = resolveProjectId(target, loaded.file, flag(argv, "project"));
    runId = multiTargetRunId(projectId);
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
    run = getRun(kernel, projectId, runId);
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
