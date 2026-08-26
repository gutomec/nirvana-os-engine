import { describe, expect, test } from "bun:test";
import { runBusinessPostGate, type BusinessPostGateDependencies, type BusinessPostGateInput } from "../lib/business-post-gate.ts";

function fixture(overrides: Partial<BusinessPostGateInput> = {}, dependencyOverrides: Partial<BusinessPostGateDependencies> = {}) {
  const files = new Map<string, string>();
  const calls: Array<{ command: string; args: string[] }> = [];
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const warnings: string[] = [];
  const dependencies: BusinessPostGateDependencies = {
    exists: pathname => pathname.endsWith("build-report-pdf.ts") || pathname.endsWith("report-publisher.md") || files.has(pathname),
    mkdir: () => {},
    read: pathname => files.get(pathname) ?? "",
    write: (pathname, content) => { files.set(pathname, content); },
    size: () => 2048,
    homeDir: () => "/home/test",
    resolve: pathname => `/cwd/${pathname.replace(/^\.\//, "")}`,
    spawn: (command, args) => {
      calls.push({ command, args });
      if (args.some(argument => argument.endsWith("build-report-pdf.ts"))) files.set("/project/deliverables/relatorio-final.pdf", "pdf");
      return { status: 0, stdout: "publisher prompt", stderr: "" };
    },
    runPublisher: () => ({ ok: true, sessionId: "session", durationMs: 1, costUsd: 0 }),
    ...dependencyOverrides,
  };
  const input: BusinessPostGateInput = {
    projectId: "proj-1", businessSlug: "example", runtime: "codex", projectDir: "/project/business",
    projectRoot: "/project", outputsRoot: "/project/deliverables", skillsRoot: "/skills",
    employeePromptScript: "/skills/employee-prompt.ts", sessionFile: "/project/session.json",
    sessionData: { zip_path: null }, rulesDirective: "rules", maxBudgetUsd: 5, timeoutMs: 1000,
    yolo: true, wantPdf: true, skipHtml: false, offlineSnapshot: true, routingMode: "agentic", wantZip: true,
    emit: (event, payload) => events.push({ event, payload }), log: () => {}, warn: warning => warnings.push(warning),
    dependencies, ...overrides,
  };
  return { input, files, calls, events, warnings };
}

describe("Business post-gate boundary", () => {
  test("preserves PDF, HTML, ZIP, session and audit effects", () => {
    const fx = fixture();
    const result = runBusinessPostGate(fx.input);
    expect(result.zipPath).toBe("/cwd/proj-1.zip");
    expect(fx.input.sessionData.zip_path).toBe("/cwd/proj-1.zip");
    expect(JSON.parse(fx.files.get("/project/session.json")!).zip_path).toBe("/cwd/proj-1.zip");
    expect(fx.events.map(entry => entry.event)).toEqual(["report_publisher_ran", "report_pdf_generated", "report_html_generated"]);
    expect(fx.calls.some(call => call.args.includes("--offline-snapshot"))).toBeTrue();
    expect(fx.calls.some(call => call.args.includes("--deliverables-only"))).toBeTrue();
  });

  test("keeps publication failures non-fatal and does not claim ZIP success", () => {
    const fx = fixture({}, {
      exists: pathname => !pathname.endsWith("build-report-pdf.ts"),
      spawn: (command, args) => { fx.calls.push({ command, args }); return { status: 1, stdout: "", stderr: "failed" }; },
    });
    const result = runBusinessPostGate(fx.input);
    expect(result.zipPath).toBeNull();
    expect(fx.input.sessionData.zip_path).toBeNull();
    expect(fx.events).toEqual([]);
    expect(fx.warnings).toEqual([
      "⚠ --pdf: build-report-pdf.ts not found; skipping PDF",
      "⚠ build-report-html failed (rc=1)",
      "⚠ export failed (deliverables are in the project folder)",
    ]);
  });

  test("preserves the fast-mode HTML skip audit", () => {
    const fx = fixture({ wantPdf: false, skipHtml: true, routingMode: "fast", wantZip: false });
    expect(runBusinessPostGate(fx.input)).toEqual({ zipPath: null });
    expect(fx.events.map(entry => entry.event)).toEqual(["report_skipped_fast"]);
    expect(fx.calls).toEqual([]);
  });
});
