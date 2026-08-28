// engine-purity-run-artifacts.test.ts — the trace of using the engine must never
// be committed into the engine.
//
// Nine files from a real dispatch run (a brief, a HANDOFF, a business's
// deliverables, a generated report) were committed and pushed to the public repo
// because `outputs/` was never gitignored and the purity gate only looked for
// squad.yaml-shaped content. The history had to be rewritten to remove them.
//
// Two things stop it now, and this file pins both: `outputs/` is ignored, and
// the gate fails on anything TRACKED under a path the engine writes to. The
// guarded paths are derived from the engine's own resolvers rather than
// hardcoded, so moving an output directory cannot silently unguard it.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { outputsDir } from "../../_shared/lib/scope.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const GATE = path.join(ROOT, "scripts", "check-engine-purity.ts");

const gitignore = () => fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
const runGate = () => spawnSync(process.execPath, [GATE], { encoding: "utf8", cwd: ROOT });

/** First path segment of where the engine writes, relative to a project root.
 *  Returns null when the engine writes outside the repo — not our problem. */
function writeRoot(abs: string): string | null {
  const rel = path.relative(ROOT, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep)[0];
}

/** Ask the resolvers about the DEFAULT layout.
 *
 *  Both honour env overrides, and several test files in this suite set
 *  HARNESS_LOGS_DIR at module scope — under `bun test` those share a process,
 *  so the value leaks across files. Run this file alone and it passes; run the
 *  suite and the resolver answers with somebody else's temp dir. That is
 *  exactly how this test failed on CI while passing locally. */
function defaultLayout<T>(fn: () => T): T {
  const saved = { out: process.env.NIRVANA_OUTPUTS_DIR, logs: process.env.HARNESS_LOGS_DIR };
  delete process.env.NIRVANA_OUTPUTS_DIR;
  delete process.env.HARNESS_LOGS_DIR;
  try {
    return fn();
  } finally {
    if (saved.out !== undefined) process.env.NIRVANA_OUTPUTS_DIR = saved.out;
    if (saved.logs !== undefined) process.env.HARNESS_LOGS_DIR = saved.logs;
  }
}

describe("run artifacts cannot be committed", () => {
  test("nothing under a write path is tracked right now", () => {
    const tracked = spawnSync("git", ["ls-files", "outputs", ".nirvana", ".harness-logs"], { cwd: ROOT, encoding: "utf8" });
    expect((tracked.stdout || "").trim()).toBe("");
  }, spawnBudgetMs(2));

  test("the gate passes on the shipped tree", () => {
    const r = runGate();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("OK");
  }, spawnBudgetMs(2));

  test("every path the engine writes to is gitignored", () => {
    // Derived, not listed: if outputsDir() moves, this test follows it there and
    // fails until .gitignore follows too.
    const ig = gitignore();
    const roots = defaultLayout(() =>
      [outputsDir({ projectRoot: ROOT } as any), harnessLogsDir({ projectRoot: ROOT })].map(writeRoot),
    ).filter((r): r is string => r !== null);
    expect(roots.length).toBeGreaterThan(0);   // resolution must have produced something
    for (const root of roots) {
      expect(ig).toMatch(new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?$`, "m"));
    }
  });

  test("git itself refuses to add one without --force", () => {
    // The gate is the backstop; this is the first line, and it is the one that
    // stops the mistake being made at all.
    const p = path.join(ROOT, "outputs", "__purity_probe__.md");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "probe\n");
    try {
      const r = spawnSync("git", ["add", p], { cwd: ROOT, encoding: "utf8" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/ignored/i);
    } finally {
      fs.rmSync(p, { force: true });
    }
  }, spawnBudgetMs(2));
});

describe("the guarded set follows the engine, not a memory of it", () => {
  test("the gate names the derivation rather than a fixed list", () => {
    const src = fs.readFileSync(GATE, "utf8");
    expect(src).toMatch(/ASKED OF THE ENGINE/);
    expect(src).toContain("outputsDir");
    expect(src).toContain("harnessLogsDir");
  });

  test("a static floor survives if the resolvers cannot be loaded", () => {
    // Resolution failing must degrade to guarding the three paths that leaked
    // once — never to guarding nothing.
    const src = fs.readFileSync(GATE, "utf8");
    expect(src).toMatch(/floor/);
    for (const p of ["outputs", ".nirvana", ".harness-logs"]) expect(src).toContain(`"${p}"`);
  });
});
