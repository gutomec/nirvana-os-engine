// runtime-snapshot-after-catalog-update.e2e.test.ts — program criterion 6: the
// runtime, provider and model snapshot a Run froze stays readable, byte for byte,
// after the provider catalog changes. Hermetic: a real SQLite Run Kernel, a
// catalog in a temporary directory through NIRVANA_PROVIDER_CATALOG_DIR, the
// Glance server restarted against the same project root, the multi-target CLI
// with the fake dispatch, no LLM and no network.
// Runs with: bun test skills/harness/tests
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProjectService } from "../lib/control-plane/project-service.ts";
import { runAgentXGauntlet, type AgentXGauntletEvaluator } from "../lib/gauntlet/agent-x-cutover.ts";
import { getRun, listEvents, openKernel, type KernelHandle, type RunEvent } from "../lib/run-kernel/index.ts";
import {
  ALLOW_STALE_ENV, CATALOG_DIR_ENV, NO_DESCRIPTOR_REASON, freezeExecutionSnapshot, resolveCatalogDirs, type ExecutionSnapshot,
} from "../lib/runtime-snapshot.ts";
import { multiTargetRunId } from "../scripts/multi-target.ts";
import { writeFakeDispatch } from "./helpers/fake-dispatch.ts";
import { removeDir } from "./helpers/temp-dirs.ts";
import { KERNEL_BUDGET_MS, spawnBudgetMs } from "./helpers/test-budgets.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const MULTI_TARGET = path.join(REPO, "skills", "harness", "scripts", "multi-target.ts");
const NOW = () => new Date("2026-08-25T12:00:00Z");
const RUNTIME = { runtimeId: "codex", runtimeSource: "flag", now: NOW };
const LITERAL = { runtime: { id: "codex", source: "flag" }, provider: { selection: "runtime-provider", resolved: false },
  model: { selection: "runtime-default", resolved: false } };
const TEXT_MODEL_2 = { canonical_id: "fixture-provider/text-model/2", priority: 20, modalities: { input: ["text"], output: ["text"] },
  capabilities: { tool_calling: { support: "native" } } };

const roots: string[] = [];
const handles: KernelHandle[] = [];
const servers: Array<{ close(): void }> = [];
const ENV_KEYS = [CATALOG_DIR_ENV, ALLOW_STALE_ENV, "NIRVANA_PROJECT_ROOT"];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
afterEach(() => {
  while (servers.length) servers.pop()!.close();
  while (handles.length) handles.pop()!.close();
  for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
  while (roots.length) removeDir(roots.pop()!);
});

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "nirvana.runtime-provider/v1alpha1",
    provider: { id: "fixture-provider" },
    catalog: { observed_at: "2026-08-24T00:00:00Z", max_age_seconds: 172800 },
    runtimes: [{ id: "codex", version: "1.2.0", capabilities: { file_read: { support: "native" } } }],
    models: [{ canonical_id: "fixture-provider/text-model/1", priority: 10, modalities: { input: ["text"], output: ["text"] },
      capabilities: { tool_calling: { support: "native" } } }],
    ...overrides,
  };
}

function writeCatalog(dir: string, content: Record<string, unknown>): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "provider.json"), JSON.stringify(content, null, 2), "utf8");
  return dir;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-runtime-snapshot-")); roots.push(root);
  fs.mkdirSync(path.join(root, ".nirvana"), { recursive: true });
  const catalogDir = path.join(root, "catalog");
  process.env[CATALOG_DIR_ENV] = catalogDir;
  const project = new ProjectService().create({ projectRoot: root, displayName: "Runtime snapshot" });
  const kernel = openKernel(path.join(root, ".nirvana", "run-kernel.sqlite")); handles.push(kernel);
  return { root, catalogDir, projectId: project.project_id, kernel,
    closeKernel() { handles.splice(handles.indexOf(kernel), 1); kernel.close(); } };
}

const EVALUATOR = { kind: "squad" as const, slug: "snapshot-evaluator", capabilityId: "quality.specification_conformance" };
const evaluator: AgentXGauntletEvaluator = {
  target: EVALUATOR,
  evaluate({ candidateId, revisionId, artifactRefs }) {
    return [{ evaluationId: `evl_${revisionId}`, candidateId, revisionId, gauntletId: "brief-conformance", rubricVersion: "snapshot/v1",
      verdict: "pass", dimensions: [{ id: "brief", score: 1, confidence: 1, blocking: true, passed: true,
        evidenceRefs: artifactRefs.map(ref => ref.revisionId) }], regressions: [], revisionRequests: [],
      evaluator: EVALUATOR, costUsd: 0, createdAt: "2026-08-25T12:00:02.000Z" }];
  },
};

