// css-composite-alpha.test.ts — the fixture the field-bg incident (PR #175,
// 2026-08-30) would have failed on had `.css` been gateable at the time.
//
// The bug: `.field-bg`'s gradients used `color-mix(in oklab, var(--accent)
// 30%, transparent)`, rendered behind `--sheet-a: 0.6` (a glass sheet whose
// own tint is 60% opaque, so only 40% of what's behind it shows through).
// 30% × 40% = 12% effective alpha — invisible against a light theme, though
// the producing agent's _SUMMARY.md claimed to have verified it visually in
// Chrome. `.css` was not in GATEABLE_EXTS at all, so nothing ever ran this
// check. This file proves the fixed percentages (this branch's actual fix:
// 30% → 65%, still under the same 0.6 sheet) clear the visibility floor,
// and the original 30% does not.
import { describe, expect, test } from "bun:test";
import { evaluate } from "../rubrics/css-composite-alpha.ts";

const FIELD_BG_ORIGINAL = `
:root {
  --sheet-a: 0.6;
}
.field-bg {
  background: radial-gradient(900px 650px at 8% 4%, color-mix(in oklab, var(--accent) 30%, transparent), transparent 70%);
}
`;

const FIELD_BG_FIXED = `
:root {
  --sheet-a: 0.6;
}
.field-bg {
  background: radial-gradient(900px 650px at 8% 4%, color-mix(in oklab, var(--accent) 65%, transparent), transparent 70%);
}
`;

describe("the exact field-bg regression (PR #175)", () => {
  test("30% decorative mix under a 0.6 sheet alpha composites to ~12% — flagged", async () => {
    const r = await evaluate({ artifact: "tokens.css", content: FIELD_BG_ORIGINAL });
    expect(r.passed).toBe(false);
    expect(r.reasoning).toContain("12%");
  });

  test("this branch's actual fix (65% mix) clears the visibility floor", async () => {
    const r = await evaluate({ artifact: "tokens.css", content: FIELD_BG_FIXED });
    expect(r.passed).toBe(true);
  });
});

describe("no sheet alpha declared", () => {
  test("a plain gradient with no --*-a variable in the file passes — nothing to compound", async () => {
    const r = await evaluate({
      artifact: "plain.css",
      content: `.hero { background: color-mix(in oklab, blue 10%, transparent); }`,
    });
    expect(r.passed).toBe(true);
  });
});

describe("rgba() decorative layers inside a gradient, not just color-mix()", () => {
  test("a low rgba alpha inside a gradient wash, under a high sheet alpha, is flagged the same way", async () => {
    const r = await evaluate({
      artifact: "tokens.css",
      content: `:root { --sheet-a: 0.7; } .panel { background: linear-gradient(rgba(80, 100, 240, 0.2), transparent); }`,
    });
    expect(r.passed).toBe(false);
  });

  test("a bare rgba() NOT inside a gradient (a flat fill, a different design intent) is out of scope", async () => {
    const r = await evaluate({
      artifact: "tokens.css",
      content: `:root { --sheet-a: 0.7; } .panel { background: rgba(80, 100, 240, 0.2); }`,
    });
    expect(r.passed).toBe(true);
  });
});

describe("a flat semantic-tint token is a different design choice than a gradient wash", () => {
  test("this engine's own real tokens.css shape (--status-success-bg: color-mix(..., 14%, transparent), not a gradient) does not false-positive", async () => {
    // The first version of this rubric flagged exactly this shape against the
    // real tokens.css on first run: a deliberately subtle status-tint token,
    // unrelated to the field-bg gradient-wash incident this rubric targets.
    const r = await evaluate({
      artifact: "tokens.css",
      content: `
:root {
  --sheet-a: 0.6;
  --status-success-bg: color-mix(in oklab, oklch(65% 0.16 145) 14%, transparent);
  --shadow-focus: 0 0 0 3px color-mix(in oklab, var(--accent) 35%, transparent);
}
`,
    });
    expect(r.passed).toBe(true);
  });
});

describe("a unitful custom property ending in a letter that reads like the alpha suffix", () => {
  test("a pixel value never gets misread as an alpha (no unit-less number immediately before the semicolon)", async () => {
    const r = await evaluate({
      artifact: "tokens.css",
      // `--space-a` intentionally shaped like the alpha-suffix pattern but
      // holding a dimensioned value, not a bare 0–1 float.
      content: `:root { --space-a: 8px; } .hero { background: color-mix(in oklab, blue 10%, transparent); }`,
    });
    expect(r.passed).toBe(true);
  });
});
