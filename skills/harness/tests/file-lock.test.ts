// file-lock.test.ts — cross-process mutual exclusion contract:
//   1. Two bun subprocesses hammering one counter under withLock lose ZERO
//      updates (the diagnosed spend-tracker/cooldown lost-update race).
//   2. Stale locks (dead owner pid, or old mtime) are taken over.
//   3. A live holder blocks acquisition until release/timeout.
//   4. spend-tracker and cooldown-registry keep every update under parallel
//      writer waves (their public interfaces unchanged).
import { describe, expect, test, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

import { acquireLockSync, withLock, lockDirFor, isContention } from "../../_shared/lib/file-lock.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-file-lock-test-"));
const LOCK_MODULE = path.resolve(import.meta.dir, "..", "..", "_shared", "lib", "file-lock.ts");
const SPEND_MODULE = path.resolve(import.meta.dir, "..", "lib", "spend-tracker.ts");
const COOLDOWN_MODULE = path.resolve(import.meta.dir, "..", "lib", "cooldown-registry.ts");

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function runWorkers(script: string, argvPerWorker: string[][], env: Record<string, string> = {}): Promise<number[]> {
  return Promise.all(argvPerWorker.map((argv) => new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...argv], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("close", (code) => resolve(code ?? -1));
    child.on("error", reject);
  })));
}

describe("file-lock — what counts as contention", () => {
  // A Windows runner went red here once: mkdir on a lock dir whose deletion was
  // still pending answers EPERM, not EEXIST, and rethrowing it turned an
  // ordinary race between two contenders into a dead worker.
  const platform = process.platform;
  const asPlatform = (p: string) => Object.defineProperty(process, "platform", { value: p, configurable: true });
  afterAll(() => asPlatform(platform));

  test("EEXIST is contention on every platform", () => {
    for (const p of ["win32", "darwin", "linux"]) {
      asPlatform(p);
      expect(isContention({ code: "EEXIST" })).toBe(true);
    }
  });

  test("a pending delete (EPERM/EACCES/EBUSY) is contention on Windows only", () => {
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      asPlatform("win32");
      expect(isContention({ code })).toBe(true);
      asPlatform("linux");
      expect(isContention({ code })).toBe(false);
    }
  });

  test("a real error is never swallowed", () => {
    asPlatform("win32");
    expect(isContention({ code: "ENOSPC" })).toBe(false);
    expect(isContention(new Error("no code at all"))).toBe(false);
    expect(isContention(undefined)).toBe(false);
  });
});

describe("file-lock — concurrent writers", () => {
  test("two subprocesses increment a shared counter with no lost updates", async () => {
    const counter = path.join(TMP, "counter.json");
    const worker = path.join(TMP, "counter-worker.ts");
    fs.writeFileSync(worker, [
      `import { withLock } from ${JSON.stringify(LOCK_MODULE)};`,
      `import * as fs from "node:fs";`,
      `const file = process.argv[2];`,
      `const n = parseInt(process.argv[3], 10);`,
      `for (let i = 0; i < n; i++) {`,
      `  try {`,
      `    withLock(file, () => {`,
      `      let v = 0;`,
      `      try { v = JSON.parse(fs.readFileSync(file, "utf8")).count; } catch {}`,
      `      fs.writeFileSync(file, JSON.stringify({ count: v + 1 }));`,
      // A generous acquire timeout, because this test is about lost updates, not
      // about the default. The 10s default lost the race on Windows runners,
      // where mkdir/rmdir contention plus the OS file layer make each acquire
      // far slower than on POSIX — 100 contended acquires would overrun it and
      // the worker died with a bare exit code that said nothing.
      `    }, { pollMs: 2, timeoutMs: 60_000 });`,
      `  } catch (e) {`,
      // Say what went wrong. A silent non-zero exit is the least debuggable
      // shape a flake can take, and this one cost several CI rounds.
      `    console.error("worker iteration " + i + " failed: " + (e && e.message ? e.message : e));`,
      `    process.exit(1);`,
      `  }`,
      `}`,
    ].join("\n"));

    const N = 50;
    const codes = await runWorkers(worker, [[counter, String(N)], [counter, String(N)]]);
    expect(codes).toEqual([0, 0]);
    const final = JSON.parse(fs.readFileSync(counter, "utf8"));
    expect(final.count).toBe(2 * N); // any lost update would land below 100
  }, 30_000);
});

