// glance-subsystems.test.ts — the row that says what is standing, and never fakes it.
//
// Grepped before this cut, views/index.html had zero occurrences of `router`,
// `supervisor`, `run kernel` and `embeddings`: the cockpit showed what RAN and
// nothing about what is UP. The row added here reads real state, and the two
// properties worth pinning are the ones a health panel usually gets wrong:
//
//   · a probe never CREATES what it measures (openLedger and openKernel both
//     create their database when missing, which would make every probe green);
//   · a subsystem with no readable signal answers `null` and shows `—`, instead
//     of a green light nobody measured.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { readSubsystems } from "../lib/glance/subsystems.ts";
import { buildSubsystemRow, cellTitle, rowSummary, statusClass, statusGlyph } from "../lib/glance/views/subsystem-row.js";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";
import { KERNEL_BUDGET_MS } from "./helpers/test-budgets.ts";

const root = makeTempRoot("nrv-glance-subsystems-");
const home = path.join(root, "home");
const previous = { home: process.env.NIRVANA_HOME, project: process.env.NIRVANA_PROJECT_ROOT, ledger: process.env.NIRVANA_RUN_LEDGER_DB };

let instance: any;
let base = "";

const EXPECTED_KEYS = ["router", "supervisor", "quality-gate", "gauntlet", "run-kernel", "embeddings", "settings", "updates"];

beforeAll(async () => {
  // A home of its own: the probes read the ledger, the settings and the update
  // cache of NIRVANA_HOME, and this machine's live ones would make the run
  // green here and red on CI.
  fs.mkdirSync(path.join(home, ".nirvana"), { recursive: true });
  fs.mkdirSync(path.join(root, ".nirvana"), { recursive: true });
  process.env.NIRVANA_HOME = home;
  process.env.NIRVANA_PROJECT_ROOT = root;
  process.env.NIRVANA_RUN_LEDGER_DB = path.join(home, ".nirvana", "run-ledger.sqlite");
  const { startServer } = await import("../lib/glance/server.ts");
  instance = await startServer({ port: 0, open: false, idleMin: 60, allowActions: false, theme: "apple" });
  base = `http://127.0.0.1:${instance.port}`;
});

afterAll(() => {
  try { instance?.close(); } catch {}
  for (const [key, value] of [["NIRVANA_HOME", previous.home], ["NIRVANA_PROJECT_ROOT", previous.project], ["NIRVANA_RUN_LEDGER_DB", previous.ledger]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  removeDir(root);
});

describe("the engine subsystem row", () => {
  test("names every subsystem and answers up, down or an honest null for each", () => {
    const subsystems = readSubsystems(root);
    expect(subsystems.map(s => s.key)).toEqual(EXPECTED_KEYS);
    for (const subsystem of subsystems) {
      expect(subsystem.label).toBeTruthy();
      expect([null, "up", "down"]).toContain(subsystem.status);
      // A reading always says what it read, whichever of the three it is.
      expect(subsystem.detail, `${subsystem.key} answered without a detail`).toBeTruthy();
    }
  });

  test("a probe never creates the database it measures", () => {
    const ledger = path.join(home, ".nirvana", "run-ledger.sqlite");
    const kernel = path.join(root, ".nirvana", "run-kernel.sqlite");
    expect(fs.existsSync(ledger)).toBe(false);
    expect(fs.existsSync(kernel)).toBe(false);

    const byKey = Object.fromEntries(readSubsystems(root).map(s => [s.key, s]));
    // Nothing has been tracked or prepared yet: undetermined, not "down".
    expect(byKey["supervisor"].status).toBeNull();
    expect(byKey["run-kernel"].status).toBeNull();

    expect(fs.existsSync(ledger), "the supervisor probe created the ledger").toBe(false);
    expect(fs.existsSync(kernel), "the run kernel probe created the kernel").toBe(false);
  });

  test("the gauntlet has no readable health signal outside a run, and says so instead of inventing one", () => {
    const gauntlet = readSubsystems(root).find(s => s.key === "gauntlet")!;
    expect(gauntlet.status).toBeNull();
    expect(gauntlet.detail).toContain("sem sinal de saúde fora de um run");
  });

  test("/api/subsystems serves the same reading over the wire", async () => {
    const payload = await fetch(`${base}/api/subsystems`).then(r => r.json()) as any;
    expect(payload.subsystems.map((s: any) => s.key)).toEqual(EXPECTED_KEYS);
  }, KERNEL_BUDGET_MS);

  test("the view shows a dot for a measured reading and an em dash for none", () => {
    expect(statusGlyph("up")).toBe("●");
    expect(statusGlyph("down")).toBe("●");
    expect(statusGlyph(null)).toBe("—");
    expect(statusClass("up")).toBe("subsystem-dot-up");
    expect(statusClass("down")).toBe("subsystem-dot-down");
    expect(statusClass(null)).toBe("subsystem-dot-unknown");
    expect(cellTitle({ label: "ROUTER", status: null, detail: "não lido", source: null })).toBe("ROUTER: não determinado · não lido");
  });

  test("the tally counts an undetermined subsystem on neither side", () => {
    const row = buildSubsystemRow({ subsystems: [
      { key: "a", label: "A", status: "up", detail: null, source: null },
      { key: "b", label: "B", status: "down", detail: null, source: null },
      { key: "c", label: "C", status: null, detail: null, source: null },
    ] });
    expect([row.up, row.down, row.unknown]).toEqual([1, 1, 1]);
    expect(rowSummary(row)).toBe("1/3 de pé · 1 sem sinal");

    // Nothing fetched yet, or the fetch failed: the row says nothing rather than
    // reporting every subsystem as down.
    const empty = buildSubsystemRow({ subsystems: null });
    expect(empty.cells).toEqual([]);
    expect(rowSummary(empty)).toBe("—");
  });
});
