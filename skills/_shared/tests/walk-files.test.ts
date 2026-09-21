// walk-files.test.ts — a link is a pointer, never content to walk through.
//
// The case is the layout the engine itself creates: `nrv deps link` (Rule 12)
// makes a component's `node_modules` a junction onto the shared store in
// ~/.nirvana. Walking through it folded the whole store into the component's
// hash and into the pre-overlay backup; on Windows the backup then died with
// EPERM recreating the link, and `nrv update <pack>` failed for any pack that
// shipped such a squad. Measured 2026-09-17: genesis-circle 0.1.88 and
// game-development 0.1.3 both downloaded, overlaid, and aborted with a raw Bun
// stack trace, leaving the packs un-updated.
//
// A junction is created here rather than a symlink on purpose: junctions need no
// privilege on Windows, so the same test exercises the real layout on every OS.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isLinked, listFilesRel } from "../lib/walk-files.ts";

let root: string;
let store: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-walk-"));
  store = path.join(root, "shared-store");
  fs.mkdirSync(path.join(store, "inner"), { recursive: true });
  fs.writeFileSync(path.join(store, "inner", "deep.js"), "x");
  fs.writeFileSync(path.join(store, "top.js"), "x");

  const component = path.join(root, "component");
  fs.mkdirSync(path.join(component, "agents"), { recursive: true });
  fs.writeFileSync(path.join(component, "squad.yaml"), "name: c");
  fs.writeFileSync(path.join(component, "agents", "a.md"), "# a");
  fs.symlinkSync(store, path.join(component, "node_modules"), "junction");
});

afterAll(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("listFilesRel", () => {
  test("lists the component's own files, with / separators and relative paths", () => {
    const files = listFilesRel(path.join(root, "component")).sort();
    expect(files).toContain("squad.yaml");
    expect(files).toContain("agents/a.md");
  });

  test("never descends into the linked store — the 2026-09-17 fix", () => {
    const files = listFilesRel(path.join(root, "component"));
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(files).not.toContain("node_modules/top.js");
    expect(files).not.toContain("node_modules/inner/deep.js");
  });

  test("walking the store directly still works — only the LINK is skipped", () => {
    const files = listFilesRel(store).sort();
    expect(files).toEqual(["inner/deep.js", "top.js"]);
  });

  test("an absent root is an empty list, not an error", () => {
    expect(listFilesRel(path.join(root, "nope"))).toEqual([]);
  });
});

describe("isLinked", () => {
  test("the junction is a link", () => {
    expect(isLinked(path.join(root, "component", "node_modules"))).toBe(true);
  });
  test("a real directory and a real file are not", () => {
    expect(isLinked(path.join(root, "component", "agents"))).toBe(false);
    expect(isLinked(path.join(root, "component", "squad.yaml"))).toBe(false);
  });
  test("an absent path is not a link", () => {
    expect(isLinked(path.join(root, "component", "absent"))).toBe(false);
  });
});
