import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyPackAssetCopies, PackAssetCopyFailure, writeFileAtomically } from "../lib/installer.ts";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nrv-pack-rollback-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pack asset copy rollback", () => {
  test("restores category metadata after a partial atomic replacement", () => {
    const root = tempRoot();
    const metadata = join(root, ".pack-categories.json");
    writeFileSync(metadata, "original");

    expect(() => writeFileAtomically(metadata, "replacement", {
      renameFile(source, destination) {
        if (source.includes(".tmp.")) {
          writeFileSync(destination, "partial");
          throw new Error("injected atomic rename failure");
        }
        renameSync(source, destination);
      },
    })).toThrow("injected atomic rename failure");

    expect(readFileSync(metadata, "utf8")).toBe("original");
    expect(readdirSync(root).some((name) => name.includes(".tmp.") || name.includes(".bak."))).toBe(false);
  });

  test("preserves original metadata when creating its atomic backup fails", () => {
    const root = tempRoot();
    const metadata = join(root, ".pack-categories.json");
    writeFileSync(metadata, "original");

    expect(() => writeFileAtomically(metadata, "replacement", {
      renameFile(source, destination) {
        if (source === metadata) throw new Error("injected backup rename failure");
        renameSync(source, destination);
      },
    })).toThrow("injected backup rename failure");

    expect(readFileSync(metadata, "utf8")).toBe("original");
    expect(readdirSync(root).some((name) => name.includes(".tmp.") || name.includes(".bak."))).toBe(false);
  });

  test("removes a partial metadata file when no original existed", () => {
    const root = tempRoot();
    const metadata = join(root, ".pack-categories.json");

    expect(() => writeFileAtomically(metadata, "replacement", {
      renameFile(source, destination) {
        if (source.includes(".tmp.")) {
          writeFileSync(destination, "partial");
          throw new Error("injected first promotion failure");
        }
        renameSync(source, destination);
      },
    })).toThrow("injected first promotion failure");

    expect(existsSync(metadata)).toBe(false);
    expect(readdirSync(root).some((name) => name.includes(".tmp.") || name.includes(".bak."))).toBe(false);
  });

  test("removes a partially created destination when copy fails", () => {
    const root = tempRoot();
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(source);

    expect(() => applyPackAssetCopies(
      [{ srcDir: source, targetDir: target }],
      (_src, destination) => {
        mkdirSync(destination, { recursive: true });
        writeFileSync(join(destination, "partial.txt"), "partial");
        throw new Error("injected copy failure");
      },
    )).toThrow("injected copy failure");

    expect(existsSync(target)).toBe(false);
  });

  test("restores a forced-install backup after partial copy failure", () => {
    const root = tempRoot();
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(source);
    mkdirSync(target);
    writeFileSync(join(target, "original.txt"), "original");

    expect(() => applyPackAssetCopies(
      [{ srcDir: source, targetDir: target, previousVersion: "1.0.0" }],
      (_src, destination) => {
        mkdirSync(destination, { recursive: true });
        writeFileSync(join(destination, "partial.txt"), "partial");
        throw new Error("injected copy failure");
      },
    )).toThrow("injected copy failure");

    expect(readFileSync(join(target, "original.txt"), "utf8")).toBe("original");
    expect(existsSync(join(target, "partial.txt"))).toBe(false);
    expect(readdirSync(root).some((name) => name.includes(".bak."))).toBe(false);
  });

  test("rolls back copied assets when downstream category metadata fails", () => {
    const root = tempRoot();
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(source);
    writeFileSync(join(source, "asset.txt"), "asset");

    expect(() => applyPackAssetCopies(
      [{ srcDir: source, targetDir: target }],
      undefined,
      () => { throw new Error("category metadata write failed"); },
    )).toThrow("category metadata write failed");

    expect(existsSync(target)).toBe(false);
  });

  test("continues rollback and reports a missing backup precisely", () => {
    const root = tempRoot();
    const source = join(root, "source");
    mkdirSync(source);
    writeFileSync(join(source, "asset.txt"), "new");
    const targets = [join(root, "first"), join(root, "second")];
    for (const target of targets) {
      mkdirSync(target);
      writeFileSync(join(target, "original.txt"), target);
    }

    let failure: PackAssetCopyFailure | undefined;
    try {
      applyPackAssetCopies(
        targets.map((targetDir) => ({ srcDir: source, targetDir, previousVersion: "1.0.0" })),
        undefined,
        () => {
          const missing = readdirSync(root).find((name) => name.startsWith("second.1.0.0.bak."));
          if (!missing) throw new Error("test backup not found");
          rmSync(join(root, missing), { recursive: true, force: true });
          throw new Error("downstream failure");
        },
      );
    } catch (error) {
      failure = error as PackAssetCopyFailure;
    }

    expect(failure).toBeInstanceOf(PackAssetCopyFailure);
    expect(failure?.rolledBack).toBe(1);
    expect(failure?.rollbackErrors.some((error) => error.includes("backup missing"))).toBe(true);
    expect(readFileSync(join(targets[0], "original.txt"), "utf8")).toBe(targets[0]);
    expect(existsSync(targets[1])).toBe(false);
  });
});
