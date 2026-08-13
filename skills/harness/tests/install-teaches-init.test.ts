// install-teaches-init.test.ts — the last screen of the install must teach the
// one step that decides whether the product works as sold.
//
// `nrv init` writes the agent contract (AGENTS.md / CLAUDE.md / GEMINI.md) that
// tells a runtime to orchestrate. Without it the skill must self-activate by
// description match, and when it does not the brief is answered inline: no
// dispatch, no gate, no audit. Users who skip init get a worse product and no
// error telling them why.
//
// The pack installer used to end with "open any AI CLI and just talk to it",
// which taught the inline path to the buyer on their very first run.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const engineInstall = fs.readFileSync(path.join(ROOT, "scripts/install.ts"), "utf8");

/** Only the completion message, so a mention elsewhere in the file cannot pass this. */
function summaryBlock(): string {
  const start = engineInstall.indexOf("function summary(): void {");
  const end = engineInstall.indexOf("async function main()");
  expect(start).toBeGreaterThan(-1);
  return engineInstall.slice(start, end);
}

describe("the engine installer's last screen", () => {
  test("leads with nrv init, not with a command list", () => {
    expect(summaryBlock()).toMatch(/Start every project with nrv init/);
  });

  test("shows both shapes: a new dir and an existing one", () => {
    const s = summaryBlock();
    expect(s).toMatch(/nrv init ~\/my-project/);
    expect(s).toMatch(/nrv init \./);
  });

  test("states the consequence of skipping it, concretely", () => {
    const s = summaryBlock();
    expect(s).toMatch(/inline/i);
    expect(s).toMatch(/no dispatch/i);
    expect(s).toMatch(/no quality gate/i);
    expect(s).toMatch(/no audit trail/i);
  });

  test("names all three contract files — no runtime is privileged", () => {
    const s = summaryBlock();
    for (const f of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) expect(s).toContain(f);
  });

  test("does not advertise the cockpit while it is unfinished", () => {
    // A first screen should not point at the weakest surface.
    expect(summaryBlock()).not.toMatch(/nrv glance/);
  });

  test("no installer prints nrv glance to the user", () => {
    // Scoped to what the user SEES: the engine installer's summary and the
    // hooks installer's closing line. A comment explaining the absence is fine.
    const hooks = fs.readFileSync(path.join(ROOT, "skills/_shared/scripts/install.ts"), "utf8");
    const printed = hooks.split("\n").filter((l) => l.includes("console.log") && l.includes("nrv glance"));
    expect(printed).toEqual([]);
    expect(summaryBlock()).not.toMatch(/console\.log\(.*nrv glance/);
  });

  test("still tells the user how to verify the install", () => {
    const s = summaryBlock();
    expect(s).toMatch(/nrv install --check/);
    expect(s).toMatch(/nrv validate/);
  });
});