describe("file-lock — stale-lock takeover", () => {
  test("dead-pid lock is reclaimed immediately", () => {
    const target = path.join(TMP, "stale-pid.json");
    const dir = lockDirFor(target);
    fs.mkdirSync(dir, { recursive: true });
    // A pid far above macOS/Linux defaults — guaranteed ESRCH.
    fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ pid: 3_999_999, acquired_iso: new Date().toISOString() }));

    const t0 = Date.now();
    const lock = acquireLockSync(target, { timeoutMs: 2_000, staleMs: 60_000, pollMs: 5 });
    expect(Date.now() - t0).toBeLessThan(1_000); // no staleMs wait — pid check reclaimed it
    lock.release();
    expect(fs.existsSync(dir)).toBe(false);
  });

  test("old-mtime lock is reclaimed even when the owner pid looks alive", () => {
    const target = path.join(TMP, "stale-mtime.json");
    const dir = lockDirFor(target);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ pid: process.pid, acquired_iso: new Date().toISOString() }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(dir, old, old);

    const lock = acquireLockSync(target, { timeoutMs: 2_000, staleMs: 500, pollMs: 5 });
    lock.release();
  });

  test("live holder blocks until release; timeout throws", () => {
    const target = path.join(TMP, "held.json");
    const lock = acquireLockSync(target);
    expect(() => acquireLockSync(target, { timeoutMs: 200, pollMs: 10 })).toThrow(/timed out/);
    lock.release();
    const second = acquireLockSync(target, { timeoutMs: 200, pollMs: 10 });
    second.release();
  });

  test("withLock releases on throw", () => {
    const target = path.join(TMP, "throwing.json");
    expect(() => withLock(target, () => { throw new Error("inner"); })).toThrow("inner");
    expect(fs.existsSync(lockDirFor(target))).toBe(false);
  });
});

describe("spend-tracker — parallel waves keep every update", () => {
  test("two subprocesses × 50 addSpend(0.01) accumulate exactly $1.00 / 100 dispatches", async () => {
    const spendFile = path.join(TMP, "spend", "cascade-spend.json");
    const worker = path.join(TMP, "spend-worker.ts");
    fs.writeFileSync(worker, [
      `import { addSpend } from ${JSON.stringify(SPEND_MODULE)};`,
      `const n = parseInt(process.argv[2], 10);`,
      `for (let i = 0; i < n; i++) addSpend(${JSON.stringify(TMP)}, "claude-code:opus", 0.01);`,
    ].join("\n"));

    const N = 50;
    const codes = await runWorkers(worker, [[String(N)], [String(N)]], { NIRVANA_SPEND_FILE: spendFile });
    expect(codes).toEqual([0, 0]);
    const reg = JSON.parse(fs.readFileSync(spendFile, "utf8"));
    expect(reg["claude-code:opus"].dispatches).toBe(2 * N);
    expect(reg["claude-code:opus"].spend_usd).toBeCloseTo(2 * N * 0.01, 6);
  }, 30_000);
});

describe("cooldown-registry — parallel waves keep every runtime", () => {
  test("concurrent markCooldown on different runtimes never clobber each other", async () => {
    const cooldownFile = path.join(TMP, "cooldowns", "runtime-cooldowns.json");
    const worker = path.join(TMP, "cooldown-worker.ts");
    fs.writeFileSync(worker, [
      `import { markCooldown } from ${JSON.stringify(COOLDOWN_MODULE)};`,
      `const runtime = process.argv[2] as never;`,
      `const n = parseInt(process.argv[3], 10);`,
      `for (let i = 0; i < n; i++) markCooldown(${JSON.stringify(TMP)}, runtime, 300, "test wave " + i);`,
    ].join("\n"));

    const N = 40;
    const codes = await runWorkers(worker, [["claude-code", String(N)], ["codex", String(N)]], { NIRVANA_COOLDOWN_FILE: cooldownFile });
    expect(codes).toEqual([0, 0]);
    const reg = JSON.parse(fs.readFileSync(cooldownFile, "utf8"));
    // Pre-fix, last-writer-wins load/save could drop one runtime entirely.
    expect(Object.keys(reg).sort()).toEqual(["claude-code", "codex"]);
    expect(reg["claude-code"].reason).toBe(`test wave ${N - 1}`);
    expect(reg["codex"].reason).toBe(`test wave ${N - 1}`);
  }, 30_000);
});
