// project-root.test.ts — the one "walk up from cwd, stop at HOME or the
// filesystem root" implementation, tested in isolation from any of its five
// consumers (paths.js, scope.ts, log-paths.ts, handoff.js, wiki-lint.js).
//
// The failure this pins: a walk that starts inside a directory ~/.nirvana
// (the engine's own install) sits in, or above, must never mistake that
// directory for a project — os.tmpdir() on the Windows CI runner resolves
// *inside* the real HOME, so a fixture's temp dir is a physical descendant of
// a directory that now looks like a project (PR #158 round 2's failure mode,
// reproducible on any platform once HOME contains the temp root, which is
// exactly what `home` below sets up).
//
// Runs with: bun test skills/_shared/tests
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { findProjectRoot, isInvalidProjectRoot, isProjectRoot, manifestScope, outputsBaseDir, resolveProjectRoot, resolveScopeMode, undeclaredProjectState } from "../lib/project-root.js";
import { makeTempRoot } from "../../harness/tests/helpers/temp-dirs.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

/** A folder declared a project, the way `nrv init` / `nrv init --adopt` leave it. */
function declare(dir: string): void {
  fs.mkdirSync(path.join(dir, ".nirvana"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".nirvana", "project.yaml"), "{}\n");
}

function fixture() {
  const root = makeTempRoot("nrv-project-root-");
  roots.push(root);
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".nirvana"), { recursive: true });
  return { root, home };
}

describe("findProjectRoot — a shared temp root is never a project either", () => {
  // Same reasoning as HOME: /tmp is scratch space every tool on the machine
  // writes to. Measured 2026-09-03: `/private/tmp` held a `.nirvana` and a
  // `package.json` left by unrelated tools, so every scope resolution from a
  // path under it adopted `/private/tmp` as the project — and a dispatch
  // launched from a scratch directory wrote its brief, kernel and audit chain
  // there, believing it was inside a project.
  test("the temp root itself is not a project, even carrying a marker", () => {
    const tmp = fs.realpathSync(os.tmpdir());
    fs.writeFileSync(path.join(tmp, ".nrv-marker-probe.json"), "{}");
    try {
      // A marker sitting in the temp root must not make the temp root a project.
      expect(findProjectRoot(tmp, { markers: [".nrv-marker-probe.json"] })).toBeNull();
    } finally {
      fs.rmSync(path.join(tmp, ".nrv-marker-probe.json"), { force: true });
    }
  });

  test("a project CREATED under temp is still found — every fixture in this repo is one", () => {
    // The rule is `sameDir`, not `isUnder`: excluding the whole subtree would
    // break the fixtures that make this suite possible.
    const root = makeTempRoot("nrv-under-temp-");
    roots.push(root);
    const proj = path.join(root, "a-real-project");
    declare(proj);
    const start = path.join(proj, "src", "deep");
    fs.mkdirSync(start, { recursive: true });
    expect(findProjectRoot(start)).toBe(fs.realpathSync(proj));
  });
});

describe("findProjectRoot — HOME is never a project, whatever is inside it", () => {
  test("a temp dir physically under HOME finds nothing, not HOME itself", () => {
    const { home } = fixture();
    const start = path.join(home, "tmp", "fixture-xyz");
    fs.mkdirSync(start, { recursive: true });
    expect(findProjectRoot(start, { home })).toBeNull();
  });

  test("HOME itself is never returned, even though it carries a marker", () => {
    const { home } = fixture();
    expect(findProjectRoot(home, { home })).toBeNull();
  });

  test("a real project INSIDE home is still found — the guard does not swallow the normal case", () => {
    const { home } = fixture();
    const proj = path.join(home, "work", "my-project");
    fs.mkdirSync(path.join(proj, "sub"), { recursive: true });
    declare(proj);
    expect(findProjectRoot(path.join(proj, "sub"), { home })).toBe(proj);
  });

  test("a project just outside HOME's ancestry is found normally", () => {
    const { root, home } = fixture();
    const proj = path.join(root, "other", "project");
    fs.mkdirSync(path.join(proj, "sub"), { recursive: true });
    declare(proj);
    expect(findProjectRoot(path.join(proj, "sub"), { home })).toBe(proj);
  });

  test("the filesystem root is never a project root, even carrying a marker", () => {
    const fsRoot = path.parse(process.cwd()).root;
    // Don't actually write to the real fs root; isInvalidProjectRoot alone
    // proves the exclusion without needing a marker file there.
    expect(isInvalidProjectRoot(fsRoot)).toBe(true);
  });

  test("a lookup for something that is not a project passes its own marker (validators/limits.ts)", () => {
    const { root, home } = fixture();
    const dir = path.join(root, "with-config");
    fs.mkdirSync(dir, { recursive: true });
    expect(findProjectRoot(dir, { home, markers: [".nirvana-limits.yaml"] })).toBeNull();
    fs.writeFileSync(path.join(dir, ".nirvana-limits.yaml"), "{}");
    expect(findProjectRoot(dir, { home, markers: [".nirvana-limits.yaml"] })).toBe(dir);
  });

  test("no project in reach returns null, not a guess", () => {
    const { root, home } = fixture();
    const standalone = path.join(root, "standalone");
    fs.mkdirSync(standalone, { recursive: true });
    expect(findProjectRoot(standalone, { home })).toBeNull();
  });
});

