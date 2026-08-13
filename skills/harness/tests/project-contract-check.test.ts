// project-contract-check.test.ts — the doctor names an uninitialised project.
//
// `nrv init` writes AGENTS.md + CLAUDE.md + GEMINI.md so every adapter finds
// one; whichever the runtime reads carries the instruction to invoke Nirvana
// "regardless of skill activation". A project with none of them still
// orchestrates once the skill is active — the skill carries the protocol, the
// dispatch instruction carries the build and writing rules — but nothing tells
// the runtime to reach for the skill at all. That degradation was invisible.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { PROJECT_CONTRACT_FILES } from "../../_shared/lib/runtime-dirs.ts";

const DOCTOR = path.resolve(import.meta.dir, "..", "scripts", "doctor-system.ts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-contract-"));

function doctorIn(dir: string): string {
  const r = spawnSync(process.execPath, [DOCTOR], { cwd: dir, encoding: "utf8" });
  return (r.stdout || "") + (r.stderr || "");
}

describe("the contract check", () => {
  test("warns when a project has none of the contract files", () => {
    const dir = path.join(TMP, "bare"); fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    const out = doctorIn(dir);
    // The doctor renders add("project: contract") as a PROJECT section with a
    // "contract" row, not as the literal key.
    expect(out).toMatch(/PROJECT/);
    expect(out).toMatch(/no AGENTS\.md \/ CLAUDE\.md \/ GEMINI\.md/);
    expect(out).toMatch(/nrv init \./);
  }, 20_000);

  test("each contract file alone is enough — no runtime is privileged", () => {
    // A gemini-cli project has GEMINI.md and no CLAUDE.md; it is initialised.
    for (const f of PROJECT_CONTRACT_FILES) {
      const dir = path.join(TMP, `only-${f}`);
      fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
      fs.writeFileSync(path.join(dir, f), "# contract\n");
      expect(doctorIn(dir)).toContain(`${f} present`);
    }
  }, 45_000);   // one full doctor run per contract file, ~3s each

  test("a non-project directory is not scolded", () => {
    const dir = path.join(TMP, "plain"); fs.mkdirSync(dir, { recursive: true });
    expect(doctorIn(dir)).toMatch(/not a project/);
  }, 20_000);
});
