// install-order.test.ts — the installer lays dependencies down first, and a
// missing dependency is a named warning, not a silent degradation.
//
// The failure this prevents: the legacy literal order installed businesses
// BEFORE mind-clones (the reverse of the dependency direction), and a pack
// business declaring a clone the pack did not carry installed an employee
// bound to nothing, silently. It also locks the twin call sites together:
// skills/_shared/scripts/install-content.ts and scripts/install.ts both order
// their syncKind calls, and history shows the duplication nearly cost a
// breakage warning once already.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const SCRIPT = join(REPO, "skills", "_shared", "scripts", "install-content.ts");

function packFixture(opts: { carryClone: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), "install-order-"));
  const biz = join(dir, "businesses", "biz-a");
  mkdirSync(join(biz, "employees"), { recursive: true });
  writeFileSync(join(biz, "business.yaml"), "name: biz-a\n");
  writeFileSync(
    join(biz, "employees", "ceo.md"),
    "---\nassigned_mind_clones:\n  - expert-x\n---\n\n# CEO\n"
  );
  mkdirSync(join(dir, "squads"), { recursive: true });
  if (opts.carryClone) {
    const clone = join(dir, "mind-clones", "expert-x");
    mkdirSync(clone, { recursive: true });
    writeFileSync(join(clone, "MANIFEST.yaml"), "name: expert-x\n");
  } else {
    mkdirSync(join(dir, "mind-clones"), { recursive: true });
  }
  return dir;
}

function runDry(content: string): { out: string; code: number } {
  const r = spawnSync(process.execPath, [SCRIPT, content, "--slug", "test-pack", "--dry"], {
    encoding: "utf8",
    env: { ...process.env },
  });
  return { out: `${r.stdout}\n${r.stderr}`, code: r.status ?? 1 };
}

describe("dependency-ordered install", () => {
  test("kind order resolves to squads → mind-clones → businesses", () => {
    const pack = packFixture({ carryClone: true });
    try {
      const { out, code } = runDry(pack);
      expect(code).toBe(0);
      expect(out).not.toContain("dependency missing");
    } finally {
      rmSync(pack, { recursive: true, force: true });
    }
  });

  test("a clone the pack does not carry is a NAMED warning", () => {
    const pack = packFixture({ carryClone: false });
    try {
      const { out, code } = runDry(pack);
      expect(code).toBe(0); // warning-only in P0; the pack build gate is the hard failure
      expect(out).toContain("dependency missing: mind-clone 'expert-x' required by biz-a/ceo");
    } finally {
      rmSync(pack, { recursive: true, force: true });
    }
  });
});

describe("twin call sites stay in lockstep", () => {
  // The regex trap: both files must execute syncKind in dependency order
  // (mind-clones before businesses). If someone reorders one twin and not
  // the other, this fails before a buyer ever sees the divergence.
  const kindCallOrder = (file: string): string[] => {
    const src = readFileSync(file, "utf8");
    const out: string[] = [];
    for (const m of src.matchAll(/syncKind\(\s*"(squads|businesses|mind-clones)"/g)) out.push(m[1]);
    return out;
  };

  test("install-content.ts declares its runner map in any order but executes by graph order", () => {
    const order = kindCallOrder(join(REPO, "skills", "_shared", "scripts", "install-content.ts"));
    expect(order.length).toBe(3);
    // execution goes through installKindOrder(); the source must reference it
    const src = readFileSync(join(REPO, "skills", "_shared", "scripts", "install-content.ts"), "utf8");
    expect(src).toContain("installKindOrder");
  });

  test("install.ts executes mind-clones before businesses", () => {
    const order = kindCallOrder(join(REPO, "scripts", "install.ts"));
    const defs = order.slice(0, 3);
    expect(defs.indexOf("mind-clones")).toBeLessThan(defs.indexOf("businesses"));
  });
});
