// install-profile.test.ts — the installer records the performance profile in
// the global config: --profile sets it, a run with no terminal and no flag
// records none, and an invalid name is refused. Real installs into a fake HOME.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fakeHomeEnv } from "./helpers/fake-home.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const roots: string[] = [];
afterAll(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

function install(...flags: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-install-profile-"));
  roots.push(root);
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const env = fakeHomeEnv(home, { NIRVANA_SCOPE: "global" });
  for (const k of ["NIRVANA_PROFILE", "NIRVANA_PROJECT_ROOT"]) delete env[k];
  const r = spawnSync(process.execPath, [path.join(REPO, "scripts", "install.ts"), "--no-starter", "--no-hermes", "--no-index", ...flags],
    { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const cfg = path.join(home, ".nirvana", "config.yaml");
  return { r, out: `${r.stdout}${r.stderr}`, config: fs.existsSync(cfg) ? fs.readFileSync(cfg, "utf8") : "" };
}

describe("the performance profile at install", () => {
  test("--profile=economy is recorded in the global config", () => {
    const { r, out, config } = install("--profile=economy");
    expect(r.status, out).toBe(0);
    expect(out).toContain("performance profile: economy");
    expect(config).toMatch(/profile:\s*"economy"/);
  }, spawnBudgetMs(6));

  test("no terminal and no flag records none", () => {
    const { r, out, config } = install();
    expect(r.status, out).toBe(0);
    expect(config).not.toMatch(/profile:/);
  }, spawnBudgetMs(6));

  test("an unknown profile is refused, and nothing is recorded", () => {
    const { r, out, config } = install("--profile=turbo");
    expect(r.status).toBe(1);
    expect(out).toContain("--profile must be one of max, balanced, economy");
    expect(config).not.toMatch(/profile:/);
  }, spawnBudgetMs(6));
});
