// process-cpu.ts — how much CPU a process and everything it started has spent.
//
// The heartbeat sidecar renews a run's lease when the worker prints or writes a
// file. A worker can do neither for longer than a lease and still be working: a
// CLI run headless (`--output-format json`) prints once, at the end, and a model
// that reasons for ten minutes writes nothing meanwhile. Seen on a Grok landing
// page run, whose lease had to be renewed by hand to keep the supervisor from
// killing it. CPU tells the two apart: a worker receiving a model's stream keeps
// spending it, a worker blocked on a dead socket spends none.
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

export interface ProcRow { pid: number; ppid: number; cpuMs: number }

/** Growth, in CPU ms between two samples, that counts as work. An idle CLI
 *  waiting on a socket spends ~0; one receiving a stream spends far more. */
export const CPU_ACTIVITY_MIN_MS = 100;

/** `ps -o time=` text in ms: "0:12.76" (macOS, minutes:seconds), "00:01:02"
 *  and "1-02:03:04" (procps). Null for anything else. */
export function parseCpuTime(text: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!m) return null;
  const [, days, hours, minutes, seconds] = m;
  return Math.round(((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000);
}

/** CPU ms of `root` and its descendants, `exclude` and its own descendants
 *  left out (the sidecar asking about the dispatcher that also started it).
 *  Null when `root` is not in the table. Windows reuses pids, so a parent link
 *  can loop; every pid is counted once. */
export function treeCpuMs(rows: ProcRow[], root: number, exclude?: number): number | null {
  if (!rows.some((r) => r.pid === root)) return null;
  const children = new Map<number, ProcRow[]>();
  for (const r of rows) {
    if (r.pid === r.ppid) continue;
    const list = children.get(r.ppid);
    if (list) list.push(r); else children.set(r.ppid, [r]);
  }
  const seen = new Set<number>();
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid) || pid === exclude) continue;
    seen.add(pid);
    total += rows.find((r) => r.pid === pid)?.cpuMs ?? 0;
    for (const c of children.get(pid) ?? []) stack.push(c.pid);
  }
  return total;
}

/** Every process under `root` (children, grandchildren…), from one snapshot.
 *  Taken BEFORE anything is signalled: once a parent dies its children are
 *  re-parented to init and the link to the run is gone. Each pid once, so a
 *  parent link that loops cannot spin. */
export function descendants(rows: ProcRow[], root: number): number[] {
  const children = new Map<number, number[]>();
  for (const r of rows) {
    if (r.pid === r.ppid) continue;
    const list = children.get(r.ppid);
    if (list) list.push(r.pid); else children.set(r.ppid, [r.pid]);
  }
  const out: number[] = [];
  const seen = new Set<number>([root]);
  const stack = [...(children.get(root) ?? [])];
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

/** Linux: /proc has utime + stime in clock ticks (100 per second on every
 *  mainstream kernel), 10ms resolution where procps `ps -o time=` has 1s. */
function linuxTable(): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      // The command name sits in parentheses and may hold spaces: fields are
      // counted from the last ")".
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      rows.push({ pid: Number(name), ppid: Number(f[1]), cpuMs: (Number(f[11]) + Number(f[12])) * 10 });
    } catch { /* the process ended between the listing and the read */ }
  }
  return rows;
}

/** Every process with its parent and CPU ms, or null when the table cannot be
 *  read (no `ps`, no PowerShell, a timeout): "cannot tell", never "idle". */
export function processTable(timeoutMs = 4000): ProcRow[] | null {
  try {
    if (process.platform === "linux" && fs.existsSync("/proc/self/stat")) return linuxTable();
    if (process.platform === "win32") {
      // Kernel and user time are in 100ns units.
      const r = spawnSync("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $([math]::Floor(($_.KernelModeTime + $_.UserModeTime) / 10000))" }',
      ], { windowsHide: true, encoding: "utf8", timeout: timeoutMs });
      if (r.status !== 0) return null;
      return (r.stdout || "").trim().split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number))
        .filter((p) => p.length === 3 && p.every(Number.isFinite))
        .map(([pid, ppid, cpuMs]) => ({ pid, ppid, cpuMs }));
    }
    const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,time="], { encoding: "utf8", timeout: timeoutMs });
    if (r.status !== 0) return null;
    const rows: ProcRow[] = [];
    for (const line of (r.stdout || "").trim().split("\n")) {
      const [pid, ppid, time] = line.trim().split(/\s+/);
      const cpuMs = parseCpuTime(time ?? "");
      if (cpuMs !== null) rows.push({ pid: Number(pid), ppid: Number(ppid), cpuMs });
    }
    return rows;
  } catch { return null; }
}

/** CPU ms spent so far by `root` and everything under it, `exclude`'s subtree
 *  left out. Null when it cannot be measured. */
export function processTreeCpuMs(root: number, exclude?: number, timeoutMs?: number): number | null {
  if (!Number.isFinite(root) || root <= 0) return null;
  const rows = processTable(timeoutMs);
  return rows ? treeCpuMs(rows, root, exclude) : null;
}
