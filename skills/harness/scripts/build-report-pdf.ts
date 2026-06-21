#!/usr/bin/env bun
// build-report-pdf.ts — assemble client deliverables into one styled PDF.
//
// The report-publisher employee writes an executive summary (--summary) and
// decides the order of the sections (--order). This script does the mechanical
// part: it converts each deliverable .md to HTML (pandoc -> python markdown ->
// <pre>), drops the summary on the cover, builds a table of contents, wraps
// everything in a polished clinical/legal theme, and renders to PDF.
//
// Engine: weasyprint (primary — purpose-built for paged media: @page margins,
// running headers, page numbers) with a Chrome-headless fallback. Cross-platform
// (Chrome detected per OS; weasyprint via PATH).
//
// Usage:
//   bun build-report-pdf.ts --deliverables <dir> --output <pdf> \
//     [--summary <file.md>] [--order "a.md,b.md,c.md"] \
//     [--title "..."] [--subtitle "..."] [--client "..."] [--date "..."]
//
// Exit: 0 ok · 1 render failed · 2 bad args

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

function arg(name: string, fallback?: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return fallback;
}

const deliverablesDir = arg("--deliverables");
const outputPdf = arg("--output");
const summaryFile = arg("--summary");
const orderArg = arg("--order");
const title = arg("--title", "Relatório Técnico Integrado");
const subtitle = arg("--subtitle", "Medicina, Segurança e Direito do Trabalho");
const client = arg("--client", "");
const dateStr = arg("--date", new Date().toLocaleDateString("pt-BR"));
const brand = arg("--brand", "Relatório");

if (!deliverablesDir || !outputPdf) {
  console.error('Uso: build-report-pdf.ts --deliverables <dir> --output <pdf> [--summary <md>] [--order "a.md,b.md"] [--title] [--subtitle] [--client] [--brand]');
  process.exit(2);
}
if (!fs.existsSync(deliverablesDir)) {
  console.error(`Pasta de deliverables não encontrada: ${deliverablesDir}`);
  process.exit(2);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// markdown -> html: pandoc (best), then python-markdown, then escaped <pre>.
function mdToHtml(file: string): string {
  const pandoc = spawnSync("pandoc", [file, "-f", "gfm", "-t", "html", "--wrap=none"], { encoding: "utf8" });
  if (pandoc.status === 0 && pandoc.stdout && pandoc.stdout.trim()) return pandoc.stdout;
  const py = spawnSync("python3", ["-c",
    "import sys,markdown;print(markdown.markdown(open(sys.argv[1],encoding='utf-8').read(),extensions=['extra','sane_lists','toc']))",
    file], { encoding: "utf8" });
  if (py.status === 0 && py.stdout && py.stdout.trim()) return py.stdout;
  return "<pre>" + escapeHtml(fs.readFileSync(file, "utf8")) + "</pre>";
}

// Inject a filled color swatch (bolinha) before every hex color code found in
// the rendered HTML. Handles both `#RRGGBB` in <code> and bare in table cells.
// Single pass, anchored to a boundary so it never touches CSS attribute values.
function addColorSwatches(html: string): string {
  return html.replace(
    /(^|[>\s(])((?:<code>)?)(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3}))((?:<\/code>)?)(?=[<\s),.;:!?]|$)/g,
    (_m, pre, openCode, hex, closeCode) =>
      `${pre}<span class="swatch" style="background:${hex};border-color:${hex}"></span>${openCode}${hex}${closeCode}`
  );
}

