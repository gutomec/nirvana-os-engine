// brief-altitude-surfaces.test.ts — `briefing.altitude` shapes every surface
// that writes a brief or a dispatch instruction.
//
// The setting promised: outcome = result, guardrails and definition of done
// (default); guided = adds the structure the author suggests; prescriptive =
// per-item criteria, artifact list and method. Only the delivery check read it,
// so every value produced the same brief and the same worker prompt. These
// cases pin, per value: the `nrv brief template` skeleton and the altitude it
// prints, the business worker's prompt, the squad worker's prompt and the
// enrichment prompt; and that outcome, set or unset, is byte for byte what the
// engine produced before.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BRIEF_ALTITUDES, briefAltitude, type BriefAltitude } from "../lib/brief-altitude.ts";
import { briefProblems, briefTemplate, parseWorkBrief } from "../lib/work-brief.ts";
import { buildSoloPrompt, type BusinessSoloArgs } from "../lib/business-solo.ts";
import { buildSquadPrompt } from "../lib/squad-exec.ts";
import { proxyPrompt } from "../lib/brief-proxy.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const BRIEF_CLI = path.join(REPO, "skills", "harness", "scripts", "brief.ts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-altitude-"));
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ } });

// The six-section skeleton as the engine printed it before the setting was read.
const OUTCOME_TEMPLATE = [
  "## Request (verbatim)",
  "<the user's own words, pasted, unedited>",
  "",
  "## Decisions",
  "- <what the user already decided in the conversation, one per line; \"None.\" when there is none>",
  "",
  "## Your part",
  "<what THIS business delivers, and what another business covers instead>",
  "",
  "## Inputs",
  "- <paths: attachments, another business's _SUMMARY.md; \"None.\" when there is none>",
  "",
  "## Done when",
  "- <an observable criterion; end it with (blocking) when the delivery fails without it>",
  "",
  "## Output",
  "<what the deliverable is made of: files and formats; the engine sets the folder>",
  "",
].join("\n");

/** A settings resolution that reads only the given environment. */
const only = (env: Record<string, string>) => ({ env, projectRoot: null, globalPath: null, enginePath: null });

describe("the active altitude", () => {
  test("unset is outcome; the variable picks any of the three", () => {
    expect(briefAltitude(only({}))).toBe("outcome");
    for (const a of BRIEF_ALTITUDES) expect(briefAltitude(only({ NIRVANA_BRIEF_ALTITUDE: a }))).toBe(a);
  });
});

describe("nrv brief template", () => {
  const run = (env: Record<string, string>) => {
    const home = fs.mkdtempSync(path.join(TMP, "home-"));
    const e: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, NIRVANA_HOME: home, ...env };
    if (!("NIRVANA_BRIEF_ALTITUDE" in env)) delete e.NIRVANA_BRIEF_ALTITUDE;
    delete e.NIRVANA_PROJECT_ROOT;
    return spawnSync(process.execPath, [BRIEF_CLI, "template"], { cwd: home, encoding: "utf8", env: e as Record<string, string> });
  };

  test("unset: the skeleton is the one printed before, and stderr names outcome", () => {
    const r = run({});
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(OUTCOME_TEMPLATE);
    expect(r.stderr).toContain("briefing.altitude = outcome");
  }, 30_000);

  for (const altitude of BRIEF_ALTITUDES) {
    test(`${altitude}: stdout is that altitude's skeleton, stderr names it`, () => {
      const r = run({ NIRVANA_BRIEF_ALTITUDE: altitude });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(briefTemplate(altitude));
      expect(r.stderr).toContain(`briefing.altitude = ${altitude}`);
      expect(r.stdout).not.toContain("briefing.altitude");
    }, 30_000);
  }
});

