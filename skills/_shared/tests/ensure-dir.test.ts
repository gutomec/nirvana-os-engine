// ensure-dir.test.ts — creating a directory that already exists is success.
//
// `mkdirSync(dir, { recursive: true })` is documented to succeed on an existing
// directory, and under Bun on Windows it can throw EEXIST anyway. Four places in
// this engine had already learned that by hand; the per-event paths had not.
//
// Measured on a client's machine (2026-09-11, Windows): two EEXIST warnings from
// the ledger creating the day's audit directory. The ledger catches and warns, so
// the run carried on — and the two audit events it was writing were lost. An
// audit log that drops evidence when the disk is fine is worse than a loud crash.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureDir, isAlreadyExists } from "../lib/ensure-dir.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-ensure-"));
  roots.push(d);
  return d;
}

describe("ensureDir", () => {
  test("creates the whole path, and calling it again is a no-op", () => {
    const deep = path.join(tmp(), "a", "b", "c");
    expect(ensureDir(deep)).toBe(deep);
    expect(fs.existsSync(deep)).toBe(true);
    expect(() => ensureDir(deep)).not.toThrow();
    expect(() => ensureDir(deep)).not.toThrow();
  });

  test("EEXIST is the one error treated as success — the Windows case, without a Windows runner", () => {
    const eexist: any = new Error("EEXIST: file already exists, mkdir");
    eexist.code = "EEXIST";
    expect(isAlreadyExists(eexist)).toBe(true);
    for (const code of ["EACCES", "ENOTDIR", "ENOSPC", "EPERM", undefined]) {
      const other: any = new Error(String(code));
      other.code = code;
      expect(isAlreadyExists(other), `${code} must stay a real failure`).toBe(false);
    }
    expect(isAlreadyExists(null)).toBe(false);
    expect(isAlreadyExists(undefined)).toBe(false);
  });

  test("a path that IS a file throws, even though the platform says EEXIST", () => {
    // The hole this closes: EEXIST also fires when the path exists as a regular
    // file. Swallowing it would report success for a directory that is not one,
    // and the caller would fail later with an error about something else.
    const root = tmp();
    const file = path.join(root, "collision");
    fs.writeFileSync(file, "x");
    expect(() => ensureDir(file)).toThrow();
  });

  test("a real failure is still a failure: a path blocked by a FILE throws", () => {
    const root = tmp();
    const file = path.join(root, "not-a-dir");
    fs.writeFileSync(file, "x");
    expect(() => ensureDir(path.join(file, "child"))).toThrow();
  });
});

describe("the per-event paths route through it", () => {
  const read = (p: string) => fs.readFileSync(path.join(import.meta.dir, "..", "..", p), "utf8");

  test.each([
    ["harness/lib/audit.js", "ensure-dir.js"],
    ["harness/lib/run-ledger.ts", "ensure-dir.ts"],
    ["_shared/scripts/audit-emit-from-hook.ts", "ensure-dir.ts"],
    ["_shared/lib/audit-emit.ts", "ensure-dir.ts"],
    ["_shared/lib/state-db.js", "ensure-dir.js"],
  ])("%s no longer calls mkdirSync bare", (file, helper) => {
    const src = read(file);
    expect(src).toContain(helper);
    expect(src).not.toMatch(/fs\.mkdirSync\([^)]*recursive: true[^)]*\);/);
  });
});
