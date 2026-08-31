// employee-frontmatter-editor.test.ts — regression coverage for the
// line-surgical frontmatter editor Glance's org-chart card editor uses.
//
// The fixture below reproduces the exact shape that caused a real data-
// corruption bug found live (2026-08-31, testing against
// aurum-contabil/employees/ac-bookkeeping-coord.md): a `squads_authorized:`
// list whose item sits flush at column 0 (`squads_authorized:\n- foo`, no
// leading space), immediately followed by ANOTHER top-level list
// (`escalation_triggers:`) whose own items are also flush. The original
// item-detection regex required at least one leading space, so it silently
// reported the flush item as "no items", and a write left the real line
// behind while inserting a duplicate above it. Every test here that touches
// `squads_authorized` is this bug's regression guard.

import { describe, expect, test } from "bun:test";
import {
  applyEmployeePatch,
  readEmployeeEditable,
  FrontmatterEditError,
} from "../lib/glance/employee-frontmatter-editor.ts";

function fixture(opts: { squadsFlush?: boolean; dnaIndented?: boolean } = {}): string {
  const squadsBlock = opts.squadsFlush
    ? "squads_authorized:\n- nirvana-contabilidade\n"
    : "";
  const dnaBlock = opts.dnaIndented
    ? "assigned_mind_clones:\n  - 21-media-moguls/jane-friedman\n"
    : "";
  return `---
name: ac-example
role: bookkeeping_coordinator
description: "Sou o Coordenador de Escrituração Contábil."
reports_to: ac-tech-director
self_score_contract:
  required_before_handoff: true
  criteria:
  - id: reconciliation_complete
    description: Todas as contas conciliadas no prazo, com divergência acima de 0,5% do ativo sinalizada e explicada
    threshold: 0.9
tools:
- Read
- Write
${squadsBlock}${dnaBlock}escalation_triggers:
- id: quality_gate
  condition: the ledger is ready for review
  severity: medium
---

# Body content

This must never change.
`;
}

describe("readEmployeeEditable", () => {
  test("reads role/description/reportsTo and both list fields", () => {
    const r = readEmployeeEditable(fixture({ squadsFlush: true, dnaIndented: true }));
    expect(r.role).toBe("bookkeeping_coordinator");
    expect(r.description).toBe("Sou o Coordenador de Escrituração Contábil.");
    expect(r.reportsTo).toBe("ac-tech-director");
    expect(r.squadsAuthorized).toEqual(["nirvana-contabilidade"]);
    expect(r.assignedMindClones).toEqual(["21-media-moguls/jane-friedman"]);
  });

  test("absent list fields read as empty arrays, not an error", () => {
    const r = readEmployeeEditable(fixture());
    expect(r.squadsAuthorized).toEqual([]);
    expect(r.assignedMindClones).toEqual([]);
  });

  test("throws on a file with no frontmatter header", () => {
    expect(() => readEmployeeEditable("no header here")).toThrow(FrontmatterEditError);
  });
});

describe("applyEmployeePatch — the flush-list corruption regression", () => {
  test("writing the SAME flush squads_authorized value is a true byte-identical no-op", () => {
    const src = fixture({ squadsFlush: true });
    const out = applyEmployeePatch(src, { squadsAuthorized: ["nirvana-contabilidade"] });
    expect(out).toBe(src);
  });

  test("changing a flush squads_authorized list doesn't duplicate or orphan the old item", () => {
    const src = fixture({ squadsFlush: true });
    const out = applyEmployeePatch(src, { squadsAuthorized: ["a", "b"] });
    // The exact bug: old code left "- nirvana-contabilidade" behind as an
    // orphan line while also writing the new items above it.
    expect(out).not.toContain("nirvana-contabilidade");
    expect((out.match(/squads_authorized:/g) || []).length).toBe(1);
    const lines = out.split("\n");
    const idx = lines.indexOf("squads_authorized:");
    expect(lines[idx + 1]).toBe("- a");
    expect(lines[idx + 2]).toBe("- b");
    expect(lines[idx + 3]).toBe("escalation_triggers:"); // no leftover line before the next key
  });

  test("the following escalation_triggers: list is never mistaken for part of squads_authorized", () => {
    const src = fixture({ squadsFlush: true });
    const out = applyEmployeePatch(src, { squadsAuthorized: [] });
    expect(out).toContain("escalation_triggers:\n- id: quality_gate");
  });
});

describe("applyEmployeePatch — untouched-content preservation", () => {
  test("editing role/description never reflows the unrelated self_score_contract.criteria list", () => {
    const src = fixture();
    const out = applyEmployeePatch(src, { role: "New Role", description: "New description." });
    const before = src.split("criteria:")[1].split("tools:")[0];
    const after = out.split("criteria:")[1].split("tools:")[0];
    expect(after).toBe(before);
  });

  test("the markdown body below the closing --- is byte-identical", () => {
    const src = fixture();
    const out = applyEmployeePatch(src, { role: "New Role" });
    const bodyOf = (s: string) => s.split(/\n---\n/).slice(1).join("\n---\n");
    expect(bodyOf(out)).toBe(bodyOf(src));
  });

  test("an empty patch is a true no-op", () => {
    const src = fixture({ squadsFlush: true, dnaIndented: true });
    expect(applyEmployeePatch(src, {})).toBe(src);
  });
});

describe("applyEmployeePatch — scalar quoting", () => {
  test("a plain unquoted role value round-trips without gaining quotes it doesn't need", () => {
    const src = fixture();
    const out = applyEmployeePatch(src, { role: "technical_accounting_director" });
    expect(out).toContain("role: technical_accounting_director");
    expect(out).not.toContain('role: "technical_accounting_director"');
  });

  test("a value that already had quotes keeps them even if the new value wouldn't strictly need any", () => {
    const src = fixture().replace(
      "role: bookkeeping_coordinator",
      'role: "CEO — Orquestrador de Licenciamento"'
    );
    const out = applyEmployeePatch(src, { role: "Simple Title" });
    expect(out).toContain('role: "Simple Title"');
  });

  test("a value containing a colon-space gets quoted even for a previously-unquoted field", () => {
    const src = fixture();
    const out = applyEmployeePatch(src, { role: "Title: with colon" });
    expect(out).toContain('role: "Title: with colon"');
  });

  test("description is always quoted, with internal quotes escaped", () => {
    const src = fixture();
    const out = applyEmployeePatch(src, { description: 'Has "quotes" inside.' });
    expect(out).toContain('description: "Has \\"quotes\\" inside."');
  });
});

describe("applyEmployeePatch — inserting a previously-absent list field", () => {
  test("assigned_mind_clones with no prior line gets appended at the end of the header", () => {
    const src = fixture();
    const out = applyEmployeePatch(src, { assignedMindClones: ["foo/bar"] });
    expect(readEmployeeEditable(out).assignedMindClones).toEqual(["foo/bar"]);
  });
});