function gauntlet(setup: ReturnType<typeof fixture>, runId: string, executionSnapshot: ExecutionSnapshot) {
  const calls = { executions: 0, finalGates: 0 };
  const result = runAgentXGauntlet({
    kernel: setup.kernel, projectId: setup.projectId, runId, traceId: `trace_${runId}`, brief: "Produza report.md",
    projectRoot: setup.root, outputsRoot: path.join(setup.root, "deliverables", runId), expectedCostUsd: 1, executionSnapshot,
    executeCandidate(candidateRoot) {
      calls.executions += 1; fs.mkdirSync(candidateRoot, { recursive: true });
      fs.writeFileSync(path.join(candidateRoot, "report.md"), "Conteúdo aprovado.", "utf8");
      return { ok: true, sessionId: `session_${runId}` };
    },
    evaluator,
    finalGate() { calls.finalGates += 1; return { exitCode: 0, gateOutcome: "pass" }; },
  });
  return { result, ...calls };
}

function snapshotEvent(events: RunEvent[], runId: string): { ref: string; snapshot: ExecutionSnapshot } {
  const event = events.find(item => item.runId === runId && item.type === "runtime.selection_snapshot");
  if (!event) throw new Error(`no runtime.selection_snapshot for ${runId}`);
  return event.payload as { ref: string; snapshot: ExecutionSnapshot };
}

async function glance(root: string) {
  process.env.NIRVANA_PROJECT_ROOT = root;
  const { startServer } = await import("../lib/glance/server.ts");
  const instance = await startServer({ port: 0, open: false, idleMin: 60, allowActions: false, theme: "apple" });
  servers.push(instance);
  const base = `http://127.0.0.1:${instance.port}`;
  return {
    run: (projectId: string, runId: string) => fetch(`${base}/api/v1/runs/${runId}?project_id=${projectId}`)
      .then(response => response.json()) as Promise<{ state: string; policySnapshotRef: string }>,
    events: (projectId: string) => fetch(`${base}/api/v1/projects/${projectId}/events?limit=500`)
      .then(response => response.json()).then(body => (body as { events: RunEvent[] }).events),
    stop() { servers.splice(servers.indexOf(instance), 1); instance.close(); },
  };
}

