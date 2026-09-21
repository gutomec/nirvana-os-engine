// clone-registry-global-mirror.test.ts — a project scan must never become the
// global truth, and an empty index must never replace a full one.
//
// The mirror exists for a real reason: reindexing inside a project used to
// leave the install blind to the new work (the global registry sat still for
// five days while the project one moved). Its guard, though, read:
//
//   roots.length === 1 && resolve(roots[0]) === resolve(paths.DNA_LIBRARY)
//
// and `roots` IS `[paths.DNA_LIBRARY]` in global mode, so the comparison was a
// tautology. `paths.DNA_LIBRARY` resolves through `cfg()`, which reads the
// PROJECT's .env — so a project pointing DNA_LIBRARY at an empty fixture
// scanned zero clones, passed the guard by construction, and wrote `count: 0`
// over the owner's global registry. It happened: 617 clones went invisible for
// two minutes during a benchmark, until the file was restored from a snapshot.
//
// Nothing was deleted — the registry is a derived cache and the clones are
// files on disk — but every `list-clones` and every routing decision in that
// window answered as if the library were empty.
//
// Two guards, either of which would have stopped it: a scan rooted inside the
// project never mirrors, and a mirror never shrinks a registry to zero.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT = path.join(import.meta.dir, "..", "scripts", "index-clones.ts");
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-clone-mirror-"));
  dirs.push(d);
  return d;
}

/** One canonical clone: a directory named by its slug, with a MANIFEST.yaml. */
function clone(root: string, slug: string): void {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "MANIFEST.yaml"), `slug: ${slug}\ndisplay_name: ${slug}\n`);
  fs.writeFileSync(path.join(dir, "AGENT.md"), `# ${slug}\n`);
}

/** The global registry as it stands, or null when absent. */
function globalRegistry(home: string): { count: number; roots: string[] } | null {
  const p = path.join(home, ".nirvana", ".mind-clones-registry.json");
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return { count: j.count, roots: j.mind_clone_roots ?? [] };
  } catch { return null; }
}

/** Runs the indexer from `cwd` under a fake HOME. */
function index(home: string, cwd: string, extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, "--quiet"], {
    cwd, encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, NIRVANA_SKIP_PATH_PERSIST: "1", ...extra },
  });
}

/** A HOME whose global library holds `n` clones, already indexed. */
function homeWithLibrary(n: number): { home: string; lib: string } {
  const home = tmp();
  const lib = path.join(home, "businesses", "_library", "dna");
  fs.mkdirSync(lib, { recursive: true });
  for (let i = 0; i < n; i++) clone(lib, `global-clone-${i}`);
  const r = index(home, home);
  expect(r.status, r.stderr).toBe(0);
  expect(globalRegistry(home)?.count).toBe(n);
  return { home, lib };
}

describe("a project scan never overwrites the global registry", () => {
  test("the empty fixture that wiped the owner's index is refused", () => {
    const { home } = homeWithLibrary(3);

    // A project whose .env points the library at its own empty fixture — the
    // exact shape of the benchmark that caused the incident.
    const project = path.join(home, "proj");
    const fixture = path.join(project, "fixture-dna");
    fs.mkdirSync(fixture, { recursive: true });
    fs.writeFileSync(path.join(project, ".env"), `DNA_LIBRARY=${fixture}\n`);

    const r = index(home, project);
    expect(r.status, r.stderr).toBe(0);

    // The project got its own registry, as it should.
    const projectRegistry = path.join(project, ".nirvana", ".mind-clones-registry.json");
    expect(fs.existsSync(projectRegistry)).toBe(true);
    expect(JSON.parse(fs.readFileSync(projectRegistry, "utf8")).count).toBe(0);

    // The global one still describes the global library.
    expect(globalRegistry(home)?.count).toBe(3);
  });

  test("a project fixture with clones of its own does not mirror either", () => {
    const { home } = homeWithLibrary(3);
    const project = path.join(home, "proj");
    const fixture = path.join(project, "fixture-dna");
    fs.mkdirSync(fixture, { recursive: true });
    clone(fixture, "project-only-clone");
    fs.writeFileSync(path.join(project, ".env"), `DNA_LIBRARY=${fixture}\n`);

    expect(index(home, project).status).toBe(0);
    const g = globalRegistry(home)!;
    expect(g.count).toBe(3);
    expect(g.roots.some((x) => x.includes("fixture-dna"))).toBe(false);
  });
});

describe("the mirror still does its job", () => {
  test("a project that scans the real global library keeps mirroring", () => {
    const { home, lib } = homeWithLibrary(2);
    // A new clone lands in the GLOBAL library; the reindex happens from inside
    // a project. This is the case the mirror exists for.
    clone(lib, "global-clone-new");
    const project = path.join(home, "proj");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, ".env"), "NIRVANA_SCOPE=global\n");

    expect(index(home, project).status).toBe(0);
    expect(globalRegistry(home)?.count).toBe(3);
  });
});

describe("a mirror never empties a registry that had content", () => {
  test("zero clones scanned leaves the previous global registry in place", () => {
    const { home, lib } = homeWithLibrary(4);
    // The library itself goes away — a bad mount, a moved disk, a wrong
    // NIRVANA_HOME. The scan legitimately finds nothing, from the real root.
    fs.rmSync(lib, { recursive: true, force: true });
    fs.mkdirSync(lib, { recursive: true });

    const r = index(home, home);
    expect(r.status, r.stderr).toBe(0);
    // Refusing to shrink to zero is the floor: an index that describes nothing
    // is worse than a stale one, because every consumer reads it as truth.
    expect(globalRegistry(home)?.count).toBe(4);
  });
});
