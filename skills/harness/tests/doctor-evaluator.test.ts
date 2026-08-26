// doctor-evaluator.test.ts — `nrv doctor` says which Gauntlet evaluator a dispatch would
// get today and why, by the same selection the canaries use and without running anything:
// the registry squad declaring quality.specification_conformance, the engine's judge-x
// on a runtime with a persona on PATH, the offline heuristic only by explicit opt-in, or
// none, in which case a Gauntlet will not start. Spawns the doctor with a temporary HOME.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DOCTOR = path.join(import.meta.dir, "..", "scripts", "doctor-system.ts");
const REPO_SKILLS = path.join(import.meta.dir, "..", "..");

interface DoctorCheck { name: string; status: string; note: string }

function runDoctor(installed: Record<string, string[]>, extraEnv: Record<string, string> = {}): DoctorCheck | undefined {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-doctor-evaluator-"));
  const work = path.join(home, "work");
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(path.join(home, ".nirvana"), { recursive: true });
  const registry = path.join(home, ".squads-registry.json");
  fs.writeFileSync(registry, JSON.stringify({ schema_version: 1, squads: Object.fromEntries(Object.entries(installed).map(([slug, capabilities]) => [slug, { capabilities }])) }), "utf8");
  try {
    const env = { ...process.env } as Record<string, string>;
    delete env.NIRVANA_GAUNTLET_EVALUATOR;
    delete env.BUSINESSES_REGISTRY_PATH;
    env.NIRVANA_PROJECT_ROOT = home;
    env.SQUADS_REGISTRY_PATH = registry;
    env.HOME = home;
    env.USERPROFILE = home;
    env.NIRVANA_HOME = home;
    env.NIRVANA_SKILLS_DIR = REPO_SKILLS;
    env.NIRVANA_SCOPE_QUIET = "1";
    Object.assign(env, extraEnv);
    const r = spawnSync(process.execPath, [DOCTOR, "--json"], { encoding: "utf8", env, cwd: work, timeout: 60_000 });
    const parsed = JSON.parse(r.stdout || "{}");
    return (parsed.checks || []).find((c: DoctorCheck) => c.name === "gauntlet: evaluator");
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

describe("doctor — gauntlet evaluator", () => {
  test("an installed squad declaring the conformance capability is the evaluator, and the note says the registry chose it", () => {
    const check = runDoctor({ "spec-judge": ["quality.specification_conformance"], "code-review": ["software_engineering.code_review.execute"] });
    expect(check).toBeDefined();
    expect(check!.status).toBe("PASS");
    expect(check!.note).toContain("squad:spec-judge:quality.specification_conformance");
    expect(check!.note).toContain("registry");
  }, 60_000);

  test("without such a squad the engine's judge-x is the evaluator when a runtime with a persona is on PATH, else none and a warning", () => {
    const check = runDoctor({ "code-review": ["software_engineering.code_review.execute"] });
    expect(check).toBeDefined();
    if (check!.status === "PASS") {
      expect(check!.note).toContain("judge-x");
      expect(check!.note).toContain("engine default");
      expect(check!.note).toContain("runtimes with a persona on PATH");
    } else {
      // A bare runner (CI) has no agent runtime, so no judge-x: the doctor says the Gauntlet will not start.
      expect(check!.status).toBe("WARN");
      expect(check!.note).toContain("a Gauntlet will not start");
      expect(check!.note).toContain("judge-x");
    }
  }, 60_000);

  test("the offline heuristic is reported as an explicit opt-in, never as the default", () => {
    const check = runDoctor({}, { NIRVANA_GAUNTLET_EVALUATOR: "heuristic" });
    expect(check).toBeDefined();
    expect(check!.status).toBe("WARN");
    expect(check!.note).toContain("explicit opt-in");
    expect(check!.note).toContain("NIRVANA_GAUNTLET_EVALUATOR=heuristic");
  }, 60_000);

  test("a variable the selection cannot honour is reported with the selection's own reason", () => {
    const check = runDoctor({}, { NIRVANA_GAUNTLET_EVALUATOR: "squad:ghost" });
    expect(check).toBeDefined();
    expect(check!.status).toBe("WARN");
    expect(check!.note).toContain("squad 'ghost', which is not in the installed registry");
  }, 60_000);
});
