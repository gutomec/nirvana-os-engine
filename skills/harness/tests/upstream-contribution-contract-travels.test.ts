// upstream-contribution-contract-travels.test.ts — engine/core fixes and ideas
// must reach both the harness orchestrator and every project runtime without
// turning consent into an implied GitHub write.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), "utf8");

const effectiveSources = [
  ["harness", read("skills/harness/SKILL.md")],
  ["nrv init template", read("skills/_shared/templates/AGENTS.md")],
  ["repository contract", read("AGENTS.md")],
] as const;

function upstreamContract(source: string): string {
  const startMarker = "<!-- nirvana:upstream-contribution:v1 -->";
  const endMarker = "<!-- /nirvana:upstream-contribution:v1 -->";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + endMarker.length);
}

describe("the upstream contribution offer reaches every orchestrator path", () => {
  test.each(effectiveSources)("%s carries both qualified triggers and the exclusions", (_name, source) => {
    const contract = upstreamContract(source);
    expect(contract).toMatch(/confirmed\s+(?:defect|correction|fix)[\s\S]*shared\s+(?:Nirvana\s+)?engine\/core/i);
    expect(contract).toMatch(/improvement idea[\s\S]*shared (?:Nirvana )?engine\/core/i);
    for (const excluded of [/project-only/i, /personal configuration/i, /user\s+content/i, /paid packs/i, /unverified (?:hypotheses|hypothesis)/i]) {
      expect(contract).toMatch(excluded);
    }
  });

  test.each(effectiveSources)("%s requires initial consent before GitHub mutation", (_name, source) => {
    const contract = upstreamContract(source);
    expect(contract).toMatch(/finish[\s\S]*validate[\s\S]*local workaround[\s\S]*offer/i);
    expect(contract).toMatch(/initial consent[\s\S]*(?:fork|branch)[\s\S]*push[\s\S]*(?:PR|pull request)/i);
    expect(contract).toMatch(/after initial consent[\s\S]*equivalent open (?:PR|pull request)/i);
  });

  test.each(effectiveSources)("%s requires a complete preview and final publication approval", (_name, source) => {
    const contract = upstreamContract(source);
    expect(contract).toMatch(/complete proposed PR title and body[\s\S]*explicit final approval/i);
    expect(contract).toMatch(/ready for review by default/i);
    expect(contract).toMatch(/draft\s+only\s+when[\s\S]*concrete\s+blocker/i);
    expect(contract).toMatch(/improvement idea[\s\S]*concrete change[\s\S]*implement[\s\S]*test/i);
  });

  test.each(effectiveSources)("%s handles the contributor CLA conditionally", (_name, source) => {
    const contract = upstreamContract(source);
    expect(contract).toMatch(/CLA\s+signatures?\s+(?:are|is)\s+normally\s+one-time/i);
    expect(contract).toMatch(/already\s+satisfied[\s\S]*report\s+that[\s\S]*without\s+asking\s+again/i);
    expect(contract).toMatch(/if (?:the )?CLA check[\s\S]*requires a signature/i);
    expect(contract).toMatch(/requires a signature[\s\S]*give the user the PR\s+link/i);
    expect(contract).toContain("I have read the CLA Document and I hereby sign the CLA");
    expect(contract).toMatch(/do not sign[\s\S]*(?:for|on behalf of) the user/i);
  });
});

describe("the project contract reaches the runtime-specific files", () => {
  test("nrv init consumes the protected template", () => {
    const init = read("skills/_shared/scripts/init-project.ts");
    expect(init).toContain('"_shared", "templates", "AGENTS.md"');
  });

  test("root runtime instruction copies are byte-identical", () => {
    const canonical = read("AGENTS.md");
    expect(read("CLAUDE.md")).toBe(canonical);
    expect(read("GEMINI.md")).toBe(canonical);
  });
});