function firstHeading(md: string, fallback: string): string {
  const m = md.match(/^#{1,2}\s+(.+?)\s*$/m);
  if (m) return m[1].trim() || fallback;
  return fallback;
}

function humanize(file: string): string {
  return path.basename(file, ".md").replace(/^\d+[-_]?/, "").replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// Resolve ordered deliverable list (exclude the summary file if it lives here).
const allMd = fs.readdirSync(deliverablesDir).filter(f => f.toLowerCase().endsWith(".md")).sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
const summaryBase = summaryFile ? path.basename(summaryFile) : null;
let ordered: string[];
if (orderArg) {
  ordered = orderArg.split(",").map(s => s.trim()).filter(Boolean);
  // append any deliverable not named in --order, preserving natural sort
  for (const f of allMd) if (!ordered.includes(f) && f !== summaryBase) ordered.push(f);
} else {
  ordered = allMd.filter(f => f !== summaryBase);
}
ordered = ordered.filter(f => f !== summaryBase && fs.existsSync(path.join(deliverablesDir, f)));

// Build sections.
type Section = { id: string; title: string; html: string };
const sections: Section[] = ordered.map((f, i) => {
  const full = path.join(deliverablesDir, f);
  const md = fs.readFileSync(full, "utf8");
  return { id: `sec-${i + 1}`, title: firstHeading(md, humanize(f)), html: addColorSwatches(mdToHtml(full)) };
});

const summaryHtml = summaryFile && fs.existsSync(summaryFile) ? addColorSwatches(mdToHtml(summaryFile)) : "";

const toc = sections.map(s => `<li><a href="#${s.id}">${escapeHtml(s.title)}</a></li>`).join("\n");
const body = sections.map(s => `
<section class="report-section" id="${s.id}">
  <h1 class="section-title">${escapeHtml(s.title)}</h1>
  <div class="section-body">${s.html}</div>
</section>`).join("\n");

const THEME_CSS = `
:root{
  --ink:#1b2430; --muted:#5b6675; --faint:#9aa6b2; --rule:#e3e8ee;
  --primary:#0e6b6a; --primary-deep:#0a4f4e; --accent:#b4882d; --bg-soft:#f5f8f8;
}
@page{
  size:A4; margin:22mm 18mm 18mm 18mm;
  @top-right{ content:"${brand}"; font:600 8pt 'Helvetica Neue',Arial,sans-serif; color:var(--faint); }
  @bottom-center{ content:counter(page) " / " counter(pages); font:8pt 'Helvetica Neue',Arial,sans-serif; color:var(--faint); }
  @bottom-left{ content:"Documento confidencial"; font:7pt 'Helvetica Neue',Arial,sans-serif; color:var(--faint); }
}
@page:first{ margin:0; @top-right{content:""} @bottom-center{content:""} @bottom-left{content:""} }
*{ box-sizing:border-box; }
html{ font-size:10.5pt; }
body{ font-family:Georgia,'Times New Roman',serif; color:var(--ink); line-height:1.5; margin:0; }
h1,h2,h3,h4{ font-family:'Helvetica Neue',Arial,sans-serif; color:var(--primary-deep); line-height:1.25; }
a{ color:var(--primary); text-decoration:none; }

/* cover */
.cover{ page-break-after:always; height:297mm; padding:0; position:relative; color:#fff; }
.cover .band{ background:linear-gradient(135deg,var(--primary-deep),var(--primary)); padding:34mm 20mm 22mm 20mm; }
.cover .kicker{ font:600 10pt 'Helvetica Neue',Arial,sans-serif; letter-spacing:.18em; text-transform:uppercase; opacity:.85; }
.cover h1{ color:#fff; font-size:30pt; margin:6mm 0 3mm; }
.cover .subtitle{ font-family:Georgia,serif; font-size:13pt; opacity:.92; font-style:italic; }
.cover .meta{ margin-top:10mm; font:9.5pt 'Helvetica Neue',Arial,sans-serif; opacity:.9; }
.cover .meta b{ font-weight:600; }
.cover .summary{ color:var(--ink); padding:14mm 20mm 0 20mm; }
.cover .summary h2{ font-size:13pt; color:var(--primary-deep); border-bottom:2px solid var(--accent); display:inline-block; padding-bottom:2mm; margin:0 0 5mm; }
.cover .summary :is(p,li){ font-size:10pt; }

/* table of contents */
.toc{ page-break-after:always; padding-top:4mm; }
.toc h2{ font-size:15pt; border-bottom:1px solid var(--rule); padding-bottom:3mm; }
.toc ol{ list-style:none; padding:0; margin:6mm 0 0; counter-reset:toc; }
.toc li{ counter-increment:toc; padding:2.4mm 0; border-bottom:1px dotted var(--rule); font-family:'Helvetica Neue',Arial,sans-serif; font-size:10.5pt; }
.toc li::before{ content:counter(toc) ".  "; color:var(--accent); font-weight:700; }
.toc a::after{ content:" — p. " target-counter(attr(href), page); color:var(--faint); float:right; font-size:9pt; }

/* sections */
.report-section{ page-break-before:always; }
.section-title{ font-size:17pt; padding-bottom:3mm; border-bottom:3px solid var(--primary); margin:0 0 6mm; }
.section-body h1{ font-size:14pt; margin:7mm 0 3mm; }
.section-body h2{ font-size:12.5pt; margin:6mm 0 2.5mm; color:var(--primary); }
.section-body h3{ font-size:11pt; margin:5mm 0 2mm; color:var(--muted); }
.section-body p{ margin:0 0 3mm; text-align:justify; }
.section-body ul,.section-body ol{ margin:0 0 3mm 5mm; padding:0; }
.section-body li{ margin:1mm 0; }
.section-body blockquote{ margin:3mm 0; padding:2mm 4mm; background:var(--bg-soft); border-left:3px solid var(--accent); color:var(--muted); }
.section-body code{ font-family:'SF Mono',Consolas,monospace; font-size:8.5pt; background:var(--bg-soft); padding:.5mm 1mm; border-radius:2px; }
.swatch{ display:inline-block; width:.85em; height:.85em; border-radius:50%; border:1px solid; vertical-align:-.10em; margin-right:.4em; }
.section-body table{ width:100%; border-collapse:collapse; margin:4mm 0; font-size:8.8pt; font-family:'Helvetica Neue',Arial,sans-serif; }
.section-body th{ background:var(--primary-deep); color:#fff; text-align:left; padding:2mm 3mm; font-weight:600; }
.section-body td{ border-bottom:1px solid var(--rule); padding:2mm 3mm; vertical-align:top; }
.section-body tr:nth-child(even) td{ background:var(--bg-soft); }
`;

const coverSummary = summaryHtml
  ? `<div class="summary"><h2>Resumo Executivo</h2>${summaryHtml}</div>`
  : "";

const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${THEME_CSS}</style></head>
<body>
<div class="cover">
  <div class="band">
    <div class="kicker">${escapeHtml(brand)} · Relatório</div>
    <h1>${escapeHtml(title)}</h1>
    <div class="subtitle">${escapeHtml(subtitle)}</div>
    <div class="meta">
      ${client ? `<div><b>Cliente:</b> ${escapeHtml(client)}</div>` : ""}
      <div><b>Data:</b> ${escapeHtml(dateStr)}</div>
    </div>
  </div>
  ${coverSummary}
</div>
${sections.length > 1 ? `<nav class="toc"><h2>Sumário</h2><ol>${toc}</ol></nav>` : ""}
${body}
</body></html>`;

const tmpHtml = path.join(os.tmpdir(), `medwork-report-${Date.now()}.html`);
fs.writeFileSync(tmpHtml, html, "utf8");
fs.mkdirSync(path.dirname(path.resolve(outputPdf)), { recursive: true });

function findChrome(): string | null {
  const env = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (env && fs.existsSync(env)) return env;
  const byOs: Record<string, string[]> = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
    win32: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
    linux: [],
  };
  for (const p of byOs[process.platform] || []) if (fs.existsSync(p)) return p;
  for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "msedge"]) {
    const probe = process.platform === "win32" ? "where" : "which";
    const r = spawnSync(probe, [bin], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split("\n")[0];
  }
  return null;
}

function render(): { ok: boolean; engine: string; error?: string } {
  // weasyprint first: best paged-media support (page numbers, TOC page refs).
  const wp = spawnSync(process.platform === "win32" ? "where" : "which", ["weasyprint"], { encoding: "utf8" });
  if (wp.status === 0) {
    const r = spawnSync("weasyprint", [tmpHtml, path.resolve(outputPdf)], { encoding: "utf8" });
    if (r.status === 0 && fs.existsSync(outputPdf)) return { ok: true, engine: "weasyprint" };
  }
  // Chrome fallback.
  const chrome = findChrome();
  if (chrome) {
    const r = spawnSync(chrome, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${path.resolve(outputPdf)}`, tmpHtml], { encoding: "utf8" });
    if (r.status === 0 && fs.existsSync(outputPdf)) return { ok: true, engine: "chrome" };
    return { ok: false, engine: "chrome", error: r.stderr || "chrome print falhou" };
  }
  return { ok: false, engine: "none", error: "nenhum engine de PDF disponível (instale weasyprint ou Chrome)" };
}

const res = render();
try { fs.rmSync(tmpHtml, { force: true }); } catch { /* ignore */ }

if (!res.ok) {
  console.error(`✗ Falha ao renderizar PDF (${res.engine}): ${res.error}`);
  process.exit(1);
}
const kb = (fs.statSync(outputPdf).size / 1024).toFixed(1);
console.log(`✓ PDF gerado via ${res.engine}: ${path.resolve(outputPdf)} (${kb} KB, ${sections.length} seções${summaryHtml ? " + resumo" : ""})`);
process.exit(0);