describe("runtime snapshot survives a catalog update (criterion 6)", () => {
  test("a Run keeps the snapshot it froze after the catalog gains a better model, in the kernel and in Glance across a restart", async () => {
    const setup = fixture();
    writeCatalog(setup.catalogDir, descriptor());
    const first = freezeExecutionSnapshot(RUNTIME);
    expect(first).toEqual({
      catalog: { dirs: [setup.catalogDir], observedAt: "2026-08-24T00:00:00Z", stale: false },
      evidence: { providerId: "fixture-provider", observedAt: "2026-08-24T00:00:00Z", modelIds: ["fixture-provider/text-model/1"] },
      model: { id: "fixture-provider/text-model/1", resolved: true },
      policy: { allowStale: false, featuresRequired: [], modelRequirements: {} },
      provider: { id: "fixture-provider", resolved: true },
      runtime: { id: "codex", resolved: true, source: "flag", version: "1.2.0" },
    });
    expect(Object.keys(first)).toEqual([...Object.keys(first)].sort());
    expect(freezeExecutionSnapshot(RUNTIME)).toEqual(first);
    const run1 = gauntlet(setup, "run_first", first);
    expect(run1.result.run.state).toBe("completed");
    const frozen = snapshotEvent(listEvents(setup.kernel, setup.projectId), "run_first");
    expect(frozen.snapshot).toEqual(first);
    expect(frozen.ref).toBe(run1.result.run.policySnapshotRef);

    // Catalog update: a higher-priority model and a new observation.
    writeCatalog(setup.catalogDir, descriptor({ catalog: { observed_at: "2026-08-25T00:00:00Z", max_age_seconds: 172800 },
      models: [...descriptor().models, TEXT_MODEL_2] }));
    const second = freezeExecutionSnapshot(RUNTIME);
    expect(second.model).toEqual({ id: "fixture-provider/text-model/2", resolved: true });
    expect(second.evidence).toEqual({ providerId: "fixture-provider", observedAt: "2026-08-25T00:00:00Z",
      modelIds: ["fixture-provider/text-model/1", "fixture-provider/text-model/2"] });
    const run2 = gauntlet(setup, "run_second", second);
    expect(run2.result.run.state).toBe("completed");
    expect(run2.result.run.policySnapshotRef).not.toBe(frozen.ref);
    expect(snapshotEvent(listEvents(setup.kernel, setup.projectId), "run_second").snapshot).toEqual(second);

    // The first Run still answers with its original decision.
    expect(getRun(setup.kernel, setup.projectId, "run_first")?.policySnapshotRef).toBe(frozen.ref);
    expect(snapshotEvent(listEvents(setup.kernel, setup.projectId), "run_first")).toEqual(frozen);
    setup.closeKernel();
    for (const boot of ["first boot", "after restart"]) {
      const server = await glance(setup.root);
      expect(await server.run(setup.projectId, "run_first"), boot).toMatchObject({ state: "completed", policySnapshotRef: frozen.ref });
      expect(snapshotEvent(await server.events(setup.projectId), "run_first"), boot).toEqual(frozen);
      expect((await server.run(setup.projectId, "run_second")).policySnapshotRef, boot).not.toBe(frozen.ref);
      server.stop();
    }
  }, KERNEL_BUDGET_MS);

  test("a stale catalog marks the snapshot and lets the Run proceed; NIRVANA_ALLOW_STALE_CATALOG=1 resolves it with a warning", () => {
    const setup = fixture();
    writeCatalog(setup.catalogDir, descriptor({ catalog: { observed_at: "2020-01-01T00:00:00Z", max_age_seconds: 60 } }));
    const marked = freezeExecutionSnapshot(RUNTIME);
    expect(marked).toMatchObject({ runtime: { id: "codex", source: "flag", resolved: false, version: "1.2.0" },
      provider: { id: "fixture-provider", resolved: false }, model: { selection: "runtime-default", resolved: false },
      catalog: { dirs: [setup.catalogDir], observedAt: "2020-01-01T00:00:00Z", stale: true }, policy: { allowStale: false } });
    expect(marked.warnings?.[0]).toContain("stale");
    expect(marked.errors).toBeUndefined();
    expect(marked.evidence).toBeUndefined();
    const run = gauntlet(setup, "run_stale", marked);
    expect(run.result.run.state).toBe("completed");
    expect(run.executions).toBe(1);
    expect(snapshotEvent(listEvents(setup.kernel, setup.projectId), "run_stale").snapshot).toEqual(marked);

    const allowed = freezeExecutionSnapshot({ ...RUNTIME, allowStale: true });
    expect(allowed).toMatchObject({ runtime: { resolved: true, version: "1.2.0" }, provider: { id: "fixture-provider", resolved: true },
      model: { id: "fixture-provider/text-model/1", resolved: true }, catalog: { stale: true }, policy: { allowStale: true } });
    expect(allowed.warnings?.[0]).toContain("stale");
    expect(allowed.errors).toBeUndefined();
    process.env[ALLOW_STALE_ENV] = "1";
    expect(freezeExecutionSnapshot(RUNTIME)).toEqual(allowed);
  }, KERNEL_BUDGET_MS);

  test("a missing required feature or model rolls the Run back before the producer with the broker's explanation", () => {
    const setup = fixture();
    writeCatalog(setup.catalogDir, descriptor());
    const feature = freezeExecutionSnapshot({ ...RUNTIME, requirements: { featuresRequired: [{ id: "sandbox", minimumSupport: "native" }] } });
    expect(feature).toMatchObject({ runtime: { id: "codex", resolved: false, version: "1.2.0" }, provider: { id: "fixture-provider", resolved: false },
      model: { selection: "runtime-default", resolved: false }, rejected: [],
      policy: { featuresRequired: [{ id: "sandbox", minimumSupport: "native" }] } });
    expect(feature.errors).toEqual(["REQUIRED feature 'sandbox' requires native, but 'codex' provides unavailable."]);

    const run = gauntlet(setup, "run_incompatible", feature);
    expect(run.result).toMatchObject({ exitCode: 1, finalGateRan: false, sessionId: null, run: { state: "rolled_back" } });
    expect(run.executions).toBe(0);
    expect(run.finalGates).toBe(0);
    expect(run.result.gauntlet).toMatchObject({ state: "stopped", stopReason: "execution_failure", reservations: [expect.stringContaining("sandbox")] });
    const events = listEvents(setup.kernel, setup.projectId).filter(event => event.runId === "run_incompatible");
    expect(snapshotEvent(events, "run_incompatible").snapshot).toEqual(feature);
    const rollback = events.find(event => event.type === "run.transitioned" && (event.payload as { to: string }).to === "rolled_back");
    expect(rollback?.payload).toMatchObject({ from: "prepared", reason: "runtime_incompatible", errors: feature.errors });
    expect(events.some(event => event.type === "gauntlet.candidate_created")).toBeFalse();

    const model = freezeExecutionSnapshot({ ...RUNTIME, requirements: { modelRequirements: { requiredCapabilities: [{ id: "video_generation", minimumSupport: "native" }] } } });
    expect(model.errors?.[0]).toContain("No model");
    expect(model.rejected).toEqual([{ model: "fixture-provider/text-model/1", reasons: ["capability 'video_generation' requires native, model provides unavailable"] }]);
    expect(model.evidence).toBeUndefined();
  }, KERNEL_BUDGET_MS);

  test("without a descriptor the snapshot is the previous literal plus the reason, and missing directories are skipped", () => {
    const setup = fixture();
    const expected = { ...LITERAL, reason: NO_DESCRIPTOR_REASON };
    expect(freezeExecutionSnapshot(RUNTIME)).toEqual(expected);
    fs.mkdirSync(setup.catalogDir, { recursive: true });
    expect(freezeExecutionSnapshot(RUNTIME)).toEqual(expected);
    writeCatalog(setup.catalogDir, descriptor({ runtimes: [{ id: "other-runtime", version: "1.0.0", capabilities: {} }] }));
    expect(freezeExecutionSnapshot(RUNTIME)).toEqual(expected);
    expect(freezeExecutionSnapshot({ ...RUNTIME, catalogDirs: [path.join(setup.root, "missing")] })).toEqual(expected);
    const run = gauntlet(setup, "run_literal", freezeExecutionSnapshot(RUNTIME));
    expect(run.result.run.state).toBe("completed");
    expect(snapshotEvent(listEvents(setup.kernel, setup.projectId), "run_literal").snapshot).toEqual(expected);

    // Default sources: the user catalog, then the project catalog, existing ones only.
    const home = path.join(setup.root, "home");
    const userCatalog = path.join(home, ".nirvana", "providers");
    const projectCatalog = path.join(setup.root, ".nirvana", "providers");
    expect(resolveCatalogDirs({ env: {}, projectRoot: setup.root, homeDir: home })).toEqual([]);
    fs.mkdirSync(projectCatalog, { recursive: true });
    expect(resolveCatalogDirs({ env: {}, projectRoot: setup.root, homeDir: home })).toEqual([projectCatalog]);
    fs.mkdirSync(userCatalog, { recursive: true });
    expect(resolveCatalogDirs({ env: {}, projectRoot: setup.root, homeDir: home })).toEqual([userCatalog, projectCatalog]);
    const configured = [setup.catalogDir, path.join(setup.root, "missing")].join(path.delimiter);
    expect(resolveCatalogDirs({ env: { [CATALOG_DIR_ENV]: configured }, projectRoot: setup.root, homeDir: home })).toEqual([setup.catalogDir]);
  }, KERNEL_BUDGET_MS);
});

