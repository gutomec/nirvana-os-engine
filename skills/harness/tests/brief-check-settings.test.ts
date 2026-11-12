// brief-check-settings.test.ts — `nrv brief check` refuses what the run's
// settings forbid. A test run's brief made "evidence of visual review"
// blocking while execution.visual_checks was off: the worker could not produce
// it and the gate failed it for five correction rounds. Another brief said the
// setting was on, and a worker drove the user's app on their screen.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const BRIEF = path.resolve(import.meta.dir, "..", "scripts", "brief.ts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-brief-settings-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

function brief(doneWhen: string[], decisions = "- None."): string {
  return [
    "## Request (verbatim)", "Build the menubar app.", "",
    "## Decisions", decisions, "",
    "## Your part", "The whole app.", "",
    "## Inputs", "- None.", "",
    "## Done when", ...doneWhen.map((d) => `- ${d}`), "",
    "## Output", "The Xcode project.", "",
  ].join("\n");
}

function check(text: string, visualChecks: "0" | "1") {
  const file = path.join(TMP, `brief-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(file, text);
  return spawnSync(process.execPath, [BRIEF, "check", file], {
    cwd: TMP, encoding: "utf8", env: { ...process.env, NIRVANA_VISUAL_CHECKS: visualChecks },
  });
}

describe("nrv brief check against the settings", () => {
  test("visual evidence is refused while visual checks are off", () => {
    const r = check(brief(["The app builds and runs. (blocking)", "Há evidência de revisão visual e de uso. (blocking)"]), "0");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("asks for visual evidence, but execution.visual_checks is off");
  });

  test("with visual checks on, the same criterion is fine", () => {
    expect(check(brief(["Há evidência de revisão visual e de uso. (blocking)"]), "1").status).toBe(0);
  });

  test("a brief cannot claim a setting is on", () => {
    const r = check(brief(["The app builds and runs. (blocking)"], "- A configuração execution.visual_checks foi habilitada neste projeto."), "0");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("a brief does not change settings");
  });

  test("an ordinary brief that only wants a beautiful interface passes", () => {
    expect(check(brief(["The interface is visually polished and the central flows work. (blocking)"]), "0").status).toBe(0);
  });
});
