// doctor-antigravity-hooks.test.ts — the doctor looks where agy reads hooks.
//
// agy reads named hooks from ~/.gemini/config/hooks.json; Nirvana's is
// `nirvana-os`, a PreInvocation that injects the session context. The hooks
// used to be written to ~/.antigravity/settings.json, which agy never reads,
// and nothing reported it. The doctor now checks the new file and names any
// entry of ours left in the old one.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "./helpers/temp-dirs.ts";

const DOCTOR = join(import.meta.dir, "..", "scripts", "doctor-system.ts");
const ROOTS: string[] = [];
afterAll(() => { for (const r of ROOTS) removeDir(r); });

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "nrv-doctor-agy-"));
  ROOTS.push(root);
  mkdirSync(join(root, ".gemini", "config"), { recursive: true });
  return root;
}

function agyChecks(root: string): Array<{ name: string; status: string; note: string }> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: root, USERPROFILE: root, NIRVANA_HOME: root };
  const r = spawnSync(process.execPath, [DOCTOR, "--json"], { cwd: root, env, encoding: "utf8", windowsHide: true });
  return JSON.parse(r.stdout).checks.filter((c: any) => c.name.startsWith("antigravity:"));
}

const OURS = { "nirvana-os": { PreInvocation: [{ type: "command", command: 'bun "/x/gemini-session-start.ts" --agy', timeout: 10 }] } };

describe("doctor: Antigravity context hook", () => {
  test("wired in ~/.gemini/config/hooks.json: PASS, with the file named", () => {
    const root = home();
    writeFileSync(join(root, ".gemini", "config", "hooks.json"), JSON.stringify(OURS));
    const checks = agyChecks(root);
    const hook = checks.find((c) => c.name === "antigravity: context hook")!;
    expect(hook.status).toBe("PASS");
    expect(hook.note).toContain("hooks.json");
    expect(checks.some((c) => c.name === "antigravity: old hook location")).toBe(false);
  }, 30_000);

  test("missing from hooks.json, ours left in ~/.antigravity/settings.json: both are WARN and name nrv setup", () => {
    const root = home();
    mkdirSync(join(root, ".antigravity"), { recursive: true });
    writeFileSync(join(root, ".antigravity", "settings.json"), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: 'bun "/x/gemini-session-start.ts"' }] }] },
    }));
    const checks = agyChecks(root);
    const hook = checks.find((c) => c.name === "antigravity: context hook")!;
    const old = checks.find((c) => c.name === "antigravity: old hook location")!;
    expect(hook.status).toBe("WARN");
    expect(hook.note).toContain("nrv setup");
    expect(old.status).toBe("WARN");
    expect(old.note).toContain(".antigravity");
    expect(old.note).toContain("nrv setup");
  }, 30_000);
});
