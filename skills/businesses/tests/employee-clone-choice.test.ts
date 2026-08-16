/**
 * What an employee is told when no mind-clone was auto-injected.
 *
 * The protocol's intent is that the agent CHOOSES: search ranks the library, the
 * employee reads the candidates and takes whichever help it think the task
 * through — or none, if none fits. The prompt said the opposite of that in three
 * places at once.
 *
 * The section header announced `DEFAULT — no useful clone, employee persona`.
 * The body said `(no useful clone for this task — operate as the employee's
 * default persona, without a clone)`. And then, three lines below, it listed the
 * candidates under the heading **Other** candidates.
 *
 * Measured against the real library: a compliance business asked about an LGPD
 * programme is shown `bruno-bioni` — Brazil's applied-LGPD reference — at 0.93,
 * directly beneath a sentence telling it no useful clone exists. "No useful
 * clone" is a verdict the system is not entitled to and contradicts on the next
 * line; an agent that believes it will never open the list.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEmployeePrompt } from "../lib/employee-prompt.ts";

/**
 * A project-scoped root, so the fixture businesses are the ones resolved rather
 * than whatever `~/businesses` happens to hold. `resolveScope` walks up for a
 * `.env` and reads NIRVANA_SCOPE; under "project" it looks in
 * `<root>/.nirvana/businesses/`.
 */
const ROOT = mkdtempSync(join(tmpdir(), "biz-"));
mkdirSync(join(ROOT, ".nirvana", "businesses"), { recursive: true });
writeFileSync(join(ROOT, ".env"), "NIRVANA_SCOPE=project\n", "utf8");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** A business with one employee and no declared clone — the state 43 of the
 *  library's 60 businesses are in, and the one the wording is about. */
function business(slug: string): string {
  const dir = join(ROOT, ".nirvana", "businesses", slug);
  mkdirSync(join(dir, "employees"), { recursive: true });
  writeFileSync(join(dir, "business.yaml"), `name: ${slug}\ndescription: a business\n`, "utf8");
  writeFileSync(join(dir, "employees", "analyst.md"), "# Analyst\n\nDoes the work.\n", "utf8");
  return dir;
}

function prompt(slug: string, brief: string): string {
  business(slug);
  return buildEmployeePrompt({
    business_slug: slug,
    employee: "analyst",
    project_dir: ROOT,
    brief,
    trace_id: "test",
  } as Parameters<typeof buildEmployeePrompt>[0]);
}

describe("choosing a clone is the agent's call, and the prompt says so", () => {
  const p = prompt("alpha-co", "montar o programa de compliance LGPD com matriz de risco");

  test("it never claims no useful clone exists", () => {
    // The system ranks; it does not get to conclude that nothing is useful.
    expect(p).not.toContain("no useful clone");
  });

  test("the decision line hands the choice over", () => {
    expect(p).toContain("YOURS — none auto-injected");
  });

  test("working without a clone is offered as an outcome, not a starting point", () => {
    expect(p).toContain("choosing is yours");
    expect(p).toContain("not the one you start from");
  });

  test("the system order ends in the agent, not in a default", () => {
    expect(p).toContain("else **you choose**");
  });
});

describe("the section still renders when the library is absent", () => {
  test("no candidates found is not an error", () => {
    // On CI there is no clone registry at all. The block must still explain the
    // choice rather than crash or fall silent.
    const p = prompt("beta-co", "uma tarefa qualquer sem correspondência");
    expect(p).toContain("MIND-CLONES YOU EMBODY");
    expect(p.length).toBeGreaterThan(0);
  });
});
