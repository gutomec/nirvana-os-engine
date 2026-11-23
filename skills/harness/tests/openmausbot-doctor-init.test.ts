// openmausbot-doctor-init.test.ts — the two places a person meets the
// OpenMausBot integration without running anything for it: `nrv doctor`
// prepares the bots and says so, and `nrv init` refuses a bot's private
// folder. Both run the real scripts as child processes against a temporary
// HOME and a temporary OpenMausBot data folder.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fakeHomeEnv } from "./helpers/fake-home.ts";
import { removeDir } from "./helpers/temp-dirs.ts";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const SKILLS = path.join(ROOT, "skills");
const DOCTOR = path.join(SKILLS, "harness", "scripts", "doctor-system.ts");
const INIT = path.join(SKILLS, "_shared", "scripts", "init-project.ts");

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-omb-doctor-")));
const home = path.join(root, "home");
fs.mkdirSync(path.join(home, ".nirvana"), { recursive: true });
afterAll(() => removeDir(root));

function childEnv(data: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === "NIRVANA_PROJECT_ROOT" || k === "OMB_DATA_DIR") continue;
    env[k] = v;
  }
  Object.assign(env, fakeHomeEnv(home, { NIRVANA_HOME: home, NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_SCOPE_QUIET: "1", NIRVANA_OPENMAUSBOT_DIR: data, NIRVANA_ORCA_HOST: "off" }) as Record<string, string>);
  return { ...env, ...extra };
}

function makeData(name: string, bots: unknown[] | null): string {
  const data = path.join(root, name);
  fs.mkdirSync(data, { recursive: true });
  if (bots) fs.writeFileSync(path.join(data, "bots.json"), JSON.stringify(bots));
  return data;
}

function doctorLine(data: string): { status: string; note: string } | undefined {
  const work = path.join(root, "work-" + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(path.join(work, ".nirvana"), { recursive: true });
  const r = spawnSync(process.execPath, [DOCTOR, "--json"], { encoding: "utf8", env: childEnv(data, { NIRVANA_PROJECT_ROOT: work }), cwd: work, timeout: 90_000 });
  const parsed = JSON.parse(r.stdout || "{}") as { checks?: Array<{ name: string; status: string; note: string }> };
  return (parsed.checks ?? []).find((c) => c.name === "openmausbot: bots");
}

describe("nrv doctor", () => {
  test("prepares each bot and says so; the next run reports it in use", () => {
    const data = makeData("two", [
      { id: "b1", name: "Atlas", modelSelection: { instanceId: "claude" } },
      { id: "b2", name: "Quiet", modelSelection: { instanceId: "codex" }, memoryEnabled: false },
    ]);
    const first = doctorLine(data);
    expect(first?.status).toBe("PASS");
    expect(first!.note).toContain("Atlas (claude): prepared now");
    expect(first!.note).toContain("Quiet (codex): not prepared (its owner switched its memory off)");
    expect(fs.readFileSync(path.join(data, "workspaces", "b1", "MEMORY.md"), "utf8")).toContain("memory/nirvana-os.md");
    expect(fs.existsSync(path.join(data, "workspaces", "b2"))).toBe(false);
    expect(doctorLine(data)!.note).toContain("Atlas (claude): uses Nirvana-OS");
  }, 240_000);

  test("without OpenMausBot there is no line at all", () => {
    expect(doctorLine(makeData("absent", null))).toBeUndefined();
  }, 120_000);
});

describe("nrv init", () => {
  test("a bot's private folder is not a project: refused, nothing written there", () => {
    const data = makeData("init", [{ id: "b1", name: "Atlas" }]);
    const thread = path.join(data, "task-workspaces", "b1", "thread-1");
    fs.mkdirSync(thread, { recursive: true });
    const r = spawnSync(process.execPath, [INIT, "."], { cwd: thread, encoding: "utf8", env: childEnv(data), timeout: 120_000 });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("private folder of the OpenMausBot bot 'Atlas'");
    expect(fs.readdirSync(thread)).toEqual([]);
  }, 150_000);
});
