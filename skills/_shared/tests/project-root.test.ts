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
import { findProjectRoot, isInvalidProjectRoot } from "../lib/project-root.js";
import { makeTempRoot } from "../../harness/tests/helpers/temp-dirs.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = makeTempRoot("nrv-project-root-");
  roots.push(root);
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".nirvana"), { recursive: true });
  return { root, home };
}

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
    fs.mkdirSync(path.join(proj, ".git"));
    expect(findProjectRoot(path.join(proj, "sub"), { home })).toBe(proj);
  });

  test("a project just outside HOME's ancestry is found normally", () => {
    const { root, home } = fixture();
    const proj = path.join(root, "other", "project");
    fs.mkdirSync(path.join(proj, "sub"), { recursive: true });
    fs.mkdirSync(path.join(proj, ".env"));
    expect(findProjectRoot(path.join(proj, "sub"), { home })).toBe(proj);
  });

  test("the filesystem root is never a project root, even carrying a marker", () => {
    const fsRoot = path.parse(process.cwd()).root;
    // Don't actually write to the real fs root; isInvalidProjectRoot alone
    // proves the exclusion without needing a marker file there.
    expect(isInvalidProjectRoot(fsRoot)).toBe(true);
  });

  test("markers are caller-configurable — handoff.js/wiki-lint.js's narrower 2-marker list", () => {
    const { root, home } = fixture();
    const proj = path.join(root, "narrow-project");
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, "package.json"), "{}");
    // package.json is NOT in the narrow marker list — must not match.
    expect(findProjectRoot(proj, { home, markers: [".nirvana", ".git"] })).toBeNull();
    fs.mkdirSync(path.join(proj, ".git"));
    expect(findProjectRoot(proj, { home, markers: [".nirvana", ".git"] })).toBe(proj);
  });

  test("no project in reach returns null, not a guess", () => {
    const { root, home } = fixture();
    const standalone = path.join(root, "standalone");
    fs.mkdirSync(standalone, { recursive: true });
    expect(findProjectRoot(standalone, { home })).toBeNull();
  });
});
