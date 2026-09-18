// dispatch-depth.test.ts — agents dispatching agents is bounded, and the bound
// is finite.
//
// Reported from a live run: two dispatches became fifteen running agents. Each
// one the owner started opened its own subagents, those opened more, and one
// produced a fork that looped against the orchestration rule of the project's
// own contract. Nothing in the engine bounded any of it.
import { describe, expect, test } from "bun:test";
import { childDepth, currentDepth, currentRole, DEFAULT_MAX_DEPTH, DEPTH_ENV, mayDispatch, refusalMessage, roleMayDispatch, roleRefusalMessage, ROLE_ENV } from "../lib/dispatch-depth.ts";

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
  test("the default clears both topologies the engine actually walks", () => {
    expect(DEFAULT_MAX_DEPTH).toBe(4);
    // terminal: session 0 -> business 1 -> seat 2 -> squad 3.
    // Glance: the maestro is itself a child, so the same chain ends at 4.
    for (const depth of [0, 1, 2, 3]) {
      const env = depth === 0 ? {} : { [DEPTH_ENV]: String(depth) };
      expect(mayDispatch(DEFAULT_MAX_DEPTH, env)).toBe(true);
    }
  });

  test("and stops the run away one step later", () => {
    expect(mayDispatch(DEFAULT_MAX_DEPTH, { [DEPTH_ENV]: "4" })).toBe(false);
    expect(mayDispatch(DEFAULT_MAX_DEPTH, { [DEPTH_ENV]: "9" })).toBe(false);
  });

  test("a squad a Glance seat reaches for is inside the ceiling, which a 3 would have refused", () => {
    // The regression this number exists to avoid: legitimate work failing for
    // half the users, the ones who dispatch from the Glance chat.
    const glanceSeat = { [DEPTH_ENV]: "3" };
    expect(mayDispatch(3, glanceSeat)).toBe(false);
    expect(mayDispatch(DEFAULT_MAX_DEPTH, glanceSeat)).toBe(true);
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

describe("who may dispatch what", () => {
  // Owner's rule, 2026-09-18: "a business employee may use a squad, but may not
  // go dispatching like mad. And squads may NEVER dispatch. Only employees, who
  // may use squads to build their deliverable."
  const as = (role: string) => ({ [ROLE_ENV]: role });

  test("the operator's own session may dispatch anything", () => {
    for (const target of ["business", "employee", "squad", "agent-x", null] as const) {
      expect(roleMayDispatch(target, {})).toBe(true);
    }
    expect(currentRole({})).toBeNull();
  });

  test("a squad never dispatches, whatever the target and even when unknown", () => {
    for (const target of ["business", "employee", "squad", "agent-x", null] as const) {
      expect(roleMayDispatch(target, as("squad"))).toBe(false);
    }
  });

  test("an employee may open SEVERAL squads for one deliverable", () => {
    // Owner, 2026-09-18: "an employee can use more than one squad to generate
    // its deliverable. That has to be possible, because it happens often."
    // Nothing counts squads: each one is a sibling at the same depth, so the
    // allowance is about KIND, never about how many.
    const seat = as("employee");
    for (let i = 0; i < 12; i++) expect(roleMayDispatch("squad", seat)).toBe(true);
    // And they do not nest, so the ceiling is not consumed by the count.
    expect(mayDispatch(DEFAULT_MAX_DEPTH, { ...seat, [DEPTH_ENV]: "2" })).toBe(true);
  });

  test("an employee may open a squad, and may not convene another company", () => {
    expect(roleMayDispatch("squad", as("employee"))).toBe(true);
    expect(roleMayDispatch("business", as("employee"))).toBe(false);
    expect(roleMayDispatch("employee", as("employee"))).toBe(false);
    expect(roleMayDispatch("agent-x", as("employee"))).toBe(false);
  });

  test("a business opens its own chart and the squads its seats carry", () => {
    expect(roleMayDispatch("employee", as("business"))).toBe(true);
    expect(roleMayDispatch("squad", as("business"))).toBe(true);
    expect(roleMayDispatch("business", as("business"))).toBe(false);
  });

  test("the workers and the decision steps open nothing", () => {
    for (const role of ["agent-x", "planner"]) {
      expect(roleMayDispatch(null, as(role))).toBe(false);
      expect(roleMayDispatch("squad", as(role))).toBe(false);
    }
  });

  test("an unknown role stamp is read as the operator rather than silently blocking every run", () => {
    expect(currentRole(as("chief-vibes-officer"))).toBeNull();
    expect(roleMayDispatch("squad", as("chief-vibes-officer"))).toBe(true);
  });

  test("a refusal from an execute-only role says so, and names no setting to raise", () => {
    const m = roleRefusalMessage("squad", as("squad"));
    expect(m).toContain("a squad executes, it never dispatches");
    expect(m).not.toContain("max_dispatch_depth");
  });

  test("a refusal from a limited role names what it may open instead", () => {
    expect(roleRefusalMessage("business", as("employee"))).toContain("may dispatch only squad");
  });

  test("the role rule is independent of depth: a squad at depth 1 still opens nothing", () => {
    const squadAtDepthOne = { [ROLE_ENV]: "squad", [DEPTH_ENV]: "1" };
    expect(mayDispatch(DEFAULT_MAX_DEPTH, squadAtDepthOne)).toBe(true);
    expect(roleMayDispatch(null, squadAtDepthOne)).toBe(false);
  });
});

describe("every real dispatch site declares its role", () => {
  // Without a stamp the rule is advisory: an unstamped child reads as the
  // operator and may open anything. A new dispatch site that forgets this
  // reopens the incident, so the sites are asserted from source.
  test.each([
    ["skills/harness/lib/squad-exec.ts", 'dispatchRole: "squad"'],
    ["skills/harness/lib/team-orchestrator.ts", 'dispatchRole: "employee"'],
    ["skills/harness/lib/team-orchestrator.ts", 'dispatchRole: "planner"'],
    ["skills/harness/scripts/dispatch.ts", 'dispatchRole: "agent-x"'],
  ])("%s declares %s", async (file, needle) => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const text = fs.readFileSync(path.join(import.meta.dir, "..", "..", "..", file), "utf8");
    expect(text).toContain(needle);
  });
});
