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
  console.error("Uso: nrv export <project_id> [--format=zip|tgz] [--output=path] [--include-audit] [--deliverables-only]");
  process.exit(2);
}

// Candidates are searched in order. The first one that LOOKS like a Nirvana
// project wins. A plain ~/<project>/ folder that's just where the user keeps
// the brief/zip is NOT a project — without the marker guard it used to be
// picked and the real outputs under .nirvana/outputs/<project>/ got ignored.
const candidates = [
  path.join(process.cwd(), "outputs", project),            // novo default visível
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
  if (source) console.error(c("yellow", `  ⚠ '${source}' não tem marcador de projeto Nirvana (businesses/, brief.md, HANDOFF.json); empacotando assim mesmo.`));
}
if (!source) {
  console.error(c("red", `Project '${project}' não encontrado. Procurei em:`));
  candidates.forEach(p => console.error("  " + p));
  process.exit(1);
}

// --deliverables-only: archive just the deliverables/ folder, not the project
// scaffold (brief.md, agent-prompt.md, session.json, handoffs, etc.). For a
// single-business project there is one deliverables dir → a clean archive
// rooted at deliverables/. Falls back to the full project if none or many.
let archiveSource = source;
if (deliverablesOnly) {
  // Look for the deliverables tree in (1) every business subdir and (2) the
  // project root. dispatch.ts sets outputs_root = <projDir>/deliverables/,
  // and the synthesizer may write either directly under that path or nest a
  // further `deliverables/` inside (older convention) — accept both.
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
    console.error(c("yellow", "  ⚠ --deliverables-only: nenhuma pasta deliverables/ encontrada; exportando projeto completo"));
  } else {
    console.error(c("yellow", `  ⚠ --deliverables-only: ${delivDirs.length} pastas deliverables/ (multi-business); exportando projeto completo`));
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

// Always exclude harness-internal scratch from client deliveries:
// _team/ holds intermediate work of peer employees in --team mode,
// .step-brief.md is the orchestrator's instruction to each step.
const excludes = (includeAudit ? [] : [
  "--exclude=audit.jsonl",
  "--exclude=HANDOFF.json",
  "--exclude=handoffs",
  "--exclude=tickets",
  "--exclude=employees",
]).concat([
  "--exclude=_team",
  "--exclude=.step-brief.md",
  "--exclude=.publisher-brief.md",
]);

const parent = path.resolve(archiveSource, "..");
const basename = path.basename(archiveSource);

let r;
if (format === "tgz") {
  // tar com cwd + paths relativos: um path absoluto do Windows (C:\...) tem ":"
  // e o GNU tar do Git Bash o trata como host remoto. Relativo funciona em
  // GNU tar e bsdtar, em qualquer OS. cwd = parent dispensa o -C.
  const relOutRaw = path.relative(parent, outputPath);
  const relOut = (relOutRaw === "" || relOutRaw.includes(":") ? outputPath : relOutRaw).split(path.sep).join("/");
  const tarArgs = ["-czf", relOut, ...excludes, basename];
  r = spawnSync("tar", tarArgs, { encoding: "utf8", cwd: parent });
} else {
  // zip — use python3 zipfile to avoid `zip` dep on minimal systems
  const py = `
import os, sys, zipfile
src = sys.argv[1]
dst = sys.argv[2]
include_audit = sys.argv[3] == "true"
exclude_basenames = ({"audit.jsonl", "HANDOFF.json"} if not include_audit else set()) | {".step-brief.md", ".publisher-brief.md"}
exclude_dirs = ({"handoffs", "tickets", "employees"} if not include_audit else set()) | {"_team"}
with zipfile.ZipFile(dst, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in exclude_dirs]
        for f in files:
            if f in exclude_basenames:
                continue
            p = os.path.join(root, f)
            arc = os.path.relpath(p, os.path.dirname(src))
            z.write(p, arcname=arc)
`;
  r = spawnSync("python3", ["-c", py, archiveSource, outputPath, includeAudit ? "true" : "false"], { encoding: "utf8" });
}

if (r.status !== 0) {
  console.error(c("red", "✗ archive failed:"));
  console.error(r.stderr || r.stdout || "");
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
