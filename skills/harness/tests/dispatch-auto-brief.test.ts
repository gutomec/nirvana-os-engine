// `nrv dispatch "<brief>"` never worked, and two skills taught it for months.
//
// dispatch.ts reads the first positional as the BUSINESS SLUG and the second
// as the brief (dispatch.ts:211-212), so a lone brief left `brief` empty and
// the command exited 4 with "pass an inline brief". The form that names no
// business is `--auto`, where the first positional IS the brief. The entry
// skill, the Hermes bridge and the project contract now say so; this pins it.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fakeHomeEnv } from "./helpers/fake-home.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const DISPATCH = path.join(REPO, "skills", "harness", "scripts", "dispatch.ts");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("the documented shell-only dispatch form is one that parses", () => {
  test("a lone positional is a slug, not a brief: exit 4", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-dispatch-"));
    const r = spawnSync(process.execPath, [DISPATCH, "write a one-page report"], {
      env: fakeHomeEnv(home, { NIRVANA_SCOPE: "global" }), encoding: "utf8", cwd: home, timeout: 30_000,
    });
    expect(r.status).toBe(4);
    expect(`${r.stdout}${r.stderr}`).toMatch(/pass an inline brief/);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("with --auto the first positional is the brief", () => {
    // Source-level: running --auto for real routes and dispatches. The parse
    // rule is one line and it is the whole point.
    const src = read("skills/harness/scripts/dispatch.ts");
    expect(src).toMatch(/const inlineBrief = \(autoMode \|\| explicitTarget\) \? positional\[0\] : positional\[1\];/);
  });

  test("without --exec the command only scaffolds; the scripted form must carry it", () => {
    // Measured 2026-09-16: `nrv dispatch --auto "<brief>" --runtime=grok-cli`
    // exited 0 having written brief.md, agent-prompt.md and HANDOFF.json, and
    // its last line read "(exit 3 — nothing dispatched, nothing judged;
    // delivery only with --exec)". A shell-only runtime has nobody to paste
    // the prompt into; --exec is the whole delivery.
    const src = read("skills/harness/scripts/dispatch.ts");
    expect(src).toMatch(/function wantsExec\(\)/);
    expect(src).toMatch(/delivery only with --exec/);
  });

  test("every place that teaches the shell-only form teaches --auto --exec", () => {
    for (const rel of [
      "skills/nirvana/SKILL.md",
      "skills/_shared/adapters/hermes/skills/nirvana/nirvana-os-hermes/SKILL.md",
      "skills/_shared/templates/AGENTS.md",
      "AGENTS.md",
      "AGENT-QUICKSTART.md",
    ]) {
      const text = read(rel);
      expect(text, rel).toMatch(/nrv dispatch --auto --exec "/);
      expect(text, rel).not.toMatch(/nrv dispatch --auto "/);
      expect(text, rel).not.toMatch(/nrv dispatch "</);
    }
  });
});
