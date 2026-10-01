// install-teaches-init.test.ts — the last screen of the install must teach
// `nrv init`, and say what it does.
//
// `nrv init` writes a short note (AGENTS.md / CLAUDE.md / GEMINI.md): the AI CLI
// keeps working as usual and uses Nirvana when a request names it, asks for a
// business, a squad or a mind-clone, or asks for another runtime.
// `--orchestrators=always` makes Nirvana the orchestrator of every artifact.
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
    expect(summaryBlock()).toMatch(/Start a project with nrv init/);
  });

  test("shows both shapes: a new dir and an existing one", () => {
    const s = summaryBlock();
    expect(s).toMatch(/nrv init ~\/my-project/);
    expect(s).toMatch(/nrv init \./);
  });

  test("says the AI CLI keeps working as usual, when it uses Nirvana, and how to make Nirvana the orchestrator", () => {
    const s = summaryBlock();
    expect(s).toMatch(/keeps working as usual/);
    expect(s).toMatch(/businesses, squads or mind-clones/);
    expect(s).toMatch(/another runtime/);
    expect(s).toMatch(/--orchestrators=always/);
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
