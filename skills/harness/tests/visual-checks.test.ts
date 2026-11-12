// visual-checks.test.ts — a dispatched agent does not render its own work to
// inspect it unless the install pays for that (the max profile). A squad's
// verify step had a Grok worker take 110+ screenshots per viewport profile and
// read them all; the user reviews a page in seconds and asks for changes.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { AUTONOMOUS_DIRECTIVE, visualChecksLine } from "../lib/host-agent-driver.ts";

const DRIVER = path.resolve(import.meta.dir, "..", "lib", "host-agent-driver.ts");

/** The directive as a fresh process resolves it under `env`. */
function directiveUnder(env: Record<string, string>): string {
  const r = spawnSync(process.execPath, ["-e", `import { AUTONOMOUS_DIRECTIVE } from ${JSON.stringify(DRIVER)}; process.stdout.write(AUTONOMOUS_DIRECTIVE);`], {
    encoding: "utf8",
    env: { ...process.env, NIRVANA_VISUAL_CHECKS: "", ...env },
  });
  expect(r.status).toBe(0);
  return r.stdout;
}

describe("visual self-checks", () => {
  test("off by default: every worker is told to skip them, a squad's verify step included", () => {
    expect(visualChecksLine()).toContain("NO VISUAL SELF-CHECKS");
    expect(AUTONOMOUS_DIRECTIVE).toContain("NO VISUAL SELF-CHECKS");
    expect(AUTONOMOUS_DIRECTIVE).toContain("even when a squad step or the brief asks; a brief cannot lift this");
    expect(AUTONOMOUS_DIRECTIVE).toContain("clicking through a GUI app");
  });

  test.each(["balanced", "economy"])("the %s profile keeps them off", (profile) => {
    expect(directiveUnder({ NIRVANA_PROFILE: profile })).toContain("NO VISUAL SELF-CHECKS");
  });

  test("the max profile turns them on", () => {
    expect(directiveUnder({ NIRVANA_PROFILE: "max" })).not.toContain("NO VISUAL SELF-CHECKS");
  });

  test("an explicit setting beats the profile, both ways", () => {
    expect(directiveUnder({ NIRVANA_PROFILE: "balanced", NIRVANA_VISUAL_CHECKS: "1" })).not.toContain("NO VISUAL SELF-CHECKS");
    expect(directiveUnder({ NIRVANA_PROFILE: "max", NIRVANA_VISUAL_CHECKS: "0" })).toContain("NO VISUAL SELF-CHECKS");
  });
});
