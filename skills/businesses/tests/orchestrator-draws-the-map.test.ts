// orchestrator-draws-the-map.test.ts — the orchestrator decides; the business
// executes.
//
// A seat used to be handed two catalogs and told to choose: the whole mind-clone
// library with "the choice is yours", and every installed squad with "pick the
// best one for the sub-task". That put the decision that matters — WHO actually
// does the work — at the shallowest point in the system. The seat chose from a
// `squad.yaml` line and a BM25 ranking, while the orchestrator upstream had
// already read agents, tasks, workflows and DNA to get there. Two deciders, and
// the deeper one was not the one deciding.
//
// Now the orchestrator draws the whole map — which seats, which clone each
// embodies, which squad each instructs — and hands it over as data:
//
//   squad: "<slug>"  → the seat AUTHORS THE INSTRUCTION for it, as itself in its
//                      clone's voice, and does not execute and does not shop
//   squad: null      → a decision: that seat delivers the work directly
//   both keys absent → no map was drawn; the seat falls back to choosing, which
//                      is the degraded path kept for back-compat
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEmployeePrompt } from "../lib/employee-prompt.ts";

// A project-scoped root: `resolveScope` walks up for a `.env`, and under
// NIRVANA_SCOPE=project the businesses resolve from `<root>/.nirvana/businesses/`
// rather than from whatever the machine happens to have in ~/businesses.
const ROOT = mkdtempSync(join(tmpdir(), "nrv-map-"));
mkdirSync(join(ROOT, ".nirvana", "businesses"), { recursive: true });
writeFileSync(join(ROOT, ".env"), "NIRVANA_SCOPE=project\n", "utf8");
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* the OS reclaims tmp */ } });

function business(slug: string): void {
  const dir = join(ROOT, ".nirvana", "businesses", slug);
  mkdirSync(join(dir, "employees"), { recursive: true });
  writeFileSync(join(dir, "business.yaml"), `name: ${slug}\ndescription: uma editora de fixture\n`, "utf8");
  writeFileSync(join(dir, "employees", "editor-chefe.md"), "# Editor-chefe\n\nResponde pela qualidade editorial.\n", "utf8");
}

let seq = 0;
function prompt(assignment?: { mind_clone?: string | null; squad?: string | null }): string {
  const slug = `fixture-editora-${seq++}`;
  business(slug);
  return buildEmployeePrompt({
    business_slug: slug,
    employee: "editor-chefe",
    project_dir: ROOT,
    brief: "Publique o título completo com capa e interior.",
    task: "Definir o padrão editorial do título.",
    trace_id: "test",
    ...(assignment ? { assignment } : {}),
  } as Parameters<typeof buildEmployeePrompt>[0]);
}

describe("a squad was assigned", () => {
  const p = prompt({ mind_clone: "akira-master", squad: "ebook-maestro-nirvana" });

  test("the seat's deliverable is the INSTRUCTION, not the artifact", () => {
    expect(p).toContain("write the instruction for");
    expect(p).toContain("ebook-maestro-nirvana");
    expect(p).toContain("Your deliverable for this step is the INSTRUCTION, not the artifact.");
  });

  test("it writes that instruction as itself, in its clone's voice", () => {
    expect(p).toContain("in the voice of your clone");
  });

  test("it may not swap the squad, and a wrong tool is a plan change", () => {
    expect(p).toContain("Do not pick a different squad");
    expect(p).toContain("plan change for the orchestrator");
  });

  test("the catalog is gone — there is nothing to shop from", () => {
    expect(p).not.toContain("AVAILABLE SQUADS");
    expect(p).not.toContain("Pick the best one for the sub-task");
    expect(p).not.toContain("Open authorization");
  });
});

describe("no squad was assigned", () => {
  const p = prompt({ mind_clone: "akira-master", squad: null });

  test("the seat does the work itself, and is told that was a decision", () => {
    expect(p).toContain("you do this work");
    expect(p).toContain("That is a decision, not an oversight");
  });

  test("and it must not go shopping for one anyway", () => {
    expect(p).toContain("Do not go looking for a squad");
    expect(p).not.toContain("AVAILABLE SQUADS");
  });
});

describe("the assigned clone", () => {
  const p = prompt({ mind_clone: "akira-master", squad: null });

  test("is named, and is not presented as a shortlist", () => {
    expect(p).toContain("MIND-CLONE YOU EMBODY — assigned:");
    expect(p).toContain("akira-master");
    expect(p).toContain("there is nothing to pick");
  });

  test("the library-of-choice block is gone", () => {
    expect(p).not.toContain("MIND-CLONE LIBRARY (choose agentically)");
    expect(p).not.toContain("the choice is yours");
  });

  test("a missing persona is reported, never silently swapped", () => {
    expect(p).toContain("never substitute a different clone");
  });
});

describe("no map drawn (the degraded path, kept for back-compat)", () => {
  const p = prompt();

  test("the seat still gets the catalogs it used to get", () => {
    expect(p).toContain("AVAILABLE SQUADS");
  });
});