describe("the skeleton per altitude", () => {
  test("outcome is the six sections, exactly as before", () => {
    expect(briefTemplate()).toBe(OUTCOME_TEMPLATE);
    expect(briefTemplate("outcome")).toBe(OUTCOME_TEMPLATE);
  });

  test("guided adds the suggested structure above Done when", () => {
    const t = briefTemplate("guided");
    expect(t.indexOf("## Suggested structure")).toBeGreaterThan(t.indexOf("## Inputs"));
    expect(t.indexOf("## Suggested structure")).toBeLessThan(t.indexOf("## Done when"));
    expect(t).not.toContain("## Method");
  });

  test("prescriptive adds the method, one criterion per item and every artifact", () => {
    const t = briefTemplate("prescriptive");
    expect(t.indexOf("## Method")).toBeLessThan(t.indexOf("## Done when"));
    expect(t).toContain("one criterion per item");
    expect(t).toContain("every artifact, one per line");
    expect(t).not.toContain("## Suggested structure");
  });

  test("every altitude still parses as a complete six-section brief", () => {
    for (const a of BRIEF_ALTITUDES) expect(briefProblems(parseWorkBrief(briefTemplate(a)))).toEqual([]);
  });
});

describe("the business worker's prompt", () => {
  const args = {
    slug: "acme", bizDir: "/biz/acme", brief: "", projectId: "p-1", projectDir: "/p/run", projectRoot: "/p",
    outputsRoot: "/p/outputs/run", runtime: "claude-code", briefFile: "/b/brief.md",
  } as unknown as BusinessSoloArgs & { briefFile: string };
  const prompt = (altitude?: BriefAltitude) => buildSoloPrompt(args, [], [], {}, [], altitude ? { altitude } : {});

  test("outcome adds nothing", () => {
    expect(prompt("outcome")).toBe(prompt());
    expect(prompt()).not.toContain("The brief is guided");
    expect(prompt()).not.toContain("The brief is prescriptive");
  });

  test("guided: follow the suggested structure, say where you departed", () => {
    const p = prompt("guided");
    const brief = p.slice(p.indexOf("## Your brief"), p.indexOf("## The business"));
    expect(brief).toContain("The brief is guided");
    expect(brief).toContain("Suggested structure");
  });

  test("prescriptive: the artifacts listed, every criterion, the stated method", () => {
    const p = prompt("prescriptive");
    const brief = p.slice(p.indexOf("## Your brief"), p.indexOf("## The business"));
    expect(brief).toContain("The brief is prescriptive");
    expect(brief).toContain("item by item");
    expect(brief).toContain("\"Method\"");
  });
});

describe("the squad worker's prompt", () => {
  const squadDir = path.join(TMP, "squads", "brandcraft");
  fs.mkdirSync(squadDir, { recursive: true });
  fs.writeFileSync(path.join(squadDir, "squad.yaml"), "name: brandcraft\n");
  const base = { squadSlug: "brandcraft", squadDir, brief: "the brief", outDir: "/out/dir", cloneInjection: { block: "", decision: "DEFAULT" } };
  const subTask = (p: string) => p.slice(p.indexOf("## YOUR SUB-TASK"), p.indexOf("## OUTPUT"));

  test("outcome keeps the historical sentence and the same bytes", () => {
    expect(buildSquadPrompt({ ...base, altitude: "outcome" })).toBe(buildSquadPrompt(base));
    expect(subTask(buildSquadPrompt(base))).toContain("Method and tools are yours. Deliverables follow");
  });

  test("guided and prescriptive change the sentence on method", () => {
    expect(subTask(buildSquadPrompt({ ...base, altitude: "guided" }))).toContain("follow the structure the brief suggests");
    const p = subTask(buildSquadPrompt({ ...base, altitude: "prescriptive" }));
    expect(p).toContain("Follow the method and the artifact list the brief states, item by item");
    expect(p).not.toContain("Method and tools are yours. Deliverables");
  });
});

describe("the enrichment prompt (--auto-brief=proxy)", () => {
  test("outcome adds nothing", () => {
    expect(proxyPrompt("b", "acme", "ctx", "outcome")).toBe(proxyPrompt("b", "acme", "ctx"));
    expect(proxyPrompt("b", "acme", "ctx")).not.toContain("Altitude");
  });

  test("guided asks for the suggested structure, prescriptive for criteria, artifacts and method", () => {
    expect(proxyPrompt("b", "acme", "ctx", "guided")).toContain("'## Suggested structure'");
    const p = proxyPrompt("b", "acme", "ctx", "prescriptive");
    expect(p).toContain("one acceptance criterion per item");
    expect(p).toContain("every artifact");
    expect(p).toContain("'## Method'");
  });
});
