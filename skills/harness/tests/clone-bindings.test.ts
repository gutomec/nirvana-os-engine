/**
 * Every clone an employee names has to be somewhere the runtime will look.
 *
 * A business binds a mind-clone to an employee by naming it in the employee's
 * frontmatter, and the runtime resolves that name against the clone library.
 * Nothing verified the name resolves, and the failure is silent by
 * construction: the employee runs without the persona it was written to carry
 * and produces plausible prose that reads like anyone.
 *
 * In a pack it is worse. Found while adding `tracking-360` to the flagship: its
 * seventeen employees name seventeen clones and the pack carried five. The other
 * twelve were located by listing them out by hand — which is the work a gate
 * should be doing.
 *
 * The reference forms are the part worth pinning. `assigned_mind_clones` holds
 * the slug, optionally category-prefixed. `dna_reference` holds a path INTO the
 * clone — `dna/michael-thaut-music-therapist/agent/AGENT.md` — so reading its
 * last segment yields `AGENT`, and the first pass of this gate duly reported six
 * businesses missing a clone named AGENT.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const GATE = join(REPO, "scripts", "check-clone-bindings.ts");
const ROOT = mkdtempSync(join(tmpdir(), "bindings-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

interface Pack { clones: string[]; employees: Record<string, string> }

/** A pack content dir: businesses/<slug>/employees/*.md + mind-clones/<slug>/. */
function pack(name: string, p: Pack): string {
  const dir = join(ROOT, name);
  mkdirSync(join(dir, "businesses", "acme", "employees"), { recursive: true });
  mkdirSync(join(dir, "mind-clones"), { recursive: true });
  writeFileSync(join(dir, "businesses", "acme", "business.yaml"), "name: acme\n", "utf8");
  for (const c of p.clones) mkdirSync(join(dir, "mind-clones", c), { recursive: true });
  for (const [emp, fm] of Object.entries(p.employees)) {
    writeFileSync(join(dir, "businesses", "acme", "employees", `${emp}.md`), `---\nname: ${emp}\n${fm}---\n\n# ${emp}\n`, "utf8");
  }
  return dir;
}

function run(dir: string, args: string[] = []) {
  const r = spawnSync(process.execPath, [GATE, "--pack", dir, ...args], { cwd: REPO, encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("a named clone that is not shipped is caught", () => {
  test("the failure this gate exists for", () => {
    // tracking-360's shape: employees name clones the pack does not carry.
    const dir = pack("short", {
      clones: ["simo-ahava-tracking"],
      employees: { engineer: "assigned_mind_clones:\n  - simo-ahava-tracking\n  - david-vallejo-tracking\n" },
    });
    const r = run(dir, ["--strict"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("david-vallejo-tracking");
    expect(r.out).not.toContain("simo-ahava-tracking\x1b");  // the present one is not flagged
  });

  test("a complete pack passes", () => {
    const dir = pack("complete", {
      clones: ["simo-ahava-tracking", "david-vallejo-tracking"],
      employees: { engineer: "assigned_mind_clones:\n  - simo-ahava-tracking\n  - david-vallejo-tracking\n" },
    });
    const r = run(dir, ["--strict"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Every clone an employee names is present");
  });
});

describe("the two reference forms", () => {
  test("a category-prefixed ref resolves to its slug", () => {
    const dir = pack("prefixed", {
      clones: ["jane-friedman"],
      employees: { editor: "assigned_mind_clones:\n  - 21-media-moguls/jane-friedman\n" },
    });
    expect(run(dir, ["--strict"]).code).toBe(0);
  });

  test("dna_reference points INTO the clone, and the slug is not the file", () => {
    // Reading the last segment gives `AGENT`. Six businesses were reported
    // missing a clone by that name before this was fixed.
    const dir = pack("dnaref", {
      clones: ["michael-thaut-music-therapist"],
      employees: { therapist: "dna_reference: dna/michael-thaut-music-therapist/agent/AGENT.md\n" },
    });
    const r = run(dir, ["--strict"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("AGENT");
  });
});

describe("the business dna/ directory", () => {
  test("a loose README is not a binding", () => {
    // `medwork360/dna/` holds a README.md and nothing else. Counting it as a
    // clone reported a missing one named "README" AND implied the business had
    // a binding it does not have — the more damaging half of that mistake.
    const dir = pack("readme", { clones: [], employees: {} });
    mkdirSync(join(dir, "businesses", "acme", "dna"), { recursive: true });
    writeFileSync(join(dir, "businesses", "acme", "dna", "README.md"), "# notes\n", "utf8");
    const r = run(dir, ["--strict"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("README");
    expect(r.out).toContain("0 bindings");
  });

  test("a dangling symlink is a binding that already broke", () => {
    const dir = pack("dangling", { clones: ["present-one"], employees: {} });
    const dna = join(dir, "businesses", "acme", "dna");
    mkdirSync(dna, { recursive: true });
    symlinkSync(join(ROOT, "nowhere", "gone-clone"), join(dna, "gone-clone"));
    const r = run(dir, ["--strict"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("gone-clone");
  });
});

describe("it reports what it inspected", () => {
  test("counts are printed, so an empty check is visibly empty", () => {
    const dir = pack("counted", {
      clones: ["a-clone"],
      employees: { one: "assigned_mind_clones:\n  - a-clone\n" },
    });
    expect(run(dir).out).toMatch(/1 businesses · 1 bindings · 1 clones/);
  });

  test("--json is shaped for a build step", () => {
    const dir = pack("json", { clones: [], employees: { one: "assigned_mind_clones:\n  - absent\n" } });
    const d = JSON.parse(run(dir, ["--json"]).out);
    expect(d.bindings).toBe(1);
    expect(d.missing[0].clone).toBe("absent");
    expect(d.missing[0].employee).toBe("one");
  });
});
