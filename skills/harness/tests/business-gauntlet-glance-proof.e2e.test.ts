import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runBusinessPostGate, type BusinessPostGateDependencies } from "../lib/business-post-gate.ts";
import { ProjectService } from "../lib/control-plane/project-service.ts";
import { runDelivery } from "../lib/delivery-pipeline.ts";
import { runAgentXGauntlet, shouldRunAgentXGauntlet, type AgentXGauntletEvaluator } from "../lib/gauntlet/agent-x-cutover.ts";
import { loadHarnessConfig } from "../lib/harness-config.ts";
import { appendEvent, listEvents, openKernel, type KernelHandle } from "../lib/run-kernel/index.ts";

const roots: string[] = [];
const servers: Array<{ server: { stop(closeActiveConnections?: boolean): void } }> = [];
afterEach(() => {
  while (servers.length) servers.pop()!.server.stop(true);
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  delete process.env.NIRVANA_PROJECT_ROOT;
});

const BUSINESS = { kind: "business" as const, slug: "proof-business" };
const EVALUATOR = { kind: "squad" as const, slug: "proof-evaluator", capabilityId: "quality.specification_conformance" };
const PASSING_HTML = "<!doctype html><html><head><title>Proof</title></head><body><main><h1>Business proof</h1><p>Deterministic local candidate with enough structured content for the offline quality gate.</p><p>The evaluator, delivery and publication stages preserve causal evidence in the canonical journal.</p></main></body></html>";

function evaluator(pass: boolean): AgentXGauntletEvaluator {
  return { target: EVALUATOR, evaluate({ runId, artifactRefs }) { return [{
    evaluationId: `evl_${runId}`, candidateId: "can_1", revisionId: `crv_${runId}_1`, gauntletId: "brief-conformance",
    rubricVersion: "proof/v1", verdict: pass ? "pass" : "reject",
    dimensions: [{ id: "brief", score: pass ? 1 : 0, confidence: 1, blocking: true, passed: pass,
      evidenceRefs: artifactRefs.map(ref => ref.revisionId) }], regressions: [],
    revisionRequests: pass ? [] : [{ requirementId: "brief", evidenceRefs: ["proof:rejected"] }],
    evaluator: EVALUATOR, costUsd: 0, createdAt: "2026-08-25T12:00:02.000Z",
  }]; } };
}

function publicationDependencies(root: string, outputsRoot: string): Partial<BusinessPostGateDependencies> {
  return {
    homeDir: () => path.join(root, "home"), resolve: () => path.join(root, "proof.zip"),
    exists: pathname => pathname.endsWith("build-report-pdf.ts") || fs.existsSync(pathname),
    runPublisher: () => ({ ok: true, sessionId: null, durationMs: 0, costUsd: 0 }),
    spawn: (_command, args) => {
      if (args.some(argument => argument.endsWith("build-report-pdf.ts"))) fs.writeFileSync(path.join(outputsRoot, "relatorio-final.pdf"), "pdf", "utf8");
      else if (args.some(argument => argument.endsWith("build-report-html.ts"))) fs.writeFileSync(path.join(outputsRoot, "relatorio-final.html"), "html", "utf8");
      else if (args.some(argument => argument.endsWith("export.ts"))) fs.writeFileSync(path.join(root, "proof.zip"), "zip", "utf8");
      return { status: 0, stdout: "", stderr: "" };
    },
  };
}

function projectAudit(handle: KernelHandle, projectId: string, runId: string, traceId: string) {
  let counter = 0;
  let cause = listEvents(handle, projectId).at(-1)?.eventId;
  return (event: string, payload: Record<string, unknown>) => {
    counter += 1;
    const recorded = appendEvent(handle, { projectId, runId, traceId, type: `delivery.${event}`,
      actor: { kind: "compatibility-facade", id: "business-proof" }, correlationId: `cor_${runId}`,
      ...(cause ? { causationId: cause } : {}), idempotencyKey: `business-proof:${runId}:delivery:${counter}`,
      payload: { legacyEvent: event, ...payload } });
    cause = recorded.eventId;
  };
}

