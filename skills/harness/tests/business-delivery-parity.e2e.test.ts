import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runBusinessPostGate, type BusinessPostGateDependencies } from "../lib/business-post-gate.ts";
import { runDelivery, type DeliveryArgs } from "../lib/delivery-pipeline.ts";
import { loadHarnessConfig } from "../lib/harness-config.ts";
import * as runLedger from "../lib/run-ledger.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

const PASSING_HTML = [
  "<!doctype html><html><head><title>Delivery</title></head><body><main>",
  "<h1>Final delivery</h1><p>This local fixture contains enough structured content for deterministic validation.</p>",
  "<p>The manifest, quality gate and publication stages all run without network access or an external runtime.</p>",
  "</main></body></html>",
].join("");

type AuditEntry = { event: string; payload: Record<string, unknown> };

function normalize(value: unknown, root: string): unknown {
  return JSON.parse(JSON.stringify(value).replaceAll(root, "<root>"));
}

function runScenario(kind: "legacy-reference" | "boundary", verifyExit: 0 | 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `nrv-business-parity-${kind}-`)); roots.push(root);
  const outputsRoot = path.join(root, "deliverables"); fs.mkdirSync(outputsRoot);
  fs.writeFileSync(path.join(outputsRoot, "report.html"), PASSING_HTML, "utf8");
  const manifest = path.join(root, "deliverables.json"); fs.writeFileSync(manifest, JSON.stringify({ outputs: ["report.html"] }), "utf8");
  const verifyScript = path.join(root, "verify.ts"); fs.writeFileSync(verifyScript, `process.exit(${verifyExit});\n`, "utf8");
  const sessionFile = path.join(root, "session.json");
  const sessionData: Record<string, unknown> = { project_id: "proj-parity", zip_path: null, manifest };
  fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2), "utf8");
  const audit: AuditEntry[] = [];
  let publicationCalls = 0;

  const publishLegacyReference = () => {
    publicationCalls++;
    const pdf = path.join(outputsRoot, "relatorio-final.pdf"); fs.writeFileSync(pdf, "pdf", "utf8");
    audit.push({ event: "report_publisher_ran", payload: { trace_id: "proj-parity", project_id: "proj-parity", business_slug: "example", ok: true, publisher: "generic" } });
    audit.push({ event: "report_pdf_generated", payload: { trace_id: "proj-parity", project_id: "proj-parity", business_slug: "example", output: pdf } });
    const html = path.join(outputsRoot, "relatorio-final.html"); fs.writeFileSync(html, "html", "utf8");
    audit.push({ event: "report_html_generated", payload: { trace_id: "proj-parity", project_id: "proj-parity", business_slug: "example", output: html } });
    const zip = path.join(root, "proj-parity.zip"); fs.writeFileSync(zip, "zip", "utf8");
    sessionData.zip_path = zip; fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2), "utf8");
    return { zipPath: zip };
  };

  const dependencies: Partial<BusinessPostGateDependencies> = {
    homeDir: () => path.join(root, "home"),
    resolve: () => path.join(root, "proj-parity.zip"),
    exists: pathname => pathname.endsWith("build-report-pdf.ts") || fs.existsSync(pathname),
    runPublisher: () => ({ ok: true, sessionId: null, durationMs: 0, costUsd: 0 }),
    spawn: (_command, args) => {
      if (args.some(argument => argument.endsWith("build-report-pdf.ts"))) {
        fs.writeFileSync(path.join(outputsRoot, "relatorio-final.pdf"), "pdf", "utf8");
      } else if (args.some(argument => argument.endsWith("build-report-html.ts"))) {
        fs.writeFileSync(path.join(outputsRoot, "relatorio-final.html"), "html", "utf8");
      } else if (args.some(argument => argument.endsWith("export.ts"))) {
        fs.writeFileSync(path.join(root, "proj-parity.zip"), "zip", "utf8");
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  };

  const postGate = kind === "legacy-reference" ? publishLegacyReference : () => {
    publicationCalls++;
    return runBusinessPostGate({
      projectId: "proj-parity", businessSlug: "example", runtime: "codex", projectDir: root, projectRoot: root,
      outputsRoot, skillsRoot: "/skills", employeePromptScript: "/skills/employee-prompt.ts",
      sessionFile, sessionData, rulesDirective: "", yolo: true, wantPdf: true, skipHtml: false,
      offlineSnapshot: false, routingMode: "agentic", wantZip: true,
      emit: (event, payload) => audit.push({ event, payload }), log: () => {}, warn: () => {}, dependencies,
    });
  };

  const ledger = runLedger.openLedger(path.join(root, "ledger.sqlite"));
  const row = runLedger.openRun(ledger, { runId: "run-parity", traceId: "proj-parity", projectId: "proj-parity", targetKind: "business", targetSlug: "example" });
  runLedger.markState(ledger, row.run_id, "running");
  const args: DeliveryArgs = {
    brief: "Produce report.html", outputsRoot, manifest, pid: "proj-parity", slug: "example", targetKind: "business",
    runtime: "codex", projectDir: root, projectRoot: root, workingDir: root, maxRevisions: 0,
    gateExhaustedPolicy: "withhold", config: loadHarnessConfig(path.join(root, "missing-config.yaml")),
    ledger: { handle: ledger, runId: row.run_id }, audit: (event, payload) => audit.push({ event, payload }),
    verifyScript, afterGate: postGate, log: () => {}, warn: () => {},
  };
  const result = runDelivery(args);
  const terminal = runLedger.getRun(ledger, row.run_id)?.state;
  ledger.close();
  const files = fs.readdirSync(outputsRoot).sort();
  return { result: normalize(result, root), audit: normalize(audit, root), terminal, publicationCalls,
    files, session: normalize(JSON.parse(fs.readFileSync(sessionFile, "utf8")), root) };
}

describe("Business delivery parity E2E", () => {
  test("matches the legacy observable contract through manifest, gate and publication", () => {
    const legacy = runScenario("legacy-reference", 0);
    const boundary = runScenario("boundary", 0);
    expect(boundary).toEqual(legacy);
    expect(boundary).toMatchObject({ terminal: "delivered", publicationCalls: 1,
      files: ["relatorio-final.html", "relatorio-final.pdf", "report.html"] });
  });

  test("keeps manifest failure terminal and never runs post-gate publication", () => {
    const legacy = runScenario("legacy-reference", 1);
    const boundary = runScenario("boundary", 1);
    expect(boundary).toEqual(legacy);
    expect(boundary).toMatchObject({ terminal: "failed", publicationCalls: 0, files: ["report.html"] });
    expect((boundary.audit as AuditEntry[]).some(entry => entry.event === "delivered")).toBeFalse();
  });
});
