// bot-cli.test.ts — `nrv bot` as an agent runs it, on a machine where no
// OpenBot agent is open to local scripts and Hermes has no Bot: every answer
// says what to do next. Then with one Hermes Bot in the roster.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fakeHomeEnv } from "./helpers/fake-home.ts";
import { removeDir } from "./helpers/temp-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const SKILLS = path.resolve(import.meta.dir, "..", "..");
const BOT = path.join(SKILLS, "harness", "scripts", "bot.ts");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-bot-cli-")));
const home = path.join(root, "home");
fs.mkdirSync(path.join(home, ".nirvana"), { recursive: true });
afterAll(() => removeDir(root));

function run(args: string[]): { code: number; out: string; err: string } {
  const env = fakeHomeEnv(home, {
    NIRVANA_HOME: home, NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_SCOPE_QUIET: "1",
    NIRVANA_OPENBOT_DIR: path.join(root, "OpenBot"), NIRVANA_OPENBOT_DB: path.join(root, "openbot.db"),
    NIRVANA_OPENBOT_AUTOMATION_DIR: path.join(root, "automation"),
    NIRVANA_HERMES_HOME: path.join(root, "hermes"), NIRVANA_HERMES_BIN: path.join(root, "no-hermes"),
  }) as Record<string, string>;
  const r = spawnSync(process.execPath, [BOT, ...args], { cwd: root, env, encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

describe("nrv bot with nobody to call", () => {
  test("list says nobody can be called and how the person opens an agent", () => {
    const r = run(["list"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("No OpenBot agent and no Hermes Bot can be called");
    expect(r.out).toContain("Local scripts");
    expect(JSON.parse(run(["list", "--json"]).out)).toEqual({ ok: true, reachable: false, agents: [], hermes: { installed: false, bots: [] } });
  }, spawnBudgetMs(2));

  test("ask fails with the same pointer, and bad arguments name the usage", () => {
    const r = run(["ask", "Image Studio", "a hero image"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Local scripts");
    expect(run(["ask", "Image Studio"]).code).toBe(4);
    expect(run(["ask", "x", "y", "--timeout", "soon"]).code).toBe(4);
    expect(run(["status", "nope"]).code).toBe(1);
    expect(run(["list", "--host", "elsewhere"]).code).toBe(4);
  }, spawnBudgetMs(5));

  test("a Hermes Bot in the roster is listed, and a call without the hermes command says so", () => {
    const dir = path.join(root, "hermes", "profiles", "artist");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "profile.yaml"), 'description: Makes images\nui_meta:\n  hermes-bots:\n    title: "Image Studio"\n');
    const list = run(["list"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain('"Image Studio" (artist): Makes images');
    expect(list.out).toContain("the hermes command is not on PATH");
    const ask = run(["ask", "Image Studio", "a hero image", "--out", path.join(root, "out")]);
    expect(ask.code).toBe(1);
    expect(ask.err).toContain("the hermes command is not installed");
  }, spawnBudgetMs(2));
});
