// html-layout.test.ts — an HTML deliverable is measured in a browser at phone,
// tablet and desktop widths, and an HTML page is judged for its design as well
// as its text. The verdict logic runs without a browser; the live rendering runs
// only where a Chromium-family browser and puppeteer-core can be found.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evaluate, layoutVerdict, VIEWPORTS, type ViewportMeasure } from "../rubrics/html-layout.ts";
import { alwaysRubricsForExt, judgeRubricNames, rubricsForExt } from "../scripts/quality-gate.ts";
import { SERIOUS_RUBRICS } from "../lib/delivery-pipeline.ts";
import { findChrome } from "../../_shared/lib/find-chrome.ts";
import { _resetSettingsCache } from "../../_shared/lib/settings.ts";

const fits = (width: number): ViewportMeasure => ({ width, height: 800, overflow: 0, offenders: [], coveredHeading: null });

describe("the layout verdict", () => {
  test("a page that fits every width passes", () => {
    const v = layoutVerdict(VIEWPORTS.map(([w]) => fits(w)));
    expect(v.passed).toBe(true);
    expect(v.fix_list).toEqual([]);
  });

  test("sideways scroll on a phone names the widths, the culprits and the width to fit", () => {
    const v = layoutVerdict([
      { ...fits(360), overflow: 72, offenders: ["div.squad-card (in #o-que-vem) reaches 432px"] },
      { ...fits(390), overflow: 42, offenders: ["div.squad-card (in #o-que-vem) reaches 432px"] },
      fits(768), fits(1440),
    ]);
    expect(v.passed).toBe(false);
    expect(v.fix_list).toHaveLength(1);
    expect(v.fix_list[0]).toContain("360px (72px), 390px (42px)");
    expect(v.fix_list[0]).toContain("div.squad-card (in #o-que-vem) reaches 432px");
    expect(v.fix_list[0]).toContain("fit 360px wide");
  });

  test("a fixed navigation over the main heading is reported", () => {
    const v = layoutVerdict([{ ...fits(390), coveredHeading: { top: 20, navBottom: 64 } }]);
    expect(v.passed).toBe(false);
    expect(v.fix_list[0]).toContain("covers the main heading");
  });
});

describe("how the gate uses it", () => {
  test("an HTML file is measured beside the judge, and a layout finding is not serious", () => {
    expect(rubricsForExt(".html")).toContain("html-layout");
    expect(alwaysRubricsForExt(".html")).toContain("html-layout");
    expect(SERIOUS_RUBRICS.has("html-layout")).toBe(false);
  });

  test("an HTML page is judged for its text and its design; other files by one rubric", () => {
    expect(judgeRubricNames(".html", [])).toEqual(["prose_longform", "design"]);
    expect(judgeRubricNames(".html", ["design"])).toEqual(["design"]);
    expect(judgeRubricNames(".md", [])).toEqual(["prose_longform"]);
  });

  test("off, the check is skipped and never fails", async () => {
    process.env.NIRVANA_HTML_LAYOUT = "0"; _resetSettingsCache();
    const r: any = await evaluate({ artifact: "/nope/index.html", content: "<html></html>" });
    expect(r.skipped).toBe(true);
    expect(r.passed).toBe(true);
  });
});

// Live: a real browser renders a page with a grid too wide for a phone.
const canRender = (() => {
  if (!findChrome()) return false;
  try { require.resolve("puppeteer-core", { paths: [path.join(import.meta.dir, "..", "rubrics")] }); return true; } catch { return false; }
})();
const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); delete process.env.NIRVANA_HTML_LAYOUT; _resetSettingsCache(); });

describe.skipIf(!canRender)("in a real browser", () => {
  const page = (body: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-layout-")); roots.push(dir);
    const file = path.join(dir, "index.html");
    fs.writeFileSync(file, `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font-family:sans-serif}</style></head><body>${body}</body></html>`);
    return file;
  };
  test("a grid that needs 432px is sent back with its culprit; a fluid one passes", async () => {
    process.env.NIRVANA_HTML_LAYOUT = "1"; _resetSettingsCache();
    const wide = page(`<section id="cards"><div class="grid" style="display:grid;grid-template-columns:repeat(2,200px);gap:32px"><div class="card">a</div><div class="card">b</div></div></section>`);
    const r: any = await evaluate({ artifact: wide, content: fs.readFileSync(wide, "utf8") });
    expect(r.passed).toBe(false);
    expect(r.fix_list[0]).toContain("360px");
    expect(r.fix_list[0]).toContain("#cards");
    const fluid = page(`<section id="cards"><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:32px"><div>a</div><div>b</div></div></section>`);
    const ok: any = await evaluate({ artifact: fluid, content: fs.readFileSync(fluid, "utf8") });
    expect(ok.passed).toBe(true);
  }, 90_000);
});
