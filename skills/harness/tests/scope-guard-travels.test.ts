// scope-guard-travels.test.ts — the scope guard reaches the two executor
// surfaces no other prompt test renders, and the gate that watches all of them
// is green on this tree.
//
// The solo business prompt is what a business worker executes. The
// autonomous directive rides every headless run as the system prompt, so the
// guard there reaches even the paths that replay a stored prompt (the
// supervisor's re-dispatch, the report publisher).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { prepareBusinessSolo } from "../lib/business-solo.ts";
import { AUTONOMOUS_DIRECTIVE } from "../lib/host-agent-driver.ts";
import { SCOPE_GUARD_EN } from "../../_shared/lib/scope-guard.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");

describe("the solo business prompt", () => {
  test("carries the guard in English, at the end", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-guard-solo-"));
    try {
      fs.mkdirSync(path.join(root, "biz", "employees"), { recursive: true });
      fs.writeFileSync(path.join(root, "biz", "employees", "copywriter.md"), "---\nname: copywriter\n---\n");
      const { prompt } = prepareBusinessSolo({
        slug: "biz", bizDir: path.join(root, "biz"), brief: "Uma landing page para a clínica.", projectId: "p", projectDir: path.join(root, "run"),
        projectRoot: root, outputsRoot: path.join(root, "run", "out"), runtime: "claude-code", cloneLookup: () => null, memoryDirs: [],
      });
      expect(prompt).toContain("Deliverables follow the language of the request.");
      expect(prompt.trim().endsWith(SCOPE_GUARD_EN)).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
      "solo business prompt", "squad prompt", "agent-x prompt", "judge-x prompt", "DISPATCH-INSTRUCTION.md", "revision brief",
      "autonomous directive", "nrv revise", "fix prompt", "squad brief file", "Glance child", "agent-x persona", "judge-x persona",
      "DISPATCH-INSTRUCTION template", "SKILL.md", "04-multi-target.md",
    ]) expect(r.stdout).toContain(surface);
  }, spawnBudgetMs(2));
});
