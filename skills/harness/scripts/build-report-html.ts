#!/usr/bin/env bun
// build-report-html.ts — render every markdown produced in a project into ONE
// self-contained HTML report (a JS library does the markdown→HTML; no pandoc,
// no python, works offline). The output is a single file with inline CSS and a
// sticky table of contents, so it drops cleanly into the --zip bundle and opens
// anywhere.
//
// Usage:
//   bun build-report-html.ts --project <dir> --output <file.html> \
//     [--title "..."] [--client "..."] [--date "..."]
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

if (!projectDir || !output) {
  console.error('Uso: build-report-html.ts --project <dir> --output <file.html> [--title] [--client] [--date]');
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
  nav.push(`<li><a href="#${id}">${escapeHtml(rel)}</a></li>`);
  sections.push(`<section id="${id}"><div class="doc-path">${escapeHtml(rel)}</div>${body}</section>`);
});

const meta = [client && `Cliente: ${escapeHtml(client)}`, dateStr && `Data: ${escapeHtml(dateStr)}`, `${files.length} documento(s)`]
  .filter(Boolean).join(" · ");

const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { --fg:#1a1a1a; --muted:#666; --line:#e2e2e2; --accent:#6d28d9; --bg:#fff; --code-bg:#f6f6f7; }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; color:var(--fg); background:var(--bg); }
  .layout { display:flex; align-items:flex-start; max-width:1180px; margin:0 auto; }
  nav { position:sticky; top:0; align-self:flex-start; width:280px; max-height:100vh; overflow:auto; padding:24px 16px; border-right:1px solid var(--line); font-size:14px; }
  nav h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:0 0 12px; }
  nav ol { list-style:none; margin:0; padding:0; }
  nav li { margin:0 0 6px; }
  nav a { color:var(--fg); text-decoration:none; display:block; padding:4px 8px; border-radius:6px; overflow-wrap:anywhere; }
  nav a:hover { background:var(--code-bg); color:var(--accent); }
  main { flex:1; min-width:0; padding:24px 40px 120px; }
  header.report { border-bottom:2px solid var(--accent); padding-bottom:16px; margin-bottom:8px; }
  header.report h1 { margin:0 0 6px; font-size:28px; }
  header.report .meta { color:var(--muted); font-size:14px; }
  section { padding:32px 0; border-bottom:1px solid var(--line); }
  section .doc-path { font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); background:var(--code-bg); display:inline-block; padding:5px 9px; border-radius:6px; margin-bottom:12px; }
  h1,h2,h3,h4 { line-height:1.25; }
  section h1 { font-size:24px; } section h2 { font-size:20px; } section h3 { font-size:17px; }
  a { color:var(--accent); }
  pre { background:var(--code-bg); padding:14px 16px; border-radius:8px; overflow:auto; font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  code { background:var(--code-bg); padding:.15em .35em; border-radius:4px; font:0.9em ui-monospace,SFMono-Regular,Menlo,monospace; }
  pre code { background:none; padding:0; }
  table { border-collapse:collapse; width:100%; margin:12px 0; font-size:14px; }
  th,td { border:1px solid var(--line); padding:8px 10px; text-align:left; }
  th { background:var(--code-bg); }
  blockquote { margin:12px 0; padding:4px 16px; border-left:3px solid var(--accent); color:var(--muted); }
  img { max-width:100%; height:auto; }
  @media (max-width:820px){ nav{display:none;} main{padding:20px;} }
  @media print { nav{display:none;} section{break-inside:avoid;} main{padding:0;} }
</style>
</head>
<body>
<div class="layout">
  <nav><h2>Documentos</h2><ol>${nav.join("")}</ol></nav>
  <main>
    <header class="report"><h1>${escapeHtml(title)}</h1><div class="meta">${meta}</div></header>
    ${sections.join("\n")}
  </main>
</div>
</body>
</html>
`;

try {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, html, "utf8");
} catch (e) {
  console.error(`Falha ao escrever ${output}: ${(e as Error).message}`);
  process.exit(1);
}
console.log(`HTML report: ${output} (${files.length} markdown(s))`);
