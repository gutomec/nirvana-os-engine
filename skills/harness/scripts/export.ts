#!/usr/bin/env bun
// export.ts — bundle a project's outputs into a zip/tar for sharing.
//
// Usage:
//   nrv export <project_id>                   # default: zip into ./<project>.zip
//   nrv export <project_id> --format=tgz
//   nrv export <project_id> --output=./dist/<file>.zip
//   nrv export <project_id> --include-audit   # also include audit.jsonl + HANDOFF
//
// Source directories scanned (in order):
//   ~/<project_id>/                                       (launch projects)
//   .nirvana/outputs/<project_id>/                        (cwd-scoped)
//   ~/.nirvana/outputs/<project_id>/                      (global)

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { RUN_PLUMBING, RUN_PLUMBING_DIRS, isRunStateFile } from "../../_shared/lib/run-plumbing.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";

const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", lime: "\x1b[38;5;154m" };
const noColor = process.argv.includes("--no-color") || !process.stdout.isTTY;
function c(k: keyof typeof ANSI, s: string): string { return noColor ? s : `${ANSI[k]}${s}${ANSI.reset}`; }

const args = process.argv.slice(2);
const project = args.filter(a => !a.startsWith("--"))[0];
const format = args.find(a => a.startsWith("--format="))?.split("=")[1] || "zip";
const output = args.find(a => a.startsWith("--output="))?.split("=")[1];
const includeAudit = args.includes("--include-audit");
const deliverablesOnly = args.includes("--deliverables-only") || args.includes("--only-deliverables");

if (!project) {
  console.error("Usage: nrv export <project_id> [--format=zip|tgz] [--output=path] [--include-audit] [--deliverables-only]");
  process.exit(2);
}

// Candidates are searched in order. The first one that LOOKS like a Nirvana
// project wins. A plain ~/<project>/ folder that's just where the user keeps
// the brief/zip is NOT a project — without the marker guard it used to be
// picked and the real outputs under .nirvana/outputs/<project>/ got ignored.
const candidates = [
  path.join(process.cwd(), "outputs", project),            // new visible default
  path.join(process.cwd(), ".nirvana/outputs", project),   // compat: runs antigos
  path.join(os.homedir(), ".nirvana/outputs", project),
  path.join(os.homedir(), project),
];
function looksLikeProject(dir: string): boolean {
  return ["businesses", "squads", "brief.md", "HANDOFF.json"].some(m => fs.existsSync(path.join(dir, m)));
}
let source = candidates.find(p => fs.existsSync(p) && fs.statSync(p).isDirectory() && looksLikeProject(p));
// Backward-compat fallback: if none of the candidates looks like a project but
// some directory exists, accept the first existing one with a warning.
if (!source) {
  source = candidates.find(p => fs.existsSync(p) && fs.statSync(p).isDirectory());
  if (source) console.error(c("yellow", `  ⚠ '${source}' has no Nirvana project marker (businesses/, brief.md, HANDOFF.json); packing it anyway.`));
}
if (!source) {
  console.error(c("red", `Project '${project}' not found. Looked in:`));
  candidates.forEach(p => console.error("  " + p));
  process.exit(1);
}

// --deliverables-only: archive just the deliverables/ folder, not the project
// scaffold (brief.md, the prompt, session.json, the squad cards). For a
// single-business project there is one deliverables dir → a clean archive
// rooted at deliverables/. With none or several, the run root ships, filtered.
let archiveSource = source;
if (deliverablesOnly) {
  // Look for the deliverables tree in (1) every business subdir and (2) the
  // project root. dispatch.ts sets outputs_root = <projDir>/deliverables/;
  // older runs nested a further `deliverables/` at the root — accept both.
  const delivDirs: string[] = [];
  const bizRoot = path.join(source, "businesses");
  if (fs.existsSync(bizRoot)) {
    for (const e of fs.readdirSync(bizRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dirPath = path.join(bizRoot, e.name, "deliverables");
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) delivDirs.push(dirPath);
    }
  }
  const topDeliv = path.join(source, "deliverables");
  if (fs.existsSync(topDeliv) && fs.statSync(topDeliv).isDirectory()) delivDirs.push(topDeliv);
  if (delivDirs.length === 1) {
    archiveSource = delivDirs[0];
  } else if (delivDirs.length === 0) {
    // It used to fall back to the WHOLE PROJECT here, which is the scaffold plus
    // every deliverable plus the employee prompt. A run served over the API has
    // no `deliverables/` folder at all — its artifacts sit flat in the run root —
    // so the normal case took the fallback and shipped the scaffold. The run root
    // is the right answer, and the plumbing filter below keeps it clean.
    console.error(c("yellow", "  ⚠ --deliverables-only: no deliverables/ folder; packing the run root, without the scaffold"));
  } else {
    // Several businesses delivered. Their folders are the product, organized as
    // the org chart produced them — not a reason to ship the scaffold instead.
    console.error(c("yellow", `  ⚠ --deliverables-only: ${delivDirs.length} deliverables/ folders (multi-business); packing the run root, without the scaffold`));
  }
}

const ext = format === "tgz" ? "tgz" : "zip";
const outputPath = output || path.resolve(`./${project}.${ext}`);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });

