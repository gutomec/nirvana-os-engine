// verify-deliverable-audit.test.ts — a verdict that is printed is also filed.
//
// The CLI recomputed the run root when writing the audit and, since 2026-09-04,
// shadowed its own variable while doing it (`const projectDir = path.join(projectDir, …)`).
// The `catch` printed "non-fatal" and the process exited with the verdict's
// code, so the gate looked healthy while the audit never received a single
// `verify_passed` or `verify_failed`. Anyone checking the chain from the audit
// concluded the verification never ran. The check now reports the run
// directory it resolved and the CLI files the verdict beside it; this test
// reads the audit back for both verdicts.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnBudgetMs } from "../../harness/tests/helpers/test-budgets.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "verify-deliverable.ts");
const today = () => new Date().toISOString().slice(0, 10);

function run(W: string, projectId: string, biz: string) {
  const logsRoot = join(W, ".nirvana", "logs", "harness");
  const r = spawnSync(process.execPath, [SCRIPT, projectId, biz], {
    cwd: W, encoding: "utf8", env: { ...process.env, HARNESS_LOGS_DIR: logsRoot },
  });
  const report = JSON.parse(`${r.stdout}`.trim().replace(/^[^{]*/, ""));
  const runAudit = join(W, "outputs", projectId, "businesses", biz, "audit.jsonl");
  const dayAudit = join(logsRoot, today(), "audit.jsonl");
  const lines = (f: string) => existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
  return { code: r.status, stderr: `${r.stderr}`, report, runEvents: lines(runAudit), dayEvents: lines(dayAudit) };
}

/** A nested-layout run: `outputs/<project_id>/` with a brief and a manifest. */
function scaffold(W: string, projectId: string, biz: string, deliverable: { name: string; write: boolean }): void {
  mkdirSync(join(W, ".nirvana"), { recursive: true });
  const run = join(W, "outputs", projectId);
  mkdirSync(join(run, "businesses", biz), { recursive: true });
  writeFileSync(join(run, "brief.md"), "# Brief\n\nDeliver the report.\n", "utf8");
  const target = join(run, "businesses", biz, deliverable.name);
  writeFileSync(join(run, "businesses", biz, "deliverables.json"), JSON.stringify([target]), "utf8");
  if (deliverable.write) writeFileSync(target, "# Report\n\n" + "A paragraph of real content. ".repeat(20) + "\n", "utf8");
}

describe("verify-deliverable files its verdict", () => {
  const roots: string[] = [];
  afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

  test("PASS is written beside the run and in the day's audit", () => {
    const W = mkdtempSync(join(tmpdir(), "verify-pass-")); roots.push(W);
    scaffold(W, "proj-pass", "acme", { name: "report.md", write: true });
    const out = run(W, "proj-pass", "acme");
    expect(out.report.status).toBe("PASS");
    expect(out.code).toBe(0);
    expect(out.stderr).not.toContain("audit emit failed");
    expect(out.runEvents.map(e => e.event)).toEqual(["verify_passed"]);
    expect(out.dayEvents.some(e => e.event === "verify_passed" && e.project_id === "proj-pass" && e.business_slug === "acme")).toBe(true);
  }, spawnBudgetMs(1));

  test("FAIL is filed too, with the counts the verdict was made from", () => {
    const W = mkdtempSync(join(tmpdir(), "verify-fail-")); roots.push(W);
    scaffold(W, "proj-fail", "acme", { name: "report.md", write: false });
    const out = run(W, "proj-fail", "acme");
    expect(out.report.status).toBe("FAIL");
    expect(out.code).toBe(1);
    expect(out.stderr).not.toContain("audit emit failed");
    const ev = out.runEvents.find(e => e.event === "verify_failed");
    expect(ev).toBeDefined();
    expect(ev.expected).toBe(1);
    expect(ev.found).toBe(0);
    expect(out.dayEvents.some(e => e.event === "verify_failed")).toBe(true);
  }, spawnBudgetMs(1));

  test("the pure check reports the run directory it resolved", async () => {
    const W = mkdtempSync(join(tmpdir(), "verify-dir-")); roots.push(W);
    scaffold(W, "proj-dir", "acme", { name: "report.md", write: true });
    const mod = await import("../scripts/verify-deliverable.ts");
    const prev = process.cwd();
    process.chdir(W);
    try {
      const r = mod.verifyDeliverableOnDisk("proj-dir", "acme");
      // process.cwd() comes back resolved after chdir into a symlinked tmpdir (macOS).
      expect(realpathSync(r.project_dir!)).toBe(realpathSync(join(W, "outputs", "proj-dir")));
      const gone = mod.verifyDeliverableOnDisk("no-such-project", "acme");
      expect(gone.status).toBe("FAIL_INDETERMINATE");
      expect(gone.project_dir).toBeUndefined();
    } finally { process.chdir(prev); }
  });
});
