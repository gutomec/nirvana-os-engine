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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    // Report-only without the flag is deliberate: the report is also how an
    // author browses the debt. The enforcement lives in --strict, against the
    // recorded ceiling.
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

/**
 * The ceiling. These are the cases that make --strict worth wiring into
 * `check:all` — the gate spent its first day there WITHOUT the flag, printing
 * 46% dead in red and exiting 0, which is the defect it was written to catch.
 *
 * A gate goes back into `check:all` only with a test that plants the defect and
 * demands exit 1. That is what the three cases below are.
 */
describe("the ceiling refuses growth, and refuses new content that arrives dead", () => {
  const DEAD = "a long entry nobody will ever match against a real brief here";
  const LIVE = "seo audit";

  /** A fixture registry plus the ceiling file the gate reads beside it. */
  function withCeiling(
    caps: Record<string, Array<Record<string, unknown>>>,
    entities: Record<string, number>,
  ): string {
    const f = fixture(caps);
    writeFileSync(`${f}.baseline.json`, JSON.stringify({ recorded_at: "test", entities }), "utf8");
    return f;
  }

  const run = (f: string) => {
    const r = spawnSync(process.execPath, [GATE, "--registry", f, "--strict"], { cwd: REPO, encoding: "utf8" });
    return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  test("an entity that grows past its ceiling fails", () => {
    const r = run(withCeiling(
      { "a.b.c": [{ squad: "s", not_for: [LIVE, DEAD], example_briefs: ["do an seo audit for me"] }] },
      { s: 0 },
    ));
    expect(r.code).toBe(1);
    expect(r.out).toContain("grew past their ceiling");
    expect(r.out).toMatch(/s\s+0 → 1/);
  }, 60_000);

  test("an entity the ceiling has never seen enters at zero, or it does not enter", () => {
    // The admission bar. Every other gate here compares against a previous
    // state, so a first arrival has nothing to fail against — which is how
    // tracking-360 joined the flagship with 79 of 79 fences dead, green.
    const r = run(withCeiling(
      {
        "a.b.c": [{ squad: "known", not_for: [LIVE], example_briefs: ["do an seo audit for me"] }],
        "d.e.f": [{ squad: "brand-new", not_for: [DEAD], example_briefs: ["something else entirely"] }],
      },
      { known: 0 },
    ));
    expect(r.code).toBe(1);
    expect(r.out).toContain("new to the ceiling");
    expect(r.out).toContain("brand-new");
  }, 60_000);

  test("a library at or below its ceiling passes", () => {
    const r = run(withCeiling(
      { "a.b.c": [{ squad: "known", not_for: [LIVE], example_briefs: ["do an seo audit for me"] }] },
      { known: 0 },
    ));
    expect(r.code).toBe(0);
    expect(r.out).toContain("No entity is above its ceiling");
  }, 60_000);

  test("--pack keys by the manifest name, not the directory", () => {
    // The registry keys by `name` (registry.js:165) and the two differ often
    // enough to matter: `nirvana-rh-dp/` declares `nirvana-rh-departamento-pessoal`.
    // Keying by directory made a squad that HAS a ceiling look like new content,
    // and failed `commerce-backoffice` for it.
    const pack = mkdtempSync(join(tmpdir(), "notfor-pack-"));
    const squad = join(pack, "squads", "some-dir");
    mkdirSync(squad, { recursive: true });
    writeFileSync(join(squad, "squad.yaml"), [
      'name: declared-name',
      'capabilities:',
      '  - id: a.b.c',
      '    not_for:',
      `      - "${DEAD}"`,
      '    example_briefs:',
      '      - "something else entirely"',
      '',
    ].join("\n"), "utf8");

    const one = (slug: string) =>
      spawnSync(process.execPath, [GATE, slug, "--pack", pack], { cwd: REPO, encoding: "utf8" });

    expect(`${one("declared-name").stdout}`).toMatch(/declared-name: .*1\/1 dead/);
    expect(`${one("some-dir").stdout}`).toContain("no not_for entries");
    rmSync(pack, { recursive: true, force: true });
  }, 60_000);

  test("the ceiling is found from any working directory", () => {
    // It describes the machine's global authoring library, so anchoring it to
    // the current scope described nothing: recorded from ~/nirvana-os it landed
    // in that repo's .nirvana/, and the pack build — which runs from
    // ~/nirvana-packs — found no ceiling and failed every pack as new content.
    const home = mkdtempSync(join(tmpdir(), "notfor-home-"));
    mkdirSync(join(home, ".nirvana"), { recursive: true });
    writeFileSync(
      join(home, ".nirvana", ".not-for-baseline.json"),
      JSON.stringify({ recorded_at: "test", entities: { "declared-name": 1 } }),
      "utf8",
    );

    const pack = mkdtempSync(join(tmpdir(), "notfor-pack2-"));
    const squad = join(pack, "squads", "d");
    mkdirSync(squad, { recursive: true });
    writeFileSync(join(squad, "squad.yaml"), [
      "name: declared-name",
      "capabilities:",
      "  - id: a.b.c",
      "    not_for:",
      `      - "${DEAD}"`,
      "    example_briefs:",
      '      - "something else entirely"',
      "",
    ].join("\n"), "utf8");

    const codes = [REPO, tmpdir()].map((cwd) =>
      spawnSync(process.execPath, [GATE, "--pack", pack, "--strict"], {
        cwd, encoding: "utf8", env: { ...process.env, NIRVANA_HOME: home },
      }).status,
    );
    expect(codes[0]).toBe(0);          // 1 dead, ceiling is 1 — at the ceiling, passes
    expect(codes[1]).toBe(codes[0]);   // and the answer does not move with cwd
    rmSync(pack, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  test("--record refuses to raise a ceiling without being told to", () => {
    // Recording after a fix is routine. Recording a regression has to be said
    // out loud, or `--record` becomes the way every debt quietly becomes the floor.
    const f = withCeiling(
      { "a.b.c": [{ squad: "s", not_for: [LIVE, DEAD], example_briefs: ["do an seo audit for me"] }] },
      { s: 0 },
    );
    const r = spawnSync(process.execPath, [GATE, "--registry", f, "--record"], { cwd: REPO, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(`${r.stdout ?? ""}${r.stderr ?? ""}`).toContain("HIGHER ceiling");
  }, 60_000);
});
