// find-chrome.ts — a Chromium-family browser this machine can run headless.
//
// One finder for every engine step that renders a page (the PDF report, the
// layout check of an HTML deliverable): the browser named in
// PUPPETEER_EXECUTABLE_PATH, then the system's Chrome, Edge or Chromium, then a
// browser a Playwright or Puppeteer install left in the shared cache
// (~/.nirvana/cache). null when there is none.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { depsCache } from "./deps-home.ts";

const SYSTEM_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Google", "Chrome", "Application", "chrome.exe"),
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  linux: [],
};

const PATH_BINS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "msedge"];

/** Executable names a browser download in a cache folder carries. */
const CACHE_BINS = new Set([
  "chrome-headless-shell", "chrome-headless-shell.exe", "headless_shell", "headless_shell.exe",
  "chrome", "chrome.exe", "Chromium", "Google Chrome for Testing",
]);

function inCache(root: string, depth = 5): string | null {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  // A headless shell is the lightest browser to start, so it is preferred.
  entries.sort((a, b) => Number(/headless/i.test(b.name)) - Number(/headless/i.test(a.name)));
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isFile() && CACHE_BINS.has(e.name)) return full;
    if (e.isDirectory() && depth > 0 && !/^(ffmpeg|firefox|webkit)/i.test(e.name)) {
      const hit = inCache(full, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

export function findChrome(): string | null {
  const env = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (env && fs.existsSync(env)) return env;
  for (const p of SYSTEM_PATHS[process.platform] ?? []) if (fs.existsSync(p)) return p;
  for (const bin of PATH_BINS) {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { windowsHide: true, encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  }
  for (const tool of ["playwright", "puppeteer"]) {
    const hit = inCache(depsCache(tool));
    if (hit) return hit;
  }
  return null;
}
