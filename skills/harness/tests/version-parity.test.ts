/**
 * The engine states its version in three places, read by different people.
 *
 * `package.json` is what the tag and the release workflow track. `CHANGELOG.md`
 * is what a user reads to decide whether to update. And `skills/VERSION` is a
 * loose file copied verbatim into the installed skills directory — the FIRST
 * thing `nrv --version` reads, so it is the number a user sees when they ask
 * what they are running.
 *
 * On the 0.6.0 release the first two moved and the third did not. Every user of
 * 0.6.0 would have been told they were on 0.5.2, with no check failing and no
 * warning printed. It surfaced only because someone ran `nrv --version` on their
 * own machine after the release had shipped.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const GATE = join(REPO, "scripts", "check-version-parity.ts");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

describe("one version, told the same way everywhere", () => {
  test("skills/VERSION matches package.json", () => {
    // This is the pairing that broke. `nrv --version` prefers skills/VERSION and
    // falls back to package.json, so a stale VERSION is silent and total.
    expect(read("skills/VERSION").trim()).toBe(JSON.parse(read("package.json")).version);
  });

  test("the newest changelog entry is the version being shipped", () => {
    expect(read("CHANGELOG.md").match(/^## (\d+\.\d+\.\d+)/m)?.[1]).toBe(JSON.parse(read("package.json")).version);
  });

  test("the localized changelog leads with the same version", () => {
    expect(read("CHANGELOG.pt-BR.md").match(/^## (\d+\.\d+\.\d+)/m)?.[1])
      .toBe(read("CHANGELOG.md").match(/^## (\d+\.\d+\.\d+)/m)?.[1]);
  });

  test("the gate passes on this tree and fails loudly when it should not", () => {
    const r = spawnSync(process.execPath, [GATE, "--strict"], { cwd: REPO, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(`${r.stdout ?? ""}`).toContain("All three agree");
  });

  test("`nrv --version` reads skills/VERSION first", () => {
    // The gate's whole premise. If the CLI ever stops preferring that file, the
    // pairing this suite protects is the wrong one.
    //
    // Anchored on the file read, not on the case label: `version|--version` also
    // appears in the update-notice guard near the top, and matching that one
    // asserted nothing about the version command at all.
    const cli = readFileSync(join(REPO, "bin", "nrv"), "utf8");
    const readsVersionFile = cli.indexOf('if [ -f "$SKILLS/VERSION" ]');
    const fallsBackToPkg = cli.indexOf('"$SKILLS/../package.json"');
    expect(readsVersionFile).toBeGreaterThan(-1);
    expect(fallsBackToPkg).toBeGreaterThan(readsVersionFile);
  });
});
