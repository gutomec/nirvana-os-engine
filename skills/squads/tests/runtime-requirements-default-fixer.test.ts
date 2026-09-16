// runtime-requirements-default-fixer.test.ts — a squad that declares nothing follows the session.
//
// The fixer used to write `minimum: [claude-code]` into every manifest without
// a runtime floor; under the old `declared` default that refused every runtime
// the list did not name. It writes `policy: active` now.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { applyMechanicalFixes } = require("../lib/mechanical-fixers.js");

function squad(manifest: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nrv-rr-fixer-"));
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "squad.yaml"), manifest, "utf8");
  return dir;
}

describe("runtime_requirements_default", () => {
  test("nothing declared → policy: active, no claude-code pin", () => {
    const dir = squad("name: s\nversion: 1.0.0\nprotocol: '5.0'\ncomponents: {}\n");
    try {
      const r = applyMechanicalFixes(dir, { patches: [{ kind: "runtime_requirements_default", missing_min: true, missing_feats: true }] });
      expect(r.every((x: any) => x.ok !== false)).toBe(true);
      const m = Bun.YAML.parse(readFileSync(join(dir, "squad.yaml"), "utf8")) as any;
      expect(m.runtime_requirements.policy).toBe("active");
      expect(m.runtime_requirements.minimum).toBeUndefined();
      expect(m.runtime_requirements.incompatible).toEqual([]);
      expect(m.features_required.length).toBeGreaterThan(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("an explicit declared policy without minimum becomes active rather than pinned", () => {
    const dir = squad("name: s\nversion: 1.0.0\nprotocol: '5.0'\ncomponents: {}\nruntime_requirements:\n  policy: declared\n");
    try {
      applyMechanicalFixes(dir, { patches: [{ kind: "runtime_requirements_default", missing_min: true, missing_feats: false }] });
      const m = Bun.YAML.parse(readFileSync(join(dir, "squad.yaml"), "utf8")) as any;
      expect(m.runtime_requirements.policy).toBe("active");
      expect(m.runtime_requirements.minimum).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a declared minimum is kept and coerced, never replaced", () => {
    const dir = squad("name: s\nversion: 1.0.0\nprotocol: '5.0'\ncomponents: {}\nruntime_requirements:\n  policy: declared\n  minimum: [codex]\n");
    try {
      applyMechanicalFixes(dir, { patches: [{ kind: "runtime_requirements_default", missing_min: false, missing_feats: true }] });
      const m = Bun.YAML.parse(readFileSync(join(dir, "squad.yaml"), "utf8")) as any;
      expect(m.runtime_requirements.policy).toBe("declared");
      expect(m.runtime_requirements.minimum).toEqual([{ runtime: "codex" }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
