// kinds/business.ts — the business module of the admission gate, trivial for now.
//
// Only the criteria every kind shares live here (the manifest parses,
// the contract surface exists and is fresh), so the CLI works end to end for all three
// kinds. The full business catalog lands in PR8 of the program plan.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { listEntities, resolveEntityDir, surfaceFindings, surfaceRegenFixer } from "../common.ts";
import type { CheckContext, Criterion, Finding, KindModule } from "../types.ts";

export const criteria: Criterion[] = [
  { id: "manifest_parse", severity: "error", autofix: "none", baselineable: false, title: "business.yaml parses" },
  { id: "surface_missing", severity: "error", autofix: "mechanical", baselineable: false, title: ".nirvana-surface.json present", fixer: "surface_regen" },
  { id: "surface_stale", severity: "warning", autofix: "mechanical", baselineable: false, title: ".nirvana-surface.json matches the files on disk", fixer: "surface_regen" },
];
const BY_ID = new Map(criteria.map((c) => [c.id, c]));

function mk(id: string, message: string, evidence: string): Finding {
  const c = BY_ID.get(id)!;
  return { id, severity: c.severity, autofix: c.autofix, message, evidence, baselined: false, ...(c.fixer ? { fixer: c.fixer } : {}) };
}

export async function check(ctx: CheckContext): Promise<Finding[]> {
  const out: Finding[] = [];
  const file = path.join(ctx.dir, "business.yaml");
  try {
    const doc = parseYaml(fs.readFileSync(file, "utf8"));
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) out.push(mk("manifest_parse", "business.yaml is not a YAML mapping", typeof doc));
  } catch (e: any) {
    out.push(mk("manifest_parse", "business.yaml does not parse", String(e?.message ?? e).split("\n")[0]));
  }
  out.push(...surfaceFindings(ctx.dir, "business", mk));
  return out;
}

export const businessModule: KindModule = {
  kind: "business",
  manifestFile: "business.yaml",
  resolveDir: (target) => resolveEntityDir("business", target),
  listAll: (roots) => listEntities("business", roots),
  criteria,
  check,
  fixers: { surface_regen: surfaceRegenFixer("business") },
  fixOrder: ["surface_regen"],
};
