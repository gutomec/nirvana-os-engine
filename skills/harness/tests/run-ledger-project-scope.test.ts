// run-ledger-project-scope.test.ts — a project sees ITS OWN runs, and nothing else.
//
// The ledger is one global SQLite DB, and until now every reader of it saw the
// whole machine. On 2026-08-27 a session working in ~/nirvana-os listed the
// open runs, found rows belonging to ~/venda-mundial-pro and
// consultorio-dr-paulo, and CLOSED one of them — a run of another project,
// terminated by a stranger, recoverable only through an x_audit_correction.
//
// The reasoning behind the global DB ("the launchd supervisor runs with no
// project context and must see every run on the machine") was only ever true
// for the supervisor. These tests pin the scope on everyone else: the row
// carries its project root, every read and write filters by the root the
// process is serving, and the supervisor is the single documented exception.
//
// Reading and WRITING FILES outside the project stays allowed — a dispatched
// job may need any directory. This is about seeing other projects' RUNS.
import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-ledger-scope-"));
const SKILLS = path.resolve(import.meta.dir, "..", "..");

// Snapshot BEFORE mutating: bun runs test FILES in one process, so anything
// left behind here would point every later file at this throwaway state.
const ENV_BEFORE = {
  HARNESS_LOGS_DIR: process.env.HARNESS_LOGS_DIR,
  NIRVANA_STATE_DB: process.env.NIRVANA_STATE_DB,
  NIRVANA_SKILLS_DIR: process.env.NIRVANA_SKILLS_DIR,
  NIRVANA_RUN_LEDGER_DB: process.env.NIRVANA_RUN_LEDGER_DB,
  NIRVANA_PROJECT_ROOT: process.env.NIRVANA_PROJECT_ROOT,
  NIRVANA_NO_DESKTOP_NOTIFY: process.env.NIRVANA_NO_DESKTOP_NOTIFY,
};
process.env.HARNESS_LOGS_DIR = path.join(TMP, "harness-logs");
process.env.NIRVANA_STATE_DB = path.join(TMP, "state.db");
process.env.NIRVANA_SKILLS_DIR = SKILLS;
process.env.NIRVANA_RUN_LEDGER_DB = path.join(TMP, "default-ledger.sqlite");
process.env.NIRVANA_NO_DESKTOP_NOTIFY = "1";

import { Database } from "bun:sqlite";
import {
  openLedger, openRun, openAgenticRun, getRun, markState, beatAgenticRuns,
  findNonTerminal, countNonTerminal, findExpired, findRelatedRuns,
  resolveProjectRoot, findProjectRootFrom, sameProjectRoot,
  type LedgerHandle, type RunRow,
} from "../lib/run-ledger.ts";

/** Two real projects on disk: a marker each, exactly as the resolver finds one. */
function makeProject(name: string): string {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  // realpath: macOS hands out /var/folders/… for a /private/var/folders/… dir,
  // and the ledger normalizes, so the fixture must compare against the same form.
  return fs.realpathSync(dir);
}

const PROJ_A = makeProject("projeto-a");
const PROJ_B = makeProject("projeto-b");

/** Run `fn` as a process serving `root` (null = no project at all). */
function asProject<T>(root: string | null, fn: () => T): T {
  const before = process.env.NIRVANA_PROJECT_ROOT;
  if (root) process.env.NIRVANA_PROJECT_ROOT = root;
  else delete process.env.NIRVANA_PROJECT_ROOT;
  try { return fn(); }
  finally {
    if (before === undefined) delete process.env.NIRVANA_PROJECT_ROOT;
    else process.env.NIRVANA_PROJECT_ROOT = before;
  }
}

let dbSeq = 0;
function freshLedger(): LedgerHandle {
  return openLedger(path.join(TMP, `case-${dbSeq++}.sqlite`));
}

