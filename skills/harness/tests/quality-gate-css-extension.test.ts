// quality-gate-css-extension.test.ts — .css is now a gateable extension.
//
// Before this cut, `.css` was absent from GATEABLE_EXTS entirely (F175's
// field-bg regression shipped in a .css file the gate never looked at, by
// construction — see css-composite-alpha.ts's own header for the incident).
// quality-gate.test.ts only tests rubric NAME selection
// (selectRubricsForProduces), never a real end-to-end run of scripts/
// quality-gate.ts against a file on disk — this file closes that specific
// gap for .css, spawning the real CLI the way delivery-pipeline.ts does.
// Runs with: bun test skills/harness/tests
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GATEABLE_EXTS, rubricsForExt } from "../scripts/quality-gate.ts";
import { gateableFiles, runGateOnce } from "../lib/delivery-pipeline.ts";

const GATE_SCRIPT = path.join(import.meta.dir, "..", "scripts", "quality-gate.ts");
const SKILLS = path.resolve(import.meta.dir, "..", "..");
// quality-gate.ts resolves rubrics from NIRVANA_SKILLS_DIR (default: the
// INSTALLED ~/.nirvana/skills copy) — without this, a rubric that only
// exists in the repo source (like the one this file tests) is invisible to
// a spawned subprocess and comes back "not implemented yet", not evaluated.
const GATE_ENV = { NIRVANA_SKILLS_DIR: SKILLS };

describe(".css is gateable", () => {
  test("GATEABLE_EXTS now includes .css", () => {
    expect(GATEABLE_EXTS.has(".css")).toBe(true);
  });

  test(".css maps to the css-composite-alpha rubric", () => {
    expect(rubricsForExt(".css")).toEqual(["css-composite-alpha"]);
  });

  test("gateableFiles() picks up a .css deliverable alongside .html — it did not before this cut", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-gate-css-"));
    try {
      fs.writeFileSync(path.join(tmp, "styles.css"), ".hero { color: red; }\n".repeat(20));
      fs.writeFileSync(path.join(tmp, "index.html"), "<html><body>x".repeat(50) + "</body></html>");
      expect(gateableFiles(tmp, new Set()).map(f => path.basename(f)).sort())
        .toEqual(["index.html", "styles.css"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("the real CLI (not just the rubric function) catches the field-bg shape end to end", () => {
  test("a gradient wash compounded under a glass sheet to <15% fails the real quality-gate.ts subprocess", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-gate-css-e2e-"));
    try {
      const cssPath = path.join(tmp, "tokens.css");
      fs.writeFileSync(cssPath, `
:root { --sheet-a: 0.6; }
.field-bg {
  background: radial-gradient(900px 650px at 8% 4%, color-mix(in oklab, var(--accent) 30%, transparent), transparent 70%);
}
`);
      const result = runGateOnce([cssPath], { gateScript: GATE_SCRIPT, offline: true, env: GATE_ENV });
      expect(result.pass).toBe(false);
      expect(result.fails[0]?.fixes.join(" ")).toContain("Raise the gradient's own opacity");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the same file with the compensated percentage passes the real subprocess", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-gate-css-e2e-pass-"));
    try {
      const cssPath = path.join(tmp, "tokens.css");
      fs.writeFileSync(cssPath, `
:root { --sheet-a: 0.6; }
.field-bg {
  background: radial-gradient(900px 650px at 8% 4%, color-mix(in oklab, var(--accent) 65%, transparent), transparent 70%);
}
`);
      const result = runGateOnce([cssPath], { gateScript: GATE_SCRIPT, offline: true, env: GATE_ENV });
      expect(result.pass).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
