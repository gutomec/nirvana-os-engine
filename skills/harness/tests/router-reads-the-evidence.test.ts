// router-reads-the-evidence.test.ts — a manifest is a claim; the directory
// beside it is the evidence.
//
// The agentic router surveyed the digest — slug, description, domains,
// produces, capability ids, two example briefs, not_for — and its escalation
// clause said, literally, "Read a full manifest ONLY". So the deepest it could
// ever look was `squad.yaml`. Two squads whose manifests read alike are
// routinely far apart once you open them: one has three agents and a two-step
// workflow, the other has eight agents, typed tasks and a gate. Choosing
// between similar CLAIMS is not the same as choosing between capabilities, and
// it is the failure this contract closes.
//
// The three branches, as the owner specified them (2026-09-20):
//
//   neighbours present  → compare them agentically, reading agents, tasks and
//                         workflows, and pick the one most capable of THIS brief
//   exactly one fits    → use it; there is nothing to ask about
//   nothing fits        → agent-x, which is a real execution and not a failure
import { describe, expect, test } from "bun:test";
import { buildRouterPrompt } from "../lib/agentic-router.ts";
import * as fs from "node:fs";
import * as path from "node:path";

const prompt = buildRouterPrompt("/tmp/brief.md", "/tmp/digest.md");

describe("what the router is told it may open", () => {
  test.each([
    ["agents/*.md", "who actually executes"],
    ["tasks/*.md", "the unit of work and its acceptance"],
    ["workflows/*", "the pipeline and its gates"],
    ["employees/*.md", "a business org chart"],
  ])("%s — %s", (needle) => {
    expect(prompt).toContain(needle);
  });

  test("the old manifest-only ceiling is gone", () => {
    expect(prompt).not.toContain("Read a full manifest ONLY");
  });

  test("and the survey is still the digest, never the registries", () => {
    expect(prompt).toContain("the digest IS the survey");
  });
});

describe("the three branches", () => {
  test("several candidates: open and compare, do not flip a coin", () => {
    expect(prompt).toContain("OPEN THEM AND COMPARE");
    expect(prompt).toMatch(/ambiguous[^.]*only when they are genuinely equivalent/i);
  });

  test("exactly one candidate: dispatch it, never ask", () => {
    expect(prompt).toContain("Exactly one candidate can deliver the OBJECT");
    expect(prompt).toContain("asking is a refusal wearing a question mark");
  });

  test("nothing fits: agent-x, and it is an execution", () => {
    expect(prompt).toContain("no_match");
    expect(prompt).toContain("agent-x");
  });

  test("the decision is made against what is INSTALLED, not what usually exists", () => {
    expect(prompt).toMatch(/not the library the next machine has/i);
  });
});

describe("the digest header points at the evidence too", () => {
  const src = fs.readFileSync(path.join(import.meta.dir, "..", "scripts", "build-routing-digest.ts"), "utf8");

  test("squads escalate to their agents, tasks and workflows", () => {
    expect(src).toContain("agents/*.md, tasks/*.md, workflows/*");
  });

  test("businesses escalate to their org chart", () => {
    expect(src).toContain("employees/*.md");
  });

  test("and the header says why", () => {
    expect(src).toContain("a manifest is a claim; the files beside it are the evidence");
  });
});
