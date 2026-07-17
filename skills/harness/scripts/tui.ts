#!/usr/bin/env bun
// tui.ts — terminal UI cockpit for Nirvana-OS.
//
// Live view of audit chain, active projects, and current dispatches without
// needing to open the browser-based glance. Refreshes every 2s, draws with
// box characters + colors.
//
// Usage:
//   nrv tui                      # interactive cockpit
//   nrv tui --once               # single render, exit
//   nrv tui --json               # machine-readable snapshot
//
// Keyboard:
//   q       quit
//   r       force refresh
//   v       toggle verbose
//
// Stats shown:
//   - audit chain events today (brief_received, dispatch_business, ...)
//   - active projects in .nirvana/outputs/ (with HANDOFF phase)
//   - last 5 events (live tail)
//   - registry health (squads + businesses counts + age)

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));

const ANSI = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
  cyan: "\x1b[36m", lime: "\x1b[38;5;154m", magenta: "\x1b[35m",
  clear: "\x1b[2J\x1b[H", hideCursor: "\x1b[?25l", showCursor: "\x1b[?25h",
};

const ONCE = process.argv.includes("--once");
const JSON_OUT = process.argv.includes("--json");
const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");
const NO_COLOR = process.argv.includes("--no-color") || !process.stdout.isTTY;

function c(color: keyof typeof ANSI, s: string): string {
  return NO_COLOR ? s : `${ANSI[color]}${s}${ANSI.reset}`;
}

type Snapshot = {
  ts: string;
  audit: Record<string, number>;
  total_events: number;
  active_projects: { id: string; phase: string; business: string; last_task: string }[];
  recent_events: { ts: string; event: string; project: string }[];
  registries: { squads: { kb: number; hours_old: number }; businesses: { kb: number; hours_old: number } };
};

function snapshot(): Snapshot {
  const today = new Date().toISOString().slice(0, 10);
  const { harnessLogsDir } = require(path.join(SKILLS_ROOT, "_shared/lib/log-paths.ts"));
  const auditPath = path.join(harnessLogsDir(), today, "audit.jsonl");
  const audit: Record<string, number> = {};
  const recent: { ts: string; event: string; project: string }[] = [];
  let totalEvents = 0;

  if (fs.existsSync(auditPath)) {
    const lines = fs.readFileSync(auditPath, "utf8").split("\n").filter(l => l.trim());
    totalEvents = lines.length;
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        audit[e.event] = (audit[e.event] || 0) + 1;
      } catch {}
    }
    // last 8 events
    for (const l of lines.slice(-8)) {
      try {
        const e = JSON.parse(l);
        recent.push({
          ts: e.ts?.slice(11, 19) || "?",
          event: e.event || "?",
          project: e.project_id || e.business_slug || (e as any).business || e.target_project || "—",
        });
      } catch {}
    }
  }

  // active projects
  const roots = [
    path.join(process.cwd(), "outputs"),            // novo default visível
    path.join(os.homedir(), ".nirvana/outputs"),
    path.join(process.cwd(), ".nirvana/outputs"),
  ];
  const active: Snapshot["active_projects"] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const proj of fs.readdirSync(root)) {
      if (seen.has(proj)) continue;
      const bizDir = path.join(root, proj, "businesses");
      if (!fs.existsSync(bizDir)) continue;
      for (const biz of fs.readdirSync(bizDir)) {
        const handoffPath = path.join(bizDir, biz, "HANDOFF.json");
        if (!fs.existsSync(handoffPath)) continue;
        try {
          const h = JSON.parse(fs.readFileSync(handoffPath, "utf8"));
          active.push({
            id: proj,
            phase: h.phase || "?",
            business: biz,
            last_task: h.last_task_completed?.task_id || "—",
          });
          seen.add(proj);
        } catch {}
      }
    }
  }

  // registries
  const squadReg = path.join(os.homedir(), ".squads-registry.json");
  const bizReg = path.join(os.homedir(), ".businesses-registry.json");
  const regStat = (p: string) => {
    if (!fs.existsSync(p)) return { kb: 0, hours_old: -1 };
    const s = fs.statSync(p);
    return { kb: Math.round(s.size / 1024), hours_old: Math.round((Date.now() - s.mtimeMs) / 3600_000) };
  };

  return {
    ts: new Date().toISOString(),
    audit,
    total_events: totalEvents,
    active_projects: active.sort((a, b) => a.id.localeCompare(b.id)),
    recent_events: recent,
    registries: { squads: regStat(squadReg), businesses: regStat(bizReg) },
  };
}

