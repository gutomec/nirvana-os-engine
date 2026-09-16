// activator-python-discovery.test.ts — the Python branch on a machine we know
// nothing about.
//
// Bun is there. "Probably" a node and a python, and no idea which. The
// activator used to probe `pip --version`, fall back to `pip3`, and install
// with `--user` into whatever Python that pip belonged to, never having asked.
// Measured on the maintainer's own machine: `python` on PATH was a dead shim
// ("Failed to locate 'python'", exit 1) ahead of a working `python3`; the
// Homebrew Python carried an EXTERNALLY-MANAGED marker, so `--user` there is
// refused by PEP 668; and 0 of the 48 Python entries in the installed library
// declared a `check:`, so pip ran on every activation of all 118 squads that
// declare Python at all.
//
// Every case here runs the real activator as a subprocess against fake
// interpreters on PATH and asserts on the argv they were actually given.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { callsOf, deadShims, fakePython, fakeUv, seedFakeVenv } from "./helpers/fake-python.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const ACTIVATOR = join(REPO, "skills", "squads", "lib", "activator.js");
const POSIX = process.platform !== "win32";
const { _pythonCandidates } = createRequire(import.meta.url)(ACTIVATOR) as { _pythonCandidates: (platform: string) => string[][] };

interface Fixture { root: string; squadDir: string; binDir: string; venvDir: string; satisfied: string; oldPip: string; }

function fixture(pythonDeps: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), "activator-python-"));
  const squadDir = join(root, "squads", "py-squad");
  const binDir = join(root, "bin");
  mkdirSync(squadDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(squadDir, "squad.yaml"), 'name: py-squad\nversion: "1.0.0"\nprotocol: "5.0"\ndescription: test\n');
  writeFileSync(join(squadDir, "dependencies.yaml"), pythonDeps);
  // Every probed name is dead until a test brings one to life, so the machine
  // running the suite cannot answer for the machine under test.
  if (POSIX) deadShims(binDir);
  // NIRVANA_HOME points at the fixture, so the shared venv lands here.
  return { root, squadDir, binDir, venvDir: join(root, ".nirvana", "python", "venv"), satisfied: join(root, "pip-satisfied"), oldPip: join(root, "pip-old") };
}

/** A PATH holding ONLY the fixture's fakes plus the directory bun lives in, so
 *  the machine's real python, uv and pip can never answer a probe. */
function isolatedPath(f: Fixture): string {
  const bunDir = join(process.execPath, "..");
  return `${f.binDir}${delimiter}${bunDir}${delimiter}/usr/bin${delimiter}/bin`;
}

/** Run the activator and hand back its exit code and its own account of what
 *  it did: `activate` prints the activation record as JSON on stdout in both
 *  modes, and that record is what every assertion below reads. */
function activate(f: Fixture, flags: string[] = []) {
  const r = spawnSync(process.execPath, [ACTIVATOR, "activate", "py-squad", ...flags], {
    encoding: "utf8",
    env: {
      ...process.env,
      NIRVANA_SKILLS_DIR: join(REPO, "skills"),
      NIRVANA_RESOLVED_SQUAD_PATH: f.squadDir,
      NIRVANA_STATE_DIR: join(f.root, "state"),
      NIRVANA_HOME: f.root,
      PATH: isolatedPath(f),
    },
  });
  let result: any = null;
  try { result = JSON.parse(r.stdout ?? ""); } catch { /* a crash prints no JSON; the status assertion says so */ }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", result };
}

const DEPS_ONE = 'python:\n  - "pyyaml>=6.0"\n';
const installs = (calls: string[][]) => calls.filter((c) => c[0] === "-m" && c[1] === "pip" && c[2] === "install" && !c.includes("--dry-run"));
const dryRuns = (calls: string[][]) => calls.filter((c) => c.includes("--dry-run"));
const probes = (calls: string[][]) => calls.filter((c) => c[0] === "-c");

