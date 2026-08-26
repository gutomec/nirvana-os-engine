// organizational-non-regression.test.ts — the gate that proves the entity
// suites leave the installed businesses, squads and mind-clones untouched.
//
// Hermetic: --roots points at fixture trees in mkdtemp and --suites at fake
// suites written beside them, so neither the live roots under $HOME nor the
// real entity suites take part. A suite that only reads passes; a suite that
// writes into a root fails with every path listed; a failing suite fails the
// gate; a machine with no roots at all passes with a note.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const GATE = join(REPO, "scripts", "check-organizational-non-regression.ts");
const ROOT = mkdtempSync(join(tmpdir(), "org-gate-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** The gate prints paths under $HOME with a leading `~`, as the other checks do. */
const short = (file: string) => (file.startsWith(homedir()) ? `~${file.slice(homedir().length)}` : file);

interface Roots { businesses: string; squads: string }

/** Installed-looking roots and one fake suite whose body is built from them. */
function fixture(name: string, suiteBody: (roots: Roots) => string) {
  const businesses = join(ROOT, name, "businesses");
  const squads = join(ROOT, name, "squads");
  mkdirSync(join(businesses, "acme", "employees"), { recursive: true });
  writeFileSync(join(businesses, "acme", "business.yaml"), "name: acme\n", "utf8");
  writeFileSync(join(businesses, "acme", "employees", "intake.md"), "---\nname: intake\n---\n", "utf8");
  mkdirSync(join(squads, "alpha"), { recursive: true });
  writeFileSync(join(squads, "alpha", "squad.yaml"), "name: alpha\n", "utf8");
  const suite = join(ROOT, name, "suite");
  mkdirSync(suite, { recursive: true });
  writeFileSync(join(suite, "fake.test.ts"), suiteBody({ businesses, squads }), "utf8");
  return { businesses, squads, suite };
}

function gate(roots: string[], suites: string[]) {
  const run = spawnSync(process.execPath, [GATE, "--strict", "--roots", roots.join(","), "--suites", suites.join(",")], { cwd: REPO, encoding: "utf8" });
  return { status: run.status, out: `${run.stdout}\n${run.stderr}` };
}

describe("check-organizational-non-regression", () => {
  test("a suite that only reads the roots passes", () => {
    const f = fixture("reads", ({ businesses }) => `
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
test("reads an installed business", () => {
  expect(readFileSync(${JSON.stringify(join(businesses, "acme", "business.yaml"))}, "utf8")).toContain("acme");
});
`);
    const { status, out } = gate([f.businesses, f.squads], [f.suite]);
    expect(status).toBe(0);
    expect(out).toContain("1 pass");
    expect(out).toContain("difference ...... 0 path(s)");
    expect(out).toContain("ORGANIZATIONAL NON-REGRESSION: OK");
  });

  test("a suite that writes into a root fails and lists the added, changed and removed paths", () => {
    const f = fixture("writes", ({ businesses, squads }) => `
import { test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
test("migrates the installed entities in place", () => {
  writeFileSync(${JSON.stringify(join(squads, "alpha", "MIGRATED.md"))}, "# migrated\\n", "utf8");
  writeFileSync(${JSON.stringify(join(businesses, "acme", "business.yaml"))}, "name: acme\\nprotocol: 2\\n", "utf8");
  rmSync(${JSON.stringify(join(businesses, "acme", "employees", "intake.md"))});
});
`);
    const { status, out } = gate([f.businesses, f.squads], [f.suite]);
    expect(status).toBe(1);
    expect(out).toContain("1 pass");
    expect(out).toContain(`added   ${short(join(f.squads, "alpha", "MIGRATED.md"))}`);
    expect(out).toContain(`changed ${short(join(f.businesses, "acme", "business.yaml"))}`);
    expect(out).toContain(`removed ${short(join(f.businesses, "acme", "employees", "intake.md"))}`);
    expect(out).toContain("3 path(s) differ under the installed roots");
    expect(out).not.toContain("ORGANIZATIONAL NON-REGRESSION: OK");
  });

  test("a failing suite fails the gate even when the roots are untouched", () => {
    const f = fixture("fails", () => `
import { expect, test } from "bun:test";
test("breaks", () => { expect(1).toBe(2); });
`);
    const { status, out } = gate([f.businesses, f.squads], [f.suite]);
    expect(status).toBe(1);
    expect(out).toContain("difference ...... 0 path(s)");
    expect(out).toContain("suites exited 1");
  });

  test("no installed roots means nothing to protect", () => {
    const { status, out } = gate([join(ROOT, "absent", "businesses")], [join(ROOT, "absent", "suite")]);
    expect(status).toBe(0);
    expect(out).toContain("nothing to protect");
  });
});
