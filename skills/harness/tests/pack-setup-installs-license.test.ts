/**
 * The pack installer must INSTALL the license, not merely read it.
 *
 * For months the shipped `setup.ts` opened PROVENANCE.json only to learn the
 * pack version, and never copied it to ~/.nirvana-license/. Every buyer finished
 * with "✓ Pack instalado" and no license on disk; the failure surfaced days
 * later, from another directory, as `nrv update <slug>` claiming there was no
 * license at all. Nothing tested the step because the step did not exist.
 *
 * These are source-level assertions on purpose. Running the real installer means
 * downloading an engine tarball and writing to the user's HOME, so what is
 * cheap and honest to guard is the contract: the copy is there, it targets
 * ~/.nirvana-license, and it cannot fail silently.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SETUP = readFileSync(join(import.meta.dir, "..", "..", "..", "packaging", "pack", "setup.ts"), "utf8");

describe("packaging/pack/setup.ts — license installation", () => {
  test("copies PROVENANCE.json into ~/.nirvana-license", () => {
    expect(SETUP).toContain(".nirvana-license");
    expect(SETUP).toMatch(/copyFileSync\(\s*provSrc\s*,/);
  });

  test("imports what the copy needs", () => {
    expect(SETUP).toMatch(/import\s*\{[^}]*\bcopyFileSync\b[^}]*\}\s*from\s*"node:fs"/);
  });

  test("a failed copy is reported, never swallowed", () => {
    // The catch around the copy must print something. An empty `catch {}` here
    // is the exact shape of the original bug.
    const block = SETUP.slice(SETUP.indexOf("const provSrc"));
    const cat = block.slice(block.indexOf("} catch"), block.indexOf("} catch") + 400);
    expect(cat).toMatch(/console\.(log|error)/);
    expect(cat).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*\}/);
  });

  test("a copy without provenance says so instead of passing quietly", () => {
    expect(SETUP).toMatch(/existsSync\(provSrc\)/);
    expect(SETUP).toContain("no PROVENANCE.json in this folder");
  });

  test("points at the one-command remedy when the copy fails", () => {
    expect(SETUP).toContain("nrv license install");
  });
});
