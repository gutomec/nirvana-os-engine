// init-audit-hooks-guidance.test.ts — `nrv init` must point users at the
// command that actually installs or repairs audit hooks.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const NRV = path.join(ROOT, "skills/harness/scripts/nrv.ts");
const INIT = fs.readFileSync(path.join(ROOT, "skills/_shared/scripts/init-project.ts"), "utf8");

function runNrv(...args: string[]) {
  return spawnSync(process.execPath, [NRV, ...args], {
    encoding: "utf8",
    env: { ...process.env, NIRVANA_SKILLS_DIR: path.join(ROOT, "skills") },
  });
}

describe("audit hook setup guidance", () => {
  test("the post-init warning recommends nrv setup", () => {
    const warning = INIT.split("\n").find((line) => line.includes("Audit hooks are NOT yet wired")) ?? "";
    expect(warning).toContain("Run: nrv setup");
    expect(warning).not.toContain("Run: nrv install");
  });

  test("nrv setup routes to the hook installer and describes that command", () => {
    const result = runNrv("setup", "--help");
    expect(result.status).toBe(0);
    expect(`${result.stdout}`).toContain("nrv setup");
    expect(`${result.stdout}`).toMatch(/install \/ repair hooks across all agents/);
  });

  test("the main help lists setup as the audit-hook command", () => {
    const result = runNrv("help");
    expect(result.status).toBe(0);
    expect(`${result.stdout}`).toMatch(/setup\s+Install or repair audit hooks across supported agents/);
  });

  test("bare nrv install remains the asset installer", () => {
    const result = runNrv("install", "--help");
    expect(result.status).toBe(0);
    expect(`${result.stdout}`).toMatch(/install a business, squad, mind-clone, or pack/);
    expect(`${result.stdout}`).not.toMatch(/install \/ repair hooks across all agents/);
  });
});