function render(s: Snapshot): string {
  const lines: string[] = [];
  const W = 78;

  // Header
  lines.push(c("lime", "╭" + "─".repeat(W) + "╮"));
  const header = `  Nirvana-OS · TUI · ${s.ts.slice(11, 19)} UTC`.padEnd(W - 1);
  lines.push(c("lime", "│") + c("bold", header) + c("lime", "│"));
  lines.push(c("lime", "├" + "─".repeat(W) + "┤"));

  // Section: AUDIT TODAY
  lines.push(c("lime", "│") + c("magenta", "  AUDIT (today)").padEnd(W + 10) + c("lime", "│"));
  const events = [
    "brief_received", "dispatch_business", "handoff_phase_advanced",
    "mind_clone_injected", "verify_passed", "gate_passed", "gate_failed"
  ];
  for (const ev of events) {
    const n = s.audit[ev] || 0;
    const bar = "█".repeat(Math.min(20, n));
    const line = `    ${ev.padEnd(28)}${c("dim", String(n).padStart(4))} ${c("lime", bar)}`;
    lines.push(c("lime", "│") + " " + line.padEnd(W + 30) + c("lime", "│"));
  }
  const total = `    total events today: ${s.total_events}`;
  lines.push(c("lime", "│") + c("dim", total).padEnd(W + 12) + c("lime", "│"));

  // Section: ACTIVE PROJECTS
  lines.push(c("lime", "├" + "─".repeat(W) + "┤"));
  lines.push(c("lime", "│") + c("magenta", "  ACTIVE PROJECTS").padEnd(W + 10) + c("lime", "│"));
  if (s.active_projects.length === 0) {
    lines.push(c("lime", "│") + c("dim", "    (nenhum projeto ativo)").padEnd(W + 8) + c("lime", "│"));
  } else {
    for (const p of s.active_projects.slice(0, 12)) {
      const phaseColor: "green" | "yellow" | "cyan" | "red" =
        p.phase === "complete" ? "green" :
        p.phase === "execute" ? "yellow" :
        p.phase === "plan" ? "cyan" : "red";
      const phaseIcon = p.phase === "complete" ? "✓" : p.phase === "execute" ? "⚡" : p.phase === "plan" ? "◷" : "✗";
      const text = `    ${phaseIcon} ${p.id.padEnd(36)} ${p.business.padEnd(28)}`;
      lines.push(c("lime", "│") + " " + text + c(phaseColor, p.phase.padEnd(8)) + " ".repeat(Math.max(0, W - text.length - 8 - 1)) + c("lime", "│"));
    }
    if (s.active_projects.length > 12) {
      const more = `    ... +${s.active_projects.length - 12} more`;
      lines.push(c("lime", "│") + c("dim", more).padEnd(W + 8) + c("lime", "│"));
    }
  }

  // Section: RECENT
  lines.push(c("lime", "├" + "─".repeat(W) + "┤"));
  lines.push(c("lime", "│") + c("magenta", "  RECENT EVENTS").padEnd(W + 10) + c("lime", "│"));
  if (s.recent_events.length === 0) {
    lines.push(c("lime", "│") + c("dim", "    (sem eventos hoje)").padEnd(W + 8) + c("lime", "│"));
  } else {
    for (const e of s.recent_events) {
      const text = `    ${c("dim", e.ts)} ${c("cyan", e.event.padEnd(28))} ${c("dim", e.project)}`;
      const visible = `    ${e.ts} ${e.event.padEnd(28)} ${e.project}`;
      lines.push(c("lime", "│") + " " + text + " ".repeat(Math.max(0, W - visible.length - 1)) + c("lime", "│"));
    }
  }

  // Section: REGISTRIES
  lines.push(c("lime", "├" + "─".repeat(W) + "┤"));
  const sq = s.registries.squads;
  const bz = s.registries.businesses;
  const sqStr = `squads-registry: ${sq.kb}KB · ${sq.hours_old < 0 ? "missing" : sq.hours_old + "h old"}`;
  const bzStr = `businesses-registry: ${bz.kb}KB · ${bz.hours_old < 0 ? "missing" : bz.hours_old + "h old"}`;
  lines.push(c("lime", "│") + c("dim", "  " + sqStr).padEnd(W + 8) + c("lime", "│"));
  lines.push(c("lime", "│") + c("dim", "  " + bzStr).padEnd(W + 8) + c("lime", "│"));

  // Footer
  lines.push(c("lime", "├" + "─".repeat(W) + "┤"));
  const help = ONCE ? "  --once mode (exiting)" : "  q quit · r refresh · v verbose";
  lines.push(c("lime", "│") + c("dim", help).padEnd(W + 8) + c("lime", "│"));
  lines.push(c("lime", "╰" + "─".repeat(W) + "╯"));

  return lines.join("\n");
}

if (JSON_OUT) {
  console.log(JSON.stringify(snapshot(), null, 2));
  process.exit(0);
}

if (ONCE) {
  process.stdout.write(render(snapshot()) + "\n");
  process.exit(0);
}

// Live mode
process.stdout.write(ANSI.hideCursor);
const cleanup = () => {
  process.stdout.write(ANSI.showCursor);
  process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

let stop = false;

// raw stdin for keystroke handling
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (key) => {
    const k = key.toString();
    if (k === "q" || k === "") { stop = true; cleanup(); }
    if (k === "r") render(snapshot()); // forced refresh next tick
  });
}

(async function loop() {
  while (!stop) {
    process.stdout.write(ANSI.clear);
    process.stdout.write(render(snapshot()) + "\n");
    await new Promise(r => setTimeout(r, 2000));
  }
})();
