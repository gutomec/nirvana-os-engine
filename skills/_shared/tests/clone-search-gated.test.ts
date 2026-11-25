// clone-search-gated.test.ts — `gated: true` keeps a clone out of every list
// that offers or assigns one when it covers too little of the task. The ranking
// normalizes by the best hit, so some clone always comes first at 1.00:
// measured 2026-11-24, "chef and menu creation" put a sales-funnel marketer
// first, covering 1 of the 3 terms. A small library on disk, in project scope.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findCloneForTask } from "../lib/clone-search.ts";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-clone-gated-")));
const PROJECT = path.join(ROOT, "project");
const saved = { scope: process.env.NIRVANA_SCOPE, root: process.env.NIRVANA_PROJECT_ROOT };

beforeAll(() => {
  fs.mkdirSync(path.join(PROJECT, ".nirvana"), { recursive: true });
  fs.writeFileSync(path.join(PROJECT, ".nirvana", "project.yaml"), "schema_version: nirvana.project/v1alpha1\n");
  const clone = (slug: string, one_liner: string, domains: string[]) => ({ slug, display_name: slug, tags: [], match: { one_liner, domains } });
  fs.writeFileSync(path.join(PROJECT, ".nirvana", ".mind-clones-registry.json"), JSON.stringify({ mind_clones: {
    "funnel-marketer": clone("funnel-marketer", "Sales funnels, offers and value ladders for digital products", ["funnels", "offers", "creation", "marketing"]),
    "privacy-lawyer": clone("privacy-lawyer", "Data privacy law: LGPD and GDPR legal bases, consent and data subject rights", ["privacy", "lgpd", "gdpr", "data"]),
  } }));
  process.env.NIRVANA_SCOPE = "project";
  process.env.NIRVANA_PROJECT_ROOT = PROJECT;
});
afterAll(() => {
  if (saved.scope === undefined) delete process.env.NIRVANA_SCOPE; else process.env.NIRVANA_SCOPE = saved.scope;
  if (saved.root === undefined) delete process.env.NIRVANA_PROJECT_ROOT; else process.env.NIRVANA_PROJECT_ROOT = saved.root;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("the relevance gate on the clone search", () => {
  test("ungated, the best irrelevant clone still comes first at 1.00, marked below the gate", () => {
    const hits = findCloneForTask("chef and menu creation", { cwd: PROJECT });
    expect(hits[0]?.slug).toBe("funnel-marketer");
    expect(hits[0]?.normalized).toBe(1);
    expect(hits[0]?.below_gate).toBe(true);
  });

  test("gated, a task no clone covers returns none", () => {
    expect(findCloneForTask("chef and menu creation", { cwd: PROJECT, gated: true })).toEqual([]);
  });

  test("gated, a clone that covers the task is still offered", () => {
    const hits = findCloneForTask("data privacy LGPD GDPR", { cwd: PROJECT, gated: true });
    expect(hits.map((h) => h.slug)).toEqual(["privacy-lawyer"]);
    expect(hits[0].below_gate).toBe(false);
  });
});
