// dispatch-depth.test.ts — agents dispatching agents is bounded, and the bound
// is finite.
//
// Reported from a live run: two dispatches became fifteen running agents. Each
// one the owner started opened its own subagents, those opened more, and one
// produced a fork that looped against the orchestration rule of the project's
// own contract. Nothing in the engine bounded any of it.
import { describe, expect, test } from "bun:test";
import { childDepth, currentDepth, DEFAULT_MAX_DEPTH, DEPTH_ENV, mayDispatch, refusalMessage } from "../lib/dispatch-depth.ts";

describe("reading the depth", () => {
  test("an absent stamp is the operator's own session", () => {
    expect(currentDepth({})).toBe(0);
    expect(childDepth({})).toBe(1);
  });

  test("the stamp is read as a number", () => {
    expect(currentDepth({ [DEPTH_ENV]: "2" })).toBe(2);
    expect(childDepth({ [DEPTH_ENV]: "2" })).toBe(3);
  });

  test("junk, empty and negative values fall back to the operator's depth, never above it", () => {
    for (const raw of ["", "  ", "abc", "-4", "0", "NaN", "1.9e999"]) {
      expect(currentDepth({ [DEPTH_ENV]: raw })).toBeLessThanOrEqual(1);
    }
    // "1.9" parses to 1 — a partial number is read, never rejected into 0,
    // because rounding DOWN a depth is the permissive direction and this
    // counter only exists to be restrictive.
    expect(currentDepth({ [DEPTH_ENV]: "3.7" })).toBe(3);
  });
});

describe("the ceiling", () => {
  test("the default clears every nesting the engine performs on purpose", () => {
    expect(DEFAULT_MAX_DEPTH).toBe(3);
    // business at 1, one of its seats at 2, a mandatory squad or judge at 3.
    expect(mayDispatch(DEFAULT_MAX_DEPTH, {})).toBe(true);
    expect(mayDispatch(DEFAULT_MAX_DEPTH, { [DEPTH_ENV]: "1" })).toBe(true);
    expect(mayDispatch(DEFAULT_MAX_DEPTH, { [DEPTH_ENV]: "2" })).toBe(true);
  });

  test("and stops the run away one step later", () => {
    expect(mayDispatch(DEFAULT_MAX_DEPTH, { [DEPTH_ENV]: "3" })).toBe(false);
    expect(mayDispatch(DEFAULT_MAX_DEPTH, { [DEPTH_ENV]: "9" })).toBe(false);
  });

  test("zero or less means unlimited, the way every other cap in this engine spells it", () => {
    for (const max of [0, -1]) {
      expect(mayDispatch(max, { [DEPTH_ENV]: "50" })).toBe(true);
    }
  });

  test("a ceiling of 1 lets the operator dispatch and lets no one re-dispatch", () => {
    expect(mayDispatch(1, {})).toBe(true);
    expect(mayDispatch(1, { [DEPTH_ENV]: "1" })).toBe(false);
  });

  test("a non-finite ceiling is treated as unlimited rather than as zero", () => {
    expect(mayDispatch(Number.NaN, { [DEPTH_ENV]: "9" })).toBe(true);
    expect(mayDispatch(Number.POSITIVE_INFINITY, { [DEPTH_ENV]: "9" })).toBe(true);
  });
});

describe("the refusal", () => {
  test("names both numbers and the setting, and says what to do instead", () => {
    const m = refusalMessage(3, { [DEPTH_ENV]: "3" });
    expect(m).toContain("depth 3");
    expect(m).toContain("ceiling is 3");
    expect(m).toContain("execution.max_dispatch_depth");
    expect(m).toContain("must DO the work, not delegate it");
  });
});

describe("the contract tells a dispatched child which role it has", () => {
  test("section 0.5 decides the role from the stamp before claiming the orchestrator role", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.join(import.meta.dir, "..", "..", "..");
    for (const f of ["AGENTS.md", "CLAUDE.md", "GEMINI.md", path.join("skills", "_shared", "templates", "AGENTS.md")]) {
      const text = fs.readFileSync(path.join(root, f), "utf8");
      const section = text.slice(text.indexOf("## 0.5."), text.indexOf("## 1."));
      expect(section).toContain(DEPTH_ENV);
      expect(section).toContain("you are a dispatched executor");
      // The check has to come BEFORE the orchestrator claim, or a child reads
      // the wrong role first and acts on it.
      expect(section.indexOf(DEPTH_ENV)).toBeLessThan(section.indexOf("you are the orchestrator"));
    }
  });
});
