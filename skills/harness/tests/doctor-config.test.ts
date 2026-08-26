// doctor-config.test.ts — `nrv doctor` shows the effective value and origin of
// every operational setting, one line per key, by the same resolution every
// reader uses, and fails on a config file the resolver refuses. Spawns the
// doctor with a temporary HOME and project. Runs with: bun test skills/harness/tests
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SETTINGS_SCHEMA } from "../../_shared/lib/settings.ts";
import { removeDir } from "./helpers/temp-dirs.ts";

const DOCTOR = path.join(import.meta.dir, "..", "scripts", "doctor-system.ts");
const REPO_SKILLS = path.join(import.meta.dir, "..", "..");
const SCHEMA_VARIABLES = new Set(SETTINGS_SCHEMA.flatMap((spec) => [spec.env, ...(spec.envAliases ?? [])]).filter((name): name is string => !!name));

interface DoctorCheck { name: string; status: string; note: string }

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeDir(root); });

function runDoctor(setup: { home: string; work: string }, extraEnv: Record<string, string> = {}): DoctorCheck[] {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || SCHEMA_VARIABLES.has(key) || key === "NIRVANA_PROJECT_ROOT" || key === "HARNESS_LOGS_DIR") continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: setup.home, USERPROFILE: setup.home, NIRVANA_HOME: setup.home, NIRVANA_PROJECT_ROOT: setup.work,
    NIRVANA_SKILLS_DIR: REPO_SKILLS, NIRVANA_SCOPE_QUIET: "1", NIRVANA_SKIP_PATH_PERSIST: "1",
  }, extraEnv);
  const r = spawnSync(process.execPath, [DOCTOR, "--json"], { encoding: "utf8", env, cwd: setup.work, timeout: 60_000 });
  const parsed = JSON.parse(r.stdout || "{}") as { checks?: DoctorCheck[] };
  return parsed.checks ?? [];
}

function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-doctor-config-")));
  roots.push(home);
  const work = path.join(home, "work");
  fs.mkdirSync(path.join(work, ".nirvana"), { recursive: true });
  fs.mkdirSync(path.join(home, ".nirvana"), { recursive: true });
  return { home, work, globalFile: path.join(home, ".nirvana", "config.yaml"), projectFile: path.join(work, ".nirvana", "config.yaml") };
}

describe("doctor — config", () => {
  test("one line per key with the effective value and its origin: variable, project file, global file, default", () => {
    const setup = fixture();
    fs.writeFileSync(setup.globalFile, "quality_gate:\n  max_revisions: 4\nrouting:\n  mode: fast\n", "utf8");
    fs.writeFileSync(setup.projectFile, "routing:\n  mode: agentic\n", "utf8");
    const checks = runDoctor(setup, { NIRVANA_DNA_INJECTION: "fragments" });
    const config = checks.filter((check) => check.name.startsWith("config: "));
    expect(config.map((check) => check.name)).toEqual(["config: files", ...SETTINGS_SCHEMA.map((spec) => `config: ${spec.key}`)]);
    expect(config.every((check) => check.status === "PASS")).toBe(true);
    const byKey = Object.fromEntries(config.map((check) => [check.name.slice("config: ".length), check.note]));
    expect(byKey.files).toContain("project ~/work/.nirvana/config.yaml");
    expect(byKey.files).toContain("global ~/.nirvana/config.yaml");
    expect(byKey.files).toMatch(/engine .*config\.yaml/);
    expect(byKey["routing.mode"]).toBe('"agentic" (project ~/work/.nirvana/config.yaml)');
    expect(byKey["quality_gate.max_revisions"]).toBe("4 (global ~/.nirvana/config.yaml)");
    expect(byKey["execution.dna_injection"]).toBe('"fragments" (env NIRVANA_DNA_INJECTION=fragments)');
    expect(byKey["multi_target.enabled"]).toBe("true (default)");
    expect(byKey["budget.on_budget_exceeded"]).toMatch(/^"warn" \(engine .*config\.yaml\)$/);
  }, 60_000);

  test("a config file the resolver refuses is a FAIL naming the file, not a silent default", () => {
    const setup = fixture();
    fs.writeFileSync(setup.globalFile, "routing:\n  mode: turbo\n", "utf8");
    const checks = runDoctor(setup);
    const files = checks.find((check) => check.name === "config: files");
    expect(files?.status).toBe("FAIL");
    expect(files?.note).toContain(`${setup.globalFile}: routing.mode: valor inválido "turbo"`);
    expect(checks.some((check) => check.name === "config: routing.mode")).toBe(false);
  }, 60_000);
});
