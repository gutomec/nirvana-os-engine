/**
 * The gate that checks whether a fence fires, and the constants it depends on.
 *
 * `not_for` is the only exclusion lever BM25 has — the index carries no
 * negation, so a capability stops taking a neighbour's brief either by losing
 * vocabulary (which also loses the briefs it should win) or by a `not_for` entry
 * firing. Measured this week: narrowing a keyword moved a ranking not at all,
 * while four short entries fixed it.
 *
 * And it fails silently. Nothing rejects a `not_for` that can never match, so an
 * author writes the boundary, the validator accepts it, and the router never
 * sees a fence. Measured across the library: 1,006 of 1,675 entries fire against
 * none of the 2,832 real example_briefs, and in 104 entities MOST of the fences
 * are dead — including one this session's own agent had "fixed", having argued
 * itself into keeping the broken form.
 *
 * Two things are pinned here. The gate's verdicts, and the fact that its
 * constants still match the router's — because a gate measuring the wrong
 * threshold is worse than no gate.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A capabilities map on disk, for the cases that must assert on real content
 *  rather than on whatever library the machine happens to have. */
const FIXTURES = mkdtempSync(join(tmpdir(), "notfor-"));
let n = 0;
function fixture(caps: Record<string, Array<Record<string, unknown>>>): string {
  const f = join(FIXTURES, `r${n++}.json`);
  writeFileSync(f, JSON.stringify(caps), "utf8");
  return f;
}
process.on("exit", () => { try { rmSync(FIXTURES, { recursive: true, force: true }); } catch {} });

const REPO = join(import.meta.dir, "..", "..", "..");
const GATE = join(REPO, "scripts", "check-not-for-fires.ts");
const ROUTER = readFileSync(join(REPO, "skills", "harness", "lib", "router.js"), "utf8");
const GATE_SRC = readFileSync(GATE, "utf8");

/** The router's own numbers, read from the router. */
function routerConst(name: string): number {
  const m = ROUTER.match(new RegExp(`const ${name}\\s*=\\s*([0-9.]+)`));
  if (!m) throw new Error(`${name} not found in router.js — the firing rule moved`);
  return Number(m[1]);
}

describe("the gate measures the rule the router actually applies", () => {
  test("router.js still defines the three firing constants", () => {
    expect(routerConst("NOT_FOR_SUBSTRING_MAX_CHARS")).toBe(25);
    expect(routerConst("NOT_FOR_MIN_CONTENT_TOKENS")).toBe(2);
    expect(routerConst("NOT_FOR_TOKEN_OVERLAP_MIN")).toBe(0.6);
  });

  test("the gate mirrors them", () => {
    // If the router's thresholds change and the gate's do not, the gate reports
    // confident numbers about a rule nobody applies any more.
    for (const [gateName, routerName] of [
      ["SUBSTRING_MAX_CHARS", "NOT_FOR_SUBSTRING_MAX_CHARS"],
      ["MIN_CONTENT_TOKENS", "NOT_FOR_MIN_CONTENT_TOKENS"],
      ["TOKEN_OVERLAP_MIN", "NOT_FOR_TOKEN_OVERLAP_MIN"],
    ] as const) {
      const m = GATE_SRC.match(new RegExp(`const ${gateName}\\s*=\\s*([0-9.]+)`));
      expect(m).toBeTruthy();
      expect(Number(m![1])).toBe(routerConst(routerName));
    }
  });

  test("the router's firing function is the one described", () => {
    // The gate's whole premise: two paths, chosen by length.
    const fn = ROUTER.slice(ROUTER.indexOf("function notForFires("));
    expect(fn.slice(0, 500)).toMatch(/entry\.length <= NOT_FOR_SUBSTRING_MAX_CHARS/);
    expect(fn.slice(0, 500)).toMatch(/briefLc\.includes/);
    expect(fn.slice(0, 500)).toMatch(/matched \/ entryTokens\.size >= NOT_FOR_TOKEN_OVERLAP_MIN/);
  });
});

describe("the gate runs and reports", () => {
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, [GATE, ...args], { cwd: REPO, encoding: "utf8" });
    return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  test("--json returns a shape a CI step can read", () => {
    const r = run(["--json"]);
    const d = JSON.parse(r.out);
    expect(typeof d.entries).toBe("number");
    expect(typeof d.dead).toBe("number");
    expect(Array.isArray(d.over_budget)).toBe(true);
    // Sanity: dead can never exceed total.
    expect(d.dead).toBeLessThanOrEqual(d.entries);
  }, 60_000);

  test("without --strict it reports rather than fails", () => {
    // Report-only is deliberate while 104 entities are over budget: a gate that
    // turns CI red with no path out teaches everyone to ignore it.
    expect(run([]).code).toBe(0);
  }, 60_000);

  test("a single entity can be inspected, and lists what is dead", () => {
    // Against a fixture, not the machine's library: CI has no `~/squads`, so
    // this case used to assert on an entity that was not there and fail on all
    // three platforms while passing on the author's laptop.
    const r = run(["one-squad", "--registry", fixture({
      "a.b.c": [{
        squad: "one-squad",
        not_for: [
          "live streaming",                                                     // fires: substring
          "auditar um artefato pronto e emitir laudo completo com correções",   // dead: too long
        ],
      }],
    })]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("one-squad");
    expect(r.out).toMatch(/1\/2 dead/);
    expect(r.out).toContain("auditar um artefato pronto");
  }, 60_000);

  test("the firing rule is length, and the report shows it", () => {
    const r = run(["--json", "--registry", fixture({
      "a.b.c": [{ squad: "s", not_for: ["seo audit", "x".repeat(40)] }],
    })]);
    const d = JSON.parse(r.out);
    expect(d.entries).toBe(2);
    expect(d.dead).toBe(1);
  }, 60_000);
});
