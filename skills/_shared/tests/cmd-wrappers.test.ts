// cmd-wrappers.test.ts — no Windows wrapper may ever redirect to `nul` again.
//
// The failure this prevents (owner report, 2026-08-21): `where bun >nul 2>nul`
// is only safe INSIDE cmd.exe. Interpreted anywhere else — PowerShell (where
// `where` is a Where-Object alias and modern .NET dropped the reserved-name
// check), Bun's own shell, or any `\\?\`-prefixed path — it MATERIALIZES a
// literal file named `nul` in the current directory, which OneDrive then
// persists as an undeletable, syncing ghost. The safe idiom is `where /q`
// (native quiet flag, zero redirection). CI never exercises the wrappers
// (the Windows job runs bash), so this source-level gate is the only guard.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");

function walkCmdFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (["node_modules", ".git", "dist", "tmp", ".nirvana", "outputs"].includes(e)) continue;
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walkCmdFiles(p, out);
    else if (e.endsWith(".cmd")) out.push(p);
  }
  return out;
}

describe("Windows wrappers never redirect to nul", () => {
  test("every tracked .cmd uses `where /q`, not `>nul`", () => {
    const files = walkCmdFiles(REPO);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) => readFileSync(f, "utf8").includes(">nul"));
    expect(offenders).toEqual([]);
  });

  test("the launcher generators in scripts/install.ts are nul-free", () => {
    const src = readFileSync(join(REPO, "scripts", "install.ts"), "utf8");
    expect(src.includes(">nul")).toBeFalse();
    expect(src).toContain("where /q bun");
  });
});
