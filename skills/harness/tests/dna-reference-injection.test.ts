// dna-reference-injection.test.ts — the default DNA mode reaches squads and direct dispatches.
//
// `execution.dna_injection` defaults to "reference": a card naming the persona
// files, which the executor opens when it needs the method. employee-prompt
// honored it; squad-exec and dispatch typed the setting as "full" | "fragments"
// and sent everything that was not "fragments" down the full-persona branch, so
// the default pasted whole personas into every squad prompt.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const R = mkdtempSync(join(tmpdir(), "dna-ref-"));
afterAll(() => rmSync(R, { recursive: true, force: true }));

writeFileSync(join(R, ".env"), "NIRVANA_SCOPE=project\n", "utf8");
mkdirSync(join(R, ".nirvana"), { recursive: true });
const agentDir = join(R, "dna", "fixture-voice", "agent");
mkdirSync(agentDir, { recursive: true });
const AGENT = join(agentDir, "AGENT.md");
const METHOD = "Method line of the fixture voice.";
writeFileSync(AGENT, `# fixture-voice\n\n${Array.from({ length: 1200 }, (_, i) => `${METHOD} ${i}`).join("\n")}\n`, "utf8");
writeFileSync(join(R, ".nirvana", ".mind-clones-registry.json"), JSON.stringify({
  mind_clones: {
    "fixture-voice": {
      slug: "fixture-voice", display_name: "Fixture Voice", tags: [], dir: join(R, "dna", "fixture-voice"),
      persona_files: { agent: AGENT },
      match: { one_liner: "the fixture voice", domains: ["fixture"], serves: "fixture", when_to_use: null, not_for: null, delegates_to: [], refuses: [] },
    },
  },
}), "utf8");

const SCRIPT = `
const { squadCloneInjection } = await import(${JSON.stringify(join(import.meta.dir, "..", "lib", "squad-exec.ts"))});
const { injectMindClones } = await import(${JSON.stringify(join(import.meta.dir, "..", "lib", "dispatch.ts"))});
const squad = squadCloneInjection("write it in the voice of fixture-voice", process.cwd());
const direct = injectMindClones({ trace_id: "t-dna-ref", slugs: ["fixture-voice"] });
console.log(JSON.stringify({ squad: squad.block, grants: squad.personaDirs ?? [], direct: direct.combined_prompt, format: direct.injections[0]?.format ?? null }));
`;

function run(mode: string | undefined): { squad: string; grants: string[]; direct: string; format: string | null } {
  const env: Record<string, string> = { ...process.env as Record<string, string>, NIRVANA_STATE_DB: join(R, "state.db"), HARNESS_LOGS_DIR: join(R, "logs") };
  if (mode) env.NIRVANA_DNA_INJECTION = mode; else delete env.NIRVANA_DNA_INJECTION;
  const r = spawnSync(process.execPath, ["-e", SCRIPT], { cwd: R, env, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

describe("execution.dna_injection reaches squad-exec and dispatch", () => {
  test("the default is a card: the persona path, never the persona", () => {
    const { squad, grants, direct, format } = run(undefined);
    for (const block of [squad, direct]) {
      expect(block).toContain(AGENT);
      expect(block).not.toContain(`${METHOD} 500`);
      expect(Buffer.byteLength(block)).toBeLessThan(2_000);
    }
    expect(format).toBe("reference");
    // The card names files the squad opens on demand, so their folder is granted to the run.
    expect(grants).toContain(join(R, "dna", "fixture-voice"));
  }, spawnBudgetMs(1));

  // Squad path only: under "full" a direct dispatch reads the persona through the
  // legacy loader (getMindClone), which reads the installed library, not this fixture.
  test("full still pastes the whole persona when the owner asks for it", () => {
    const { squad } = run("full");
    expect(squad).toContain(`${METHOD} 500`);
  }, spawnBudgetMs(1));
});
