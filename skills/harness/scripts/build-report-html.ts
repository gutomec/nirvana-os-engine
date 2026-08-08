#!/usr/bin/env bun
// build-report-html.ts — render every markdown produced in a project into ONE
// Apple-styled HTML report. Default mode pulls top-tier components from CDN
// (Tailwind CSS + Lucide icons + Inter font). The `--offline-snapshot` flag
// fetches those CDN assets at build time and inlines them, producing a single
// self-contained file that opens with no network (drops cleanly into --zip).
//
// Usage:
//   bun build-report-html.ts --project <dir> --output <file.html> \
//     [--title "..."] [--client "..."] [--date "..."] [--offline-snapshot]
//
// Exit: 0 ok · 1 nothing to render / write failed · 2 bad args

import * as fs from "node:fs";
import * as path from "node:path";
import { marked } from "marked";

function arg(name: string, fallback?: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return fallback;
}

const projectDir = arg("--project") || arg("--deliverables");
const output = arg("--output");
const title = arg("--title", "Relatório do projeto");
const client = arg("--client", "");
const dateStr = arg("--date", "");
const offlineSnapshot = process.argv.includes("--offline-snapshot");

if (!projectDir || !output) {
  console.error('Uso: build-report-html.ts --project <dir> --output <file.html> [--title] [--client] [--date] [--offline-snapshot]');
  process.exit(2);
}
if (!fs.existsSync(projectDir)) {
  console.error(`Pasta do projeto não encontrada: ${projectDir}`);
  process.exit(2);
}

// Dirs whose markdowns are internal plumbing, not deliverables.
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".nirvana", ".squad-state", ".squads-outputs",
  ".harness-logs", ".wiki-brain-state", ".vercel", ".omc", "_internal", "relatorio",
]);
const SKIP_FILES = new Set(["HANDOFF.json"]);

function walk(root: string): string[] {
  const out: string[] = [];
  const rec = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) rec(abs); }
      else if (e.name.toLowerCase().endsWith(".md") && !SKIP_FILES.has(e.name)) out.push(abs);
    }
  };
  rec(root);
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Render summaries first, then the rest sorted by path.
const SUMMARY_HINTS = ["resumo-executivo", "_summary", "resumo", "executive-summary", "readme"];
const files = walk(projectDir).sort((a, b) => {
  const ra = path.relative(projectDir, a).toLowerCase();
  const rb = path.relative(projectDir, b).toLowerCase();
  const sa = SUMMARY_HINTS.some(h => path.basename(ra).includes(h)) ? 0 : 1;
  const sb = SUMMARY_HINTS.some(h => path.basename(rb).includes(h)) ? 0 : 1;
  return sa !== sb ? sa - sb : ra.localeCompare(rb);
});

if (files.length === 0) {
  console.error(`Nenhum markdown encontrado em ${projectDir}`);
  process.exit(1);
}

marked.setOptions({ gfm: true, breaks: false });

const sections: string[] = [];
const nav: string[] = [];
files.forEach((file, i) => {
  const rel = path.relative(projectDir, file);
  const id = `doc-${i}`;
  let body = "";
  try { body = marked.parse(fs.readFileSync(file, "utf8")) as string; }
  catch (e) { body = `<pre>${escapeHtml(String(e))}</pre>`; }
  nav.push(`<li><a href="#${id}"><i data-lucide="file-text"></i><span>${escapeHtml(rel)}</span></a></li>`);
  sections.push(`<section id="${id}"><div class="doc-path">${escapeHtml(rel)}</div>${body}</section>`);
});

const meta = [client && `Cliente: ${escapeHtml(client)}`, dateStr && `Data: ${escapeHtml(dateStr)}`, `${files.length} documento(s)`]
  .filter(Boolean).join(" · ");

