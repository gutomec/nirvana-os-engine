/**
 * Where the squad doctor writes, and in what language.
 *
 * The doctor used to write `SQUAD-DOCTOR-REPORT.md` into the squad directory
 * itself. Two things followed, and both were found in the wild rather than
 * reasoned about: 25 of those reports were sitting in the content trees and 18
 * more inside built pack artifacts, so buyers received a diagnostic about the
 * seller's machine; and because the file carries a fresh timestamp on every
 * run, two copies of the same squad validated minutes apart disagreed forever —
 * a slug that could not be reconciled no matter how carefully it was merged.
 *
 * The squad directory is product. A diagnostic about the product is not.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDoctorReport, type Finding } from "../lib/squad-doctor.ts";

/**
 * The report lands under the project's state directory, so this points the root
 * at a throwaway one — otherwise the suite leaves six fake squads in the real
 * `.nirvana/state/squads`.
 *
 * It is set in beforeAll and PUT BACK in afterAll, not assigned at module scope.
 * `bun test` runs every file in one process, so a module-scope assignment leaks
 * into every file loaded afterwards: doing it that way made `buyer-path` resolve
 * its install records to a directory this suite had already deleted, and report
 * "No installations recorded" on Linux and Windows while passing on macOS, where
 * the file order happened to differ. `resolvePaths()` reads the environment on
 * every call, so scoping it to the tests that need it costs nothing.
 */
const FAKE_ROOT = mkdtempSync(join(tmpdir(), "doctor-root-"));
let previousRoot: string | undefined;
beforeAll(() => { previousRoot = process.env.NIRVANA_PROJECT_ROOT; process.env.NIRVANA_PROJECT_ROOT = FAKE_ROOT; });
afterAll(() => {
  if (previousRoot === undefined) delete process.env.NIRVANA_PROJECT_ROOT;
  else process.env.NIRVANA_PROJECT_ROOT = previousRoot;
  rmSync(FAKE_ROOT, { recursive: true, force: true });
});

function squadDir(slug: string) {
  const root = mkdtempSync(join(tmpdir(), "doctor-"));
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "squad.yaml"), `name: ${slug}\nversion: 1.0.0\n`, "utf8");
  return { root, dir };
}

const finding: Finding = {
  severity: "warn",
  code: "fidelity-unverified",
  where: "design.thing.execute",
  problem: "declares fidelity.status: validated but points at no eval_results",
  why: "fidelity.status: validated without proof is fabricated fidelity",
  fix: "generate an eval-results.json, or downgrade to experimental",
  autofixable: true,
};

describe("the report does not live in the product", () => {
  test("it is written outside the squad directory", () => {
    const { root, dir } = squadDir("alpha");
    const out = writeDoctorReport(dir, [finding], "2026-08-15T00:00:00.000Z");
    expect(existsSync(out)).toBe(true);
    expect(out.startsWith(dir)).toBe(false);
    expect(existsSync(join(dir, "SQUAD-DOCTOR-REPORT.md"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("a report left by the old location is retired", () => {
    // 25 of these were in the content trees. Diagnosing a squad again should
    // clear its own litter rather than wait for someone to notice.
    const { root, dir } = squadDir("beta");
    const legacy = join(dir, "SQUAD-DOCTOR-REPORT.md");
    writeFileSync(legacy, "# stale report from the old location\n", "utf8");
    writeDoctorReport(dir, [], "2026-08-15T00:00:00.000Z");
    expect(existsSync(legacy)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("the path is per-slug, so two squads do not overwrite each other", () => {
    const a = squadDir("gamma"), b = squadDir("delta");
    const pa = writeDoctorReport(a.dir, [], "2026-08-15T00:00:00.000Z");
    const pb = writeDoctorReport(b.dir, [], "2026-08-15T00:00:00.000Z");
    expect(pa).not.toBe(pb);
    expect(pa).toContain("gamma");
    expect(pb).toContain("delta");
    rmSync(a.root, { recursive: true, force: true });
    rmSync(b.root, { recursive: true, force: true });
  });
});

describe("the report reads in the project's language", () => {
  test("no Portuguese in the generated report", () => {
    // Every user-facing string in the engine is English; the buyer report that
    // started this whole thread arrived in Portuguese and that was the bug.
    const { root, dir } = squadDir("epsilon");
    const body = readFileSync(writeDoctorReport(dir, [finding], "2026-08-15T00:00:00.000Z"), "utf8");
    for (const pt of ["diagnóstico", "Problemas:", "Como corrigir", "Por quê", "auto-corrigível", "Nenhum problema"]) {
      expect(body).not.toContain(pt);
    }
    expect(body).toContain("How to fix");
    expect(body).toContain("Why it matters");
    rmSync(root, { recursive: true, force: true });
  });

  test("a clean squad still gets a readable report", () => {
    const { root, dir } = squadDir("zeta");
    const body = readFileSync(writeDoctorReport(dir, [], "2026-08-15T00:00:00.000Z"), "utf8");
    expect(body).toContain("No fidelity or portability problems found.");
    expect(body).toContain("Findings: 0");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("the packaging path knows it is not content", () => {
  test("run-state excludes it, so no builder can ship one again", async () => {
    // The doctor writing elsewhere fixes new reports. This is what stops the
    // ones already on disk from travelling into a pack.
    const rs = await import("../../_shared/lib/run-state.ts");
    expect(rs.isRunStatePath("SQUAD-DOCTOR-REPORT.md")).toBe(true);
    expect(rs.isRunStatePath("agents/whatever.md")).toBe(false);
  });

  test("`.runs` is run state too", async () => {
    // Found by inspecting a rebuild file by file: `brandcraft/.runs` holds 64
    // files and 36 MB of leftover Remotion renders, and it was shipping inside
    // four packs. The name was in three private exclusion lists and missing
    // from the one four consumers read.
    const rs = await import("../../_shared/lib/run-state.ts");
    expect(rs.isRunStatePath(".runs/mago-demo/out/frame-001.png")).toBe(true);
    expect(rs.isRunStatePath("lib/design-intelligence/README.md")).toBe(false);
  });
});
