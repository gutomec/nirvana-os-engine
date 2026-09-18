// run-plumbing.test.ts — instrumentation is never a deliverable, and there is
// one list that says so.
//
// Measured on a customer VPS (2026-09-18): `GET /v1/jobs/<trace>/artifacts/
// relatorio-final.html` returned 81 KB containing no line of the delivered work
// and every line of the run's instrumentation — the employee's system prompt,
// the mind-clone library, the business manifest and the firm's permanent
// memory. That is the IP of a pack sold for US$ 1,290, downloadable by anyone
// holding a session key.
//
// Two causes, both path bugs, and one aggravator:
//   · `nrv serve` wrote deliverables to the legacy `.nirvana/outputs/<run>`
//     while every other layer computes the canonical `outputs/<run>`;
//   · the scripted autopilot pointed the report renderer at the PROJECT dir
//     instead of the run, so it indexed the contract files and the prompt;
//   · three consumers each kept a private exclusion list, and the two that
//     faced the client were the short ones.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRunPlumbing, isRunPlumbingDir, RUN_PLUMBING } from "../lib/run-plumbing.ts";

const ROOT = path.join(import.meta.dir, "..", "..", "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("what counts as plumbing", () => {
  test("the prompt that carries the persona, the library and the memory", () => {
    expect(isRunPlumbing("agent-prompt.md")).toBe(true);
    expect(isRunPlumbing("/tmp/outputs/run_1/agent-prompt.md")).toBe(true);
  });

  test("the brief, the handoff, the ledger and the envelope fields", () => {
    for (const f of ["brief.md", ".brief.md", "HANDOFF.json", ".run.json", "audit.jsonl", "_SUMMARY.md", "_QA-RESERVATIONS.md"]) {
      expect(isRunPlumbing(f)).toBe(true);
    }
  });

  test("the project's own contract, which describes the engine and not the work", () => {
    for (const f of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) expect(isRunPlumbing(f)).toBe(true);
  });

  test("and real work is not", () => {
    for (const f of ["checklist-fechamento-mensal-consolidado.md", "relatorio-final.html", "logo.png", "README.md"]) {
      expect(isRunPlumbing(f)).toBe(false);
    }
  });

  test("run-state directories are excluded whole", () => {
    expect(isRunPlumbingDir(".nirvana")).toBe(true);
    expect(isRunPlumbingDir("node_modules")).toBe(true);
    expect(isRunPlumbingDir("squads")).toBe(false);
  });
});

describe("one list, every consumer", () => {
  // A private copy is how the leak got in. These assert the copies are gone.
  test.each([
    ["skills/harness/lib/serve/artifacts.ts", "the API's artifact listing"],
    ["skills/harness/scripts/build-report-html.ts", "the client report renderer"],
    ["skills/businesses/scripts/verify-deliverable.ts", "the deliverable verifier"],
  ])("%s reads the shared list", (file) => {
    const src = read(file);
    expect(src).toContain("run-plumbing.ts");
    // No local re-declaration of the same idea.
    expect(src).not.toMatch(/const (SKIP|SKIP_FILES|RUN_PLUMBING)\s*=\s*new Set/);
  });

  test("the API would have served the prompt before this, and does not now", () => {
    const src = read("skills/harness/lib/serve/artifacts.ts");
    expect(src).toContain("isRunPlumbing(e.name)");
    expect(RUN_PLUMBING.has("agent-prompt.md")).toBe(true);
  });
});

describe("one outputs root", () => {
  test("serve writes where the rest of the engine computes, not the legacy path", () => {
    const src = read("skills/harness/lib/serve/server.ts");
    expect(src).toContain("runOutputsRoot(session.dir, traceId)");
    expect(src).not.toContain('path.join(session.dir, ".nirvana", "outputs", traceId)');
  });

  test("the helper returns the canonical shape, and a base when no run is named", () => {
    const { runOutputsRoot } = require("../../harness/lib/serve/runs.ts");
    expect(runOutputsRoot("/s", "run_1")).toBe(path.join("/s", "outputs", "run_1"));
    expect(runOutputsRoot("/s", "")).toBe(path.join("/s", "outputs"));
  });

  test("readers still accept the legacy root, so an upgraded server finds yesterday's runs", () => {
    for (const f of ["skills/harness/lib/serve/runs.ts", "skills/harness/lib/serve/webhook-outbox.ts"]) {
      const src = read(f);
      expect(src).toContain("runOutputsRoot");
      expect(src).toContain(".nirvana");
    }
  });
});

describe("the report is asked for, never assumed", () => {
  test("dispatch builds it only with --html", () => {
    const src = read("skills/harness/scripts/dispatch.ts");
    expect(src).toContain('const wantHtml = process.argv.includes("--html")');
    expect(src).toContain("const skipHtml = !wantHtml;");
  });

  test("and when asked, it renders the run rather than the project", () => {
    const src = read("skills/harness/lib/business-post-gate.ts");
    expect(src).toContain('"--project", input.outputsRoot');
    expect(src).not.toContain('"--project", input.projectDir');
  });

  test("the protocol says on request, not by default", () => {
    const skill = read("skills/harness/SKILL.md");
    expect(skill).toContain("Phase 8 — HTML report (ON REQUEST ONLY)");
    expect(skill).not.toContain("HTML report (DEFAULT");
  });
});

describe("the two dispatch rules the owner set", () => {
  test.each(["AGENTS.md", "CLAUDE.md", "GEMINI.md", path.join("skills", "_shared", "templates", "AGENTS.md")])(
    "%s states them",
    (file) => {
      const src = read(file);
      expect(src).toContain("Never dispatch in `fast` mode");
      expect(src).toContain("Never set a spend ceiling the user did not ask for");
    },
  );
});