test("the engine home (~/.nirvana) is never a project root, even with the deps store's package.json in it", () => {
  // Seen 2026-09-16: ~/.nirvana carries the dependency store's package.json,
  // so a command run from inside it adopted ~/.nirvana as the project and
  // wrote a second ~/.nirvana/.nirvana with registries, logs and a state.db.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-engine-home-"));
  const engineHome = path.join(home, ".nirvana");
  fs.mkdirSync(path.join(engineHome, "outputs", "run-1"), { recursive: true });
  fs.writeFileSync(path.join(engineHome, "package.json"), '{"name":"nirvana-os","private":true}');
  expect(isInvalidProjectRoot(engineHome, { home })).toBe(true);
  expect(findProjectRoot(path.join(engineHome, "outputs", "run-1"), { home })).toBeNull();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("a project is declared, never inferred", () => {
  // Every repository carries `.git`, `package.json`, `.env` or `pyproject.toml`,
  // and hooks left bare `.nirvana/` folders behind. Reading any of those as a
  // project made a repository's root the project of every command run inside it.
  test("a repository with .git, package.json, .env, pyproject.toml and a bare .nirvana is not a project", () => {
    const { root, home } = fixture();
    const repo = path.join(root, "some-repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".nirvana", "logs"), { recursive: true });
    for (const f of ["package.json", ".env", "pyproject.toml"]) fs.writeFileSync(path.join(repo, f), "");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    expect(findProjectRoot(path.join(repo, "src"), { home })).toBeNull();
    expect(isProjectRoot(repo, { home })).toBe(false);
  });

  test(".nirvana/project.yaml makes it one", () => {
    const { root, home } = fixture();
    const repo = path.join(root, "declared-repo");
    fs.mkdirSync(path.join(repo, ".git", "objects"), { recursive: true });
    declare(repo);
    expect(findProjectRoot(path.join(repo, ".git", "objects"), { home })).toBe(repo);
    expect(isProjectRoot(repo, { home })).toBe(true);
  });

  test("NIRVANA_PROJECT_ROOT wins over the walk", () => {
    const { root, home } = fixture();
    const walked = path.join(root, "walked");
    const pinned = path.join(root, "pinned");
    declare(walked);
    fs.mkdirSync(pinned, { recursive: true });
    expect(resolveProjectRoot({ cwd: walked, env: { NIRVANA_PROJECT_ROOT: pinned }, home })).toBe(pinned);
    expect(resolveProjectRoot({ cwd: walked, env: {}, home })).toBe(walked);
  });

  test("a pinned root that can never be a project (HOME) resolves to none, not to a project", () => {
    const { home } = fixture();
    expect(resolveProjectRoot({ cwd: home, env: { NIRVANA_PROJECT_ROOT: home }, home })).toBeNull();
  });

  test("outputs go to <project>/outputs, or to the engine's store when there is no project", () => {
    expect(outputsBaseDir("/work/proj")).toBe(path.join("/work/proj", "outputs"));
    expect(outputsBaseDir(null, { HOME: "/h" })).toBe(path.join("/h", ".nirvana", "outputs"));
    expect(outputsBaseDir(null, { HOME: "/h", NIRVANA_HOME: "/n" })).toBe(path.join("/n", ".nirvana", "outputs"));
  });

  test("a folder holding Nirvana state without project.yaml is reported for adoption", () => {
    const { root, home } = fixture();
    const legacy = path.join(root, "legacy-project");
    fs.mkdirSync(path.join(legacy, ".nirvana", "logs"), { recursive: true });
    fs.writeFileSync(path.join(legacy, ".nirvana", "run-kernel.sqlite"), "");
    fs.mkdirSync(path.join(legacy, "src"), { recursive: true });
    const found = undeclaredProjectState(path.join(legacy, "src"), { home });
    expect(found?.dir).toBe(fs.realpathSync(legacy));
    expect(found?.state).toEqual(expect.arrayContaining(["logs", "run-kernel.sqlite"]));
    declare(legacy);
    expect(undeclaredProjectState(path.join(legacy, "src"), { home })).toBeNull();
  });
});

describe("the scope lives in the project manifest", () => {
  const withManifest = (content: string | null) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-scope-manifest-"));
    fs.mkdirSync(path.join(root, ".nirvana"), { recursive: true });
    if (content !== null) fs.writeFileSync(path.join(root, ".nirvana", "project.yaml"), content);
    return root;
  };

  test("read from the JSON manifest nrv init writes, and from a hand-edited YAML one", () => {
    expect(manifestScope(withManifest('{"scope": "project"}'))).toBe("project");
    expect(manifestScope(withManifest("schema_version: x\nscope: merge\n"))).toBe("merge");
    expect(manifestScope(withManifest('{"scope": "nonsense"}'))).toBeNull();
    expect(manifestScope(withManifest(null))).toBeNull();
    expect(manifestScope(null)).toBeNull();
  });

  test("environment > manifest > legacy .env > global", () => {
    const root = withManifest('{"scope": "project"}');
    expect(resolveScopeMode(root, { NIRVANA_SCOPE: "merge" }, { NIRVANA_SCOPE: "global" })).toBe("merge");
    expect(resolveScopeMode(root, {}, { NIRVANA_SCOPE: "merge" })).toBe("project");
    expect(resolveScopeMode(withManifest(null), {}, { NIRVANA_SCOPE: "merge" })).toBe("merge");
    expect(resolveScopeMode(withManifest(null), {}, {})).toBe("global");
  });
});
