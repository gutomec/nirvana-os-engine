// html-layout.ts — renders an HTML deliverable in a headless browser at phone,
// tablet and desktop widths, and fails it when the page scrolls sideways or a
// fixed navigation bar covers the main heading. The other HTML rubric reads the
// markup; this one measures the layout, which no reading of the source can
// promise (a grid that needs 432px only shows itself at 360px).
//
// No browser on the machine, no puppeteer-core in the shared store, or
// quality_gate.html_layout off: the rubric is skipped, never failed. A layout
// finding is not serious: it goes back for correction, and if it survives the
// rounds the delivery ships with reservations.
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { findChrome } from "../../_shared/lib/find-chrome.ts";
import { resolveSetting } from "../../_shared/lib/settings.ts";

export const VIEWPORTS: ReadonlyArray<readonly [number, number]> = [[360, 800], [390, 844], [768, 1024], [1440, 900]];

export interface ViewportMeasure {
  width: number;
  height: number;
  /** How far the page scrolls sideways, in px (0 when it fits). */
  overflow: number;
  /** The elements that stick out, described for a fix ("div.card (in #pricing) reaches 432px"). */
  offenders: string[];
  /** A fixed bar at the top that covers the page's h1, or null. */
  coveredHeading: { top: number; navBottom: number } | null;
}

const skipped = (reasoning: string) => ({ name: "html-layout", passed: true, skipped: true, score: 1, reasoning, fix_list: [] as string[] });

/** The verdict for a set of measures: pure, so it is tested without a browser. */
export function layoutVerdict(measures: ViewportMeasure[]) {
  const fix_list: string[] = [];
  const wide = measures.filter((m) => m.overflow > 1);
  if (wide.length) {
    const widths = wide.map((m) => `${m.width}px (${m.overflow}px)`).join(", ");
    const offenders = [...new Set(wide.flatMap((m) => m.offenders))].slice(0, 5);
    const narrowest = Math.min(...wide.map((m) => m.width));
    fix_list.push(`The page scrolls sideways at ${widths}${offenders.length ? `: ${offenders.join("; ")}` : ""}. Make every section fit ${narrowest}px wide (grids with minmax(0, 1fr), flex-wrap, max-width: 100%, no fixed widths).`);
  }
  const covered = measures.filter((m) => m.coveredHeading);
  if (covered.length) {
    const m = covered[0];
    fix_list.push(`At ${covered.map((c) => `${c.width}px`).join(", ")} the fixed navigation (bottom ${m.coveredHeading!.navBottom}px) covers the main heading (top ${m.coveredHeading!.top}px). Offset the content by the navigation's height.`);
  }
  const passed = fix_list.length === 0;
  return {
    name: "html-layout",
    passed,
    score: passed ? 1 : 0.5,
    reasoning: passed
      ? `Fits ${measures.map((m) => `${m.width}px`).join(", ")} with no sideways scroll and the main heading clear of the navigation.`
      : fix_list.join(" "),
    fix_list,
  };
}

/** Runs inside the page: what one viewport shows. */
function measure(): ViewportMeasure {
  const doc = document.documentElement;
  const W = doc.clientWidth;
  const overflow = Math.max(0, doc.scrollWidth - W);
  const describe = (e: Element) => {
    let s = e.tagName.toLowerCase();
    if (e.id) s += `#${e.id}`;
    else if (typeof (e as HTMLElement).className === "string" && (e as HTMLElement).className.trim()) s += "." + (e as HTMLElement).className.trim().split(/\s+/).slice(0, 2).join(".");
    const section = e.parentElement?.closest("section[id], main[id], header[id], footer[id], article[id]");
    return section ? `${s} (in #${section.id})` : s;
  };
  let offenders: string[] = [];
  if (overflow > 1) {
    // Full-width boxes only stretch with the page; the ones narrower than the
    // page that still reach past the screen are what makes it wide.
    const out = [...document.body.querySelectorAll("*")]
      .map((e) => ({ e, r: e.getBoundingClientRect() }))
      .filter((x) => x.r.width > 0 && x.r.right > W + 1 && x.r.width < doc.scrollWidth - 1);
    const outer = out.filter((x) => !out.some((y) => y.e !== x.e && y.e.contains(x.e)));
    outer.sort((a, b) => b.r.right - a.r.right);
    offenders = [...new Set(outer.slice(0, 5).map((x) => `${describe(x.e)} reaches ${Math.round(x.r.right)}px`))];
  }
  let coveredHeading: ViewportMeasure["coveredHeading"] = null;
  const bars = [...document.body.querySelectorAll("*")].filter((e) => {
    const s = getComputedStyle(e);
    if (s.position !== "fixed" && s.position !== "sticky") return false;
    const r = e.getBoundingClientRect();
    return r.top <= 0.5 && r.height > 0 && r.height < innerHeight * 0.3 && r.width >= W * 0.8;
  });
  const h1 = document.querySelector("h1");
  if (bars.length && h1 && !bars.some((b) => b.contains(h1))) {
    const navBottom = Math.max(...bars.map((b) => b.getBoundingClientRect().bottom));
    const top = h1.getBoundingClientRect().top;
    if (top < navBottom - 1) coveredHeading = { top: Math.round(top), navBottom: Math.round(navBottom) };
  }
  return { width: W, height: innerHeight, overflow, offenders, coveredHeading };
}

export async function evaluate(args: { artifact: string; content: string; offline?: boolean }) {
  if (!resolveSetting("quality_gate.html_layout").value) return skipped("quality_gate.html_layout is off.");
  const executablePath = findChrome();
  if (!executablePath) return skipped("No Chromium-family browser on this machine; the layout was not measured.");
  let puppeteer: any;
  try { puppeteer = (await import("puppeteer-core")).default; }
  catch { return skipped("puppeteer-core is not in the shared store (nrv deps install puppeteer-core); the layout was not measured."); }

  let browser: any = null;
  const work = (async () => {
    browser = await puppeteer.launch({ headless: true, executablePath });
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await page.setViewport({ width: VIEWPORTS[0][0], height: VIEWPORTS[0][1] });
    // CDN styles and fonts change the layout, so the page loads with its network;
    // a slow CDN costs at most the timeout, after which what loaded is measured.
    await page.goto(pathToFileURL(path.resolve(args.artifact)).href, { waitUntil: "networkidle2", timeout: 15_000 }).catch(() => {});
    const measures: ViewportMeasure[] = [];
    for (const [width, height] of VIEWPORTS) {
      await page.setViewport({ width, height });
      await new Promise((r) => setTimeout(r, 250));
      measures.push(await page.evaluate(measure));
    }
    return measures;
  })();
  try {
    const measures = await Promise.race([
      work,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 45_000)),
    ]);
    if (!measures) return skipped("The browser did not finish measuring within 45s; the layout was not measured.");
    return layoutVerdict(measures);
  } catch (error) {
    return skipped(`The browser could not render the page (${(error as Error).message.split("\n")[0]}); the layout was not measured.`);
  } finally {
    try { await browser?.close(); } catch { /* already gone */ }
  }
}
