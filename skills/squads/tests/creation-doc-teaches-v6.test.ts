/**
 * creation-doc-teaches-v6.test.ts — the creation doc and the validator agree.
 *
 * For three weeks references/02-creation.md taught protocol "5.0", workflow
 * YAML with `depends_on`, and refs carrying their extension — while the
 * admission gate rejected all three (measured 2026-09-02: a fresh v6 scaffold
 * plus the doc's own snippets came back REJECTED with `workflow_shape_legacy`
 * and unresolved refs). Whoever loaded only the doc wrote the wrong format,
 * and nothing failed until a human ran the gate.
 *
 * These cases close that class of drift: the doc's OWN example blocks are
 * extracted verbatim, assembled into a squad, and pushed through the same
 * verifyHook that init-squad.ts runs at creation. The doc can only teach what
 * the gate admits.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { verifyHook } from "../../_shared/lib/verify/index.ts";

const DOC = fs.readFileSync(path.join(import.meta.dir, "..", "references", "02-creation.md"), "utf8");
const WIZARD = fs.readFileSync(path.join(import.meta.dir, "..", "references", "15-creation-wizard.md"), "utf8");
const SKILL = fs.readFileSync(path.join(import.meta.dir, "..", "SKILL.md"), "utf8");

/** First fenced block of `lang` after the heading that contains `anchor`. */
function blockAfter(anchor: string, lang: string): string {
  const at = DOC.indexOf(anchor);
  if (at === -1) throw new Error(`anchor not found in 02-creation.md: ${anchor}`);
  const rest = DOC.slice(at);
  const m = new RegExp("```" + lang + "\\n([\\s\\S]*?)```").exec(rest);
  if (!m) throw new Error(`no \`\`\`${lang} block after: ${anchor}`);
  return m[1];
}

describe("02-creation.md teaches only what the admission gate admits", () => {
  test("the Phase 3 manifest + Phase 6 workflow document, verbatim, pass the create gate", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-doc-v6-"));
    const dir = path.join(root, "my-squad");
    for (const sub of ["agents", "tasks", "workflows", "schemas"]) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
    }
    fs.writeFileSync(path.join(dir, "squad.yaml"), blockAfter("### Phase 3", "yaml"), "utf8");
    fs.writeFileSync(path.join(dir, "workflows", "main-pipeline.md"), blockAfter("### Phase 6", "markdown"), "utf8");

    // Minimal components matching the names the doc's manifest declares. If
    // the doc renames them, this test names the mismatch instead of guessing.
    for (const a of ["agent-one", "agent-two"]) {
      fs.writeFileSync(path.join(dir, "agents", `${a}.md`), [
        "---", `name: ${a}`,
        'description: "Builds funnel artifacts. Use when the pipeline dispatches this step. Do NOT use for isolated copy."',
        "maxTurns: 25", "tools: [read, write, bash]", "model: inherit", "---", "",
        "You are a funnel specialist. You build the assigned artifact from the brief.",
        "", "# Guidelines", "", "## DO", "- Ground every stage in the product brief.",
        "", "## DO NOT", "- Invent product facts the brief does not carry.",
        "", "# Process", "1. Read the brief.", "2. Produce the artifact.",
        "", "# Output", "Markdown at the declared output path.", "",
      ].join("\n"), "utf8");
    }
    for (const t of ["task-one", "task-two"]) {
      fs.writeFileSync(path.join(dir, "tasks", `${t}.md`), [
        "---", `name: ${t}`, 'description: "What this accomplishes"', "---", "",
        `# ${t}`, "", "## Input", "The product brief.", "", "## Steps",
        "1. Read the input.", "2. Produce the output.", "", "## Output",
        "Markdown artifact at the run directory.", "", "## Acceptance Criteria",
        "- The artifact exists at the declared path.", "",
      ].join("\n"), "utf8");
    }

    // The same call init-squad.ts makes at creation: mechanical fixes allowed
    // (they regenerate the ENGINE-owned .nirvana-surface.json), then blocked
    // must be false — the doc's example is an admitted squad or the doc lies.
    const gate = await verifyHook({ kind: "squad", target: dir, gate: "create", fix: "mechanical" });
    expect(`blocked: ${gate.blocked}\n${gate.lines.join("\n")}`).toStartWith("blocked: false");
    fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);

  test("the poison patterns the gate rejects never come back as teaching", () => {
    // `depends_on` may appear only in the line that tells you NOT to use it.
    for (const line of DOC.split("\n")) {
      if (!line.includes("depends_on")) continue;
      expect(line).toContain("never");
    }
    // No workflow ref carries an extension anywhere in the doc's YAML.
    expect(DOC).not.toMatch(/ref: workflows\/[a-z0-9_-]+\.(ya?ml|md)/);
    // The doc never instructs protocol 5.0 for a new squad.
    expect(DOC).not.toContain('protocol: "5.0"');
    // §33: the not_for guidance forbids the "(use X)" suffix instead of teaching it.
    expect(DOC).not.toMatch(/not_for:\s*\n\s*- "<counterexample> \(use /);
  });

  test("the wizard and the SKILL teach the same protocol as the doc", () => {
    expect(WIZARD).not.toContain("workflow.yaml.tmpl");
    expect(WIZARD).not.toMatch(/invoke\.ref points to workflows\/<name>\.yaml/);
    expect(SKILL).toContain("# Squad Protocol Engine v6.0.0");
    // The creation-rules list is 1..17 with no duplicate — rule 16 is the
    // self-retrieval gate the anti-patterns section points at.
    const rules = SKILL.slice(SKILL.indexOf("## Creation Rules"));
    expect(rules).toContain("\n16. **Self-retrieval gate (blocking)");
    expect(rules).toContain("(rule 16)");
    expect(rules.match(/\n10\. /g)!.length).toBe(1);
  });
});
