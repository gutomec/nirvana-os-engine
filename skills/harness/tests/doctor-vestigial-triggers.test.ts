// doctor-vestigial-triggers.test.ts — the dead invocation surface, counted.
//
// `triggers:` and `trigger_threshold:` name a command and how many must match
// before a workflow fires. No version of the protocol ever defined them (v4
// does not, v5 mentions them zero times, v6 mentions them once — the line that
// preserves them in `extensions`) and no code reads them. Measured on the
// installed library on 2026-08-27: 302 of 629 workflows in 101 squads.
//
// Two things these cases hold in place. First, the count comes from the
// normalizer, not from a grep for a top-level key: 24 of those 302 files are
// already on v6 and carry the key INSIDE `extensions:`, where a column-0 grep
// misses it. Second, the check reports and stops — it is WARN, it names the
// keys as decorative, and it says out loud that nothing deletes them, because
// the next agent to read the line is the one who would write that fixer.
//
// Runs with: bun test skills/harness/tests
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const DOCTOR = join(REPO, "skills", "harness", "scripts", "doctor-system.ts");
const ROOTS: string[] = [];
afterAll(() => { for (const r of ROOTS) try { removeDir(r); } catch { /* best effort */ } });

/** A library of squads, each `[slug, { workflowFile: contents }]`. */
function library(squads: Array<[string, Record<string, string>]>): string {
  const home = makeTempRoot("nrv-doctor-triggers-");
  ROOTS.push(home);
  for (const [slug, workflows] of squads) {
    mkdirSync(join(home, "squads", slug, "workflows"), { recursive: true });
    writeFileSync(join(home, "squads", slug, "squad.yaml"),
      `name: ${slug}\nversion: 1.0.0\nprotocol: "5.0"\ndescription: fixture\n`, "utf8");
    for (const [file, body] of Object.entries(workflows)) {
      writeFileSync(join(home, "squads", slug, "workflows", file), body, "utf8");
    }
  }
  return home;
}

function check(home: string): { status: string; note: string } {
  const r = spawnSync(process.execPath, [DOCTOR, "--json"], {
    cwd: home, encoding: "utf8",
    env: {
      ...process.env, HOME: home, NIRVANA_HOME: home,
      NIRVANA_SKILLS_DIR: join(REPO, "skills"), CLAUDE_SKILLS_DIR: join(REPO, "skills"),
      NIRVANA_SCOPE: "global", NIRVANA_SCOPE_QUIET: "1", NIRVANA_NO_UPDATE_CHECK: "1",
    } as Record<string, string>,
  });
  const checks: Array<{ name: string; status: string; note: string }> = JSON.parse(r.stdout).checks;
  const found = checks.find((c) => c.name === "routing: vestigial triggers");
  expect(found).toBeDefined();
  return { status: found!.status, note: found!.note };
}

/** v5 dialect: the keys sit at the top level of the YAML document. */
const V5_WITH_BOTH = [
  "workflow_name: alpha",
  "agent_sequence:",
  "  - planner",
  "triggers:",
  "  commands:",
  '    - "*alpha"',
  "trigger_threshold: 1",
  "",
].join("\n");

/** v6 Markdown: already migrated, the key preserved inside `extensions`. A
 *  grep for `^trigger_threshold:` never sees this one. */
const V6_IN_EXTENSIONS = [
  "---",
  "name: beta",
  "steps:",
  "  - id: plan",
  "    agent: planner",
  "extensions:",
  "  key_commands:",
  '    - "*beta"',
  "  trigger_threshold: 2",
  "---",
  "",
  "## plan",
  "",
  "Read the brief first.",
  "",
].join("\n");

const CLEAN = "name: gamma\nsteps:\n  - id: plan\n    agent: planner\n";

describe("the doctor counts the invocation keys nothing reads", () => {
  test("a library that declares them is WARN, with the spread and the two facts about them", () => {
    const out = check(library([
      ["one", { "alpha.yaml": V5_WITH_BOTH, "gamma.yaml": CLEAN }],
      ["two", { "beta.md": V6_IN_EXTENSIONS }],
    ]));
    expect(out.status).toBe("WARN");
    // Three workflows read, two of them carrying a key, across two squads.
    expect(out.note).toContain("2 of 3 workflow(s) in 2 squad(s)");
    expect(out.note).toContain("1× `triggers`");
    expect(out.note).toContain("2× `trigger_threshold`");
    // Decorative, and nothing deletes it. Both halves are the point of the cut.
    expect(out.note).toContain("no code reads them");
    expect(out.note).toContain("no fixer removes them");
  }, spawnBudgetMs(1));

  test("the v6 form counts too: the key inside `extensions` is the same dead surface", () => {
    const grepBlind = check(library([["only-v6", { "beta.md": V6_IN_EXTENSIONS }]]));
    expect(grepBlind.status).toBe("WARN");
    expect(grepBlind.note).toContain("1 of 1 workflow(s) in 1 squad(s)");
    expect(grepBlind.note).toContain("1× `trigger_threshold`");
    expect(grepBlind.note).not.toContain("`triggers`");
  }, spawnBudgetMs(1));

  test("a library without them passes and says how much it read", () => {
    const out = check(library([["clean", { "gamma.yaml": CLEAN }]]));
    expect(out.status).toBe("PASS");
    expect(out.note).toContain("1 workflow(s) read");
  }, spawnBudgetMs(1));

  // CI reads a doctor exit >= 2 as "this machine is broken". A workflow key the
  // author wrote and the engine ignores is not that, under any count.
  test("it is never a FAIL — the keys are authored text, not a broken machine", () => {
    for (const home of [library([["one", { "alpha.yaml": V5_WITH_BOTH }]]), library([["clean", { "gamma.yaml": CLEAN }]])]) {
      expect(check(home).status).not.toBe("FAIL");
    }
  }, spawnBudgetMs(2));
});
