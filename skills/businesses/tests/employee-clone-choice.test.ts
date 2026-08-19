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

/**
 * The seat does not outrank the task.
 *
 * Until 2026-08-18 the chain had a DESIGNADO step: `assigned_mind_clones` was
 * injected with NO fitness gate, before the task ranking ran. A film-director
 * seat bound to one director got that director for every task, while the
 * director the TASK needed appeared only as a suggestion below, with the
 * injection budget already spent.
 *
 * This fixture plants exactly that: a seat assigned to `steven-blockbuster`,
 * and a brief that is unmistakably `akira-master`'s. The ranking must win.
 * Deterministic — its own project scope, its own clone registry, its own
 * persona files; run as a subprocess so `resolveScope()` (cwd-based, used by
 * the clone registry path) sees the fixture root and never the machine's.
 */
import { spawnSync } from "node:child_process";

describe("the clone is chosen for the task, not for the seat", () => {
  const R = mkdtempSync(join(tmpdir(), "seat-"));
  afterAll(() => rmSync(R, { recursive: true, force: true }));

  // project scope
  writeFileSync(join(R, ".env"), "NIRVANA_SCOPE=project\n", "utf8");

  // the business, with a seat statically bound to the wrong director
  const biz = join(R, ".nirvana", "businesses", "studio-co");
  mkdirSync(join(biz, "employees"), { recursive: true });
  writeFileSync(join(biz, "business.yaml"), "name: studio-co\ndescription: a film studio\n", "utf8");
  writeFileSync(join(biz, "employees", "director.md"), [
    "---",
    "assigned_mind_clones:",
    "  - steven-blockbuster",
    "---",
    "# Film Director",
    "",
    "Directs the film.",
    "",
  ].join("\n"), "utf8");

  // two clones with personas on disk and routing blocks in the registry
  const clone = (slug: string, oneLiner: string, serves: string) => {
    const d = join(R, "dna", slug, "agent");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "AGENT.md"), `# ${slug}\n\nMethod of ${slug}.\n`, "utf8");
    return {
      slug, display_name: slug, tags: [], dir: join(R, "dna", slug),
      persona_files: { agent: join(d, "AGENT.md") },
      match: { one_liner: oneLiner, domains: [], serves, when_to_use: null, not_for: null, delegates_to: [], refuses: [] },
    };
  };
  mkdirSync(join(R, ".nirvana"), { recursive: true });
  writeFileSync(join(R, ".nirvana", ".mind-clones-registry.json"), JSON.stringify({
    mind_clones: {
      "steven-blockbuster": clone("steven-blockbuster",
        "the adventure blockbuster director",
        "wonder spectacle adventure family blockbuster suspense"),
      "akira-master": clone("akira-master",
        "the samurai epic director",
        "compor um épico de samurai na chuva com múltiplas câmeras e movimento de elenco"),
    },
  }), "utf8");

  const briefFile = join(R, "brief.txt");
  writeFileSync(briefFile, "compor um épico de samurai na chuva com múltiplas câmeras", "utf8");

  const r = spawnSync(process.execPath, [
    join(import.meta.dir, "..", "lib", "employee-prompt.ts"),
    "studio-co", "director", R, briefFile,
  ], { cwd: R, encoding: "utf8" });
  const out = `${r.stdout ?? ""}`;

  test("the task's director is injected", () => {
    expect(out).toContain("--- MIND-CLONE: akira-master");
    expect(out).toContain("found by SEARCH for the task");
  });

  test("the seat's static binding is not", () => {
    expect(out).not.toContain("--- MIND-CLONE: steven-blockbuster");
    expect(out).not.toContain("ASSIGNED to the employee");
  });

  test("the choice must be recorded", () => {
    expect(out).toContain("x_clone_choice");
  });
});

describe("with no clone channeled, the identity line stays honest", () => {
  test("it never claims to channel clones that are not there", () => {
    // In this fixture scope the registry is empty (beta-co's root), so nothing
    // injects — and the closing identity line must not reference "the
    // mind-clones above". Same defect class as d6098ec: the prompt
    // contradicting itself one section apart.
    const p = prompt("gamma-co", "uma tarefa sem correspondência nenhuma");
    if (!p.includes("--- MIND-CLONE:")) {
      expect(p).not.toContain("channeling the mind-clones above");
      expect(p).toContain("your persona above is your full operating identity");
    }
  });
});
