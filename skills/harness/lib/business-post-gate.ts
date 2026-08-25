import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { AUTONOMOUS_DIRECTIVE, runHeadless, type Runtime } from "./host-agent-driver.ts";

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
  employeePromptScript: string;
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
 * the existing PDF, HTML, ZIP, session and audit behavior from dispatch.ts. */
export function runBusinessPostGate(input: BusinessPostGateInput): { zipPath: string | null } {
  const deps = { ...defaults, ...input.dependencies };

  if (input.wantPdf) {
    const businessHome = path.join(deps.homeDir(), "businesses", input.businessSlug);
    const businessBuild = path.join(businessHome, "scripts", "build-report-pdf.ts");
    const buildScript = deps.exists(businessBuild) ? businessBuild : path.join(input.skillsRoot, "harness/scripts/build-report-pdf.ts");
    const publisherEmployee = path.join(businessHome, "employees", "report-publisher.md");
    const hasPublisher = deps.exists(publisherEmployee);
    if (!deps.exists(buildScript)) {
      input.warn("⚠ --pdf: build-report-pdf.ts not found; skipping PDF");
    } else {
      input.log(`▶ Step 6.5 — PDF report (${hasPublisher ? "report-publisher" : "generic publisher"})`);
      const reportDir = path.join(input.projectDir, "relatorio");
      deps.mkdir(reportDir);
      const summaryPath = path.join(reportDir, "resumo-executivo.md");
      const orderPath = path.join(reportDir, "order.json");
      const publisherBrief = [
        "Você é o publicador do relatório final. Compile a entrega.",
        `Leia TODOS os arquivos .md em: ${input.outputsRoot}`,
        "",
        "Escreva EXATAMENTE dois arquivos (use a ferramenta Write, não rode shell):",
        `1. ${summaryPath} — resumo executivo fiel (markdown), que vai na capa do PDF.`,
        `2. ${orderPath} — JSON: {"title": "...", "subtitle": "...", "client": "...", "summary_file": "${summaryPath}", "order": ["arquivo1.md", "arquivo2.md", ...]}`,
        "   - order = nomes dos .md em " + input.outputsRoot + " na sequência ideal (resposta direta primeiro, depois análise, base e anexos).",
        "Não invente conclusão nem fonte. Apenas sintetize e ordene.",
      ].join("\n");
      const publisherBriefFile = path.join(reportDir, ".publisher-brief.md");
      deps.write(publisherBriefFile, publisherBrief);

      let publisherPrompt = publisherBrief;
      if (hasPublisher) {
        const result = deps.spawn("bun", [input.employeePromptScript, input.businessSlug, "report-publisher", input.projectDir, publisherBriefFile, reportDir], { encoding: "utf8" });
        if (result.status === 0 && result.stdout) publisherPrompt = result.stdout;
        else input.warn("⚠ report-publisher prompt failed; using the generic publisher");
      }
      const publisher = deps.runPublisher({
        runtime: input.runtime, prompt: publisherPrompt, cwd: input.projectDir, addDirs: [input.projectRoot],
        appendSystemPrompt: AUTONOMOUS_DIRECTIVE + input.rulesDirective,
        maxBudgetUsd: input.maxBudgetUsd, timeoutMs: input.timeoutMs, yolo: input.yolo,
      });
      input.emit("report_publisher_ran", { trace_id: input.projectId, project_id: input.projectId,
        business_slug: input.businessSlug, ok: publisher.ok, publisher: hasPublisher ? "employee" : "generic" });

      const pdfOutput = path.join(input.outputsRoot, "relatorio-final.pdf");
      const pdfArgs = [buildScript, "--deliverables", input.outputsRoot, "--output", pdfOutput];
      if (deps.exists(summaryPath)) pdfArgs.push("--summary", summaryPath);
      let title = `Relatório — ${input.projectId}`, subtitle = "", clientName = "", brand = input.businessSlug;
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
      const pdf = deps.spawn("bun", pdfArgs, { encoding: "utf8" });
      if (pdf.status === 0 && deps.exists(pdfOutput)) {
        input.log(`✓ PDF: ${pdfOutput} (${(deps.size(pdfOutput) / 1024).toFixed(1)} KB)`);
        input.emit("report_pdf_generated", { trace_id: input.projectId, project_id: input.projectId, business_slug: input.businessSlug, output: pdfOutput });
      } else {
        input.warn(`⚠ build-report-pdf failed: ${(pdf.stdout || "") + (pdf.stderr || "")}`);
      }
    }
  }

  if (!input.skipHtml) {
    input.log("▶ Step 6.6 — HTML report");
    const htmlBuild = path.join(input.skillsRoot, "harness/scripts/build-report-html.ts");
    const htmlOutput = path.join(input.outputsRoot, "relatorio-final.html");
    const htmlArgs = [htmlBuild, "--project", input.projectDir, "--output", htmlOutput, "--title", `Relatório — ${input.businessSlug}`];
    if (input.offlineSnapshot) htmlArgs.push("--offline-snapshot");
    const html = deps.spawn("bun", htmlArgs, { encoding: "utf8", stdio: "inherit" });
    if (html.status === 0) input.emit("report_html_generated", { trace_id: input.projectId, project_id: input.projectId, business_slug: input.businessSlug, output: htmlOutput });
    else input.warn(`⚠ build-report-html failed (rc=${html.status})`);
  } else if (input.routingMode === "fast") {
    input.emit("report_skipped_fast", { trace_id: input.projectId, project_id: input.projectId, business_slug: input.businessSlug });
  }

  let zipPath: string | null = null;
  if (input.wantZip) {
    input.log("▶ Step 7/7 — export .zip");
    const exportScript = path.join(input.skillsRoot, "harness/scripts/export.ts");
    const output = deps.resolve(`./${input.projectId}.zip`);
    const zip = deps.spawn("bun", [exportScript, input.projectId, "--format=zip", "--deliverables-only", `--output=${output}`], { encoding: "utf8", stdio: "inherit" });
    if (zip.status === 0) {
      zipPath = output;
      input.sessionData.zip_path = output;
      deps.write(input.sessionFile, JSON.stringify(input.sessionData, null, 2));
    } else {
      input.warn("⚠ export failed (deliverables are in the project folder)");
    }
  }
  return { zipPath };
}
