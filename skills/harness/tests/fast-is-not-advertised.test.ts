// fast-is-not-advertised.test.ts — the keyword router is not offered to agents.
//
// It used to be sold in the highest-reach surface the system has: the harness
// SKILL.md `description`, the first thing any runtime reads to decide whether to
// activate. The sentence ended "Agentic by default; a `fast` BM25 mode gives
// zero-token deterministic routing" — a pitch for the worse mode, on the most
// tempting axis an agent has. The project contract then spent a paragraph
// forbidding it, which is weaker than silence: a prohibition teaches the
// shortcut exists and then asks for restraint.
//
// Measured at 0.224 top-1 against real first-touch briefs, it loses the right
// destination in two thirds of them. It stays in the engine because a user may
// ask for it by name; it leaves every surface an agent reads.
//
// Concealment alone would be worse than the advertising it replaced, so it is
// paired: a machine that INHERITED `fast` (a config file, an env var set months
// ago) says so out loud on every dispatch, because the agent driving that run
// has never been told the mode exists and could not otherwise name what it is
// seeing. Silent when chosen for a run; loud when inherited.
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
    ["GEMINI.md", "the same contract, Gemini's filename"],
    ["skills/_shared/templates/AGENTS.md", "what `nrv init` writes into a project"],
    ["skills/businesses/lib/employee-prompt.ts", "a seat's prompt"],
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

  test.each(["route", "find"])("`nrv %s` is a dev diagnostic", (cmd) => {
    expect(visibilityOf(cmd)).toBe("dev");
  });

  test("the RETRIEVER stays, because Phase 3 surveys with it", () => {
    // `nrv search` and `nrv find-clone` surface candidates for the orchestrator
    // to READ. Hiding them would cut the agentic pipeline's own recall step.
    expect(visibilityOf("search")).toBe("user");
    expect(visibilityOf("find-clone")).toBe("user");
  });
});

describe("inherited is not the same as chosen", () => {
  test("the origin of the mode is distinguishable", async () => {
    const m = await import("../../_shared/lib/routing-mode.ts");
    expect(m.routingModeOrigin("fast")).toBe("flag");
    const prev = process.env.NIRVANA_ROUTING_MODE;
    process.env.NIRVANA_ROUTING_MODE = "fast";
    try { expect(m.routingModeOrigin()).toBe("env"); }
    finally { if (prev === undefined) delete process.env.NIRVANA_ROUTING_MODE; else process.env.NIRVANA_ROUTING_MODE = prev; }
  });

  test("the dispatcher warns on an inherited mode and stays quiet on a chosen one", () => {
    const src = read("skills/harness/scripts/dispatch.ts");
    expect(src).toContain(`routingModeOrigin(arg("--mode")) !== "flag"`);
    expect(src).toContain("nrv config unset routing.mode");
  });
});
