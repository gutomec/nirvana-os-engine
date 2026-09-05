#!/usr/bin/env bun
/**
 * audit-tail.ts — follow a run's audit, normalized, from now on.
 *
 * Three things every reader had to rebuild by hand, and get wrong:
 *
 *  1. TWO ENVELOPES. Some events are flat, some are CloudEvents with the name in
 *     the last segment of `type` and the payload under `data`. A `jq` filter on
 *     `.event` silently misses half of them — including `brief_received`, the
 *     first event of a run. `parseAuditLine` has normalized both all along; it
 *     is CJS, so nobody reading from a shell ever reached it.
 *  2. FOUR FILES. A run writes to the project log, one per dispatched target,
 *     and the global fallback. Following one is how a reader concludes a healthy
 *     run never dispatched.
 *  3. NO "FROM NOW ON". Every consumer replayed the whole file on first pass.
 *     `--follow` starts at the end, like tail, unless asked otherwise.
 *
 * Usage:
 *   nrv audit tail [--project <dir>] [--trace <id>] [--follow] [--all]
 *                  [--only orchestration|hooks|all] [--json]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
import { provenanceOf } from "../../_shared/lib/audit-provenance.js";

const argv = process.argv.slice(2);
const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const follow = argv.includes("--follow");
const fromStart = argv.includes("--all");
const asJson = argv.includes("--json");
const only = (arg("--only") ?? "orchestration") as "orchestration" | "hooks" | "all";
const trace = arg("--trace");
const projectDir = path.resolve(arg("--project") ?? process.cwd());

/** The hook stream is the highest-volume writer and answers a different
 *  question than orchestration. Denying it by name beats listing the events you
 *  want: a list goes blind the day the engine gains an `x_` event, which is the
 *  open namespace's whole point. */
const HOOK_EVENTS = /^(tool_invoked|bash_completed|artifact_touched|x_webhook_delivery_attempted|x_ledger_progress_ping|x_ledger_state_changed)$/;

function auditFiles(): string[] {
  const roots = [harnessLogsDir({ cwd: projectDir }), path.join(projectDir, "outputs")];
  const out: string[] = [];
  for (const root of roots) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (stack.length < 512) stack.push(full); }
        else if (e.name === "audit.jsonl") out.push(full);
      }
    }
  }
  const local = path.join(projectDir, "audit.jsonl");
  if (fs.existsSync(local)) out.push(local);
  return [...new Set(out)];
}

function render(line: string, file: string): string | null {
  let ev: any, raw: any;
  try { raw = JSON.parse(line); ev = parseAuditLine(line); } catch { return null; }
  const name = ev.event ?? "";
  if (!name) return null;
  const isHook = HOOK_EVENTS.test(name);
  if (only === "orchestration" && isHook) return null;
  if (only === "hooks" && !isHook) return null;
  if (trace && ev.trace_id !== trace && ev.project_id !== trace) return null;
  if (asJson) return JSON.stringify({ ...ev, _file: file, _provenance: provenanceOf(raw) });
  const seat = ev.employee ? `  seat=${ev.employee}` : "";
  const step = ev.step ? `  [${ev.step}/${ev.total}]` : "";
  const prov = provenanceOf(raw) === "engine" ? "" : `  ·${provenanceOf(raw)}`;
  const src = path.basename(path.dirname(file));
  return `${String(ev.ts ?? "").slice(11, 19)} [${src}] ${name}${seat}${step}${prov}`;
}

const offsets = new Map<string, number>();
function drain(initial: boolean): void {
  for (const f of auditFiles()) {
    let size = 0;
    try { size = fs.statSync(f).size; } catch { continue; }
    const prev = offsets.get(f);
    if (prev === undefined) {
      // `--follow` starts at the end; a one-shot read shows what is there.
      offsets.set(f, initial && follow && !fromStart ? size : 0);
      if (initial && follow && !fromStart) continue;
    }
    const from = offsets.get(f)!;
    if (size <= from) { offsets.set(f, size); continue; }
    let chunk = "";
    try {
      const fd = fs.openSync(f, "r");
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      fs.closeSync(fd);
      chunk = buf.toString("utf8");
    } catch { continue; }
    offsets.set(f, size);
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      const out = render(line, f);
      if (out) console.log(out);
    }
  }
}

drain(true);
if (follow) {
  setInterval(() => drain(false), 1000);
} 
