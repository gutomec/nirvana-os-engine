/**
 * The doctor reports every runtime the dispatch engine supports, from the
 * driver's own roster — never from a local copy.
 *
 * The dispatch driver supports nine agent CLIs (RUNTIMES). The doctor's
 * BINARIES section carried a private, hardcoded list holding three of them, so
 * grok, pi, agy, kimi, qwen and opencode never appeared in the report even
 * when installed and perfectly dispatchable — on every OS. Duplicated lists
 * drift; these cases lock the three lists (RUNTIMES, RUNTIME_BINS, the
 * doctor's probe set) to one source of truth.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listRuntimes, __testables } from "../../_shared/lib/host-agent-driver.ts";

const DOCTOR = join(import.meta.dir, "..", "scripts", "doctor-system.ts");

describe("listRuntimes is the roster, verbatim", () => {
  test("it returns exactly the adapters RUNTIMES declares, in order", () => {
    const fromSeam = __testables.RUNTIMES.map((r: { name: string; cli: string }) => ({ name: r.name, cli: r.cli }));
    expect(listRuntimes()).toEqual(fromSeam);
    // The number is not pinned by hand on purpose: a 10th adapter must flow
    // through without editing this test. What IS pinned is non-emptiness and
    // uniqueness — an empty or duplicated roster is a broken driver.
    const names = listRuntimes().map((r) => r.name);
    expect(names.length).toBeGreaterThanOrEqual(9);
    expect(new Set(names).size).toBe(names.length);
  });

  test("RUNTIME_BINS mirrors it exactly — the literal is drift-proofed here", () => {
    // The Record<Runtime, string> literal is kept (its exhaustive key type
    // makes a missing Runtime member a compile error), and THIS is the check
    // that its values never drift from the adapters'.
    for (const rt of listRuntimes()) {
      // runtimeAvailable resolves through RUNTIME_BINS; the probe command it
      // builds must target the same binary the adapter declares. Read the
      // mapping straight from the source to compare without exporting it.
      const src = readFileSync(join(import.meta.dir, "..", "..", "_shared", "lib", "host-agent-driver.ts"), "utf8");
      const m = src.match(new RegExp(`"${rt.name}":\\s*"([^"]+)"`));
      expect(m, `RUNTIME_BINS has no entry for ${rt.name}`).toBeTruthy();
      expect(m![1]).toBe(rt.cli);
    }
  });
});

describe("the doctor consumes the roster instead of copying it", () => {
  const src = readFileSync(DOCTOR, "utf8");

  test("it imports and iterates listRuntimes", () => {
    expect(src).toContain('import { listRuntimes }');
    expect(src).toContain("for (const rt of listRuntimes())");
  });

  test("its bins array carries no agent runtime", () => {
    // The infra binaries stay; every runtime binary name inside the bins
    // literal would be the drift starting over.
    const bins = src.slice(src.indexOf("const bins = ["), src.indexOf("];", src.indexOf("const bins = [")));
    for (const rt of listRuntimes()) {
      expect(bins, `bins hardcodes the runtime binary "${rt.cli}"`).not.toContain(`"${rt.cli}"`);
    }
    for (const infra of ["bun", "git", "node", "python3"]) expect(bins).toContain(`"${infra}"`);
  });

  test("no runtime is individually fatal, and zero runtimes is", () => {
    // Each missing runtime is a WARN (dispatch falls through to the next);
    // the FAIL belongs to the summary line alone, when none is on PATH.
    expect(src).toMatch(/add\(`runtime: \$\{rt\.name\}`, "WARN"/);
    // FAIL on a user machine; WARN on a headless CI runner, where zero
    // runtimes is the expected state (the smoke job installs the engine on a
    // bare image to prove the install itself).
    expect(src).toContain('runtimesOnPath > 0 ? "PASS" : headlessCI ? "WARN" : "FAIL"');
  });
});
