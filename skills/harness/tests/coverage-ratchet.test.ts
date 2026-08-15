/**
 * An entity may not quietly know less than it did.
 *
 * The gates this library already had all ask whether an entity can still be
 * FOUND. None asked whether it still COVERS what it used to. Measured on a real
 * squad: deleting 3 of 8 capabilities and trimming 56 briefs to 10 left the
 * self-retrieval gate reporting a clean PASS — the survivors retrieved
 * perfectly, the neighbours were untouched. The library got smaller and every
 * signal stayed green.
 *
 * That is the shape of the damage the routing contract already carries a
 * correction for: descriptions truncated mid-word at 500 characters across the
 * whole library, to save space. Losing coverage is invisible in a way losing
 * correctness is not.
 *
 * These tests run against a fixture baseline rather than the live one, so they
 * are deterministic and say nothing about whatever the developer's library
 * happens to hold today.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT = path.resolve(import.meta.dir, "..", "..", "_shared", "scripts", "coverage-ratchet.ts");

let tmp: string;
let env: NodeJS.ProcessEnv;

/**
 * Point the script at a throwaway registry. The baseline lands beside it, so a
 * run here never reads or writes the developer's real one.
 */
function writeRegistry(caps: Record<string, Array<Record<string, unknown>>>): void {
  fs.writeFileSync(path.join(tmp, ".squads-registry.json"), JSON.stringify({ capabilities: caps }));
  fs.writeFileSync(path.join(tmp, ".businesses-registry.json"), JSON.stringify({ businesses: {} }));
}

/** Two capabilities on one squad, each with briefs and keywords. */
const FULL = {
  "demo.alpha.execute": [{ squad: "demo-squad", example_briefs: ["a", "b", "c"], keywords: ["k1", "k2"] }],
  "demo.beta.execute": [{ squad: "demo-squad", example_briefs: ["d", "e"], keywords: ["k3"] }],
};

function run(args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: tmp, env, encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-ratchet-"));
  env = {
    ...process.env,
    SQUADS_REGISTRY_PATH: path.join(tmp, ".squads-registry.json"),
    BUSINESSES_REGISTRY_PATH: path.join(tmp, ".businesses-registry.json"),
  };
  writeRegistry(FULL);
});
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe("coverage ratchet", () => {
  test("records a baseline and passes against itself", () => {
    expect(run(["--record"]).code).toBe(0);
    const r = run(["--check", "--strict"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("No entity knows less");
  });

  test("a deleted capability fails, and names what was lost", () => {
    run(["--record"]);
    writeRegistry({ "demo.alpha.execute": FULL["demo.alpha.execute"] }); // beta amputated
    const r = run(["--check", "--strict"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("capabilities: 2 → 1");
    expect(r.out).toContain("demo.beta.execute");
  });

  test("deleted briefs fail even when the capability survives", () => {
    run(["--record"]);
    writeRegistry({
      ...FULL,
      "demo.alpha.execute": [{ squad: "demo-squad", example_briefs: ["a"], keywords: ["k1", "k2"] }],
    });
    const r = run(["--check", "--strict"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("example_briefs: 5 → 3");
  });

  test("a swap that keeps the count is still caught", () => {
    // Same number of capabilities, different ids. Counting alone would miss it.
    run(["--record"]);
    writeRegistry({
      "demo.alpha.execute": FULL["demo.alpha.execute"],
      "demo.gamma.execute": [{ squad: "demo-squad", example_briefs: ["x", "y"], keywords: ["k9"] }],
    });
    const r = run(["--check", "--strict"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("demo.beta.execute");
  });

  test("growth is never a failure", () => {
    run(["--record"]);
    writeRegistry({
      ...FULL,
      "demo.delta.execute": [{ squad: "demo-squad", example_briefs: ["f", "g", "h"], keywords: ["k4"] }],
    });
    expect(run(["--check", "--strict"]).code).toBe(0);
  });

  test("an intended removal can be accepted, and needs a reason to be", () => {
    run(["--record"]);
    writeRegistry({ "demo.alpha.execute": FULL["demo.alpha.execute"] });

    // A decrease without a stated reason is exactly what this gate is for.
    const bare = run(["--accept", "demo-squad"]);
    expect(bare.code).toBe(2);
    expect(bare.out).toContain("--reason");

    expect(run(["--accept", "demo-squad", "--reason", "merged into demo.alpha"]).code).toBe(0);
    expect(run(["--check", "--strict"]).code).toBe(0);
  });

  test("with no baseline it says so instead of failing", () => {
    // A fresh checkout must not fail the contract gates for lack of a baseline.
    const r = run(["--check", "--strict"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("No baseline");
  });
});
