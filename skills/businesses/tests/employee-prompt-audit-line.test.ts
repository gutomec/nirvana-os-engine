// employee-prompt-audit-line.test.ts — the seat's audit file is JSONL: one
// event per physical line.
//
// On 2026-09-04 the emitter was wrapped with the provenance stamp and the
// separator became the two characters `\` `n`. Every `mind_clone_injected`
// since then landed on ONE line, which no line reader can parse — the event
// that proves a clone was injected was the one that vanished. No test read the
// file back, so nothing noticed. This one does.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnBudgetMs } from "../../harness/tests/helpers/test-budgets.ts";

describe("the seat audit is one event per line", () => {
  const R = mkdtempSync(join(tmpdir(), "audit-line-"));
  afterAll(() => rmSync(R, { recursive: true, force: true }));

  writeFileSync(join(R, ".env"), "NIRVANA_SCOPE=project\n", "utf8");
  const biz = join(R, ".nirvana", "businesses", "audit-co");
  mkdirSync(join(biz, "employees"), { recursive: true });
  writeFileSync(join(biz, "business.yaml"), "name: audit-co\ndescription: a fixture business\n", "utf8");
  writeFileSync(join(biz, "employees", "writer.md"), [
    "---",
    "assigned_mind_clones:",
    "  - fixture-voice",
    "---",
    "# Writer",
    "",
    "Writes the thing.",
    "",
  ].join("\n"), "utf8");

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
  writeFileSync(briefFile, "escreva o texto de abertura, na voz do fixture-voice", "utf8");

  // Pinned, not inherited: another test file setting HARNESS_LOGS_DIR would
  // send this audit somewhere the assertions are not looking.
  const logsRoot = join(R, ".nirvana", "logs", "harness");
  const r = spawnSync(process.execPath, [
    join(import.meta.dir, "..", "lib", "employee-prompt.ts"),
    "audit-co", "writer", R, briefFile,
  ], { cwd: R, encoding: "utf8", env: { ...process.env, HARNESS_LOGS_DIR: logsRoot } });

  test("the clone was injected, so there is something to audit", () => {
    expect(r.status).toBe(0);
    expect(`${r.stdout}`).toContain("--- MIND-CLONE: fixture-voice");
  }, spawnBudgetMs(1));

  test("every event sits on its own line and parses", () => {
    const today = new Date().toISOString().slice(0, 10);
    const file = join(logsRoot, today, "audit.jsonl");
    const raw = readFileSync(file, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const events = lines.map(l => JSON.parse(l));
    // As many physical lines as events: the literal `\n` separator glued them.
    expect(lines.length).toBe((raw.match(/"event":/g) ?? []).length);
    expect(events.some(e => e.event === "mind_clone_injected")).toBe(true);
    expect(raw).not.toContain("}\\n{");
  });
});
