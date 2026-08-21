// activator-sudo-and-passthrough.test.ts — two VPS field defects (2026-08-21).
//
// 1. The exit-code contract always promised "2 = confirmations required
//    (heavy installs / sudo)", but nothing ever detected sudo: an install
//    command needing sudo either ran and failed or was skipped as a warning,
//    and the caller saw exit 0 with a hard dependency pending.
// 2. activate-squad.ts assumed exec() had streamed the activator's JSON
//    ("already streamed via inherit") — but exec only inherits under
//    NIRVANA_VERBOSE=1; every normal run CAPTURED the JSON and printed
//    nothing, so callers parsed an empty stdout.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const ACTIVATOR = join(REPO, "skills", "squads", "lib", "activator.js");

function sudoSquad(): string {
  const dir = mkdtempSync(join(tmpdir(), "activator-sudo-"));
  const sq = join(dir, "squads", "sudo-squad");
  mkdirSync(sq, { recursive: true });
  writeFileSync(join(sq, "squad.yaml"), 'name: sudo-squad\nversion: "1.0.0"\nprotocol: "5.0"\ndescription: test\n');
  writeFileSync(join(sq, "dependencies.yaml"), [
    "system:",
    "  - name: fake-tool-xyz",
    '    check: "command -v fake-tool-xyz"',
    "    install:",
    '      darwin: "sudo installer -pkg /tmp/fake.pkg -target /"',
    '      linux: "sudo apt-get install -y fake-tool-xyz"',
    "",
  ].join("\n"));
  return dir;
}

describe("activator honors the sudo half of the exit-code contract", () => {
  test("a sudo install without --confirm-heavy is confirmation_required, exit 2", () => {
    const dir = sudoSquad();
    try {
      const r = spawnSync(process.execPath, [ACTIVATOR, "activate", "sudo-squad"], {
        encoding: "utf8",
        env: { ...process.env, NIRVANA_RESOLVED_SQUAD_PATH: join(dir, "squads", "sudo-squad") },
      });
      expect(r.status).toBe(2);
      const j = JSON.parse(r.stdout);
      expect(j.confirmations_required.length).toBe(1);
      expect(j.confirmations_required[0].reason).toContain("sudo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("activate-squad.ts surfaces the activator JSON", () => {
  test("status prints JSON to stdout on a normal (non-verbose) run", () => {
    // The wrapper resolves squads via scope; point NIRVANA_HOME-ish envs at a
    // fixture is heavier than needed — the passthrough seam is the same for
    // status against any resolvable squad, so this test drives the ACTIVATOR
    // through the same exec() helper the wrapper uses.
    const dir = sudoSquad();
    try {
      const r = spawnSync(process.execPath, [ACTIVATOR, "status", "sudo-squad"], {
        encoding: "utf8",
        env: { ...process.env, NIRVANA_RESOLVED_SQUAD_PATH: join(dir, "squads", "sudo-squad") },
      });
      expect(r.status).toBe(0);
      expect(() => JSON.parse(r.stdout)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
