// smoke.test.ts — the four-command lifecycle of a business, end to end.
//
// `SKILL.md` promised this file for months at `tests/smoke.ts` and it never
// existed, so nothing proved that the templates a wizard copies still validate,
// index and list. That is exactly the chain a Business Protocol 2.0 template
// edit can break: a stale field in `business.yaml` fails the loader, and the
// only place it would surface is a user creating a business.
//
// Everything runs against a temp NIRVANA_HOME (mkdtemp) with the repo's own
// skills tree as CLAUDE_SKILLS_DIR, so the templates under test are the ones in
// this checkout — never the installed copy — and the machine's ~/businesses is
// neither read nor written.
//
// Runs with: bun test skills/businesses/tests
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const SKILLS = join(import.meta.dir, "..", "..");
const SCRIPTS = join(SKILLS, "businesses", "scripts");
const TEMPLATE_TYPES = join(SKILLS, "businesses", "templates", "business-types");

let home: string;
let env: Record<string, string>;

function nrv(script: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    cwd: home, env, encoding: "utf8",
  });
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "nrv-biz-smoke-"));
  mkdirSync(join(home, "businesses"), { recursive: true });
  env = {
    ...process.env,
    NIRVANA_HOME: home,
    BUSINESSES_DIR: join(home, "businesses"),
    BUSINESSES_REGISTRY_PATH: join(home, ".businesses-registry.json"),
    CLAUDE_SKILLS_DIR: SKILLS,
    NIRVANA_SCOPE: "global",
    NIRVANA_SCOPE_QUIET: "1",
  } as Record<string, string>;
});

afterAll(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("business lifecycle — init → validate → index → list", () => {
  test("init scaffolds from the solo template and the scaffold passes the loader", () => {
    const r = nrv("init-business.ts", "smoke-solo", "--template", "solo", "--non-interactive");
    expect(`${r.stdout}${r.stderr}`).not.toContain("validation failed");
    expect(r.status).toBe(0);
    expect(existsSync(join(home, "businesses", "smoke-solo", "business.yaml"))).toBe(true);
  });

  // The wizard writes no `.nirvana-surface.json` (§5.3 puts it in the layout and
  // gives it to the engine), so the gate rejects a scaffold on exactly that one
  // error and `--fix` clears it. The wizard hook that closes the gap is PR11 of
  // the program plan; until then this test states the gap instead of hiding it.
  test("validate names the one error a scaffold carries, and --fix clears it", () => {
    const first = nrv("validate-business.ts", "smoke-solo", "--json", "--no-retrieval");
    const report = JSON.parse(first.stdout);
    expect(report.findings.filter((f: any) => f.severity === "error").map((f: any) => f.id)).toEqual(["surface_missing"]);
    expect(first.status).toBe(1);

    const fixed = nrv("validate-business.ts", "smoke-solo", "--fix", "--no-retrieval");
    expect(`${fixed.stdout}${fixed.stderr}`).not.toContain("ROLLED BACK");
    expect(fixed.status).toBe(0);
    expect(existsSync(join(home, "businesses", "smoke-solo", ".nirvana-surface.json"))).toBe(true);
  });

  test("--report writes the JSON under the project's own .audit-state", () => {
    // Pinned project root: a report belongs to the project that asked for it,
    // never to the global skills tree (the split audit-businesses-score made).
    const r = spawnSync(process.execPath, [join(SCRIPTS, "validate-business.ts"), "smoke-solo", "--report", "--no-retrieval"], {
      cwd: home, env: { ...env, NIRVANA_PROJECT_ROOT: home, NIRVANA_SCOPE: "project" }, encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const file = join(home, ".nirvana", ".audit-state", "smoke-solo", "verify.json");
    expect(r.stdout).toContain(file);
    expect(JSON.parse(readFileSync(file, "utf8")).schema).toBe("nirvana.verify-report/v1");
  });

  test("index writes the registry with the new business", () => {
    const r = nrv("index-businesses.ts", "--quiet");
    expect(r.status).toBe(0);
    const registry = JSON.parse(readFileSync(join(home, ".businesses-registry.json"), "utf8"));
    expect(Object.keys(registry.businesses)).toContain("smoke-solo");
    // employee_count is derived from disk (§6.12), never from the manifest.
    expect(registry.businesses["smoke-solo"].employee_count).toBe(1);
  });

  test("list prints the business it just indexed", () => {
    const r = nrv("list-businesses.ts");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("smoke-solo");
  });
});

/** Employee frontmatter retired by §22. A scaffold must not seed them. */
const RETIRED_EMPLOYEE_FIELDS = [
  "heartbeat", "self_score_contract", "budget_monthly_usd", "mentions",
  "escalation_triggers", "draws_from", "dna_reference",
];

describe("business templates — every business-type scaffold is Protocol 2.0", () => {
  // Directories only: the tree also carries legacy `<type>.yaml` siblings.
  const types = readdirSync(TEMPLATE_TYPES).filter((n) => statSync(join(TEMPLATE_TYPES, n)).isDirectory()).sort();

  test("there is at least one template type to check", () => {
    expect(types.length).toBeGreaterThan(0);
  });

  for (const type of types) {
    test(`${type}: manifest declares 2.0, no retired manifest field, no authored employee_count`, () => {
      const manifest = parseYaml(readFileSync(join(TEMPLATE_TYPES, type, "business.yaml"), "utf8")) as Record<string, unknown>;
      expect(manifest.protocol).toBe("2.0");
      expect(manifest.run_budget_usd).toBe(0);
      expect("not_for" in manifest).toBe(true);
      for (const retired of ["employee_count", "auto_routes", "capabilities_required", "default_tools"]) {
        expect(retired in manifest).toBe(false);
      }
    });

    test(`${type}: no employee carries a retired frontmatter field`, () => {
      const dir = join(TEMPLATE_TYPES, type, "employees");
      const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
      expect(files.length).toBeGreaterThan(0);
      const found: string[] = [];
      for (const f of files) {
        const fm = parseYaml(/^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(dir, f), "utf8"))![1]) as Record<string, unknown>;
        for (const retired of RETIRED_EMPLOYEE_FIELDS) if (retired in fm) found.push(`${f}:${retired}`);
      }
      expect(found).toEqual([]);
    });

    test(`${type}: the intake seat declares acceptance (BP4 redefined)`, () => {
      const dir = join(TEMPLATE_TYPES, type, "employees");
      const seats = readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) =>
        parseYaml(/^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(dir, f), "utf8"))![1]) as Record<string, unknown>,
      );
      const intake = seats.find((s) => s.is_brief_intake === true);
      expect(intake).toBeDefined();
      expect(Array.isArray(intake!.acceptance)).toBe(true);
      expect((intake!.acceptance as unknown[]).length).toBeGreaterThan(0);
    });
  }
});
