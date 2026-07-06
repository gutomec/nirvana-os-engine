#!/usr/bin/env bun
/**
 * watch.ts — terminal live tail of harness audit events for a project.
 *
 * Usage:
 *   nrv watch                       # tail all events from today
 *   nrv watch <project_path>        # filter to events touching that path
 *   nrv watch <slug>                # match by project_id slug
 *   nrv watch --trace <trace_id>    # follow a single run end-to-end
 *   nrv watch --since 2h            # show last N minutes/hours then follow
 *   nrv watch --no-follow           # snapshot only, then exit
 *
 * Reads ~/.harness-logs/<today>/audit.jsonl (or HARNESS_LOGS_DIR env override).
 * Polls every 1s for new lines. Pretty-prints events with color + per-event
 * shape (brief_received shows the brief text; dispatch_* shows the target;
 * gate_* shows the rubric verdict; delivered shows artifact_path).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseArgs, EXIT } from "../../_shared/lib/bun-helpers.ts";

// Resolves per-project when run inside a project, else fallback ~/.harness-logs.
// $HARNESS_LOGS_DIR (handled inside harnessLogsDir) still wins for explicit override.
const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));
const { harnessLogsDir } = require(path.join(SKILLS_ROOT, "_shared/lib/log-paths.ts"));
const HARNESS_LOGS_ROOT = harnessLogsDir();

// ANSI colors (only when stdout is a TTY)
const TTY = process.stdout.isTTY;
const c = (code: string, s: string) => TTY ? `\x1b[${code}m${s}\x1b[0m` : s;
const dim = (s: string) => c("2", s);
const bold = (s: string) => c("1", s);
const red = (s: string) => c("31", s);
const green = (s: string) => c("32", s);
const yellow = (s: string) => c("33", s);
const blue = (s: string) => c("34", s);
const purple = (s: string) => c("35", s);
const cyan = (s: string) => c("36", s);

// Color per event family
function eventColor(event: string): (s: string) => string {
  if (event === "brief_received" || event === "brief_amplified") return blue;
  if (event.startsWith("routing_") || event.startsWith("invocation_")) return cyan;
  if (event.startsWith("dispatch_")) return purple;
  if (event === "gate_passed" || event === "delivered") return green;
  if (event === "gate_failed" || event.startsWith("validation_") || event.startsWith("budget_") || event.includes("violation")) return red;
  if (event === "stall_detected" || event === "stall_retry" || event === "loop_detected" || event === "context_budget_warning") return yellow;
  if (event === "cost_emission") return dim;
  return (s: string) => s;
}

function todayDir(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function listLogFiles(sinceMs: number | null): string[] {
  if (!fs.existsSync(HARNESS_LOGS_ROOT)) return [];
  const dirs = fs.readdirSync(HARNESS_LOGS_ROOT)
    .filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .sort()
    .reverse();
  // Always include today; if --since N, walk back enough days.
  const cutoff = sinceMs ? Date.now() - sinceMs : null;
  const files: string[] = [];
  for (const d of dirs) {
    const f = path.join(HARNESS_LOGS_ROOT, d, "audit.jsonl");
    if (fs.existsSync(f)) {
      files.push(f);
      if (cutoff) {
        const dDate = new Date(d + "T23:59:59Z").getTime();
        if (dDate < cutoff) break; // older than cutoff, stop
      } else {
        break; // no --since, only today
      }
    }
  }
  return files.reverse(); // chronological
}

function parseSince(arg: string): number {
  const m = String(arg).match(/^(\d+)([mhd]?)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2] || "m";
  if (unit === "m") return n * 60_000;
  if (unit === "h") return n * 3_600_000;
  if (unit === "d") return n * 86_400_000;
  return 0;
}

function eventMatchesProject(ev: any, filter: { paths: string[]; slugs: string[]; trace?: string }): boolean {
  if (filter.trace && ev.trace_id !== filter.trace) return false;
  if (!filter.paths.length && !filter.slugs.length) return true;
  // Stringify the event so we catch project_path / artifact_path / cwd / project_id wherever they live
  const haystack = JSON.stringify(ev).toLowerCase();
  for (const p of filter.paths) if (haystack.includes(p.toLowerCase())) return true;
  for (const s of filter.slugs) if (haystack.includes(s.toLowerCase())) return true;
  return false;
}

function fmtEvent(ev: any): string {
  const color = eventColor(ev.event);
  const ts = (ev.ts || "").slice(11, 19); // HH:MM:SS
  const trace = ev.trace_id ? dim("[" + ev.trace_id.slice(0, 8) + "]") : dim("[--------]");
  const head = `${dim(ts)} ${trace} ${color(bold(ev.event.padEnd(22)))}`;

  // Per-event detail line
  const parts: string[] = [];
  if (ev.business_slug) parts.push(`biz=${ev.business_slug}`);
  if (ev.squad_name) parts.push(`squad=${ev.squad_name}`);
  if (ev.agent_or_employee) parts.push(`agent=${ev.agent_or_employee}`);
  if (ev.project_id) parts.push(`proj=${ev.project_id}`);

  let body = "";
  if (ev.event === "brief_received") {
    body = ev.brief || ev.user_input || ev.payload?.brief || "";
    body = body.slice(0, 120);
  } else if (ev.event === "routing_decision") {
    body = `signal=${ev.signal || "?"} target=${ev.target || ev.target_id || "?"}`;
  } else if (ev.event === "delivered") {
    body = `→ ${ev.artifact_path || ev.path || ""}`;
  } else if (ev.event === "gate_passed" || ev.event === "gate_failed") {
    body = `${ev.rubric || "?"}${ev.score != null ? ` score=${ev.score}` : ""}`;
  } else if (ev.event === "cost_emission") {
    const inT = ev.usage?.input_tokens ?? "?";
    const outT = ev.usage?.output_tokens ?? "?";
    body = dim(`tokens in=${inT} out=${outT} usd=${(ev.total_cost_usd ?? 0).toFixed(4)}`);
  } else if (ev.event === "context_budget_warning" || ev.event === "budget_violation") {
    body = `${ev.percent ?? "?"}% of ${ev.budget ?? "?"}`;
  }

  const tail = parts.length ? dim("  " + parts.join(" · ")) : "";
  return body ? `${head} ${body}${tail}` : `${head}${tail}`;
}

function printSnapshot(files: string[], filter: any, sinceMs: number | null): number {
  const cutoffIso = sinceMs ? new Date(Date.now() - sinceMs).toISOString() : null;
  let printed = 0;
  let totalLines = 0;
  for (const f of files) {
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      totalLines++;
      try {
        const ev = JSON.parse(line);
        if (cutoffIso && ev.ts < cutoffIso) continue;
        if (!eventMatchesProject(ev, filter)) continue;
        console.log(fmtEvent(ev));
        printed++;
      } catch { /* skip malformed */ }
    }
  }
  if (printed === 0 && totalLines > 0) {
    const filterDesc = filter.trace ? `trace=${filter.trace}` :
                       filter.paths.length || filter.slugs.length ? `filter="${[...filter.paths, ...filter.slugs].join(",")}"` :
                       "";
    console.log(dim(`(no matching events in ${totalLines} log lines${filterDesc ? " for " + filterDesc : ""})`));
  } else if (totalLines === 0) {
    console.log(dim("(audit log empty — no agent run today yet)"));
  }
  return printed;
}

