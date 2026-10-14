// gate-dependency-noise.test.ts — the gate judges the run's work, never its
// dependencies (2026-10-14 Camila incident).
//
// A website deliverable sent node_modules READMEs, Playwright's
// ThirdPartyNotices.txt, dist/ font licences and a vendored GSAP notice to the
// LLM judge as prose: twenty-six files and nine minutes, none of them the run's.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gateableFiles, candidateArtifacts } from "../lib/delivery-pipeline.ts";
import { isDependencyNoise, isLegalText } from "../../_shared/lib/deliverable-noise.ts";

let tmp: string;
const saved = { logs: process.env.HARNESS_LOGS_DIR, skills: process.env.NIRVANA_SKILLS_DIR };
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-incident-"));
  process.env.HARNESS_LOGS_DIR = path.join(tmp, "logs");
  process.env.NIRVANA_SKILLS_DIR = path.join(import.meta.dir, "..", "..");
});
afterEach(() => {
  if (saved.logs === undefined) delete process.env.HARNESS_LOGS_DIR; else process.env.HARNESS_LOGS_DIR = saved.logs;
  if (saved.skills === undefined) delete process.env.NIRVANA_SKILLS_DIR; else process.env.NIRVANA_SKILLS_DIR = saved.skills;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

describe("the gate judges the run's work, never its dependencies", () => {
  test("a website with node_modules, dist, a lockfile and licences sends only its sources to the judge", () => {
    const root = path.join(tmp, "out");
    const site = path.join(root, "website");
    const long = "x".repeat(400);
    write(path.join(site, "src", "index.html"), `<!doctype html><html><body><p>${long}</p></body></html>`);
    write(path.join(site, "node_modules", "@playwright", "test", "README.md"), `# Playwright\n${long}`);
    write(path.join(site, "node_modules", "playwright-core", "ThirdPartyNotices.txt"), long);
    write(path.join(site, "dist", "index.html"), `<html>${long}</html>`);
    write(path.join(site, "dist", "assets", "fonts", "Inter-OFL.txt"), long);
    write(path.join(site, "dist", "assets", "vendor", "GSAP-NOTICE.txt"), long);
    write(path.join(site, "package-lock.json"), JSON.stringify({ x: long }));
    write(path.join(site, "LICENSE"), long);
    write(path.join(site, ".venv", "lib", "x.py"), long);
    const files = gateableFiles(root, new Set()).map(f => path.relative(root, f).replace(/\\/g, "/"));
    expect(files).toEqual(["website/src/index.html"]);
    // The salvage's "did it leave anything?" asks the same filter, build output included.
    expect(candidateArtifacts(root, "").map(f => path.relative(root, f).replace(/\\/g, "/")).sort()).toEqual(["website/dist/index.html", "website/src/index.html"]);
  });

  test("a delivery that is only dist/ keeps it", () => {
    const root = path.join(tmp, "out");
    write(path.join(root, "dist", "index.html"), `<html>${"y".repeat(400)}</html>`);
    expect(gateableFiles(root, new Set()).map(f => path.relative(root, f).replace(/\\/g, "/"))).toEqual(["dist/index.html"]);
  });

  test("the project's own LICENSE stays when the brief asks for it", () => {
    expect(isDependencyNoise("LICENSE.md", new Set())).toBe(true);
    expect(isDependencyNoise("LICENSE.md", new Set(["license.md"]))).toBe(false);
    expect(isDependencyNoise("node_modules/x/LICENSE.md", new Set(["license.md"]))).toBe(true);
    expect(isLegalText("license-checker.ts")).toBe(false);
    expect(isLegalText("ThirdPartyNotices.txt")).toBe(true);
    expect(isDependencyNoise("pnpm-lock.yaml")).toBe(true);
    expect(isDependencyNoise("src/vendor.ts")).toBe(false);
  });
});