describe("where python3 is tried", () => {
  test("Windows tries the py launcher and python first, and python3 last — the Store alias lives there", () => {
    expect(_pythonCandidates("win32")).toEqual([["py", "-3"], ["python"], ["python3"]]);
  });
  test("POSIX tries python3 first, python second", () => {
    expect(_pythonCandidates("darwin")).toEqual([["python3"], ["python"]]);
    expect(_pythonCandidates("linux")).toEqual([["python3"], ["python"]]);
  });
});

describe("proof of presence", () => {
  test.skipIf(!POSIX)("a venv that already satisfies every token is proven present, and pip install never runs", () => {
    const f = fixture(DEPS_ONE);
    const log = join(f.root, "py.log");
    const py = fakePython(f.binDir, "python3", log, { version: "3.11", satisfiedFlag: f.satisfied });
    seedFakeVenv(f.venvDir, py);
    writeFileSync(f.satisfied, "");
    try {
      const r = activate(f);
      expect(r.status).toBe(0);
      const calls = callsOf(log);
      expect(dryRuns(calls)).toHaveLength(1);
      expect(installs(calls)).toHaveLength(0);
      expect(r.result.steps.python).toMatchObject({ status: "already_present", via: "pip-dry-run" });
      // The proof is pip's own resolver, offline, version specifiers included.
      expect(dryRuns(calls)[0]).toEqual(["-m", "pip", "install", "--dry-run", "--no-index", "--quiet", "--report", "-", "pyyaml>=6.0"]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);

  test.skipIf(!POSIX)("not satisfied: the install runs INTO the venv, with the token as one argument", () => {
    const f = fixture(DEPS_ONE);
    const log = join(f.root, "py.log");
    const py = fakePython(f.binDir, "python3", log, { version: "3.11", satisfiedFlag: f.satisfied });
    seedFakeVenv(f.venvDir, py);
    try {
      const r = activate(f);
      expect(r.status).toBe(0);
      const calls = callsOf(log);
      expect(dryRuns(calls)).toHaveLength(1);
      expect(installs(calls)).toEqual([["-m", "pip", "install", "pyyaml>=6.0"]]);
      expect(r.result.steps.python).toMatchObject({ status: "installed", manager: "pip", venv: f.venvDir });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);

  test.skipIf(!POSIX)("a pip too old for --dry-run is not a proof — the install runs", () => {
    const f = fixture(DEPS_ONE);
    const log = join(f.root, "py.log");
    const py = fakePython(f.binDir, "python3", log, { version: "3.11", satisfiedFlag: f.satisfied, oldPipFlag: f.oldPip });
    seedFakeVenv(f.venvDir, py);
    writeFileSync(f.satisfied, "");   // it WOULD be satisfied, but this pip cannot say so
    writeFileSync(f.oldPip, "");
    try {
      const r = activate(f);
      expect(r.status).toBe(0);
      const calls = callsOf(log);
      expect(dryRuns(calls)).toHaveLength(1);
      expect(installs(calls)).toHaveLength(1);
      expect(r.result.steps.python.status).toBe("installed");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);

  test.skipIf(!POSIX)("the author's explicit check: still wins, and no interpreter is even probed", () => {
    const f = fixture('python:\n  packages:\n    - name: pyyaml\n      check: "true"\n');
    const log = join(f.root, "py.log");
    fakePython(f.binDir, "python3", log, { version: "3.11", satisfiedFlag: f.satisfied });
    try {
      const r = activate(f);
      expect(r.status).toBe(0);
      expect(r.result.steps.python).toMatchObject({ status: "already_present", via: "check" });
      expect(callsOf(log)).toHaveLength(0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);
});

describe("which interpreter", () => {
  test.skipIf(!POSIX)("a dead shim first on PATH is skipped by proof of execution, not by name", () => {
    // The maintainer's machine: `python` printed "Failed to locate 'python'"
    // and exited 1, ahead of a working `python3`. POSIX tries python3 first, so
    // here the dead one IS python3 and the working one is python.
    const f = fixture(DEPS_ONE);
    const deadLog = join(f.root, "dead.log");
    const liveLog = join(f.root, "live.log");
    fakePython(f.binDir, "python3", deadLog, { version: "3.11", satisfiedFlag: f.satisfied, broken: true });
    fakePython(f.binDir, "python", liveLog, { version: "3.11", satisfiedFlag: f.satisfied });
    try {
      const r = activate(f);
      expect(r.status).toBe(0);
      expect(probes(callsOf(deadLog))).toHaveLength(1);          // asked, and it failed
      expect(installs(callsOf(deadLog))).toHaveLength(0);        // never trusted with anything
      expect(r.result.steps.python).toMatchObject({ status: "installed", manager: "pip" });
      expect(existsSync(join(f.venvDir, "pyvenv.cfg"))).toBe(true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);

  test.skipIf(!POSIX)("an interpreter below 3.8 cannot prove anything and is skipped", () => {
    const f = fixture(DEPS_ONE);
    const oldLog = join(f.root, "old.log");
    const newLog = join(f.root, "new.log");
    fakePython(f.binDir, "python3", oldLog, { version: "3.7", satisfiedFlag: f.satisfied });
    fakePython(f.binDir, "python", newLog, { version: "3.12", satisfiedFlag: f.satisfied });
    try {
      const r = activate(f);
      expect(r.status).toBe(0);
      expect(installs(callsOf(oldLog))).toHaveLength(0);
      expect(r.result.steps.python.status).toBe("installed");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);

  test.skipIf(!POSIX)("no usable Python and no uv: reported as a warning with a hint, and the activation goes on", () => {
    const f = fixture(DEPS_ONE);
    fakePython(f.binDir, "python3", join(f.root, "old.log"), { version: "3.7", satisfiedFlag: f.satisfied });
    try {
      const r = activate(f);
      expect(r.status).toBe(0);   // not a failure: a buyer's machine without Python must not fail every other step
      const step = r.result.steps.python;
      expect(step.status).toBe("python_unavailable");
      expect(step.hint).toContain("uv");
      expect(existsSync(f.venvDir)).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);
});

describe("uv, when it is on the machine", () => {
  test.skipIf(!POSIX)("creates the venv with --seed --no-project and installs with --python <venv>; the proof is still pip's", () => {
    const f = fixture(DEPS_ONE);
    const uvLog = join(f.root, "uv.log");
    const pyLog = join(f.root, "py.log");
    // The interpreter uv copies into the venv; nothing else on PATH answers to python.
    const pySrc = fakePython(join(f.root, "src"), "python", pyLog, { version: "3.12", satisfiedFlag: f.satisfied });
    fakeUv(f.binDir, uvLog, pySrc);
    try {
      const first = activate(f);
      expect(first.status).toBe(0);
      const uv = callsOf(uvLog);
      expect(uv).toContainEqual(["venv", "--seed", "--no-project", f.venvDir]);
      expect(uv).toContainEqual(["pip", "install", "--python", join(f.venvDir, "bin", "python"), "pyyaml>=6.0"]);
      expect(first.result.steps.python).toMatchObject({ status: "installed", manager: "uv" });
      // Second activation: the venv exists, pip's dry-run proves presence, uv installs nothing.
      writeFileSync(f.satisfied, "");
      const second = activate(f);
      expect(second.status).toBe(0);
      expect(dryRuns(callsOf(pyLog))).toHaveLength(1);
      expect(callsOf(uvLog).filter((c) => c[0] === "pip" && c[1] === "install")).toHaveLength(1);
      expect(second.result.steps.python).toMatchObject({ status: "already_present", via: "pip-dry-run" });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);
});

describe("--dry-run", () => {
  test.skipIf(!POSIX)("plans the venv and the install without creating either", () => {
    const f = fixture(DEPS_ONE);
    fakePython(f.binDir, "python3", join(f.root, "py.log"), { version: "3.11", satisfiedFlag: f.satisfied });
    try {
      const r = activate(f, ["--dry-run"]);
      expect(r.status).toBe(0);
      expect(existsSync(f.venvDir)).toBe(false);
      // `--dry-run` prints the plan as JSON on stdout; that is the contract the
      // plan test in activator-package-token-injection reads too.
      const step = r.result.steps.python;
      expect(step.status).toBe("would_install");
      expect(step.would_create_venv).toContain("-m venv");
      expect(step.argv.at(-1)).toBe("pyyaml>=6.0");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);
});
