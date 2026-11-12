// fast-is-not-advertised.test.ts — the keyword router is not offered to agents,
// and since 2026-10-13 it decides nothing.
//
// It used to be sold in the highest-reach surface the system has: the harness
// SKILL.md `description`, the first thing any runtime reads to decide whether to
// activate. The sentence ended "Agentic by default; a `fast` BM25 mode gives
// zero-token deterministic routing" — a pitch for the worse mode, on the most
// tempting axis an agent has.
//
// Measured at 0.224 top-1 against real first-touch briefs, and on 48 labeled
// requests (2026-10-13) AMBIGUOUS for 42 with the right business for 4 of 42,
// the mode was retired as a decider: `--mode=fast` and `nrv config set
// routing.mode fast` are refused, and a stored value reads as the profile
// default with one warning (routing-fast-retired.e2e.test.ts, settings.test.ts).
// BM25 stays as the retriever behind `nrv find` and the clone search.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(import.meta.dir, "..", "..", "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/** `fast` as the routing mode — not "faster", not the `test:fast` script. */
const advertises = (text: string): string[] =>
  text.split("\n").filter((l) =>
    /`fast`|fast mode|fast-mode|mode.{0,12}fast|fast.{0,6}BM25|BM25.{0,6}fast/i.test(l)
    && !/test:fast/.test(l));

describe("no agent-facing surface offers it", () => {
  test.each([
    ["skills/harness/SKILL.md", "the orchestrator protocol, description included"],
    ["AGENTS.md", "the project contract"],
    ["CLAUDE.md", "the same contract, Claude's filename"],
    ["GEMINI.md", "the same contract, the filename agy also reads"],
    ["skills/_shared/templates/AGENTS.md", "what `nrv init` writes into a project"],
    ["skills/harness/lib/business-solo.ts", "the business worker's prompt"],
  ])("%s — %s", (file) => {
    expect(advertises(read(file))).toEqual([]);
  });

  test("the skill description, which is what a runtime reads first", () => {
    const front = read("skills/harness/SKILL.md").split("---")[1] ?? "";
    expect(front.toLowerCase()).not.toContain("fast");
    expect(front.toLowerCase()).not.toContain("bm25");
  });
});

describe("the decider's CLI is not in the user-facing help", () => {
  const commands = read("skills/harness/lib/commands.ts");
  const visibilityOf = (name: string): string | null =>
    commands.match(new RegExp(`\\{ name: "${name}",[^}]*visibility: "(\\w+)"`))?.[1] ?? null;

  test("`nrv route` is a dev diagnostic", () => {
    expect(visibilityOf("route")).toBe("dev");
  });

  test("`nrv find` is the orchestrator's shortlist step, so it is in the user-facing help", () => {
    // The 0.15 harness runs `nrv find` first and reads what it returns; the
    // choice stays the orchestrator's. A command the protocol calls on every
    // request cannot be filed under ADVANCED.
    expect(visibilityOf("find")).toBe("user");
    expect(commands.match(/\{ name: "find",[^}]*category: "(\w+)"/)?.[1]).not.toBe("dev");
  });

  test("the RETRIEVER stays, because Phase 3 surveys with it", () => {
    // `nrv search` and `nrv find-clone` surface candidates for the orchestrator
    // to READ. Hiding them would cut the agentic pipeline's own recall step.
    expect(visibilityOf("search")).toBe("user");
    expect(visibilityOf("find-clone")).toBe("user");
  });
});

describe("nothing can choose it any more", () => {
  test("the schema has no fast mode and no BM25 fallback, only their retirement", async () => {
    const { SETTINGS } = await import("../../_shared/lib/settings-schema.ts");
    expect(SETTINGS["routing.mode"].options).toEqual(["agentic", "cards"]);
    expect(Object.keys(SETTINGS["routing.mode"].retired ?? {})).toEqual(["fast"]);
    expect(SETTINGS["routing.on_router_failure"].options).toEqual(["agent-x-only", "fail"]);
    expect(SETTINGS["routing.on_router_failure"].retired?.cascade?.to).toBe("agent-x-only");
  });

  test("the dispatcher has no BM25 pick left to call", () => {
    const src = read("skills/harness/scripts/dispatch.ts");
    expect(src).not.toContain("fastBm25Business");
    expect(src).not.toContain("fastRoute");
    expect(src).toContain("--mode=fast was retired");
    expect(read("skills/harness/lib/dispatch-cascade.ts")).not.toContain("fastRoute");
  });
});