// --- CDN asset references (default) ---
const CDN = {
  tailwind: `https://cdn.tailwindcss.com`,
  lucide: `https://unpkg.com/lucide@latest`,
  fontsPreconnect: `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
  fontsCss: `https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap`,
};

// Tailwind config (Apple-ish theme) — applied whether Tailwind comes from CDN or inlined.
const TAILWIND_CONFIG = `tailwind.config={darkMode:'media',theme:{extend:{fontFamily:{sf:['-apple-system','BlinkMacSystemFont','"SF Pro Display"','"SF Pro Text"','Inter','system-ui','sans-serif']},colors:{sysblue:{DEFAULT:'#0071e3',dark:'#0a84ff'}},borderRadius:{squircle:'14px',pill:'980px'}}}};`;

// Apple design tokens + styling for the semantic (marked-rendered) HTML.
const APPLE_CSS = `
:root{--bg:#fbfbfd;--card:#fff;--fg:#1d1d1f;--soft:#424245;--mute:#6e6e73;--line:rgba(0,0,0,.10);--accent:#0071e3;--code:#f5f5f7;--glass:saturate(180%) blur(20px);}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--fg:#f5f5f7;--soft:#c7c7cc;--mute:#8e8e93;--line:rgba(255,255,255,.14);--accent:#0a84ff;--code:#1c1c1e;}}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;color:var(--fg);background:var(--bg);letter-spacing:-0.01em;}
::selection{background:var(--accent);color:#fff}
.layout{display:flex;align-items:flex-start;max-width:1180px;margin:0 auto}
nav.toc{position:sticky;top:0;align-self:flex-start;width:300px;max-height:100vh;overflow:auto;padding:24px 16px;font-size:14px;border-right:1px solid var(--line);-webkit-backdrop-filter:var(--glass);backdrop-filter:var(--glass);}
nav.toc h2{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--mute);margin:0 0 14px;padding:0 8px}
nav.toc ol{list-style:none;margin:0;padding:0}
nav.toc li{margin:0 0 2px}
nav.toc a{color:var(--soft);text-decoration:none;display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:10px;overflow-wrap:anywhere;transition:background .15s,color .15s}
nav.toc a:hover{background:color-mix(in srgb,var(--accent) 10%,transparent);color:var(--accent)}
nav.toc a i,nav.toc a svg{width:15px;height:15px;flex:0 0 auto;opacity:.7}
main{flex:1;min-width:0;padding:0 0 140px}
header.report{position:sticky;top:0;z-index:20;-webkit-backdrop-filter:var(--glass);backdrop-filter:var(--glass);background:color-mix(in srgb,var(--bg) 72%,transparent);border-bottom:1px solid var(--line);padding:20px 40px}
header.report .eyebrow{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);border-radius:980px;padding:4px 12px;margin-bottom:12px}
header.report h1{margin:0 0 6px;font-size:30px;font-weight:800;letter-spacing:-0.03em}
header.report .meta{color:var(--mute);font-size:14px}
.content{padding:8px 40px}
section{padding:36px 0;border-bottom:1px solid var(--line)}
section:last-child{border-bottom:none}
section .doc-path{font:12px/1 ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;color:var(--mute);background:var(--code);display:inline-flex;align-items:center;border-radius:980px;padding:6px 12px;margin-bottom:16px}
h1,h2,h3,h4{line-height:1.22;letter-spacing:-0.02em;font-weight:700}
section h1{font-size:26px} section h2{font-size:21px;margin-top:1.6em} section h3{font-size:17px} section h4{font-size:15px}
p,li{color:var(--soft);line-height:1.65}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
strong{color:var(--fg)}
pre{background:var(--code);padding:16px 18px;border-radius:14px;overflow:auto;font:13px/1.55 ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;border:1px solid var(--line)}
code{background:var(--code);padding:.15em .4em;border-radius:6px;font:0.9em ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace}
pre code{background:none;padding:0;border:none}
table{border-collapse:separate;border-spacing:0;width:100%;margin:18px 0;font-size:14px;border:1px solid var(--line);border-radius:14px;overflow:hidden}
th,td{padding:11px 14px;text-align:left;border-bottom:1px solid var(--line)}
tbody tr:last-child td{border-bottom:none}
th{background:var(--code);font-weight:600;color:var(--fg);font-size:13px}
blockquote{margin:16px 0;padding:8px 18px;border-left:3px solid var(--accent);background:color-mix(in srgb,var(--accent) 5%,transparent);border-radius:0 10px 10px 0;color:var(--soft)}
img{max-width:100%;height:auto;border-radius:14px}
hr{border:none;border-top:1px solid var(--line);margin:28px 0}
@media (max-width:860px){nav.toc{display:none}.content,header.report{padding-left:20px;padding-right:20px}}
@media print{nav.toc{display:none}header.report{position:static}section{break-inside:avoid}body{background:#fff}}
`;

// Assemble the HTML with placeholders for the CDN/inline asset blocks.
const htmlTemplate = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<!--ASSET-FONTS-->
<!--ASSET-TAILWIND-->
<script>${TAILWIND_CONFIG}</script>
<!--ASSET-LUCIDE-->
<style>${APPLE_CSS}</style>
</head>
<body class="font-sf">
<div class="layout">
  <nav class="toc"><h2>Documentos</h2><ol>${nav.join("")}</ol></nav>
  <main>
    <header class="report">
      <span class="eyebrow"><i data-lucide="sparkles"></i> Relatório Nirvana-OS</span>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">${meta}${offlineSnapshot ? " · offline snapshot" : ""}</div>
    </header>
    <div class="content">
    ${sections.join("\n")}
    </div>
  </main>
</div>
<!--ASSET-LUCIDE-INIT-->
</body>
</html>
`;

// Fetch a CDN text asset; return null on any failure (best-effort).
async function tryFetch(url: string): Promise<string | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

// Resolve the three asset blocks (FONTS, TAILWIND, LUCIDE) + the lucide init.
let fontsBlock = `${CDN.fontsPreconnect}<link href="${CDN.fontsCss}" rel="stylesheet">`;
let tailwindBlock = `<script src="${CDN.tailwind}"></script>`;
let lucideBlock = `<script src="${CDN.lucide}"></script>`;
const lucideInit = `<script>if(window.lucide)lucide.createIcons();</script>`;

if (offlineSnapshot) {
  const [tw, lu] = await Promise.all([tryFetch(CDN.tailwind), tryFetch(CDN.lucide)]);
  // Offline: rely on the system SF/Inter stack (no webfont fetch needed).
  fontsBlock = "";
  if (tw) tailwindBlock = `<script>\n${tw}\n</script>`;
  else console.error("  ⚠ offline-snapshot: falha ao buscar Tailwind — mantendo link CDN");
  if (lu) lucideBlock = `<script>\n${lu}\n</script>`;
  else console.error("  ⚠ offline-snapshot: falha ao buscar Lucide — mantendo link CDN");
}

// Replace placeholders with a FUNCTION replacement so `$` and backticks inside
// the inlined JS are never treated as special by String.replace.
const html = htmlTemplate
  .replace("<!--ASSET-FONTS-->", () => fontsBlock)
  .replace("<!--ASSET-TAILWIND-->", () => tailwindBlock)
  .replace("<!--ASSET-LUCIDE-->", () => lucideBlock)
  .replace("<!--ASSET-LUCIDE-INIT-->", () => lucideInit);

try {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, html, "utf8");
} catch (e) {
  console.error(`Falha ao escrever ${output}: ${(e as Error).message}`);
  process.exit(1);
}
const sizeKb = (fs.statSync(output).size / 1024).toFixed(0);
console.log(`HTML report: ${output} (${files.length} markdown(s), ${sizeKb} KB${offlineSnapshot ? ", offline snapshot" : ", CDN"})`);
