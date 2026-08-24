// behavioral-rules-travel.test.ts — the four build rules reach every runtime.
//
// They lived only in the project contract, which `nrv init` writes as AGENTS.md
// + CLAUDE.md + GEMINI.md. Two independent failure modes: most projects never
// run `nrv init`, and the file a runtime reads differs across the eight adapters
// (AGENTS.md for antigravity/codex/grok/kimi/pi, CLAUDE.md for claude-code,
// GEMINI.md for gemini-cli). Anything that depends on a project file is
// therefore unreliable twice over.
//
// So the rules travel with what is always present: the dispatch instruction for
// the entity that builds, the skill itself for the orchestrator.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AUTONOMOUS_DIRECTIVE } from "../lib/host-agent-driver.ts";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const tpl = fs.readFileSync(path.join(ROOT, "skills/harness/templates/DISPATCH-INSTRUCTION.template.md"), "utf8");
const skill = fs.readFileSync(path.join(ROOT, "skills/harness/SKILL.md"), "utf8");
const projectContract = fs.readFileSync(path.join(ROOT, "skills/_shared/templates/AGENTS.md"), "utf8");
const ADAPTERS = path.join(ROOT, "skills/_shared/adapters");

describe("the builder's rules ride the dispatch", () => {
  test("all four are present", () => {
    for (const rule of [/Think before building/i, /Minimum that solves it/i, /Surgical changes/i, /Verifiable done/i]) {
      expect(tpl).toMatch(rule);
    }
  });

  test("the anti-patterns are named concretely, not gestured at", () => {
    expect(tpl).toMatch(/do not refactor what is not broken/i);
    expect(tpl).toMatch(/abstraction for\s+single-use code/i);
    expect(tpl).toMatch(/Remove\s+orphans YOUR change created/i);
  });

  test("it says why it is carried rather than assumed", () => {
    expect(tpl).toMatch(/nrv init/);
    expect(tpl).toMatch(/the file each runtime reads differs/i);
  });
});

describe("the orchestrator's version rides the skill", () => {
  test("all four are restated for dispatching", () => {
    for (const rule of [/Think before dispatching/i, /Minimum viable dispatch/i, /Surgical scope/i, /Gate-driven execution/i]) {
      expect(skill).toMatch(rule);
    }
  });

  test("it protects the shared libraries from dispatch side effects", () => {
    expect(skill).toMatch(/Never mutate `~\/squads`/);
  });
});

describe("no runtime is left out", () => {
  test("every adapter's contract file is one nrv init writes", () => {
    // If an adapter ever declares a file `nrv init` does not create, a project
    // on that runtime would silently get no contract at all.
    const init = fs.readFileSync(path.join(ROOT, "skills/_shared/scripts/init-project.ts"), "utf8");
    const written = new Set((init.match(/"(AGENTS|CLAUDE|GEMINI|QWEN)\.md"/g) || []).map((s) => s.replace(/"/g, "")));
    const missing: string[] = [];
    for (const f of fs.readdirSync(ADAPTERS)) {
      if (!f.endsWith(".md") || f === "README.md") continue;
      const text = fs.readFileSync(path.join(ADAPTERS, f), "utf8");
      for (const decl of new Set(text.match(/\b(AGENTS|CLAUDE|GEMINI|QWEN)\.md\b/g) || [])) {
        if (!written.has(decl)) missing.push(`${f} → ${decl}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("the rules do not depend on any project file to reach the builder", () => {
    // The template is written per dispatch by the orchestrator; it exists
    // regardless of whether the project was ever initialised.
    expect(tpl).toMatch(/travel with the dispatch instead of with the directory/i);
  });
});

describe("structural proposals start with capability evidence", () => {
  const consumingPaths = [
    ["initialized project contract", projectContract],
    ["multi-target dispatch", tpl],
    ["orchestrator skill", skill],
    ["headless worker directive", AUTONOMOUS_DIRECTIVE],
  ] as const;

  test.each(consumingPaths)("%s carries the same diagnostic outcomes", (_name, prompt) => {
    expect(prompt).toMatch(/existing\s+and\s+usable/i);
    expect(prompt).toMatch(/existing\s+but\s+misconfigured/i);
    expect(prompt).toMatch(/genuinely\s+missing/i);
  });

  test.each(consumingPaths)("%s requires evidence and the narrowest sufficient layer", (_name, prompt) => {
    expect(prompt).toMatch(/evidence/i);
    expect(prompt).toMatch(/narrowest sufficient layer/i);
    expect(prompt).toMatch(/broad external research/i);
  });
});
