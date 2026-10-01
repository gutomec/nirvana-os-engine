import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { AUTONOMOUS_DIRECTIVE, runHeadless, type Runtime } from "./host-agent-driver.ts";
import { runFolderOf } from "../../_shared/lib/run-workspace.ts";

type SpawnResult = Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr">;

export interface BusinessPostGateDependencies {
  exists(pathname: string): boolean;
  mkdir(pathname: string): void;
  read(pathname: string): string;
  write(pathname: string, content: string): void;
  size(pathname: string): number;
  homeDir(): string;
  resolve(pathname: string): string;
  spawn(command: string, args: string[], options: Record<string, unknown>): SpawnResult;
  runPublisher(input: Parameters<typeof runHeadless>[0]): ReturnType<typeof runHeadless>;
}

export interface BusinessPostGateInput {
  projectId: string;
  businessSlug: string;
  runtime: Runtime;
  projectDir: string;
  projectRoot: string;
  outputsRoot: string;
  skillsRoot: string;
  sessionFile: string;
  sessionData: Record<string, unknown>;
  rulesDirective: string;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  yolo: boolean;
  wantPdf: boolean;
  skipHtml: boolean;
  offlineSnapshot: boolean;
  routingMode: string;
  wantZip: boolean;
  emit(event: string, payload: Record<string, unknown>): void;
  log(message: string): void;
  warn(message: string): void;
  /** The run's ledger row: the publisher heartbeats it, so a long publication
   *  never makes a delivered run look dead to the supervisor. */
  ledger?: { runId: string; watchDir?: string };
  dependencies?: Partial<BusinessPostGateDependencies>;
}

const defaults: BusinessPostGateDependencies = {
  exists: fs.existsSync,
  mkdir: pathname => fs.mkdirSync(pathname, { recursive: true }),
  read: pathname => fs.readFileSync(pathname, "utf8"),
  write: (pathname, content) => fs.writeFileSync(pathname, content),
  size: pathname => fs.statSync(pathname).size,
  homeDir: os.homedir,
  resolve: path.resolve,
  spawn: (command, args, options) => spawnSync(command, args, options as Parameters<typeof spawnSync>[2]) as SpawnResult,
  runPublisher: runHeadless,
};

/** Runs Business publication only after the delivery pipeline authorizes it.
 * The function deliberately owns no gate decision. Its observable contract is
 * the PDF, HTML, ZIP, session and audit behavior from dispatch.ts.
 *
 * Publication never decides the delivery and never stops it: each step that
 * fails or throws is warned and recorded (`x_report_<step>_failed`), the next
 * step still runs, and the function always returns, so the run reaches its
 * terminal state instead of staying at `gated`. */
export function runBusinessPostGate(input: BusinessPostGateInput): { zipPath: string | null } {
  const deps = { ...defaults, ...input.dependencies };
  const ids = { trace_id: input.projectId, project_id: input.projectId, business_slug: input.businessSlug };
  const failed = (step: "publisher" | "pdf" | "html" | "export", reason: string) => {
    // Literal event names, so check-audit-parity sees each one.
    const event = { publisher: "x_report_publisher_failed", pdf: "x_report_pdf_failed", html: "x_report_html_failed", export: "x_report_export_failed" }[step];
    try { input.emit(event, { ...ids, reason: reason.slice(0, 500) }); } catch { /* the warning below still tells it */ }
  };
  const guarded = (step: "pdf" | "html" | "export", fn: () => void) => {
    try { fn(); }
    catch (e) {
      const reason = (e as Error)?.message ?? String(e);
      input.warn(`⚠ ${step} step failed: ${reason}`);
      failed(step, reason);
    }
  };

  guarded("pdf", () => runPdf(input, deps, failed));
  guarded("html", () => runHtml(input, deps, failed));
  let zipPath: string | null = null;
  guarded("export", () => { zipPath = runExport(input, deps, failed); });
  return { zipPath };
}

type Failed = (step: "publisher" | "pdf" | "html" | "export", reason: string) => void;

