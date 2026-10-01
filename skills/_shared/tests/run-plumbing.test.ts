// run-plumbing.test.ts — instrumentation is never a deliverable, and there is
// one list that says so.
//
// Measured on a customer VPS (2026-09-18): `GET /v1/jobs/<trace>/artifacts/
// final-report.html` returned 81 KB containing no line of the delivered work
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
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { isRunPlumbing, isRunPlumbingDir, isRunStateFile, RUN_PLUMBING } from "../lib/run-plumbing.ts";

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
    for (const f of ["checklist-fechamento-mensal-consolidado.md", "final-report.html", "logo.png", "README.md"]) {
      expect(isRunPlumbing(f)).toBe(false);
    }
  });

  test("run-state directories are excluded whole", () => {
    expect(isRunPlumbingDir(".nirvana")).toBe(true);
    expect(isRunPlumbingDir("node_modules")).toBe(true);
    expect(isRunPlumbingDir("squads")).toBe(false);
  });
});

describe("what counts as run state (isRunStateFile)", () => {
  test("the run's own bookkeeping, matched by name wherever it lands", () => {
    for (const f of ["_SUMMARY.md", "_CLAIMS.json", "_QA-RESERVATIONS.md", "_STATUS.json", "solo-prompt.md", "agent-prompt.md",
      "participation.json", "session.json", "HANDOFF.json", "audit.jsonl", "sub/dir/_STATUS.json"]) {
      expect(isRunStateFile(f), f).toBe(true);
    }
  });

  test("everything under _work/ and _review/, at any depth, and the squad cards at the top of a run", () => {
    for (const f of ["_work/PROGRESS.md", "_review/answer-0.txt", "deliverables/_work/notes.md", "cards/copy.md", "businesses/acme/cards/copy.md"]) {
      expect(isRunStateFile(f), f).toBe(true);
    }
    // A directory, spelled with a trailing separator, prunes the whole folder.
    expect(isRunStateFile("_work/")).toBe(true);
    expect(isRunStateFile("deliverables/")).toBe(false);
  });

  test("and real work is not, a deliverable folder called cards included", () => {
    for (const f of ["relatorio.md", "final-report.html", "site/index.html", "carousel/cards/slide-1.png", "summary.md", "claims-analysis.json"]) {
      expect(isRunStateFile(f), f).toBe(false);
    }
  });

  test("a Windows path answers the same: either separator, and no case on win32", () => {
    expect(isRunStateFile("_work\\PROGRESS.md")).toBe(true);
    expect(isRunStateFile("deliverables\\_review\\prompt-0.md")).toBe(true);
    expect(isRunStateFile("businesses\\acme\\cards\\copy.md")).toBe(true);
    expect(isRunStateFile("site\\index.html")).toBe(false);
    expect(isRunStateFile("_Summary.md", "win32")).toBe(true);
    expect(isRunStateFile("_WORK\\notes.md", "win32")).toBe(true);
    expect(isRunStateFile("Session.JSON", "win32")).toBe(true);
    // POSIX file systems are case-sensitive: a different name is a different file.
    expect(isRunStateFile("_Summary.md", "linux")).toBe(false);
  });

  test("an absolute path from this OS is read the same way", () => {
    expect(isRunStateFile(path.join(os.tmpdir(), "out", "_CLAIMS.json"))).toBe(true);
    expect(isRunStateFile(path.join(os.tmpdir(), "out", "report.md"))).toBe(false);
  });
});

describe("one list, every consumer", () => {
  // A private copy is how the leak got in. These assert the copies are gone.
  test.each([
    ["skills/harness/lib/serve/artifacts.ts", "the API's artifact listing"],
    ["skills/harness/scripts/build-report-html.ts", "the client report renderer"],
    ["skills/harness/scripts/build-report-pdf.ts", "the client PDF renderer"],
    ["skills/harness/scripts/export.ts", "the zip a client keeps"],
    ["skills/harness/lib/delivery-pipeline.ts", "the delivery count and the gate surface"],
    ["skills/businesses/scripts/verify-deliverable.ts", "the deliverable verifier"],
  ])("%s reads the shared list", (file) => {
    const src = read(file);
    expect(src).toContain("run-plumbing.ts");
    expect(src).toContain("isRunStateFile");
    // No local re-declaration of the same idea.
    expect(src).not.toMatch(/const (SKIP|SKIP_FILES|RUN_PLUMBING)\s*=\s*new Set/);
  });

  test("the API lists the work and refuses run state even by direct path, Windows spelling included", () => {
    const { listArtifacts, resolveArtifact } = require("../../harness/lib/serve/artifacts.ts");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-artifacts-"));
    try {
      const put = (rel: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), "x"); };
      for (const rel of ["relatorio.md", "site/index.html", "_SUMMARY.md", "_CLAIMS.json", "_STATUS.json", "_work/PROGRESS.md", "_review/answer-0.txt", "solo-prompt.md"]) put(rel);
      expect(listArtifacts(root).map((a: { path: string }) => a.path)).toEqual(["relatorio.md", "site/index.html"]);
      expect(resolveArtifact(root, "relatorio.md")).not.toBeNull();
      for (const rel of ["_SUMMARY.md", "_STATUS.json", "_work/PROGRESS.md", "_work\\PROGRESS.md", "solo-prompt.md", "agent-prompt.md"]) {
        expect(resolveArtifact(root, rel), rel).toBeNull();
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test("the HTML report embeds the work, never the run's own state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-report-"));
    try {
      const put = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
      put("relatorio.md", "# Relatório\n\nO TRABALHO REAL.\n");
      put("_SUMMARY.md", "# Resumo\n\nRESUMO DO WORKER.\n");
      put("_QA-RESERVATIONS.md", "# Ressalvas\n\nRESSALVA DO GATE.\n");
      put("_work/PROGRESS.md", "# Progresso\n\nRASCUNHO DO WORKER.\n");
      put("solo-prompt.md", "# Prompt\n\nPERSONA E MEMÓRIA.\n");
      const out = path.join(root, "final-report.html");
      const r = spawnSync(process.execPath, [path.join(ROOT, "skills", "harness", "scripts", "build-report-html.ts"), "--project", root, "--output", out], { encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      const html = fs.readFileSync(out, "utf8");
      expect(html).toContain("O TRABALHO REAL.");
      for (const leak of ["RESUMO DO WORKER", "RESSALVA DO GATE", "RASCUNHO DO WORKER", "PERSONA E MEMÓRIA"]) expect(html).not.toContain(leak);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
    expect(skill).toMatch(/only when the user asked for a report/);
    expect(skill).toContain("none is built by default");
  });
});

describe("the dispatch rules the owner set", () => {
  test.each(["AGENTS.md", "CLAUDE.md", "GEMINI.md", path.join("skills", "_shared", "templates", "AGENTS.md")])(
    "%s states them",
    (file) => {
      const src = read(file);
      // The rule used to read "Never dispatch in `fast` mode". A prohibition
      // teaches the shortcut exists and then asks for restraint, which is
      // weaker than not naming it: the keyword router is no longer offered on
      // any surface an agent reads (see fast-is-not-advertised.test.ts). What
      // replaces it is the positive statement of how routing works.
      expect(src).toContain("Routing is agentic, and it is yours");
      expect(src).toContain("Never hand the decision to a score");
      expect(src).toContain("Never set a spend ceiling the user did not ask for");
    },
  );
});
