#!/usr/bin/env bun
// clean-project.ts — remove an autopilot project's scaffold + outputs.
//
// Default is reversible: the project dir + its .zip are MOVED to
// ~/.nirvana/trash/<project_id>-<ts>/. With --hard they are deleted outright.
// An append-only `project_purged` event is written to the audit log (the log
// itself is never rewritten).
//
// Usage:
//   nrv clean <project_id>           # move to trash (reversible)
//   nrv clean <project_id> --hard    # delete permanently
//   nrv clean <project_id> --dry-run # show what would be removed
//
// Exit codes: 0 = cleaned · 1 = nothing found · 2 = bad args

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));

const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", lime: "\x1b[38;5;154m" };
const noColor = process.argv.includes("--no-color") || !process.stdout.isTTY;
function c(k: keyof typeof ANSI, s: string): string { return noColor ? s : `${ANSI[k]}${s}${ANSI.reset}`; }

const positional = process.argv.slice(2).filter(a => !a.startsWith("--"));
const projectId = positional[0];
const hard = process.argv.includes("--hard");
const dryRun = process.argv.includes("--dry-run");

if (!projectId) {
  console.error("Uso: nrv clean <project_id> [--hard] [--dry-run]");
  process.exit(2);
}

// A directory only qualifies as a Nirvana project if it carries one of these
// markers — guards against nuking an unrelated folder that happens to match.
function isNirvanaProject(dir: string): boolean {
  return ["businesses", "brief.md", "HANDOFF.json", "squads"].some(m => fs.existsSync(path.join(dir, m)));
}

const candidates = [
  path.join(os.homedir(), ".nirvana/outputs", projectId),
  path.join(process.cwd(), ".nirvana/outputs", projectId),
  path.join(os.homedir(), projectId),
];

const projectDirs = [...new Set(candidates)].filter(d => fs.existsSync(d) && fs.statSync(d).isDirectory() && isNirvanaProject(d));

// Find any zip: cwd/<id>.zip + session.json's zip_path.
const zips = new Set<string>();
const cwdZip = path.resolve(`./${projectId}.zip`);
if (fs.existsSync(cwdZip)) zips.add(cwdZip);
for (const d of projectDirs) {
  const bizRoot = path.join(d, "businesses");
  if (!fs.existsSync(bizRoot)) continue;
  for (const e of fs.readdirSync(bizRoot, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const sf = path.join(bizRoot, e.name, "session.json");
    if (fs.existsSync(sf)) {
      try {
        const z = JSON.parse(fs.readFileSync(sf, "utf8")).zip_path;
        if (z && fs.existsSync(z)) zips.add(z);
      } catch { /* ignore */ }
    }
  }
}

if (projectDirs.length === 0 && zips.size === 0) {
  console.error(c("yellow", `Nada encontrado para '${projectId}'. Procurei em:`));
  candidates.forEach(p => console.error("  " + p));
  process.exit(1);
}

console.log("");
console.log(c("lime", "▶") + c("bold", ` nrv clean — ${projectId}`));
console.log(c("dim", `  modo: ${hard ? "HARD (apaga)" : "trash (reversível)"}${dryRun ? " · dry-run" : ""}`));
[...projectDirs, ...zips].forEach(p => console.log(c("dim", `  alvo: ${p}`)));

if (dryRun) {
  console.log("");
  console.log(c("yellow", "  dry-run: nada removido."));
  process.exit(0);
}

const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const trashRoot = path.join(os.homedir(), ".nirvana", "trash", `${projectId}-${ts}`);
const moved: string[] = [];

function dispose(target: string, kind: "dir" | "file"): void {
  if (hard) {
    fs.rmSync(target, { recursive: true, force: true });
  } else {
    fs.mkdirSync(trashRoot, { recursive: true });
    const dest = path.join(trashRoot, path.basename(target));
    try {
      fs.renameSync(target, dest);
    } catch (e: any) {
      // Cross-device (EXDEV): trash on another volume. Copy then remove.
      if (e?.code === "EXDEV") {
        fs.cpSync(target, dest, { recursive: true });
        fs.rmSync(target, { recursive: true, force: true });
      } else {
        throw e;
      }
    }
  }
  moved.push(target);
}

for (const d of projectDirs) dispose(d, "dir");
for (const z of zips) dispose(z, "file");

function appendAudit(payload: Record<string, any>): void {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { harnessLogsDir } = require(path.join(SKILLS_ROOT, "_shared/lib/log-paths.ts"));
    // Try to route the purge event into the project's own logs first (so the
    // record stays with the project being purged). projectDirs[0] is the
    // best cwd hint we have here.
    const dir = path.join(harnessLogsDir({ cwd: projectDirs[0] || process.cwd() }), today);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n");
  } catch { /* non-fatal */ }
}
appendAudit({ event: "project_purged", project_id: projectId, hard, removed: moved, trash: hard ? null : trashRoot });

console.log("");
console.log(c("green", `✓ Removido (${moved.length} alvo(s)).`));
if (!hard) console.log(c("dim", `  Recuperável em: ${trashRoot}`));
console.log("");
process.exit(0);
