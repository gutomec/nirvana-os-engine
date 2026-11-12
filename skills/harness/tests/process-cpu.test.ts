// process-cpu.test.ts — the CPU a worker spends is how the heartbeat tells a
// worker that is thinking from one that hangs.
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { parseCpuTime, processTreeCpuMs, treeCpuMs, type ProcRow } from "../lib/process-cpu.ts";

describe("parseCpuTime", () => {
  test.each([
    ["0:12.76", 12_760],          // macOS: minutes:seconds.hundredths
    ["123:45.67", 7_425_670],     // macOS past an hour stays in minutes
    ["00:01:02", 62_000],         // procps
    ["1-02:03:04", 93_784_000],   // procps past a day
  ])("%s → %d ms", (text, ms) => {
    expect(parseCpuTime(text)).toBe(ms);
  });

  test("anything else is unknown, not zero", () => {
    expect(parseCpuTime("")).toBeNull();
    expect(parseCpuTime("TIME")).toBeNull();
  });
});

describe("treeCpuMs", () => {
  const rows: ProcRow[] = [
    { pid: 1, ppid: 0, cpuMs: 1_000 },
    { pid: 10, ppid: 1, cpuMs: 5 },     // the dispatcher
    { pid: 11, ppid: 10, cpuMs: 300 },  // the worker CLI
    { pid: 12, ppid: 11, cpuMs: 40 },   // a tool the worker started
    { pid: 13, ppid: 10, cpuMs: 900 },  // the heartbeat sidecar
    { pid: 14, ppid: 13, cpuMs: 20 },   // the sidecar's own `ps`
  ];

  test("a process counts with everything under it", () => {
    expect(treeCpuMs(rows, 11)).toBe(340);
    expect(treeCpuMs(rows, 10)).toBe(1_265);
  });

  test("the excluded subtree is left out", () => {
    expect(treeCpuMs(rows, 10, 13)).toBe(345);
  });

  test("a root that is gone is unknown", () => {
    expect(treeCpuMs(rows, 99)).toBeNull();
  });

  test("a parent link that loops (reused pids) counts each process once", () => {
    expect(treeCpuMs([{ pid: 2, ppid: 3, cpuMs: 7 }, { pid: 3, ppid: 2, cpuMs: 8 }], 2)).toBe(15);
  });
});

describe("processTreeCpuMs, measured live", () => {
  test("a busy child shows up in its parent's tree", async () => {
    // A child that burns CPU for ~1.2s, then waits to be measured.
    const child = spawn(process.execPath, ["-e", "const t = Date.now(); while (Date.now() - t < 1200) {} setTimeout(() => {}, 30000);"], { stdio: "ignore" });
    try {
      const before = processTreeCpuMs(process.pid);
      expect(before).not.toBeNull();
      await new Promise((r) => setTimeout(r, 1600));
      const after = processTreeCpuMs(process.pid);
      expect(after! - before!).toBeGreaterThanOrEqual(500);
      // and only its own CPU when it is the root
      expect(processTreeCpuMs(child.pid!)).toBeGreaterThanOrEqual(500);
    } finally {
      child.kill();
    }
  }, 30_000);

  test("an idle child spends almost none", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000);"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 1000)); // past its startup
      const a = processTreeCpuMs(child.pid!);
      await new Promise((r) => setTimeout(r, 1500));
      const b = processTreeCpuMs(child.pid!);
      expect(a).not.toBeNull();
      expect(b! - a!).toBeLessThan(100);
    } finally {
      child.kill();
    }
  }, 30_000);

  test("a pid that does not exist is unknown", () => {
    expect(processTreeCpuMs(0)).toBeNull();
  });
});
