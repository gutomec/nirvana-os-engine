// employee-prompt-frontmatter.test.ts — a YAML list means the same thing in
// both of its spellings, and a pinned clone is channeled.
//
// The seat prompt read its frontmatter lists with a regex that accepted only
// the `- item` block form. `squads_authorized: [brandcraft]` parsed as empty
// while the "declared" test saw the key, so the seat was told the opposite of
// what its author wrote: "WITHOUT dispatching squads". And `pinned_mind_clones`
// was read by the validator and by nothing at runtime, so a typed mind_clone
// seat ran without its voice. Both are exercised here through the CLI, in the
// fixture's own project scope, like employee-clone-choice.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnBudgetMs } from "../../harness/tests/helpers/test-budgets.ts";

const R = mkdtempSync(join(tmpdir(), "seat-fm-"));
afterAll(() => rmSync(R, { recursive: true, force: true }));

writeFileSync(join(R, ".env"), "NIRVANA_SCOPE=project\n", "utf8");
const biz = join(R, ".nirvana", "businesses", "atelier");
mkdirSync(join(biz, "employees"), { recursive: true });
writeFileSync(join(biz, "business.yaml"), "name: atelier\ndescription: a fixture atelier\n", "utf8");

const seat = (name: string, frontmatter: string) =>
  writeFileSync(join(biz, "employees", `${name}.md`), `---\n${frontmatter}\n---\n# ${name}\n\nDoes the ${name} work.\n`, "utf8");
seat("inline-closed", "squads_authorized: [brandcraft]");
seat("inline-empty", "squads_authorized: []");
seat("block-closed", "squads_authorized:\n  - brandcraft");
seat("open", "role: anything");
seat("pinned", "type: mind_clone\npinned_mind_clones: [fixture-voice]");
seat("inline-missing", "squads_authorized: [ghost-squad]");

// A project-scoped squad catalog: without one the block is skipped entirely.
for (const slug of ["brandcraft", "ledgerworks"]) {
  const d = join(R, ".nirvana", "squads", slug);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "squad.yaml"), `name: ${slug}\nversion: 1.0.0\ndescription: fixture squad ${slug}\ndomains:\n  - ${slug === "brandcraft" ? "branding" : "finance"}\ncapabilities:\n  - id: ${slug}.work.execute\n    domains: [${slug === "brandcraft" ? "branding" : "finance"}]\n    invoke: task\n`, "utf8");
}

const agentDir = join(R, "dna", "fixture-voice", "agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "AGENT.md"), "# fixture-voice\n\nMethod of the fixture voice.\n", "utf8");
writeFileSync(join(R, ".nirvana", ".mind-clones-registry.json"), JSON.stringify({
  mind_clones: {
    "fixture-voice": {
      slug: "fixture-voice", display_name: "Fixture Voice", tags: [], dir: join(R, "dna", "fixture-voice"),
      persona_files: { agent: join(agentDir, "AGENT.md") },
      match: { one_liner: "the fixture voice", domains: [], serves: "fixture", when_to_use: null, not_for: null, delegates_to: [], refuses: [] },
    },
  },
}), "utf8");
const briefFile = join(R, "brief.txt");
writeFileSync(briefFile, "monte o relatório trimestral", "utf8");

function prompt(employee: string): string {
  const r = spawnSync(process.execPath, [join(import.meta.dir, "..", "lib", "employee-prompt.ts"), "atelier", employee, R, briefFile],
    { cwd: R, encoding: "utf8", env: { ...process.env, HARNESS_LOGS_DIR: join(R, ".nirvana", "logs", "harness") } });
  return `${r.stdout ?? ""}`;
}

describe("squads_authorized means the same in both spellings", () => {
  test("an inline closed set is a closed set", () => {
    const p = prompt("inline-closed");
    expect(p).toContain("YOUR authorized squads (CLOSED set");
    expect(p).toContain("**brandcraft**");
    expect(p).not.toContain("declared EMPTY");
  }, spawnBudgetMs(1));

  test("the block form reads exactly the same", () => {
    const p = prompt("block-closed");
    expect(p).toContain("YOUR authorized squads (CLOSED set");
    expect(p).toContain("**brandcraft**");
  }, spawnBudgetMs(1));

  test("a closed set the scope cannot serve is still a closed set, named as missing", () => {
    // Filtering the declared slugs by the catalog turned an uninstalled closed
    // set into "declared EMPTY": the instruction not to dispatch at all.
    const p = prompt("inline-missing");
    expect(p).toContain("YOUR authorized squads (CLOSED set");
    expect(p).toContain("**ghost-squad** — (not in the catalog of this scope");
    expect(p).not.toContain("declared EMPTY");
  }, spawnBudgetMs(1));

  test("an inline empty list is declared-empty, and an absent key is open", () => {
    expect(prompt("inline-empty")).toContain("declared EMPTY");
    expect(prompt("open")).toContain("Open authorization");
  }, spawnBudgetMs(2));
});

describe("a pinned clone is the seat's identity", () => {
  test("it is channeled before any search, and the decision says so", () => {
    const p = prompt("pinned");
    expect(p).toContain("--- MIND-CLONE: fixture-voice");
    expect(p).toContain("(pinned;");
    expect(p).toContain("decision: PINNED to the seat");
  }, spawnBudgetMs(1));
});
