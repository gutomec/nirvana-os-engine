import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const hookInstaller = fs.readFileSync(path.join(ROOT, "skills/_shared/scripts/install.ts"), "utf8");

describe("agent hook command portability", () => {
  test("does not append shell-specific null-device redirections", () => {
    expect(hookInstaller).not.toContain("HOOK_SUPPRESS");
    expect(hookInstaller).not.toMatch(/2\s*>\s*(?:nul|\/dev\/null)/i);
  });
});
