// scope-guard-travels.test.ts — the scope guard reaches the two executor
// surfaces no other prompt test renders, and the gate that watches all of them
// is green on this tree.
//
// Team mode used to build the step brief inline in runStep, so nothing could
// look at it without running a chain; buildStepBrief is the extraction. The
// autonomous directive rides every headless run as the system prompt, so the
// guard there reaches even the paths that replay a stored prompt (the
// supervisor's re-dispatch, the report publisher).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { buildStepBrief } from "../lib/team-orchestrator.ts";
import { AUTONOMOUS_DIRECTIVE } from "../lib/host-agent-driver.ts";
import { SCOPE_GUARD_EN, SCOPE_GUARD_PT_BR } from "../../_shared/lib/scope-guard.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");

describe("the team step brief", () => {
  const args = { brief: "Uma landing page para a clínica.", outputsRoot: "/out/final" };

  test("a middle step writes to its own dir, lists the colleagues and carries the guard in PT-BR", () => {
    const text = buildStepBrief({ employee: "copywriter", task: "Escreva o copy." }, 1, 3, args,
      [{ employee: "strategist", dir: "/out/final/_team/strategist" }], "/out/final/_team/copywriter");
    expect(text).toContain("# Tarefa para copywriter — step 2 de 3");
    expect(text).toContain("Escreva o copy.");
    expect(text).toContain("- **strategist** → /out/final/_team/strategist");
    expect(text).toContain("sob: `/out/final/_team/copywriter`");
    expect(text).toContain(SCOPE_GUARD_PT_BR);
    expect(text).not.toContain(SCOPE_GUARD_EN);
  });

  test("the last step synthesizes into the outputs root and still carries it", () => {
    const text = buildStepBrief({ employee: "ceo", task: "Consolide." }, 2, 3, args, [], "/out/final");
    expect(text).toContain("ENTREGÁVEIS FINAIS como arquivos sob: `/out/final`");
    expect(text).not.toContain("## Outputs dos colegas");
    expect(text.trim().endsWith(SCOPE_GUARD_PT_BR)).toBe(true);
  });
});

describe("the autonomous directive", () => {
  test("carries the guard in English, inside the autonomous-mode rules", () => {
    const rules = AUTONOMOUS_DIRECTIVE.slice(AUTONOMOUS_DIRECTIVE.indexOf("AUTONOMOUS MODE"));
    expect(rules).toContain(`- ${SCOPE_GUARD_EN}`);
  });
});

describe("the gate", () => {
  test("check-scope-guard --strict passes on this tree and names every surface", () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "check-scope-guard.ts"), "--strict"], { encoding: "utf8", cwd: ROOT });
    expect(r.stdout).toContain("0 missing");
    expect(r.status).toBe(0);
    for (const surface of [
      "employee prompt", "team step brief", "squad prompt", "agent-x prompt", "judge-x prompt", "DISPATCH-INSTRUCTION.md", "revision brief",
      "autonomous directive", "nrv revise", "fix prompt", "squad brief file", "Glance child", "agent-x persona", "judge-x persona",
      "DISPATCH-INSTRUCTION template", "SKILL.md", "04-multi-target.md",
    ]) expect(r.stdout).toContain(surface);
  }, spawnBudgetMs(2));
});
