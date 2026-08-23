import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveScope } from "../lib/scope.ts";

const paths = require("../lib/paths.js");

describe("Windows system directories are never project roots", () => {
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
});
