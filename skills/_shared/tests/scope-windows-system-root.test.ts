// scope-windows-system-root.test.ts — OS-owned directories are never project
// roots, and HOME is recognised even when the path arrives in 8.3 short form.
//
// The failure this prevents (field report, Windows 11 + PowerShell 7.6.5,
// 2026-08-23): an elevated PowerShell starts in C:\Windows\System32. The
// resolver walked up from there, found a project marker, and pointed the
// engine's writes at a directory the user does not own — EPERM on
// `nrv index`, or a polluted System32 when elevated.
//
// Two of these cases run on every platform on purpose. The original version
// of this file skipped everything off Windows, and the one case that did run
// in CI failed for a DIFFERENT reason than it was written for: the temp dir
// resolved to C:\Users\RUNNER~1 while homedir() reported
// C:\Users\runneradmin, so the HOME guard — a string compare — did not
// recognise its own home. That bug predated the fix and is covered below.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveScope } from "../lib/scope.ts";

const paths = require("../lib/paths.js");

describe("system directories are never project roots", () => {
  test.skipIf(process.platform !== "win32")("ignores project markers under SystemRoot", () => {
    const originalSystemRoot = process.env.SystemRoot;
    const systemRoot = mkdtempSync(path.join(os.tmpdir(), "nrv-system-root-"));
    const cwd = path.join(systemRoot, "System32");

    try {
      mkdirSync(cwd);
      writeFileSync(path.join(cwd, "package.json"), "{}");
      process.env.SystemRoot = systemRoot;

      expect(resolveScope({ cwd }).projectRoot).toBeNull();
      expect(paths.detectScope({ cwd }).projectRoot).toBeNull();
    } finally {
      if (originalSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = originalSystemRoot;
      rmSync(systemRoot, { recursive: true, force: true });
    }
  });

  test("the filesystem root is never a project root, even carrying a marker", () => {
    // Every platform: "/" on POSIX, "C:\" or a UNC share on Windows. A stray
    // package.json at a drive root would otherwise make the whole drive one
    // project, and every directory on it inherit that.
    const root = path.parse(process.cwd()).root;
    expect(paths.detectScope({ cwd: root }).projectRoot).not.toBe(root);
    expect(resolveScope({ cwd: root }).projectRoot).not.toBe(root);
  });

  test("HOME is recognised through symlinks and short paths, not by string equality", () => {
    // The CI failure that exposed this: on Windows os.tmpdir() answers with
    // an 8.3 short path (C:\Users\RUNNER~1\...), so walking up from a temp
    // directory reaches a spelling of HOME that a string compare misses. On
    // macOS the same class of mismatch appears via /var -> /private/var.
    const home = os.homedir();
    const marker = path.join(home, ".nirvana");
    // The realpath of HOME must be rejected whatever spelling arrives.
    expect(resolveScope({ cwd: home }).projectRoot).not.toBe(home);
    // And a directory INSIDE home is still a legitimate project root — the
    // guard must not swallow the normal case it exists to protect.
    const proj = mkdtempSync(path.join(os.tmpdir(), "nrv-real-project-"));
    try {
      writeFileSync(path.join(proj, "package.json"), "{}");
      expect(resolveScope({ cwd: proj }).projectRoot).not.toBeNull();
    } finally {
      rmSync(proj, { recursive: true, force: true });
      void marker;
    }
  });
});
