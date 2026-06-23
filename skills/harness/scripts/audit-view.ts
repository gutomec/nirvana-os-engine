#!/usr/bin/env bun
// audit-view.ts — rich viewer for the audit chain of a project.
//
// Usage:
//   nrv audit-view <project_id>             # full chronological chain
//   nrv audit-view <project_id> --since=1h
//   nrv audit-view <project_id> --tail=20
//   nrv audit-view --all                    # summary across all projects today
//   nrv audit-view <project_id> --json
//
// Reads:
//   ~/.harness-logs/<today>/audit.jsonl              (global)
//   .nirvana/outputs/<project>/businesses/*/audit.jsonl  (project-local)
//
// Output:
//   chronological line-per-event with colors per type, deduped across sources.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));

const ANSI = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
  cyan: "\x1b[36m", lime: "\x1b[38;5;154m", magenta: "\x1b[35m", blue: "\x1b[34m",
};
const noColor = process.argv.includes("--no-color") || !process.stdout.isTTY;
function c(color: keyof typeof ANSI, s: string): string {
  return noColor ? s : `${ANSI[color]}${s}${ANSI.reset}`;
}

const args = process.argv.slice(2);
const all = args.includes("--all");
const jsonOut = args.includes("--json");
const positional = args.filter(a => !a.startsWith("--"));
const projectId = positional[0];
const sinceArg = args.find(a => a.startsWith("--since="))?.split("=")[1];
const tailArg = args.find(a => a.startsWith("--tail="))?.split("=")[1];
const tail = tailArg ? parseInt(tailArg) : null;

if (!projectId && !all) {
  console.error("Uso: nrv audit-view <project_id> [opts]");
  console.error("     nrv audit-view --all");
  console.error("");
  console.error("  --since=1h|30m|2d   Filter by relative time");
  console.error("  --tail=N            Only last N events");
  console.error("  --json              Machine-readable");
  process.exit(2);
}

type Event = { ts: string; event: string; [k: string]: any };

function loadAllEvents(): Event[] {
  const events: Event[] = [];
  const seen = new Set<string>();
  const addEvent = (e: Event) => {
    const k = `${e.ts}|${e.event}|${e.business_slug || ""}|${e.from_phase || ""}|${e.to_phase || ""}|${e.artifact || ""}|${e.project_id || ""}`;
    if (!seen.has(k)) { seen.add(k); events.push(e); }
  };

  // Global today
  const today = new Date().toISOString().slice(0, 10);
  const { harnessLogsDir } = require(path.join(SKILLS_ROOT, "_shared/lib/log-paths.ts"));
  const globalPath = path.join(harnessLogsDir(), today, "audit.jsonl");
  if (fs.existsSync(globalPath)) {
    const lines = fs.readFileSync(globalPath, "utf8").split("\n").filter(l => l.trim());
    for (const l of lines) {
      try { addEvent(JSON.parse(l)); } catch {}
    }
  }

  // Project-local across all output roots
  const roots = [
    path.join(os.homedir(), ".nirvana/outputs"),
    path.join(process.cwd(), ".nirvana/outputs"),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const proj of fs.readdirSync(root)) {
      const bizDir = path.join(root, proj, "businesses");
      if (!fs.existsSync(bizDir)) continue;
      for (const biz of fs.readdirSync(bizDir)) {
        const auditPath = path.join(bizDir, biz, "audit.jsonl");
        if (!fs.existsSync(auditPath)) continue;
        const lines = fs.readFileSync(auditPath, "utf8").split("\n").filter(l => l.trim());
        for (const l of lines) {
          try {
            const e = JSON.parse(l);
            // tag project_id if missing
            if (!e.project_id) e.project_id = proj;
            addEvent(e);
          } catch {}
        }
      }
    }
  }

  return events;
}

function parseSince(s: string): number {
  const m = s.match(/^(\d+)([smhd])$/);
  if (!m) return 0;
  const n = parseInt(m[1]);
  const unit = m[2];
  const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3600_000 : 86400_000;
  return Date.now() - n * mult;
}

function colorForEvent(ev: string): keyof typeof ANSI {
  if (ev.includes("dispatch_")) return "magenta";
  if (ev.includes("brief_")) return "cyan";
  if (ev.includes("handoff_phase")) return "blue";
  if (ev.includes("verify_passed") || ev.includes("gate_passed") || ev.includes("complete")) return "green";
  if (ev.includes("failed") || ev.includes("error")) return "red";
  if (ev.includes("warn") || ev.includes("revision")) return "yellow";
  if (ev.includes("mind_clone_injected")) return "lime";
  return "dim";
}

let events = loadAllEvents();

// Filter by project
if (projectId && !all) {
  events = events.filter(e =>
    e.project_id === projectId ||
    e.trace_id === projectId ||
    e.target_project === projectId
  );
}

// Filter by since
if (sinceArg) {
  const cutoff = parseSince(sinceArg);
  events = events.filter(e => Date.parse(e.ts) >= cutoff);
}

// Sort chronologically
events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

// Tail
if (tail) events = events.slice(-tail);

if (jsonOut) {
  console.log(JSON.stringify(events, null, 2));
  process.exit(0);
}

if (all) {
  // Summary mode
  const byProject: Record<string, Record<string, number>> = {};
  for (const e of events) {
    const pid = e.project_id || e.target_project || "—";
    byProject[pid] = byProject[pid] || {};
    byProject[pid][e.event] = (byProject[pid][e.event] || 0) + 1;
  }
  console.log("");
  console.log(c("bold", `Audit summary across ${Object.keys(byProject).length} projects (${events.length} events)`));
  console.log("");
  for (const [pid, counts] of Object.entries(byProject).sort()) {
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([e, n]) => `${e}:${n}`).join("  ");
    console.log(`  ${c("cyan", pid.padEnd(48))} ${c("dim", top)}`);
  }
  process.exit(0);
}

if (events.length === 0) {
  console.log(c("yellow", `No events found${projectId ? ` for project '${projectId}'` : ""}.`));
  process.exit(0);
}

console.log("");
console.log(c("bold", `Audit chain · ${projectId || "(filtered)"} · ${events.length} events`));
console.log("");

for (const e of events) {
  const time = e.ts.slice(11, 19);
  const color = colorForEvent(e.event);
  const detail = [];
  if (e.from_phase && e.to_phase) detail.push(`${e.from_phase}→${e.to_phase}`);
  if (e.business_slug) detail.push(`biz=${e.business_slug}`);
  if (e.employee) detail.push(`emp=${e.employee}`);
  if (e.artifact) detail.push(`artifact=${path.basename(e.artifact)}`);
  if (e.score_avg !== undefined) detail.push(`score=${e.score_avg}`);
  if (e.expected && e.found !== undefined) detail.push(`${e.found}/${e.expected}`);
  if (e.dna_files_injected) detail.push(`dna=${e.dna_files_injected}`);
  if (e.bytes) detail.push(`${e.bytes}B`);
  console.log(`  ${c("dim", time)}  ${c(color, e.event.padEnd(32))} ${c("dim", detail.join(" · "))}`);
}
console.log("");
process.exit(0);