async function runProof(pass: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-business-glance-proof-")); roots.push(root);
  fs.mkdirSync(path.join(root, ".nirvana"), { recursive: true });
  const project = new ProjectService().create({ projectRoot: root, displayName: "Business proof" });
  const kernel = openKernel(path.join(root, ".nirvana", "run-kernel.sqlite"));
  const runId = pass ? "run_business-success" : "run_business-rejected";
  const traceId = `trace_${runId}`;
  const outputsRoot = path.join(root, "deliverables");
  const snapshot = { runtime: { id: "codex", source: "active-session", resolved: true },
    provider: { id: "openai", resolved: true }, model: { id: "runtime-default", resolved: false } };
  let postGateCalls = 0;
  const result = runAgentXGauntlet({
    kernel, projectId: project.project_id, runId, traceId, brief: "Produce report.html", projectRoot: root, outputsRoot,
    expectedCostUsd: 1, producerTarget: BUSINESS, executionSnapshot: snapshot,
    executeCandidate(candidateRoot) { fs.mkdirSync(candidateRoot, { recursive: true }); fs.writeFileSync(path.join(candidateRoot, "report.html"), PASSING_HTML, "utf8"); return { ok: true, sessionId: "session_proof" }; },
    evaluator: evaluator(pass),
    finalGate() {
      const audit = projectAudit(kernel, project.project_id, runId, traceId);
      const sessionFile = path.join(root, "session.json");
      const sessionData: Record<string, unknown> = { project_id: project.project_id, runtime: "codex", zip_path: null };
      fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2), "utf8");
      const delivery = runDelivery({ brief: "Produce report.html", outputsRoot, pid: project.project_id, slug: BUSINESS.slug,
        targetKind: "business", runtime: "codex", projectDir: root, projectRoot: root, maxRevisions: 0,
        config: loadHarnessConfig(path.join(root, "missing-config.yaml")), audit, log: () => {}, warn: () => {},
        afterGate: () => { postGateCalls += 1; return runBusinessPostGate({ projectId: project.project_id, businessSlug: BUSINESS.slug,
          runtime: "codex", projectDir: root, projectRoot: root, outputsRoot, skillsRoot: "/skills",
          employeePromptScript: "/skills/employee-prompt.ts", sessionFile, sessionData, rulesDirective: "", yolo: true,
          wantPdf: true, skipHtml: false, offlineSnapshot: false, routingMode: "agentic", wantZip: true,
          emit: audit, log: () => {}, warn: () => {}, dependencies: publicationDependencies(root, outputsRoot) }); },
      });
      return { exitCode: delivery.exitCode, gateOutcome: delivery.gateOutcome };
    },
  });
  const kernelEvents = listEvents(kernel, project.project_id);
  kernel.close();

  process.env.NIRVANA_PROJECT_ROOT = root;
  const { startServer } = await import("../lib/glance/server.ts");
  const glance = await startServer({ port: 0, open: false, idleMin: 60, allowActions: false, theme: "apple" });
  servers.push(glance);
  const base = `http://127.0.0.1:${glance.port}`;
  const timeline = await fetch(`${base}/api/v1/projects/${project.project_id}/events`).then(response => response.json()) as { events: typeof kernelEvents };
  const gauntletResponse = await fetch(`${base}/api/v1/runs/${runId}/gauntlet?project_id=${project.project_id}`);
  const gauntlet = await gauntletResponse.json() as any;
  if (!gauntletResponse.ok) throw new Error(`Glance gauntlet projection failed (${gauntletResponse.status}): ${JSON.stringify(gauntlet)}`);
  return { root, project, result, snapshot, postGateCalls, kernelEvents, timeline: timeline.events, gauntlet };
}

describe("typed Business Gauntlet proof through Glance", () => {
  test("projects producer, snapshot, evaluation, delivery and post-gate in causal order", async () => {
    const proof = await runProof(true);
    expect(proof.result.run).toMatchObject({ target: BUSINESS, state: "completed" });
    expect(proof.postGateCalls).toBe(1);
    expect(fs.existsSync(path.join(proof.root, "deliverables", "relatorio-final.pdf"))).toBeTrue();
    const snapshot = proof.timeline.find(event => event.type === "runtime.selection_snapshot");
    expect((snapshot?.payload as any).snapshot).toEqual(proof.snapshot);
    expect(proof.result.run.policySnapshotRef).toBe((snapshot?.payload as any).ref);
    const types = proof.timeline.map(event => event.type);
    for (const pair of [["gauntlet.candidate_created", "gauntlet.evaluation_recorded"],
      ["gauntlet.evaluation_recorded", "delivery.gate_passed"], ["delivery.gate_passed", "delivery.report_pdf_generated"],
      ["delivery.report_pdf_generated", "run.transitioned"]] as const) {
      expect(types.indexOf(pair[0])).toBeLessThan(types.lastIndexOf(pair[1]));
    }
    expect(proof.timeline.map(event => event.sequence)).toEqual(proof.kernelEvents.map(event => event.sequence));
    const byId = new Map(proof.timeline.map(event => [event.eventId, event]));
    for (const event of proof.timeline.filter(event => event.type.startsWith("delivery."))) {
      expect(event.causationId && byId.get(event.causationId)?.sequence).toBeLessThan(event.sequence);
    }
    expect(proof.gauntlet.candidates[0].producer).toEqual(BUSINESS);
    expect(proof.gauntlet.scorecards[0].evaluator).toEqual(EVALUATOR);
  });

  test("withholds a rejected Business candidate before delivery and keeps production cutover disabled", async () => {
    const proof = await runProof(false);
    expect(proof.result).toMatchObject({ exitCode: 2, finalGateRan: false, run: { target: BUSINESS, state: "withheld" } });
    expect(proof.postGateCalls).toBe(0);
    expect(proof.timeline.some(event => event.type.startsWith("delivery."))).toBeFalse();
    expect(shouldRunAgentXGauntlet({ targetKind: "business", wantExec: true, resolvedMode: "gauntlet", intensity: "light" })).toBeFalse();
  });
});
