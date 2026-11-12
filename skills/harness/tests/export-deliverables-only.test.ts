// export-deliverables-only.test.ts — what the client is handed as "the complete
// final product".
//
// `--zip` is the most dangerous surface of the three that face a client, because
// it is a bundle they keep. It carried a FOURTH private copy of the exclusion
// list — `audit.jsonl`, `HANDOFF.json` and two dotfiles — which let
// `agent-prompt.md` through: the employee's system prompt, the mind-clone
// library and the firm's permanent memory.
//
// Worse, `--deliverables-only` fell back to exporting the WHOLE PROJECT whenever
// it could not isolate exactly one `deliverables/` folder. A run served over the
// API has no such folder — its artifacts sit flat in the run root — so the
// normal case took the fallback and shipped the scaffold.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT = path.join(import.meta.dir, "..", "scripts", "export.ts");
// A project of its own: export looks in <cwd>/outputs/<id> first, so the runs
// below never touch the owner's ~/.nirvana/outputs.
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-export-cwd-"));
const OUTPUTS = path.join(CWD, "outputs");
const made: string[] = [];

afterEach(() => { for (const p of made.splice(0)) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } } });
afterAll(() => { try { fs.rmSync(CWD, { recursive: true, force: true }); } catch { /* best effort */ } });

/** A run whose shape matches what the engine actually writes. */
function project(id: string, files: Record<string, string>): string {
  const root = path.join(OUTPUTS, id);
  fs.rmSync(root, { recursive: true, force: true });
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  made.push(root);
  return root;
}

const PROMPT = "PROTOCOL COMPLIANCE\nYOUR PERSONA\nMIND-CLONE LIBRARY\nMEMÓRIA DESTA ENTIDADE\n";

function zipOf(id: string, extra: string[] = []): { names: string[]; body: string } {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-zip-")), `${id}.zip`);
  made.push(path.dirname(out));
  const r = spawnSync(process.execPath, [SCRIPT, id, "--format=zip", "--deliverables-only", `--output=${out}`, ...extra], { encoding: "utf8", cwd: CWD });
  expect(r.status, r.stderr).toBe(0);
  const names = spawnSync("unzip", ["-Z1", out], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  const body = spawnSync("unzip", ["-p", out], { encoding: "utf8" }).stdout;
  return { names, body };
}

describe("the run shape the API produces: artifacts flat, no deliverables folder", () => {
  const id = "nrv-test-flat-run";
  const files = {
    "checklist-fechamento.md": "o trabalho real",
    "plano-fiscal.md": "segunda entrega",
    "agent-prompt.md": PROMPT,
    "brief.md": "o pedido",
    "CLAUDE.md": "o contrato do projeto",
    "AGENTS.md": "o contrato do projeto",
    "_SUMMARY.md": "promovido para campo do envelope",
    "HANDOFF.json": "{}",
    "session.json": "{}",
    "_CLAIMS.json": "[]",
    "_STATUS.json": "{}",
    "solo-prompt.md": PROMPT,
    "participation.json": "{}",
    "_work/rascunho.md": "o rascunho do próprio worker",
    "_review/answer-0.txt": "o parecer do revisor",
  };

  test("ships the work and nothing else", () => {
    project(id, files);
    const { names } = zipOf(id);
    expect(names.map((n) => path.basename(n)).sort()).toEqual(["checklist-fechamento.md", "plano-fiscal.md"]);
  });

  test("the employee prompt never leaves, which is the whole point", () => {
    project(id, files);
    const { body } = zipOf(id);
    expect(body).not.toContain("MIND-CLONE LIBRARY");
    expect(body).not.toContain("MEMÓRIA DESTA ENTIDADE");
    expect(body).toContain("o trabalho real");
  });

  test.each(["agent-prompt.md", "brief.md", "CLAUDE.md", "AGENTS.md", "_SUMMARY.md", "HANDOFF.json", "session.json",
    "_CLAIMS.json", "_STATUS.json", "solo-prompt.md", "participation.json", "answer-0.txt"])(
    "%s is plumbing and stays behind",
    (name) => {
      project(id, files);
      expect(zipOf(id).names.map((n) => path.basename(n))).not.toContain(name);
    },
  );

  test("the worker's scratch folder stays behind too", () => {
    project(id, files);
    expect(zipOf(id).names.join(" ")).not.toContain("rascunho");
  });
});

describe("the org chart's own shape", () => {
  test("one business: the deliverables folder is the product, rooted at itself", () => {
    const id = "nrv-test-one-biz";
    project(id, {
      "businesses/acme/deliverables/relatorio.md": "a entrega",
      "businesses/acme/deliverables/_SUMMARY.md": "o resumo do worker",
      "businesses/acme/cards/copy.md": "o card de um squad",
      "businesses/acme/solo-prompt.md": PROMPT,
      "agent-prompt.md": PROMPT,
      "brief.md": "o pedido",
    });
    const { names, body } = zipOf(id);
    expect(names).toEqual(["deliverables/relatorio.md"]);
    expect(body).not.toContain("MIND-CLONE LIBRARY");
  });

  test("several businesses: every one of them ships, and the scaffold still does not", () => {
    const id = "nrv-test-multi-biz";
    project(id, {
      "businesses/acme/deliverables/relatorio.md": "entrega da acme",
      "businesses/beta/deliverables/parecer.md": "entrega da beta",
      "agent-prompt.md": PROMPT,
      "CLAUDE.md": "contrato",
    });
    const { names, body } = zipOf(id);
    const base = names.map((n) => path.basename(n));
    expect(base).toContain("relatorio.md");
    expect(base).toContain("parecer.md");
    expect(base).not.toContain("agent-prompt.md");
    expect(base).not.toContain("CLAUDE.md");
    expect(body).not.toContain("MIND-CLONE LIBRARY");
  });
});

describe("--include-audit is a deliberate choice, not a hole", () => {
  test("it returns the audit trail and still never the prompt", () => {
    const id = "nrv-test-audit";
    project(id, { "entrega.md": "o trabalho", "audit.jsonl": '{"event":"gate_passed"}', "agent-prompt.md": PROMPT });
    const { names, body } = zipOf(id, ["--include-audit"]);
    const base = names.map((n) => path.basename(n));
    expect(base).toContain("audit.jsonl");
    expect(base).not.toContain("agent-prompt.md");
    expect(body).not.toContain("MIND-CLONE LIBRARY");
  });
});

describe("the tarball ships exactly what the zip ships", () => {
  test("--format=tgz: the same member list, run state left behind", () => {
    const id = "nrv-test-tgz";
    project(id, { "relatorio.md": "o trabalho", "brief.md": "o pedido", "_SUMMARY.md": "resumo", "_work/rascunho.md": "rascunho", "site/index.html": "<p>ok</p>" });
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-tgz-")), `${id}.tgz`);
    made.push(path.dirname(out));
    const r = spawnSync(process.execPath, [SCRIPT, id, "--format=tgz", `--output=${out}`], { encoding: "utf8", cwd: CWD });
    expect(r.status, r.stderr).toBe(0);
    const names = spawnSync("tar", ["-tzf", out], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort();
    expect(names).toEqual([`${id}/relatorio.md`, `${id}/site/index.html`]);
  });
});
