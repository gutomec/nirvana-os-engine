// work-brief.test.ts — the six-section brief the orchestrator writes for one
// business: parsed deterministically, its gaps named, its "Done when" read as
// review criteria, and a mid-run decision appended in place.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendDecision, briefProblems, briefTemplate, doneWhenCriteria, parseWorkBrief } from "../lib/work-brief.ts";

const FULL = [
  "## Request (verbatim)",
  "Quero um agente de atendimento no WhatsApp.",
  "",
  "## Decisions",
  "- Baileys for now",
  "",
  "## Your part",
  "Architecture and PRD.",
  "",
  "## Inputs",
  "None.",
  "",
  "## Done when",
  "- The PRD lists every table (blocking)",
  "- Must name the deploy target",
  "- A cost estimate per month",
  "",
  "## Output",
  "/tmp/out",
].join("\n");

let tmp: string;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-brief-"))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("parseWorkBrief", () => {
  test("a complete brief has no problems", () => {
    expect(briefProblems(parseWorkBrief(FULL))).toEqual([]);
  });

  test("the template names every section", () => {
    expect(parseWorkBrief(briefTemplate()).missing).toEqual([]);
  });

  test("a missing section and an empty required one are named", () => {
    const text = FULL.replace("## Output\n/tmp/out", "").replace("Architecture and PRD.", "");
    expect(briefProblems(parseWorkBrief(text))).toEqual(["missing section: ## Output", "empty section: ## Your part"]);
  });

  test("Decisions and Inputs may be empty but must be present", () => {
    const text = FULL.replace("- Baileys for now", "").replace("None.", "");
    expect(briefProblems(parseWorkBrief(text))).toEqual([]);
  });

  test("headings match without regard to case", () => {
    expect(parseWorkBrief(FULL.replace("## Done when", "## DONE WHEN")).missing).toEqual([]);
  });
});

describe("doneWhenCriteria", () => {
  test("bullets become d1..dn, blocking by suffix or by 'must'", () => {
    expect(doneWhenCriteria(FULL)).toEqual([
      { id: "d1", description: "The PRD lists every table", blocking: true },
      { id: "d2", description: "Must name the deploy target", blocking: true },
      { id: "d3", description: "A cost estimate per month", blocking: false },
    ]);
  });
});

describe("appendDecision", () => {
  test("adds to the Decisions section and keeps the rest", () => {
    const file = path.join(tmp, "b.md");
    fs.writeFileSync(file, FULL);
    appendDecision(file, "Everything runs on one VPS");
    const parsed = parseWorkBrief(fs.readFileSync(file, "utf8"));
    expect(parsed.sections.Decisions).toBe("- Baileys for now\n- Everything runs on one VPS");
    expect(parsed.sections["Your part"]).toBe("Architecture and PRD.");
    expect(briefProblems(parsed)).toEqual([]);
  });

  test("replaces a None placeholder", () => {
    const file = path.join(tmp, "b.md");
    fs.writeFileSync(file, FULL.replace("- Baileys for now", "None."));
    appendDecision(file, "A manual switch for auto mode");
    expect(parseWorkBrief(fs.readFileSync(file, "utf8")).sections.Decisions).toBe("- A manual switch for auto mode");
  });
});
