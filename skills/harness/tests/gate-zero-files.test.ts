// gate-zero-files.test.ts — regression for the zero-gated-files gate honesty.
//
// nonStubText() only gates .md/.txt/.json, so a run delivering only non-text
// artifacts (e.g. .html) produced an empty gated-file list — and
// runGateOnce([]) is vacuously {pass:true}, which emitted `gate_passed` with
// files:0. Phase 0.2 made the empty list INDETERMINATE; routing-360 Phase 4
// went further: the helpers moved to lib/delivery-pipeline.ts, the pipeline
// gates the FULL rubricsForExt surface (gateableFiles — .html counts now),
// and an indeterminate outcome WITHHOLDS delivery (exit 3, no `delivered`
// event) instead of delivering with gate:"indeterminate". This file was
// DELIBERATELY updated for that: the delivery-outcome assertions live in
// delivery-pipeline.test.ts; here we keep the helper semantics + the
// dispatch.ts re-export contract.
// Runs with: bun test skills/harness/tests
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nonStubText, runGateOnce, decideGateOutcome, gateableFiles } from "../lib/delivery-pipeline.ts";
import * as dispatchScript from "../scripts/dispatch.ts";

describe("dispatch quality gate — zero gated files", () => {
  test("nonStubText (legacy surface) returns [] for a dir with only .html deliverables", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-gate-"));
    try {
      fs.writeFileSync(path.join(tmp, "relatorio-final.html"), "<html>" + "x".repeat(500) + "</html>");
      fs.writeFileSync(path.join(tmp, "cover.png"), Buffer.alloc(1024));
      expect(nonStubText(tmp, new Set())).toEqual([]);
      // Phase 4: the pipeline's REAL surface gates both of these now.
      expect(gateableFiles(tmp, new Set()).map(f => path.basename(f)).sort())
        .toEqual(["cover.png", "relatorio-final.html"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("runGateOnce([]) is vacuously pass — the raw result the wrapper must correct", () => {
    expect(runGateOnce([], "/nonexistent/quality-gate.ts")).toEqual({ pass: true, fails: [] });
  });

  test("decideGateOutcome on an empty list is indeterminate, not pass", () => {
    expect(decideGateOutcome([], true)).toBe("indeterminate");
    expect(decideGateOutcome([], false)).toBe("indeterminate");
  });

  test("decideGateOutcome passes through the real verdict when files were gated", () => {
    expect(decideGateOutcome(["/tmp/a.md"], true)).toBe("pass");
    expect(decideGateOutcome(["/tmp/a.md"], false)).toBe("fail");
  });

  test("dispatch.ts keeps re-exporting the moved helpers (back-compat contract)", () => {
    expect(dispatchScript.nonStubText).toBe(nonStubText);
    expect(dispatchScript.runGateOnce).toBe(runGateOnce);
    expect(dispatchScript.decideGateOutcome).toBe(decideGateOutcome);
  });
});
