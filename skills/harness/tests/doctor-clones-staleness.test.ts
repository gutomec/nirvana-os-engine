// doctor-clones-staleness.test.ts — routing-360 Phase 2.5.
//
// doctor-system.ts used to check only the squads + businesses registries for
// staleness; the mind-clones registry could sit stale for days unnoticed.
// These tests spawn the doctor with a temp HOME (no project root, so the
// clones registry resolves to $HOME/.nirvana/.mind-clones-registry.json —
// same resolution as _shared/scripts/index-clones.ts) and assert the new
// `registry: mind-clones` check reacts to missing / stale / fresh registries.
//
// Runs with: bun test skills/harness/tests
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const DOCTOR = path.join(import.meta.dir, "..", "scripts", "doctor-system.ts");
const REPO_SKILLS = path.join(import.meta.dir, "..", "..");

interface DoctorCheck { name: string; status: string; note: string }

function runDoctor(prepare: (home: string) => void): DoctorCheck | undefined {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-doctor-home-"));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-doctor-work-"));
  try {
    prepare(home);
    const env = { ...process.env } as Record<string, string>;
    delete env.NIRVANA_PROJECT_ROOT;
    delete env.BUSINESSES_REGISTRY_PATH;
    delete env.SQUADS_REGISTRY_PATH;
    env.HOME = home;
    env.NIRVANA_HOME = home;
    env.NIRVANA_SKILLS_DIR = REPO_SKILLS;
    env.NIRVANA_SCOPE_QUIET = "1";
    const r = spawnSync(process.execPath, [DOCTOR, "--json"], { encoding: "utf8", env, cwd: work, timeout: 60_000 });
    const parsed = JSON.parse(r.stdout || "{}");
    return (parsed.checks || []).find((c: DoctorCheck) => c.name === "registry: mind-clones");
  } finally {
    for (const d of [home, work]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

function writeClonesRegistry(home: string, ageHours: number): void {
  const dir = path.join(home, ".nirvana");
  fs.mkdirSync(dir, { recursive: true });
  const reg = path.join(dir, ".mind-clones-registry.json");
  fs.writeFileSync(reg, JSON.stringify({ schema_version: "1.0", mind_clones: {} }));
  const t = new Date(Date.now() - ageHours * 3600_000);
  fs.utimesSync(reg, t, t);
}

describe("doctor — mind-clones registry staleness (routing-360 Phase 2.5)", () => {
  test("missing clones registry is a FAIL", () => {
    const check = runDoctor(() => { /* nothing on disk */ });
    expect(check).toBeDefined();
    expect(check!.status).toBe("FAIL");
    expect(check!.note).toContain("nrv index");
  }, 60_000);

  test("registry older than 24h is a WARN pointing at `nrv index`", () => {
    const check = runDoctor((home) => writeClonesRegistry(home, 48));
    expect(check).toBeDefined();
    expect(check!.status).toBe("WARN");
    expect(check!.note).toContain("stale");
    expect(check!.note).toContain("nrv index");
  }, 60_000);

  test("fresh registry is a PASS", () => {
    const check = runDoctor((home) => writeClonesRegistry(home, 1));
    expect(check).toBeDefined();
    expect(check!.status).toBe("PASS");
  }, 60_000);
});
