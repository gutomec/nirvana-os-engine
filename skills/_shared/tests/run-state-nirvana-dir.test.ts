/**
 * `.nirvana` inside an entity is run state, and run state never ships.
 *
 * The regression this locks. Running ANY `nrv` command with the cwd inside a
 * squad materializes a `.nirvana/` there — registries, routing digest, verify
 * state — and those files carry absolute paths into the author's home
 * (`/Users/<name>/…`). Measured 2026-09-03: three squads in the live library had
 * picked one up during an audit campaign, and `RUN_STATE_EXCLUDES` did not name
 * `.nirvana`, so the next pack build would have copied the author's paths into
 * every buyer's artifact.
 *
 * `isRunStatePath` is what the installer, the uninstaller, the migrator and the
 * pack build all consult, so the entry has to hold there, not merely in the
 * array.
 */

import { describe, test, expect } from "bun:test";
import { RUN_STATE_EXCLUDES, isRunStatePath } from "../lib/run-state.ts";

describe("`.nirvana` is run state for squads and businesses", () => {
  test("it is named in the exclusion list of both kinds", () => {
    expect(RUN_STATE_EXCLUDES.squads).toContain(".nirvana");
    expect(RUN_STATE_EXCLUDES.businesses).toContain(".nirvana");
  });

  test("a path inside it is run state, at the root and nested", () => {
    // The shapes a real leak takes: the registries and the digest the engine
    // writes when a command runs with the cwd inside the entity.
    expect(isRunStatePath(".nirvana", "squads")).toBe(true);
    expect(isRunStatePath(".nirvana/.squads-registry.json", "squads")).toBe(true);
    expect(isRunStatePath(".nirvana/state/squads/x/verify.json", "squads")).toBe(true);
    expect(isRunStatePath(".nirvana/.routing-digest.md", "businesses")).toBe(true);
  });

  test("the entity's own content is untouched by the rule", () => {
    // The guard must not widen: these are the files a squad ships.
    for (const p of ["squad.yaml", "agents/x.md", "tasks/y.md", "references/z.md"]) {
      expect(isRunStatePath(p, "squads")).toBe(false);
    }
    // A file that merely starts with the same letters is not the directory.
    expect(isRunStatePath(".nirvana-surface.json", "squads")).toBe(false);
  });
});
