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

  test("the nrv launcher prefers the standard absolute Bun path", () => {
    const src = readFileSync(join(REPO, "scripts", "install.ts"), "utf8");
    const absolute = src.indexOf('set "BUN=%USERPROFILE%\\\\.bun\\\\bin\\\\bun.exe"');
    const missingAbsolute = src.indexOf('if not exist "%BUN%" (', absolute);
    const pathLookup = src.indexOf("where /q bun", absolute);
    const pathFallback = src.indexOf('set "BUN=bun"', pathLookup);
    const entrypointCheck = src.indexOf('if not exist "%NRVTS%" (', pathFallback);

    expect(absolute).toBeGreaterThan(-1);
    expect(missingAbsolute).toBeGreaterThan(absolute);
    expect(pathLookup).toBeGreaterThan(missingAbsolute);
    expect(pathFallback).toBeGreaterThan(pathLookup);
    expect(entrypointCheck).toBeGreaterThan(pathFallback);
  });
});

// The second thing CI cannot see, for the same reason: cmd.exe percent-expands a
// parenthesized block at PARSE time, so `%ERRORLEVEL%` written on a line INSIDE
// `if ... ( ... )` carries whatever the condition left, not what the command in
// the block returned. Every wrapper had `exit /b %ERRORLEVEL%` after a
// `where /q` probe, which parse-expands to `exit /b 0` — so a failed dispatch, a
// failed activation and the `confirmation_required` consent gate (exit 2, the
// sudo prompt in activator.js) all reported success to whoever called the .cmd.
// `SCRIPT_CONTRACT.md` defines exit codes 0/1/2/4 and names `activate-squad.cmd`
// as the Windows entry point, so the contract was unobservable there.
//
// Bare `exit /b` leaves the current errorlevel untouched, which is exactly what
// the block needs and needs no delayed expansion.
describe("Windows wrappers propagate the real exit code", () => {
  const files = walkCmdFiles(REPO);

  test("there are wrappers to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("no wrapper reads %ERRORLEVEL% inside a parenthesized block", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const lines = readFileSync(f, "utf8").split(/\r?\n/);
      let depth = 0;
      for (const line of lines) {
        const inBlock = depth > 0;
        if (inBlock && /%ERRORLEVEL%/i.test(line)) offenders.push(`${f}: ${line.trim()}`);
        depth += (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
        if (depth < 0) depth = 0;
      }
    }
    expect(offenders).toEqual([]);
  });
});