function runPdf(input: BusinessPostGateInput, deps: BusinessPostGateDependencies, failed: Failed): void {
  if (input.wantPdf) {
    const businessHome = path.join(deps.homeDir(), "businesses", input.businessSlug);
    const businessBuild = path.join(businessHome, "scripts", "build-report-pdf.ts");
    const buildScript = deps.exists(businessBuild) ? businessBuild : path.join(input.skillsRoot, "harness/scripts/build-report-pdf.ts");
    const publisherEmployee = path.join(businessHome, "employees", "report-publisher.md");
    const hasPublisher = deps.exists(publisherEmployee);
    if (!deps.exists(buildScript)) {
      input.warn("⚠ --pdf: build-report-pdf.ts not found; skipping PDF");
      failed("pdf", "build-report-pdf.ts not found");
    } else {
      input.log(`▶ Step 6.5 — PDF report (${hasPublisher ? "report-publisher" : "generic publisher"})`);
      const reportDir = path.join(input.projectDir, "_report");
      deps.mkdir(reportDir);
      const summaryPath = path.join(reportDir, "executive-summary.md");
      const orderPath = path.join(reportDir, "order.json");
      const publisherBrief = [
        "You are the publisher of the final report. Compile the delivery.",
        `The delivery is the .md files in: ${input.outputsRoot}`,
        "",
        "The result is EXACTLY two files:",
        `1. ${summaryPath}: a faithful executive summary (markdown), which goes on the PDF cover.`,
        `2. ${orderPath}: JSON {"title": "...", "subtitle": "...", "client": "...", "summary_file": "${summaryPath}", "order": ["file1.md", "file2.md", ...]}`,
        "   - order = the names of the .md files in " + input.outputsRoot + " in the ideal sequence (direct answer first, then analysis, evidence and appendices).",
        "Do not invent a conclusion or a source. Only synthesize and order. The report follows the language of the deliverables.",
      ].join("\n");
      const publisherBriefFile = path.join(reportDir, ".publisher-brief.md");
      deps.write(publisherBriefFile, publisherBrief);

      // A business with its own publisher seat gets that seat's voice and method:
      // the worker opens the seat file, the same way a solo worker plays a seat.
      const publisherPrompt = hasPublisher
        ? `Work as the seat described in \`${publisherEmployee}\`: read it first.\n\n${publisherBrief}`
        : publisherBrief;
      const publisher = deps.runPublisher({
        runtime: input.runtime, prompt: publisherPrompt, cwd: input.projectRoot, addDirs: [input.projectDir, reportDir],
        workspace: runFolderOf(input.projectDir, input.projectRoot) ?? undefined,
        appendSystemPrompt: AUTONOMOUS_DIRECTIVE + input.rulesDirective,
        maxBudgetUsd: input.maxBudgetUsd, timeoutMs: input.timeoutMs, yolo: input.yolo,
        ...(input.ledger ? { ledger: { runId: input.ledger.runId, watchDir: input.ledger.watchDir ?? reportDir } } : {}),
      });
      input.emit("report_publisher_ran", { trace_id: input.projectId, project_id: input.projectId,
        business_slug: input.businessSlug, ok: publisher.ok, publisher: hasPublisher ? "employee" : "generic" });
      if (!publisher.ok) failed("publisher", String(publisher.error ?? "the publisher run failed"));

      const pdfOutput = path.join(input.outputsRoot, "final-report.pdf");
      const pdfArgs = [buildScript, "--deliverables", input.outputsRoot, "--output", pdfOutput];
      if (deps.exists(summaryPath)) pdfArgs.push("--summary", summaryPath);
      let title = `Report: ${input.projectId}`, subtitle = "", clientName = "", brand = input.businessSlug;
      if (deps.exists(orderPath)) {
        try {
          const metadata = JSON.parse(deps.read(orderPath));
          if (Array.isArray(metadata.order) && metadata.order.length) pdfArgs.push("--order", metadata.order.join(","));
          if (metadata.title) title = metadata.title;
          if (metadata.subtitle) subtitle = metadata.subtitle;
          if (metadata.client) clientName = metadata.client;
          if (metadata.brand) brand = metadata.brand;
        } catch { /* preserve legacy defaults */ }
      }
      pdfArgs.push("--title", title, "--brand", brand);
      if (subtitle) pdfArgs.push("--subtitle", subtitle);
      if (clientName) pdfArgs.push("--client", clientName);
      const pdf = deps.spawn("bun", pdfArgs, { windowsHide: true, encoding: "utf8" });
      if (pdf.status === 0 && deps.exists(pdfOutput)) {
        input.log(`✓ PDF: ${pdfOutput} (${(deps.size(pdfOutput) / 1024).toFixed(1)} KB)`);
        input.emit("report_pdf_generated", { trace_id: input.projectId, project_id: input.projectId, business_slug: input.businessSlug, output: pdfOutput });
      } else {
        input.warn(`⚠ build-report-pdf failed: ${(pdf.stdout || "") + (pdf.stderr || "")}`);
        failed("pdf", `build-report-pdf exited ${pdf.status}`);
      }
    }
  }
}

function runHtml(input: BusinessPostGateInput, deps: BusinessPostGateDependencies, failed: Failed): void {
  if (!input.skipHtml) {
    input.log("▶ Step 6.6 — HTML report");
    const htmlBuild = path.join(input.skillsRoot, "harness/scripts/build-report-html.ts");
    const htmlOutput = path.join(input.outputsRoot, "final-report.html");
    // The RUN, not the project. Pointed at projectDir it indexed the project's
    // own contract files and the employee prompt beside them, which is how a
    // client report came to contain the persona and the firm's memory instead
    // of the work. SKILL.md always said `<outputs>/<run_id>`; the code did not.
    const htmlArgs = [htmlBuild, "--project", input.outputsRoot, "--output", htmlOutput, "--title", `Report: ${input.businessSlug}`];
    if (input.offlineSnapshot) htmlArgs.push("--offline-snapshot");
    const html = deps.spawn("bun", htmlArgs, { windowsHide: true, encoding: "utf8", stdio: "inherit" });
    if (html.status === 0) input.emit("report_html_generated", { trace_id: input.projectId, project_id: input.projectId, business_slug: input.businessSlug, output: htmlOutput });
    else {
      input.warn(`⚠ build-report-html failed (rc=${html.status})`);
      failed("html", `build-report-html exited ${html.status}`);
    }
  } else if (input.routingMode === "fast") {
    input.emit("report_skipped_fast", { trace_id: input.projectId, project_id: input.projectId, business_slug: input.businessSlug });
  }
}

function runExport(input: BusinessPostGateInput, deps: BusinessPostGateDependencies, failed: Failed): string | null {
  let zipPath: string | null = null;
  if (input.wantZip) {
    input.log("▶ Step 7/7 — export .zip");
    const exportScript = path.join(input.skillsRoot, "harness/scripts/export.ts");
    const output = deps.resolve(`./${input.projectId}.zip`);
    const zip = deps.spawn("bun", [exportScript, input.projectId, "--format=zip", "--deliverables-only", `--output=${output}`], { windowsHide: true, encoding: "utf8", stdio: "inherit" });
    if (zip.status === 0) {
      zipPath = output;
      input.sessionData.zip_path = output;
      deps.write(input.sessionFile, JSON.stringify(input.sessionData, null, 2));
    } else {
      input.warn("⚠ export failed (deliverables are in the project folder)");
      failed("export", `export exited ${zip.status}`);
    }
  }
  return zipPath;
}