console.log("");
console.log(c("lime", "▶") + c("bold", " nrv export"));
console.log(c("dim", `  source: ${archiveSource}`));
console.log(c("dim", `  output: ${outputPath}`));
console.log(c("dim", `  audit:  ${includeAudit ? "included" : "excluded"}`));
console.log("");

// What never ships to a client, whichever archive format is used. The lists
// are the engine's own (run-plumbing.ts), not a private copy — and a private
// copy is exactly what this once was. It excluded `audit.jsonl` and
// `HANDOFF.json` and let `agent-prompt.md` through, which is the employee's
// system prompt, the mind-clone library and the firm's permanent memory, in the
// zip the client is handed as "the complete final product". Run state (the
// worker's summary and claims, `_STATUS.json`, `_work/`, `_review/`, the squad
// cards) is the run describing itself and stays out the same way.
// `--include-audit` lets the trail through (audit.jsonl, HANDOFF.json).
const AUDIT_TRAIL: ReadonlySet<string> = new Set(["audit.jsonl", "HANDOFF.json"]);
const SCAFFOLD_DIRS: ReadonlySet<string> = new Set(includeAudit ? [] : ["employees"]);

function shipped(rel: string, isDir: boolean): boolean {
  const name = rel.split("/").pop() ?? rel;
  if (isDir) return !RUN_PLUMBING_DIRS.has(name) && !SCAFFOLD_DIRS.has(name) && !isRunStateFile(`${rel}/`);
  if (name === ".publisher-brief.md") return false;
  if (includeAudit && AUDIT_TRAIL.has(name)) return true;
  return !RUN_PLUMBING.has(name) && !isRunStateFile(rel);
}

/** Every file that ships, relative to `root`, with "/" separators. Decided
 *  here, once, so the zip and the tarball can never disagree. */
function collect(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (shipped(r, true)) walk(path.join(dir, e.name), r); }
      else if (e.isFile() && shipped(r, false)) out.push(r);
    }
  };
  walk(root, "");
  return out.sort();
}

const parent = path.resolve(archiveSource, "..");
const basename = path.basename(archiveSource);
// Archive names are `<basename>/<rel>`, as the archive always rooted them.
const members = collect(archiveSource).map((rel) => `${basename}/${rel}`);

let r: ReturnType<typeof spawnSync> | undefined;
if (format === "tgz") {
  // tar with cwd + relative paths: a Windows absolute path (C:\...) has ":",
  // which GNU tar (Git Bash) reads as a remote host. Relative works with GNU
  // tar and bsdtar on every OS; cwd = parent spares the -C. The member list
  // goes through a file (-T), never the command line, so no length limit.
  const relOutRaw = path.relative(parent, outputPath);
  const relOut = (relOutRaw === "" || relOutRaw.includes(":") ? outputPath : relOutRaw).split(path.sep).join("/");
  const listFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-export-")), "members.txt");
  fs.writeFileSync(listFile, members.join("\n") + "\n", "utf8");
  r = spawnSync("tar", ["-czf", relOut, "-T", listFile], { windowsHide: true, encoding: "utf8", cwd: parent });
  try { fs.rmSync(path.dirname(listFile), { recursive: true, force: true }); } catch { /* temp dir */ }
} else {
  // zip — python's zipfile avoids a `zip` dependency on minimal systems. The
  // members arrive on stdin as UTF-8 JSON, so a long list or an accented name
  // never meets the command line or the console code page.
  const py = [
    "import sys, zipfile, json",
    "entries = json.loads(sys.stdin.buffer.read().decode('utf-8'))",
    "with zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:",
    "    for src, arc in entries:",
    "        z.write(src, arcname=arc)",
  ].join("\n");
  const input = JSON.stringify(members.map((m) => [path.join(parent, ...m.split("/")), m]));
  // `python3` on macOS and Linux; on Windows the launcher is usually `python`.
  for (const python of process.platform === "win32" ? ["python", "python3", "py"] : ["python3", "python"]) {
    r = spawnSync(python, ["-c", py, outputPath], { windowsHide: true, encoding: "utf8", input });
    if (!r.error && r.status !== 9009) break;
  }
}

if (!r || r.status !== 0) {
  console.error(c("red", "✗ archive failed:"));
  console.error(r?.error?.message || r?.stderr || r?.stdout || "");
  process.exit(1);
}

const stat = fs.statSync(outputPath);
console.log(c("green", `✓ Exported: ${outputPath} (${(stat.size / 1024).toFixed(1)} KB)`));

try {
  const today = new Date().toISOString().slice(0, 10);
  const dir = path.join(harnessLogsDir({ cwd: source }), today);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify({
    ts: new Date().toISOString(),
    event: "project_exported",
    project_id: project,
    format,
    output: outputPath,
    bytes: stat.size,
    include_audit: includeAudit,
  }) + "\n");
} catch {}

process.exit(0);