async function follow(filter: any) {
  // Track per-file byte offset; on each tick, read new bytes.
  const offsets = new Map<string, number>();
  const initial = listLogFiles(null);
  for (const f of initial) offsets.set(f, fs.statSync(f).size);

  console.log(dim("\n— following live (Ctrl-C to stop) —\n"));
  const tick = () => {
    // Always check today's file; new days roll over.
    const f = path.join(HARNESS_LOGS_ROOT, todayDir(), "audit.jsonl");
    if (!fs.existsSync(f)) return;
    if (!offsets.has(f)) offsets.set(f, 0);
    const sz = fs.statSync(f).size;
    const off = offsets.get(f) || 0;
    if (sz <= off) return;
    const fd = fs.openSync(f, "r");
    const buf = Buffer.alloc(sz - off);
    fs.readSync(fd, buf, 0, sz - off, off);
    fs.closeSync(fd);
    offsets.set(f, sz);
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (!eventMatchesProject(ev, filter)) continue;
        console.log(fmtEvent(ev));
      } catch { /* skip */ }
    }
  };
  setInterval(tick, 1000);
  // Keep process alive
  await new Promise(() => {});
}

async function main() {
  const { positional, flags } = parseArgs();
  if (flags.h || flags.help) {
    console.log(`watch — terminal live tail of harness audit events

USAGE
  nrv watch                          tail today's events (no filter)
  nrv watch <project_path>           filter by absolute path
  nrv watch <slug>                   filter by project_id slug
  nrv watch --trace <trace_id>       follow one run end-to-end
  nrv watch --since 2h               show last 2h then follow
  nrv watch --no-follow              snapshot only, then exit

EVENTS
  brief_received        blue   — agent picked up a brief
  routing_decision      cyan   — picker chose a target
  invocation_start/end  cyan   — capability run boundaries
  dispatch_business     purple — dispatched to a business
  dispatch_squad        purple — dispatched to a squad
  gate_passed           green  — quality gate passed
  delivered             green  — artifact delivered (path)
  gate_failed           red    — gate failed; revision triggered
  validation_failed     red    — schema violation
  context_budget_warning yellow — context filling up
  cost_emission         dim    — token/USD per turn

EXAMPLES
  nrv watch ~/projects/meu-novo-projeto
  nrv watch meu-novo-projeto
  nrv watch --trace 5190116c
  nrv watch --since 30m
`);
    process.exit(EXIT.OK);
  }

  const filter = {
    paths: [] as string[],
    slugs: [] as string[],
    trace: flags.trace ? String(flags.trace) : undefined,
  };
  for (const arg of positional) {
    if (arg.startsWith("/") || arg.startsWith("~")) {
      filter.paths.push(path.resolve(arg.replace(/^~/, os.homedir())));
    } else {
      filter.slugs.push(arg);
    }
  }

  const sinceMs = flags.since ? parseSince(String(flags.since)) : null;
  const files = listLogFiles(sinceMs);

  // Header
  const target = filter.trace ? `trace=${filter.trace}` :
                 filter.paths.length || filter.slugs.length ? [...filter.paths, ...filter.slugs].join(", ") :
                 "all events";
  console.log(bold(`watching: ${target}`));
  console.log(dim(`logs: ${HARNESS_LOGS_ROOT} · ${files.length} day(s)\n`));

  printSnapshot(files, filter, sinceMs);

  if (flags["no-follow"]) process.exit(EXIT.OK);
  await follow(filter);
}

main().catch(e => { console.error(e); process.exit(EXIT.FAILURES); });
