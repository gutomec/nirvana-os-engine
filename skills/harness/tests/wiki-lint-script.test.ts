// wiki-lint-script.test.ts — the wiki-lint rubric only opines on prose it can
// read. Reproduction of trace 70341260-ff80-4c9b-9dd4-6925a36c6b99 (27/08/2026),
// where an English-prose rubric failed README.hi.md and README.ar.md for
// "em-dash overuse" and "hyphen-as-clause-stitching" and burned the delivery's
// revision budget on the complaint.
// Runs with: bun test skills/harness/tests
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evaluate } from "../rubrics/wiki-lint.ts";

const GATE = path.join(import.meta.dir, "..", "scripts", "quality-gate.ts");
const SKILLS_DIR = path.join(import.meta.dir, "..", "..");

// The tell wiki-lint punishes hardest: " - " stitching, severity 1.0.
const stitched = (sentence: string, times: number) =>
  `# ${sentence}\n\n` + `${sentence} - ${sentence} `.repeat(times) + "\n";

const HINDI = stitched("यह दस्तावेज़ एक परीक्षण के लिए लिखा गया है", 20);
const ARABIC = stitched("هذا المستند مكتوب لأغراض الاختبار فقط", 20);
const PORTUGUESE = stitched("Este documento foi escrito para teste", 20);

describe("wiki-lint — abstains outside the Latin script", () => {
  test("Devanagari prose is NOT judged (skipped, and skipped is not a pass)", async () => {
    const r = await evaluate({ artifact: "README.hi.md", content: HINDI });
    expect(r.skipped).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.fix_list).toEqual([]);
    expect(r.reasoning).toContain("Latin");
  });

  test("Arabic prose is NOT judged", async () => {
    const r = await evaluate({ artifact: "README.ar.md", content: ARABIC });
    expect(r.skipped).toBe(true);
  });

  test("Portuguese with the SAME tell is still judged, and still fails", async () => {
    const r = await evaluate({ artifact: "README.md", content: PORTUGUESE });
    expect(r.skipped).toBeUndefined();
    expect(r.passed).toBe(false);
    expect(r.fix_list.join(" ")).toContain("hyphen-as-clause-stitching");
  });

  test("clean English prose still passes", async () => {
    const clean = "# Delivery note\n\nThe report covers the agreed scope and the files produced.\n" +
      "Every decision taken during the run is recorded next to its justification.\n";
    const r = await evaluate({ artifact: "README.md", content: clean });
    expect(r.skipped).toBeUndefined();
    expect(r.passed).toBe(true);
  });
});

describe("quality-gate — an abstaining rubric never becomes a silent PASS", () => {
  test("wiki-lint alone over Hindi → INDETERMINATE, exit non-zero", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-wikilint-"));
    try {
      const artifact = path.join(tmp, "README.hi.md");
      fs.writeFileSync(artifact, HINDI);
      const g = spawnSync("bun", [GATE, artifact, "--rubrics=wiki-lint", "--offline"], {
        encoding: "utf8",
        env: { ...process.env, NIRVANA_SKILLS_DIR: SKILLS_DIR, HARNESS_LOGS_DIR: path.join(tmp, "logs") },
      });
      const verdict = JSON.parse(g.stdout);
      expect(verdict.status).toBe("INDETERMINATE");
      expect(verdict.results[0].skipped).toBe(true);
      expect(g.status).not.toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
