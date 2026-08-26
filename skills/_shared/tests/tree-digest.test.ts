// tree-digest.test.ts — the snapshot the organizational gate compares before
// and after the entity suites run.
//
// Pins: two snapshots of an untouched tree are equal entry by entry; a changed,
// an added and a removed file each land under their own label; a symlink is
// recorded by its target and never followed; skipDirs prunes a directory; a
// root nested inside another root is walked once.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffTreeSnapshots, snapshotTree } from "../lib/tree-digest.ts";

const ROOT = mkdtempSync(join(tmpdir(), "tree-digest-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function tree(name: string, files: Record<string, string>): string {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content, "utf8");
  }
  return dir;
}

describe("snapshotTree", () => {
  test("is idempotent over an untouched tree and keys entries by absolute path in a fixed order", () => {
    const dir = tree("stable", { "b.txt": "bee", "a/z.md": "zed", "a/y.md": "why" });
    const first = snapshotTree([dir]);
    expect([...snapshotTree([dir])]).toEqual([...first]);
    expect([...first.keys()]).toEqual([join(dir, "a", "y.md"), join(dir, "a", "z.md"), join(dir, "b.txt")]);
    expect(first.get(join(dir, "b.txt"))).toEqual({ sha256: sha("bee"), size: 3 });
    expect(snapshotTree([join(ROOT, "missing")]).size).toBe(0);
  });

  test("records a symlink by its target and never follows it", () => {
    const dir = tree("links", { "outside/secret.txt": "one", "root/keep.txt": "keep" });
    const root = join(dir, "root");
    symlinkSync(join("..", "outside"), join(root, "dna"));
    const snapshot = snapshotTree([root]);
    expect([...snapshot.keys()]).toEqual([join(root, "dna"), join(root, "keep.txt")]);
    // The link target is recorded as the platform spells it: `..\outside` on Windows.
    expect(snapshot.get(join(root, "dna"))).toEqual({ sha256: sha(join("..", "outside")), size: 10, link: join("..", "outside") });

    writeFileSync(join(dir, "outside", "secret.txt"), "two", "utf8");
    expect(diffTreeSnapshots(snapshot, snapshotTree([root]))).toEqual({ added: [], removed: [], changed: [] });

    rmSync(join(root, "dna"));
    symlinkSync(join("..", "elsewhere"), join(root, "dna"));
    expect(diffTreeSnapshots(snapshot, snapshotTree([root])).changed).toEqual([join(root, "dna")]);
  });

  test("prunes skipDirs and walks a nested root once", () => {
    const dir = tree("pruned", { "squad.yaml": "name: x\n", "node_modules/dep/index.js": "x", "sub/file.md": "y" });
    expect([...snapshotTree([dir]).keys()]).toContain(join(dir, "node_modules", "dep", "index.js"));
    const pruned = snapshotTree([join(dir, "sub"), dir], { skipDirs: new Set(["node_modules"]) });
    expect([...pruned.keys()]).toEqual([join(dir, "squad.yaml"), join(dir, "sub", "file.md")]);
  });
});

describe("diffTreeSnapshots", () => {
  test("labels a same-size edit, an added file and a removed file", () => {
    const dir = tree("delta", { "keep.md": "same", "edit.md": "before", "gone.md": "bye" });
    const before = snapshotTree([dir]);
    writeFileSync(join(dir, "edit.md"), "beforf", "utf8");
    writeFileSync(join(dir, "new.md"), "hello", "utf8");
    rmSync(join(dir, "gone.md"));
    expect(diffTreeSnapshots(before, snapshotTree([dir]))).toEqual({
      added: [join(dir, "new.md")], removed: [join(dir, "gone.md")], changed: [join(dir, "edit.md")],
    });
  });
});
