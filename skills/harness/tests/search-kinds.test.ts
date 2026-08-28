// search-kinds.test.ts — regression for `nrv search --kind=squad|business`.
//
// The registries store keyed OBJECTS ({ squads: { <slug>: entry } }), not
// arrays. The old iteration treated `data.squads` as iterable, threw a
// TypeError and the empty `catch {}` swallowed it — so squads and businesses
// NEVER appeared in results. These tests pin the fixed behavior:
//   1. keyed-object registries produce squad + business hits (slug from key);
//   2. a broken registry file prints a stderr warning instead of silence.
//
// Isolation: registry paths are scope-aware via _shared/lib/paths.js, which
// honors the SQUADS_REGISTRY_PATH / BUSINESSES_REGISTRY_PATH / DNA_LIBRARY /
// NIRVANA_HOME env overrides — that is the env hook the test uses.
// Runs with: bun test skills/harness/tests
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const SCRIPT = path.resolve(import.meta.dir, "../scripts/search.ts");

let tmp: string;
let squadsReg: string;
let bizReg: string;
let dnaDir: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-search-"));
  squadsReg = path.join(tmp, ".squads-registry.json");
  bizReg = path.join(tmp, ".businesses-registry.json");
  dnaDir = path.join(tmp, "dna");
  fs.mkdirSync(dnaDir, { recursive: true });

  // Keyed-object shape — exactly what index-squads / index-businesses emit.
  fs.writeFileSync(squadsReg, JSON.stringify({
    schema_version: "1.0.0",
    squads: {
      "fixture-landing-squad": {
        version: "5.0.0",
        protocol: "5.0",
        domains: ["web"],
        capabilities: ["web.landing_page.execute"],
        keywords: ["landing-page", "hero-section"],
        produces: ["landing-page"],
        example_briefs: [],
      },
    },
  }));
  fs.writeFileSync(bizReg, JSON.stringify({
    schema_version: "1.0.0",
    businesses: {
      "fixture-growth-biz": {
        version: "1.0.0",
        protocol: "1.0",
        domains: ["marketing"],
        capabilities: [],
        keywords: ["landing-page"],
        produces: ["landing-page"],
        example_briefs: ["Criar landing page para o produto X"],
      },
    },
  }));
});

afterAll(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

function runSearch(args: string[]): { stdout: string; stderr: string; code: number | null } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    cwd: tmp,
    env: {
      ...process.env,
      SQUADS_REGISTRY_PATH: squadsReg,
      BUSINESSES_REGISTRY_PATH: bizReg,
      DNA_LIBRARY: dnaDir,
      NIRVANA_HOME: tmp,
    },
  });
  return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.status };
}

describe("nrv search — keyed-object registries", () => {
  test("--kind=squad finds squads in a keyed-object registry (slug from key)", () => {
    const r = runSearch(["landing page", "--kind=squad", "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    const slugs = out.results.map((h: any) => h.slug);
    expect(slugs).toContain("fixture-landing-squad");
    expect(out.results.every((h: any) => h.kind === "squad")).toBe(true);
  });

  test("--kind=business finds businesses in a keyed-object registry", () => {
    const r = runSearch(["landing page", "--kind=business", "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    const slugs = out.results.map((h: any) => h.slug);
    expect(slugs).toContain("fixture-growth-biz");
    expect(out.results.every((h: any) => h.kind === "business")).toBe(true);
  });

  test("no --kind returns both squads and businesses", () => {
    const r = runSearch(["landing page", "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    const kinds = new Set(out.results.map((h: any) => h.kind));
    expect(kinds.has("squad")).toBe(true);
    expect(kinds.has("business")).toBe(true);
  });

  test("broken registry file prints a stderr warning, not silence", () => {
    const broken = path.join(tmp, "broken-squads.json");
    fs.writeFileSync(broken, "{ this is not json");
    const r = spawnSync(process.execPath, [SCRIPT, "landing page", "--kind=squad", "--json"], {
      encoding: "utf8",
      cwd: tmp,
      env: {
        ...process.env,
        SQUADS_REGISTRY_PATH: broken,
        BUSINESSES_REGISTRY_PATH: bizReg,
        DNA_LIBRARY: dnaDir,
        NIRVANA_HOME: tmp,
      },
    });
    expect(r.status).toBe(0); // non-fatal
    expect(r.stderr).toMatch(/warn: squads registry/);
  }, spawnBudgetMs(2));
});
