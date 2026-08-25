// multi-target-dispatch-adapters.ts — production adapters for the multi-target
// coordinator. Each node runs the existing single-target dispatch script as a
// subprocess, so the legacy contract (exit codes, artifacts, audit, session
// files, canaries) is preserved verbatim: nothing here re-implements dispatch.
//
// Target selection is always explicit, never keyword routing:
//   business  → positional `<slug>` (dispatch.ts resolves it without a router)
//   squad     → `--auto` with a brief that opens with `use squad <slug>:`, the
//               form the agentic router is instructed to honor without negotiation
//   agent-x / synthesis → `--auto` with a brief that opens with `use agent-x`;
//               dispatch.ts has no deterministic agent-x selector, so this is the
//               closest explicit form the legacy CLI accepts
//
// Cost source: `agent_executed.cost_usd` events in the harness audit log,
// filtered by trace and by the target discriminator each legacy path writes
// (`business_slug`, `squad_slug`, `employee: "agent-x"`). The run-ledger stores
// no cost, and the audit log is per project and append-only, which makes it
// the one source every dispatch path already feeds.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { harnessLogsDir } from "../../../_shared/lib/log-paths.ts";
import type { CompiledMultiTargetPlan, ManifestPhase } from "../plan-compiler.ts";
import type { MultiTargetAdapterInput, MultiTargetAdapterResult, MultiTargetCoordinatorPorts } from "./multi-target-coordinator.ts";

export const MULTI_TARGET_RESULT_MARKER = ".multi-target-result.json";
export const MULTI_TARGET_INSTRUCTION_FILE = "DISPATCH-INSTRUCTION.md";
export const MULTI_TARGET_BRIEF_FILE = "dispatch-brief.md";

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

function readMarker(file: string): MultiTargetResultMarker | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as MultiTargetResultMarker; } catch { return null; }
}

function costMatcher(target: MultiTargetAdapterInput["target"]): (event: Record<string, unknown>) => boolean {
  if (target.kind === "business") return (event) => event.business_slug === target.id;
  if (target.kind === "squad") return (event) => event.squad_slug === target.id && !event.business_slug;
  return (event) => event.employee === "agent-x";
}

/** Sum of `agent_executed.cost_usd` for this trace and target across every day folder of the audit log. */
function observedCostUsd(logsDir: string, projectId: string, matches: (event: Record<string, unknown>) => boolean): number {
  let days: string[];
  try { days = fs.readdirSync(logsDir).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)); } catch { return 0; }
  let total = 0;
  for (const day of days) {
    let text: string;
    try { text = fs.readFileSync(path.join(logsDir, day, "audit.jsonl"), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (event.event !== "agent_executed" || event.trace_id !== projectId || !matches(event)) continue;
      const cost = Number(event.cost_usd);
      if (Number.isFinite(cost) && cost > 0) total += cost;
    }
  }
  return total;
}

function selector(target: MultiTargetAdapterInput["target"]): string | null {
  if (target.kind === "business") return null;
  if (target.kind === "squad") return `use squad ${target.id}`;
  return "use agent-x (generalist; no business or squad)";
}

function renderInstruction(args: {
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
  return `---
target: ${phase.target}
phase_id: ${phase.id}
trace_id: ${args.projectId}
created_at: ${new Date().toISOString()}
---

# Your mission in this dispatch

You are **${input.target.id}** within project \`${args.projectId}\`. This file is your specific scope. The full project context lives elsewhere; read it first.

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
    if (adapterInput.mode === "gauntlet" && (adapterInput.intensity ?? "light") !== "light") {
      return failed(`gauntlet intensity '${adapterInput.intensity}' is not supported by the dispatch canaries (light only)`);
    }
    const outputsDir = resolveWorkspacePath(adapterInput.outputPath);
    const nodeDir = path.dirname(outputsDir);
    const markerFile = path.join(nodeDir, MULTI_TARGET_RESULT_MARKER);
    const marker = readMarker(markerFile);
    if (marker && marker.idempotencyKey === adapterInput.idempotencyKey) {
      return { state: marker.state, reportedCostUsd: marker.reportedCostUsd, outputPaths: [adapterInput.outputPath],
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
    const prefix = selector(adapterInput.target);
    fs.writeFileSync(briefFile, `${prefix ? `${prefix}: ${deliverable}` : deliverable}

Read ${instructionFile} before producing anything: it names the upstream summaries to read first and fixes your output path (${outputsDir}). Write ${path.join(outputsDir, "_SUMMARY.md")} last.
`, "utf8");

    const command = ["bun", dispatchScript];
    if (adapterInput.target.kind === "business") command.push(adapterInput.target.id);
    else command.push("--auto");
    command.push("--brief-file", briefFile, "--exec", "--project", input.projectId, "--outputs-root", outputsDir);
    if (input.runtime) command.push("--runtime", input.runtime);
    const budgets = [adapterInput.mode === "gauntlet" ? adapterInput.grantedCostUsd : NaN, input.budgetUsd?.[adapterInput.nodeId] ?? NaN]
      .filter((value) => Number.isFinite(value) && value > 0);
    if (budgets.length) command.push("--max-budget", String(Math.min(...budgets)));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...input.env })) if (value !== undefined) env[key] = value;
    if (adapterInput.mode === "gauntlet") {
      command.push("--execution-mode=gauntlet", `--gauntlet-intensity=${adapterInput.intensity ?? "light"}`);
      if (adapterInput.target.kind === "business") env[BUSINESS_ALLOWLIST_ENV] = mergeAllowlist(env[BUSINESS_ALLOWLIST_ENV], adapterInput.target.id);
    }

    const spawned = await spawn({ command, cwd: projectRoot, env, signal: adapterInput.signal });
    if (adapterInput.signal?.aborted) return failed(`aborted: ${String(adapterInput.signal.reason)}`);

    const logsDir = env.HARNESS_LOGS_DIR ? path.resolve(env.HARNESS_LOGS_DIR) : harnessLogsDir({ projectRoot });
    const reportedCostUsd = observedCostUsd(logsDir, input.projectId, costMatcher(adapterInput.target));
    const outcome = mapExitCode(spawned.exitCode, spawned.stderr);
    const record: MultiTargetResultMarker = {
      idempotencyKey: adapterInput.idempotencyKey, state: outcome.state, exitCode: spawned.exitCode, reportedCostUsd,
      finishedAt: new Date().toISOString(), ...(outcome.reason ? { reason: outcome.reason } : {}),
    };
    fs.writeFileSync(markerFile, JSON.stringify(record, null, 2), "utf8");
    return { state: outcome.state, reportedCostUsd, outputPaths: [adapterInput.outputPath], ...(outcome.reason ? { reason: outcome.reason } : {}) };
  };

  return { standard: { run }, gauntlet: { run } };
}
