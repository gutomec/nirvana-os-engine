/**
 * Three ways an install said "done" while leaving the buyer broken.
 *
 * Each of these shipped for months. None of them threw, none of them printed
 * anything, and `nrv doctor` said "All systems nominal" on top of all three.
 * They share one shape with the license bug: something is written on one track
 * and looked for on another, or a step is skipped by a flag nobody connected to
 * it.
 *
 * Source-level assertions, deliberately. Executing the real installer needs a
 * network fetch and a writable HOME; what is cheap and honest to guard here is
 * the wiring, and the behavioural coverage lives in buyer-path.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const read = (...p: string[]) => readFileSync(join(REPO, ...p), "utf8");

const INSTALL = read("scripts", "install.ts");
const SETUP_PS1 = read("packaging", "pack", "setup.ps1");
const SETUP_SH = read("packaging", "pack", "setup.sh");
const CONTENT = read("skills", "_shared", "scripts", "install-content.ts");

describe("the registries are built on every install, not only with a starter pack", () => {
  // The index call used to sit at the tail of offerStarterPack(), below its
  // `--no-starter` early return — and --no-starter is what both entry points
  // pass. A plain `npx @nirvana-os/cli` finished with no registry on disk.
  test("indexing lives in its own function", () => {
    expect(INSTALL).toMatch(/function buildRegistries\(\)/);
  });

  test("main() calls it outside offerStarterPack", () => {
    const main = INSTALL.slice(INSTALL.indexOf("async function main("));
    expect(main).toMatch(/buildRegistries\(\)/);
  });

  test("offerStarterPack no longer owns the index", () => {
    const start = INSTALL.indexOf("async function offerStarterPack(");
    const body = INSTALL.slice(start, INSTALL.indexOf("function buildRegistries("));
    expect(body).not.toMatch(/"index"/);
  });

  test("--no-index and --dry still suppress it", () => {
    const fn = INSTALL.slice(INSTALL.indexOf("function buildRegistries("));
    expect(fn.slice(0, 600)).toMatch(/FLAG_DRY/);
    expect(fn.slice(0, 600)).toMatch(/FLAG_NO_INDEX/);
  });
});

describe("the Windows bootstrap reports the installer's exit code", () => {
  // Without this the script always returned 0, so a Windows buyer whose setup
  // failed saw a shell that said everything was fine — on the platform both
  // license reports came from.
  test("setup.ps1 propagates LASTEXITCODE", () => {
    expect(SETUP_PS1).toMatch(/exit \$LASTEXITCODE/);
  });

  test("it is the last thing the script does", () => {
    const lines = SETUP_PS1.trimEnd().split("\n");
    expect(lines[lines.length - 1].trim()).toBe("exit $LASTEXITCODE");
  });

  test("setup.sh gets the same guarantee from exec", () => {
    expect(SETUP_SH).toMatch(/\bexec\b/);
  });
});

describe("a paid pack is visible to `nrv installed`", () => {
  // install-content wrote only ~/.nirvana/packs/<slug>.json; list-installed
  // replays only ~/.nirvana-installed.jsonl. A successful paid install answered
  // "No installations recorded".
  test("install-content records the install in the manifest", () => {
    expect(CONTENT).toMatch(/import \{ InstallManifest \}/);
    expect(CONTENT).toMatch(/function recordInstall\(/);
    expect(CONTENT).toMatch(/recordInstall\(out\)/);
  });

  test("it records kind 'pack' with its items", () => {
    const fn = CONTENT.slice(CONTENT.indexOf("function recordInstall("));
    expect(fn.slice(0, 1800)).toMatch(/kind: "pack"/);
    expect(fn.slice(0, 1800)).toMatch(/items,/);
  });

  test("a bookkeeping failure is reported, not swallowed", () => {
    const fn = CONTENT.slice(CONTENT.indexOf("function recordInstall("));
    const cat = fn.slice(fn.indexOf("} catch"), fn.indexOf("} catch") + 400);
    expect(cat).toMatch(/console\.log/);
    expect(cat).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*\}/);
  });

  test("it does not abort the install — the content is already on disk", () => {
    const fn = CONTENT.slice(CONTENT.indexOf("function recordInstall("));
    expect(fn.slice(0, 2200)).not.toMatch(/process\.exit/);
  });
});