afterAll(() => {
  for (const [k, v] of Object.entries(ENV_BEFORE)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ── 1. where the root comes from ──────────────────────────────────────────

describe("the root a process is serving", () => {
  test("NIRVANA_PROJECT_ROOT wins, normalized", () => {
    asProject(PROJ_A, () => {
      expect(resolveProjectRoot()).toBe(PROJ_A);
    });
  });

  test("without the env var, the first marker-bearing ancestor of cwd", () => {
    const nested = path.join(PROJ_B, "outputs", "trace-1", "squads", "x");
    fs.mkdirSync(nested, { recursive: true });
    expect(findProjectRootFrom(nested)).toBe(PROJ_B);
  });

  test("a path that never had a marker resolves to no project", () => {
    // TMP itself carries no .git/.env/.nirvana/package.json; HOME and / are
    // never projects, so the walk runs out.
    expect(findProjectRootFrom(TMP)).toBeNull();
  });

  test("HOME is never a project root", () => {
    expect(findProjectRootFrom(os.homedir())).not.toBe(fs.realpathSync(os.homedir()));
  });

  test("sameProjectRoot compares roots, not strings-with-slashes", () => {
    expect(sameProjectRoot(PROJ_A, PROJ_A + path.sep)).toBe(true);
    expect(sameProjectRoot(PROJ_A, PROJ_B)).toBe(false);
    expect(sameProjectRoot(null, null)).toBe(true);
    expect(sameProjectRoot(PROJ_A, null)).toBe(false);
  });
});

// ── 2. the column, the migration and the legacy rows ──────────────────────

describe("project_root — schema and migration", () => {
  test("a fresh ledger has the column and every new row carries the root", () => {
    const h = asProject(PROJ_A, () => {
      const handle = freshLedger();
      openRun(handle, { runId: "r-a", targetSlug: "t", targetKind: "squad" });
      return handle;
    });
    expect(getRun(h, "r-a")!.project_root).toBe(PROJ_A);
  });

  test("openAgenticRun stamps the process root, not its outputs dir", () => {
    const db = path.join(TMP, "agentic.sqlite");
    const opened = asProject(PROJ_A, () => {
      process.env.NIRVANA_RUN_LEDGER_DB = db;
      try {
        return openAgenticRun({
          projectId: "projeto-a", targetSlug: "s", targetKind: "squad",
          outputsRoot: path.join(PROJ_A, "outputs", "t1"),
        });
      } finally { process.env.NIRVANA_RUN_LEDGER_DB = path.join(TMP, "default-ledger.sqlite"); }
    });
    expect(opened).not.toBeNull();
    const row = getRun(openLedger(db), opened!.runId)!;
    expect(row.project_root).toBe(PROJ_A);
    // meta keeps recording the outputs dir; the column is the project.
    expect(row.meta.outputs_root).toBe(path.join(PROJ_A, "outputs", "t1"));
  });

  test("an explicit projectRoot overrides the ambient one", () => {
    const h = asProject(PROJ_A, () => {
      const handle = freshLedger();
      openRun(handle, { runId: "r-explicit", targetSlug: "t", targetKind: "squad", projectRoot: PROJ_B });
      return handle;
    });
    expect(getRun(h, "r-explicit")!.project_root).toBe(PROJ_B);
  });

  test("an old ledger is migrated in place, idempotently, and backfilled from meta", () => {
    const dbPath = path.join(TMP, "legacy.sqlite");
    // The pre-migration schema, verbatim — no project_root column.
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE runs (
      run_id TEXT PRIMARY KEY, trace_id TEXT, project_id TEXT, target_slug TEXT, target_kind TEXT,
      state TEXT NOT NULL, child_pid INTEGER, session_id TEXT, runtime TEXT, lease_expires_at TEXT,
      heartbeat_at TEXT, retries INTEGER NOT NULL DEFAULT 0, max_retries INTEGER NOT NULL DEFAULT 2,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, terminal_at TEXT, last_error TEXT,
      meta TEXT NOT NULL DEFAULT '{}')`);
    const now = new Date().toISOString();
    const insert = (id: string, meta: Record<string, unknown>) =>
      raw.run("INSERT INTO runs (run_id, state, created_at, updated_at, meta) VALUES (?, 'running', ?, ?, ?)",
        [id, now, now, JSON.stringify(meta)]);
    // Shapes taken from the owner's real ledger on 2026-08-27.
    insert("legacy-relative", { project_root: ".nirvana/outputs/t", project_dir: ".nirvana/outputs/t", cwd: PROJ_A });
    insert("legacy-absolute", { project_root: path.join(PROJ_B, "outputs", "t", "businesses", "vivid-pancake") });
    insert("legacy-cwd-only", { cwd: path.join(PROJ_B, "deep", "inside") });
    insert("legacy-deleted-outputs", { project_root: path.join(PROJ_A, "outputs", "gone-for-good") });
    insert("legacy-nothing", { path: "agentic" });
    insert("legacy-unparseable", {});
    raw.run("UPDATE runs SET meta = 'not json' WHERE run_id = 'legacy-unparseable'");
    raw.close();

    const h = openLedger(dbPath);
    const rootOf = (id: string) => getRun(h, id)!.project_root;
    expect(rootOf("legacy-relative")).toBe(PROJ_A);
    expect(rootOf("legacy-absolute")).toBe(PROJ_B);
    expect(rootOf("legacy-cwd-only")).toBe(PROJ_B);
    // The outputs dir is long gone; the walk still lands on the project above it.
    expect(rootOf("legacy-deleted-outputs")).toBe(PROJ_A);
    // Nothing to derive from: NULL means legacy, and legacy is never lost.
    expect(rootOf("legacy-nothing")).toBeNull();
    expect(rootOf("legacy-unparseable")).toBeNull();

    // Re-opening runs the migration again and changes nothing.
    h.close();
    const again = openLedger(dbPath);
    expect(again.db.query("PRAGMA table_info(runs)").all().filter((c: any) => c.name === "project_root").length).toBe(1);
    expect(getRun(again, "legacy-relative")!.project_root).toBe(PROJ_A);
  });
});

// ── 3. two projects, one ledger, no crossing ──────────────────────────────

describe("two projects with active runs never see each other", () => {
  let h: LedgerHandle;

  beforeAll(() => {
    h = openLedger(path.join(TMP, "two-projects.sqlite"));
    // Same project_id and trace_id on both sides on purpose: the id is a
    // directory BASENAME, so two projects can collide on it. Only the root
    // separates them.
    asProject(PROJ_A, () => {
      openRun(h, { runId: "a-1", projectId: "cliente", traceId: "t-shared", targetSlug: "brand", targetKind: "squad" });
      openRun(h, { runId: "a-2", projectId: "cliente", traceId: "t-shared", targetSlug: "docs", targetKind: "squad", initialLeaseSec: -60 });
    });
    asProject(PROJ_B, () => {
      openRun(h, { runId: "b-1", projectId: "cliente", traceId: "t-shared", targetSlug: "ads", targetKind: "business" });
      openRun(h, { runId: "b-2", projectId: "cliente", traceId: "t-shared", targetSlug: "video", targetKind: "squad", initialLeaseSec: -60 });
    });
    // A row from before the column existed: no root at all.
    h.db.run("INSERT INTO runs (run_id, project_id, state, created_at, updated_at, meta, lease_expires_at) VALUES (?, ?, 'running', ?, ?, '{}', NULL)",
      ["legacy-1", "cliente", new Date().toISOString(), new Date().toISOString()]);
  });

  test("findNonTerminal lists only the caller's project", () => {
    expect(asProject(PROJ_A, () => findNonTerminal(h).map(r => r.run_id)).sort()).toEqual(["a-1", "a-2"]);
    expect(asProject(PROJ_B, () => findNonTerminal(h).map(r => r.run_id)).sort()).toEqual(["b-1", "b-2"]);
  });

  test("countNonTerminal counts only the caller's project", () => {
    expect(asProject(PROJ_A, () => countNonTerminal(h))).toBe(2);
    expect(asProject(PROJ_B, () => countNonTerminal(h))).toBe(2);
  });

  test("the expired-lease sweep never reaches the other project", () => {
    expect(asProject(PROJ_A, () => findExpired(h).map(r => r.run_id))).toEqual(["a-2"]);
    expect(asProject(PROJ_B, () => findExpired(h).map(r => r.run_id))).toEqual(["b-2"]);
  });

  test("findRelatedRuns stays inside the project even when ids collide", () => {
    const a1 = asProject(PROJ_A, () => getRun(h, "a-1")!);
    expect(asProject(PROJ_A, () => findRelatedRuns(h, a1).map(r => r.run_id)).sort()).toEqual(["a-2"]);
  });

  test("the machine-wide scope sees every project, legacy rows included", () => {
    const all = asProject(PROJ_A, () => findNonTerminal(h, { allProjects: true }).map(r => r.run_id));
    expect(all.sort()).toEqual(["a-1", "a-2", "b-1", "b-2", "legacy-1"]);
    expect(asProject(PROJ_A, () => countNonTerminal(h, { allProjects: true }))).toBe(5);
    expect(asProject(PROJ_A, () => findExpired(h, undefined, { allProjects: true }).map(r => r.run_id)).sort())
      .toEqual(["a-2", "b-2", "legacy-1"]);
  });

  test("a legacy row survives: invisible to a project, present in history", () => {
    expect(asProject(PROJ_A, () => findNonTerminal(h).map(r => r.run_id))).not.toContain("legacy-1");
    expect(getRun(h, "legacy-1")).not.toBeNull();
    expect(getRun(h, "legacy-1")!.project_root).toBeNull();
  });

  test("an explicit projectRoot scopes a reader without touching the environment", () => {
    expect(asProject(PROJ_A, () => findNonTerminal(h, { projectRoot: PROJ_B }).map(r => r.run_id)).sort())
      .toEqual(["b-1", "b-2"]);
    expect(asProject(PROJ_A, () => findNonTerminal(h, { projectRoot: null }).map(r => r.run_id)))
      .toEqual(["legacy-1"]);
  });
});

// ── 4. the writers ────────────────────────────────────────────────────────

describe("beatAgenticRuns beats this project's rows and nobody else's", () => {
  // beatAgenticRuns opens the DEFAULT ledger by itself (no handle argument) —
  // it is called from scripts that never hold one.
  const db = process.env.NIRVANA_RUN_LEDGER_DB!;

  function open(root: string, runId: string): RunRow {
    return asProject(root, () => {
      const h = openLedger(db);
      const row = openRun(h, {
        runId, projectId: "cliente", traceId: "cliente", targetSlug: "emp", targetKind: "business",
        meta: { path: "agentic" },
      });
      markState(h, runId, "running");
      return row;
    });
  }

  test("a beat from project A leaves project B's lease untouched", () => {
    open(PROJ_A, "beat-a");
    open(PROJ_B, "beat-b");
    const h = openLedger(db);
    const before = getRun(h, "beat-b")!.lease_expires_at;
    const beaten = asProject(PROJ_A, () => beatAgenticRuns({ projectId: "cliente", source: "test" }));
    expect(beaten).toBe(1);
    expect(getRun(h, "beat-b")!.lease_expires_at).toBe(before!);
    expect(getRun(h, "beat-a")!.heartbeat_at).not.toBeNull();
  });

  test("naming another project's run id explicitly does not beat it either", () => {
    const h = openLedger(db);
    const before = getRun(h, "beat-b")!.lease_expires_at;
    const beaten = asProject(PROJ_A, () => beatAgenticRuns({ runId: "beat-b", source: "test" }));
    expect(beaten).toBe(0);
    expect(getRun(h, "beat-b")!.lease_expires_at).toBe(before!);
  });
});

// ── 5. the CLI the owner used when this went wrong ────────────────────────

describe("nrv run-track — the door a session actually touches", () => {
  const db = path.join(TMP, "run-track.sqlite");
  const script = path.join(SKILLS, "harness", "scripts", "run-track.ts");

  function runTrack(root: string | null, args: string[]): { status: number | null; stdout: string; stderr: string } {
    const env: Record<string, string> = {
      ...process.env,
      NIRVANA_RUN_LEDGER_DB: db,
      NIRVANA_SKILLS_DIR: SKILLS,
      NIRVANA_NO_DESKTOP_NOTIFY: "1",
      HARNESS_LOGS_DIR: path.join(TMP, "harness-logs"),
    } as Record<string, string>;
    if (root) env.NIRVANA_PROJECT_ROOT = root;
    else delete env.NIRVANA_PROJECT_ROOT;
    const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: root ?? TMP, env });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  beforeAll(() => {
    const h = openLedger(db);
    // `running`, as openAgenticRun leaves an agentic row: that is the state a
    // `close` walks out of.
    asProject(PROJ_A, () => {
      openRun(h, { runId: "ct-a", projectId: "cliente", targetSlug: "brand", targetKind: "squad" });
      markState(h, "ct-a", "running");
    });
    asProject(PROJ_B, () => {
      openRun(h, { runId: "ct-b", projectId: "cliente", targetSlug: "ads", targetKind: "business" });
      markState(h, "ct-b", "running");
    });
  });

  test("list shows this project's runs only", () => {
    const a = runTrack(PROJ_A, ["list"]);
    expect(a.status).toBe(0);
    expect(a.stdout).toContain("squad/brand");
    expect(a.stdout).not.toContain("business/ads");

    const b = runTrack(PROJ_B, ["list"]);
    expect(b.stdout).toContain("business/ads");
    expect(b.stdout).not.toContain("squad/brand");
  });

  test("closing another project's run is refused, and names the owner", () => {
    const before = getRun(openLedger(db), "ct-b")!;
    const r = runTrack(PROJ_A, ["close", "ct-b", "--state", "delivered"]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain(PROJ_B);
    expect(r.stderr).toContain("ct-b");
    // The run of the other project is untouched — this is the exact damage of
    // 2026-08-27, when a foreign row was closed by a session that just saw it.
    const after = getRun(openLedger(db), "ct-b")!;
    expect(after.state).toBe(before.state);
    expect(after.terminal_at).toBeNull();
  });

  test("beating another project's run is refused too", () => {
    const before = getRun(openLedger(db), "ct-b")!;
    const r = runTrack(PROJ_A, ["beat", "ct-b"]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain(PROJ_B);
    const after = getRun(openLedger(db), "ct-b")!;
    expect(after.lease_expires_at).toBe(before.lease_expires_at!);
    expect(after.heartbeat_at).toBe(before.heartbeat_at!);
  });

  test("its own run still closes normally", () => {
    const r = runTrack(PROJ_A, ["close", "ct-a", "--state", "delivered"]);
    expect(r.status).toBe(0);
    expect(getRun(openLedger(db), "ct-a")!.state).toBe("delivered");
  });
});

// ── 6. the supervisor, and only the supervisor, sees the machine ──────────

describe("supervisor — the documented exception", () => {
  const db = path.join(TMP, "supervisor.sqlite");
  const script = path.join(SKILLS, "harness", "scripts", "supervisor.ts");

  function supervisor(root: string | null, args: string[]): { status: number | null; stdout: string; stderr: string } {
    const env: Record<string, string> = {
      ...process.env,
      NIRVANA_RUN_LEDGER_DB: db,
      NIRVANA_SKILLS_DIR: SKILLS,
      NIRVANA_NO_DESKTOP_NOTIFY: "1",
      NRV_SUPERVISOR: "0",
      HARNESS_LOGS_DIR: path.join(TMP, "harness-logs"),
    } as Record<string, string>;
    if (root) env.NIRVANA_PROJECT_ROOT = root;
    else delete env.NIRVANA_PROJECT_ROOT;
    const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: root ?? TMP, env });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  beforeAll(() => {
    const h = openLedger(db);
    asProject(PROJ_A, () => { openRun(h, { runId: "sv-a", projectId: "cliente", targetSlug: "brand", targetKind: "squad" }); });
    asProject(PROJ_B, () => { openRun(h, { runId: "sv-b", projectId: "cliente", targetSlug: "ads", targetKind: "business" }); });
  });

  test("status without the flag sweeps only the project it is standing in", () => {
    const a = supervisor(PROJ_A, ["status"]);
    expect(a.status).toBe(0);
    expect(a.stdout).toContain("sv-a");
    expect(a.stdout).not.toContain("sv-b");
  });

  test("status --all-projects sees the whole machine", () => {
    const all = supervisor(PROJ_A, ["status", "--all-projects"]);
    expect(all.status).toBe(0);
    expect(all.stdout).toContain("sv-a");
    expect(all.stdout).toContain("sv-b");
  });

  test("with no project to scope to, it stays machine-wide and says why", () => {
    // This is launchd: cwd `/`, no NIRVANA_PROJECT_ROOT. The never-stall
    // guarantee cannot depend on the operator re-installing the LaunchAgent.
    const r = supervisor(null, ["status"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("sv-a");
    expect(r.stdout).toContain("sv-b");
    expect(r.stderr).toMatch(/all-projects|projeto/i);
  });

  test("the LaunchAgent it writes asks for the machine-wide scope explicitly", async () => {
    const { renderLaunchdPlist } = await import("../scripts/supervisor.ts");
    expect(renderLaunchdPlist()).toContain("<string>--all-projects</string>");
  });
});

// ── 7. the sweep itself: recovery never crosses the fence ─────────────────

describe("a sweep recovers its own project and leaves the other alone", () => {
  const escalated: string[] = [];
  const salvaged: string[] = [];

  /** Far past the lease and the stall budget, so a row born now looks silent. */
  const LATER = Date.now() + 40 * 60_000;

  function ledgerWithBothProjects(): LedgerHandle {
    const h = freshLedger();
    for (const [root, id] of [[PROJ_A, "sw-a"], [PROJ_B, "sw-b"]] as const) {
      asProject(root, () => {
        openRun(h, {
          runId: id, projectId: "cliente", traceId: "cliente", targetSlug: "emp", targetKind: "business",
          initialLeaseSec: -60, meta: { path: "agentic" },
        });
        markState(h, id, "running");
      });
    }
    return h;
  }

  const deps = (h: LedgerHandle, allProjects: boolean) => ({
    handle: h, now: LATER, allProjects, quiet: true, pidExitWaitMs: 0,
    notifyImpl: (row: RunRow) => { escalated.push(row.run_id); },
    salvageImpl: (row: RunRow) => {
      salvaged.push(row.run_id);
      return {
        judged: false, skipReason: "no_artifacts" as const, artifacts: 0, gateable: 0, gate: null,
        delivered: false, ceiling: null, outputsRoot: null, finalState: "stalled" as const, detail: null,
      };
    },
    resumeImpl: () => { throw new Error("a run of another project must never be resumed from here"); },
    redispatchImpl: () => { throw new Error("a run of another project must never be re-dispatched from here"); },
    killImpl: () => { throw new Error("a run of another project must never be signalled from here"); },
  });

  test("scoped: one row scanned, one escalated, the other project untouched", async () => {
    const { sweep } = await import("../scripts/supervisor.ts");
    const h = ledgerWithBothProjects();
    escalated.length = 0; salvaged.length = 0;

    const s = asProject(PROJ_A, () => sweep(deps(h, false)));
    expect(s.scanned).toBe(1);
    expect(s.escalated).toBe(1);
    expect(escalated).toEqual(["sw-a"]);
    expect(salvaged).toEqual(["sw-a"]);
    expect(getRun(h, "sw-a")!.state).toBe("stalled");
    // Project B's run is still exactly where its own session left it.
    expect(getRun(h, "sw-b")!.state).toBe("running");
    expect(getRun(h, "sw-b")!.meta.salvage).toBeUndefined();
  });

  test("--all-projects: the supervisor still reaches every project", async () => {
    const { sweep } = await import("../scripts/supervisor.ts");
    const h = ledgerWithBothProjects();
    escalated.length = 0; salvaged.length = 0;

    const s = asProject(PROJ_A, () => sweep(deps(h, true)));
    expect(s.scanned).toBe(2);
    expect(s.escalated).toBe(2);
    expect(escalated.sort()).toEqual(["sw-a", "sw-b"]);
    expect(getRun(h, "sw-a")!.state).toBe("stalled");
    expect(getRun(h, "sw-b")!.state).toBe("stalled");
  });
});
