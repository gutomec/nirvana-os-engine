// glance-unknown-not-zero.test.ts — the cockpit must not report absence as zero.
//
// Measured on 2026-08-28 against a live cockpit on port 3737 with two active runs:
// `curl localhost:3737/api/projects` answered `{"projects": []}` and the panel read
// "Projects 0". The maestro logs directory did not exist, so the truth was "could not
// determine", and the API said "measured zero". A reader acts on the difference.
//
// The contract these cases pin, in both directions:
//   · the source of truth is absent  ⇒ the API answers `null` ⇒ the view renders `—`
//   · the source of truth is present and empty ⇒ the API answers `[]` / `0` ⇒ the view
//     renders the number
//
// The fixtures pin where the logs live instead of reading this machine's, so a green run
// here means the same thing on CI. Setting the variable alone is not enough — see
// helpers/engine-log-dirs.ts for the frozen-snapshot trap it works around.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { pinLogDirs } from "./helpers/engine-log-dirs.ts";
import { countLabel, isUnknown, listLength } from "../lib/glance/views/absence.js";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";
import { KERNEL_BUDGET_MS } from "./helpers/test-budgets.ts";

const root = makeTempRoot("nrv-glance-absence-");
const maestro = path.join(root, "maestro");
const harness = path.join(root, "harness");
const previousProjectRoot = process.env.NIRVANA_PROJECT_ROOT;

let instance: any;
let base = "";

const logDirs = pinLogDirs();
const useLogDirs = () => logDirs.use({ MAESTRO_LOGS_DIR: maestro, HARNESS_LOGS_DIR: harness });

beforeAll(async () => {
  process.env.NIRVANA_PROJECT_ROOT = root;
  fs.mkdirSync(path.join(root, ".nirvana"), { recursive: true });
  useLogDirs();
  const { startServer } = await import("../lib/glance/server.ts");
  instance = await startServer({ port: 0, open: false, idleMin: 60, allowActions: false, theme: "apple" });
  base = `http://127.0.0.1:${instance.port}`;
});

afterEach(() => useLogDirs());

afterAll(() => {
  try { instance?.close(); } catch {}
  if (previousProjectRoot === undefined) delete process.env.NIRVANA_PROJECT_ROOT;
  else process.env.NIRVANA_PROJECT_ROOT = previousProjectRoot;
  logDirs.restore();
  removeDir(root);
});

describe("the cockpit distinguishes unknown from zero", () => {
  test("listProjects answers null when the maestro logs directory does not exist, and [] when it exists empty", async () => {
    const { listProjects } = await import("../lib/glance/data-loader.ts");
    removeDir(maestro);
    expect(listProjects()).toBeNull();
    fs.mkdirSync(maestro, { recursive: true });
    expect(listProjects()).toEqual([]);
  });

  test("/api/projects answers null for undetermined and an array for a real, measured absence", async () => {
    removeDir(maestro);
    const undetermined = await fetch(`${base}/api/projects`).then(r => r.json()) as any;
    expect(undetermined.projects).toBeNull();

    fs.mkdirSync(maestro, { recursive: true });
    const measured = await fetch(`${base}/api/projects`).then(r => r.json()) as any;
    expect(measured.projects).toEqual([]);
  }, KERNEL_BUDGET_MS);

  test("/api/runs answers null runs and a null total when the harness logs root does not exist", async () => {
    removeDir(harness);
    const undetermined = await fetch(`${base}/api/runs`).then(r => r.json()) as any;
    expect(undetermined.runs).toBeNull();
    expect(undetermined.total).toBeNull();

    fs.mkdirSync(harness, { recursive: true });
    const measured = await fetch(`${base}/api/runs`).then(r => r.json()) as any;
    expect(measured.runs).toEqual([]);
    expect(measured.total).toBe(0);
  }, KERNEL_BUDGET_MS);

  test("/api/logs/dates answers null when the log root does not exist", async () => {
    removeDir(harness);
    const undetermined = await fetch(`${base}/api/logs/dates?type=harness`).then(r => r.json()) as any;
    expect(undetermined.dates).toBeNull();

    fs.mkdirSync(harness, { recursive: true });
    const measured = await fetch(`${base}/api/logs/dates?type=harness`).then(r => r.json()) as any;
    expect(measured.dates).toEqual([]);
  }, KERNEL_BUDGET_MS);

  test("/api/logs answers null events for a missing root and [] for a day that wrote nothing", async () => {
    removeDir(harness);
    const undetermined = await fetch(`${base}/api/logs?type=harness`).then(r => r.json()) as any;
    expect(undetermined.events).toBeNull();

    fs.mkdirSync(harness, { recursive: true });
    const measured = await fetch(`${base}/api/logs?type=harness`).then(r => r.json()) as any;
    expect(measured.events).toEqual([]);
  }, KERNEL_BUDGET_MS);

  test("the view renders an em dash for the undetermined and the number for the measured", () => {
    expect(countLabel(null)).toBe("—");
    expect(countLabel(undefined)).toBe("—");
    expect(countLabel(0)).toBe("0");
    expect(countLabel(12)).toBe("12");

    expect(isUnknown(null)).toBe(true);
    expect(isUnknown([])).toBe(false);
    expect(isUnknown(0)).toBe(false);

    // A list the API could not determine has no length to show, and asking for one
    // is exactly how `null` became `0` in the panel.
    expect(listLength(null)).toBeNull();
    expect(listLength([])).toBe(0);
    expect(listLength([1, 2])).toBe(2);
    expect(countLabel(listLength(null))).toBe("—");
  });
});