describe("nrv multi-target run freezes the coordinator's runtime snapshot", () => {
  const PLAN = {
    schemaVersion: "nirvana.multi-target-plan/v1alpha1",
    brief: "# Brief\n\nBuild the thing.\n",
    briefs: { "business-a": "Deliver part A.", "final-output": "Write the final report." },
    graph: {
      nodes: [{ id: "brief-main", type: "brief" }, { id: "business-a", type: "company" }, { id: "final-output", type: "deliverable" }],
      edges: [{ id: "brief-a", source: "brief-main", target: "business-a", type: "briefs" }, { id: "final", source: "business-a", target: "final-output", type: "yields" }],
    },
  };

  function engine() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-runtime-snapshot-mt-"))); roots.push(root);
    const projectRoot = path.join(root, "project");
    fs.mkdirSync(path.join(projectRoot, ".nirvana", "plans"), { recursive: true });
    const planFile = path.join(projectRoot, ".nirvana", "plans", "plan.json");
    fs.writeFileSync(planFile, JSON.stringify(PLAN, null, 2));
    const spawnLog = path.join(root, "spawns.log");
    const catalogDir = path.join(root, "catalog");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (/^(HARNESS_LOGS_DIR|NIRVANA_MULTI_TARGET_|NIRVANA_PROJECT_ROOT|NIRVANA_STATE_DB|NIRVANA_DISPATCH_SCRIPT|NIRVANA_BUSINESS_GAUNTLET|FAKE_DISPATCH_|NIRVANA_PROVIDER_CATALOG_DIR|NIRVANA_ALLOW_STALE_CATALOG)/.test(key)) continue;
      env[key] = value;
    }
    Object.assign(env, { NIRVANA_SKILLS_DIR: path.join(REPO, "skills"), NIRVANA_NO_UPDATE_CHECK: "1", NIRVANA_SCOPE_QUIET: "1",
      NIRVANA_STATE_DB: path.join(root, "state.db"), NIRVANA_DISPATCH_SCRIPT: writeFakeDispatch(root),
      FAKE_DISPATCH_SPAWN_LOG: spawnLog, [CATALOG_DIR_ENV]: catalogDir });
    const run = (projectId: string) => spawnSync(process.execPath, [MULTI_TARGET, "run", planFile, "--project", projectId, "--runtime", "codex"],
      { cwd: projectRoot, encoding: "utf8", env });
    const kernelEvents = (projectId: string) => {
      const kernel = openKernel(path.join(projectRoot, ".nirvana", "run-kernel.sqlite"));
      try { return { run: getRun(kernel, projectId, multiTargetRunId(projectId)), events: listEvents(kernel, projectId) }; } finally { kernel.close(); }
    };
    const audit = () => {
      const dir = path.join(projectRoot, ".nirvana", "logs", "harness");
      if (!fs.existsSync(dir)) return [] as Array<Record<string, unknown>>;
      return fs.readdirSync(dir).sort().flatMap(day => {
        const file = path.join(dir, day, "audit.jsonl");
        return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) : [];
      });
    };
    return { catalogDir, spawnLog, run, kernelEvents, audit };
  }

  test("journals runtime.selection_snapshot on the multi-target Run and ends an incompatible runtime before any node", () => {
    const setup = engine();
    // The CLI freezes with the wall clock, so the descriptor must stay fresh whenever the test runs.
    const fresh = () => ({ observed_at: new Date().toISOString(), max_age_seconds: 315_360_000 });
    writeCatalog(setup.catalogDir, descriptor({ catalog: fresh(), models: [] }));
    const blocked = setup.run("proj-blocked");
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("incompatível");
    expect(fs.existsSync(setup.spawnLog)).toBeFalse();
    const blockedRun = setup.kernelEvents("proj-blocked");
    expect(blockedRun.run?.state).toBe("rolled_back");
    const blockedSnapshot = snapshotEvent(blockedRun.events, multiTargetRunId("proj-blocked"));
    expect(blockedSnapshot.snapshot).toMatchObject({ runtime: { id: "codex", source: "flag", resolved: false }, provider: { id: "fixture-provider", resolved: false } });
    expect(blockedSnapshot.snapshot.errors?.[0]).toContain("No model");
    const rollback = blockedRun.events.find(event => event.type === "run.transitioned" && (event.payload as { to: string }).to === "rolled_back");
    expect(rollback?.payload).toMatchObject({ reason: "runtime_incompatible", errors: blockedSnapshot.snapshot.errors });
    const incompatible = setup.audit().filter(event => event.event === "x_runtime_incompatible");
    expect(incompatible).toHaveLength(1);
    expect(incompatible[0]).toMatchObject({ trace_id: "proj-blocked", run_id: multiTargetRunId("proj-blocked"), runtime: "codex", runtime_source: "flag" });

    writeCatalog(setup.catalogDir, descriptor({ catalog: fresh() }));
    const delivered = setup.run("proj-delivered");
    expect(delivered.status).toBe(0);
    // Only the company node spawns a dispatch; the deliverable completes as a support node.
    expect(fs.readFileSync(setup.spawnLog, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
    const deliveredRun = setup.kernelEvents("proj-delivered");
    expect(deliveredRun.run?.state).toBe("completed");
    const deliveredSnapshot = snapshotEvent(deliveredRun.events, multiTargetRunId("proj-delivered"));
    expect(deliveredSnapshot.ref).toStartWith("snapshot_");
    expect(deliveredSnapshot.snapshot).toMatchObject({ runtime: { id: "codex", source: "flag", resolved: true, version: "1.2.0" },
      provider: { id: "fixture-provider", resolved: true }, model: { id: "fixture-provider/text-model/1", resolved: true } });
    expect(deliveredRun.events.filter(event => event.type === "runtime.selection_snapshot")).toHaveLength(1);
  }, spawnBudgetMs(3));
});
