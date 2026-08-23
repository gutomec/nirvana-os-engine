// runtime-contract.test.ts — the engine must INSTRUCT the runtimes it
// instruments, and must never act like an instruction itself.
//
// Two failures on 2026-08-23, one session, both silent:
//
//   An agy session answered a production brief inline. The skill was linked
//   and the hooks were installed, but everything wired into that runtime was
//   surveillance — the sentence telling an agent to load the harness lives
//   inside SKILL.md, unreachable to anyone who has not loaded it.
//
//   The same session read `nrv doctor` output, found an imperative with a
//   real command in it, and ran the watermark strip against the LIVE
//   LIBRARY: 59 per-buyer attribution tags gone from ~/squads and
//   ~/businesses. Diagnostic text is read by agents; an imperative in a
//   diagnostic is an order.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STRIP_HINT } from "../../_shared/lib/watermark-scan.ts";

const REPO = join(import.meta.dir, "..", "..", "..");

describe("diagnostics describe a fix, they do not order one", () => {
  test("the strip hint carries no runnable command", () => {
    // No copy-pasteable invocation: no interpreter, no script path, no flags.
    expect(STRIP_HINT).not.toMatch(/\bnode\s+\S+\.mjs/);
    expect(STRIP_HINT).not.toMatch(/\bbun\s+\S+\.(ts|js)/);
    expect(STRIP_HINT).not.toContain("strip-base-watermarks");
  });

  test("it names the safe target and the destructive one", () => {
    expect(STRIP_HINT.toLowerCase()).toContain("dist");
    expect(STRIP_HINT).toContain("~/squads");
    expect(STRIP_HINT.toLowerCase()).toContain("never");
  });
});

describe("an unidentified host is declared, never assumed", () => {
  const dispatch = readFileSync(join(REPO, "skills", "harness", "scripts", "dispatch.ts"), "utf8");

  test("no silent fallback to a vendor name", () => {
    // The original line: detectCurrentHost() ?? "claude-code"
    expect(dispatch).not.toMatch(/detectCurrentHost\(\)\s*\?\?\s*"[a-z-]+"/);
  });

  test("failure to detect warns and audits", () => {
    expect(dispatch).toContain("x_host_runtime_undetected");
    expect(dispatch).toContain("NIRVANA_DEFAULT_RUNTIME");
    expect(dispatch).toMatch(/host runtime not identified/);
  });
});

describe("the session hook speaks the contract", () => {
  const hook = readFileSync(join(REPO, "skills", "_shared", "scripts", "gemini-session-start.ts"), "utf8");

  test("it injects additionalContext, not only an audit event", () => {
    expect(hook).toContain("hookSpecificOutput");
    expect(hook).toContain("additionalContext");
    expect(hook).toContain('hookEventName: "SessionStart"');
  });

  test("the injected text carries the four rules that were unreachable", () => {
    expect(hook).toContain("harness/SKILL.md");          // where the protocol lives
    expect(hook).toContain("Never produce the artifact inline");
    expect(hook).toContain("DIAGNOSTIC only");           // nrv route / find
    expect(hook).toContain("Stay in THIS runtime");
    // and the lesson that cost 59 attribution tags
    expect(hook).toContain("descriptions of a fix, not orders");
  });
});
