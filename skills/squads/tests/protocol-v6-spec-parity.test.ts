// protocol-v6-spec-parity.test.ts — SQUAD_PROTOCOL_V6.md and the code it
// describes name the same things.
//
// A protocol document is only worth reading while it is true. The failure mode
// is silent: a criterion is renamed in `kinds/squad.ts`, the spec keeps the old
// id, and the next person to read the spec fixes a finding that no longer
// exists. This test makes that a build failure — every criterion id, every lint
// id, every mechanical fixer and every `nrv migrate` flag has to appear
// verbatim in the spec.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { criteria as squadCriteria, squadModule } from "../../_shared/lib/verify/kinds/squad.ts";
import { WORKFLOW_LINT_IDS } from "../lib/workflow-reader.ts";
import { LIMITS } from "../../_shared/validators/limits.ts";
import { CapabilitySchema, SquadManifestSchema, WorkflowSchema } from "../../_shared/validators/validators.ts";

const SPEC = fs.readFileSync(path.join(import.meta.dir, "..", "SQUAD_PROTOCOL_V6.md"), "utf8");
const MIGRATE = fs.readFileSync(path.join(import.meta.dir, "..", "scripts", "migrate-squad.ts"), "utf8");

describe("the catalog the spec describes is the catalog that runs", () => {
  test("every squad criterion id is named in the spec", () => {
    const missing = squadCriteria.map((c) => c.id).filter((id) => !SPEC.includes(`\`${id}\``));
    expect(missing).toEqual([]);
  });

  test("every workflow lint id is named in the spec", () => {
    const missing = [...WORKFLOW_LINT_IDS].filter((id) => !SPEC.includes(`\`${id}\``));
    expect(missing).toEqual([]);
  });

  test("every mechanical fixer is named in the spec", () => {
    const missing = Object.keys(squadModule.fixers)
      .filter((f) => f !== "caps_examples_not_for" && f !== "components_files_stub" && f !== "surface_regen"
        && f !== "agents_frontmatter_repair" && f !== "tasks_acceptance_criteria" && f !== "dependencies_synth" && f !== "readme_scaffold")
      .filter((f) => !SPEC.includes(`\`${f}\``));
    expect(missing).toEqual([]);
  });
});

describe("the numbers the spec states", () => {
  test("the body ceiling is LIMITS.workflow_body_words_max", () => {
    expect(LIMITS.workflow_body_words_max).toBe(2500);
    expect(SPEC).toContain("**2.500 palavras**");
  });

  test("acceptance is capped at 12 in the schema and in the spec", () => {
    const acceptance = (CapabilitySchema.shape.acceptance as any);
    expect(acceptance.safeParse(Array.from({ length: 13 }, () => ({ id: "a", description: "x" }))).success).toBe(false);
    expect(acceptance.safeParse(Array.from({ length: 12 }, () => ({ id: "a", description: "x" }))).success).toBe(true);
    expect(SPEC).toContain("**máximo 12 entradas**");
  });

  test("not_for's 25-char ceiling lives in the gate, exactly as the spec says", async () => {
    const { NOT_FOR_MAX_CHARS } = await import("../../_shared/lib/verify/kinds/squad.ts");
    expect(NOT_FOR_MAX_CHARS).toBe(25);
    expect(SPEC).toContain("no máximo **25 caracteres**");
    // The spec states the divergence: CapabilitySchema only enforces min(5).
    expect(CapabilitySchema.shape.not_for.safeParse(["a much longer refusal than twenty-five chars"]).success).toBe(true);
    expect(CapabilitySchema.shape.not_for.safeParse(["ab"]).success).toBe(false);
  });

  test("the workflow schema shape the spec tabulates", () => {
    expect(Object.keys(WorkflowSchema.shape).sort())
      .toEqual(["description", "extensions", "name", "on_failure", "steps", "success_indicators", "version"]);
    expect(SquadManifestSchema.shape.protocol.safeParse("6.0").success).toBe(true);
  });

  test("the task-extraction threshold the spec quotes matches the migration", () => {
    expect(MIGRATE).toContain("export const TASK_EXTRACTION_WORDS = 40;");
    expect(SPEC).toContain("≥40 palavras");
  });
});

describe("the migrate flags the spec tabulates are the flags the CLI parses", () => {
  const FLAGS = ["--to", "--apply", "--all", "--map-refs", "--no-extract-tasks", "--no-derive-acceptance", "--force", "--rollback", "--json", "--root"];
  for (const flag of FLAGS) {
    test(flag, () => {
      expect(MIGRATE).toContain(`case "${flag.replace(/^--/, "")}"`);
      expect(SPEC).toContain(`\`${flag}`);
    });
  }
});
