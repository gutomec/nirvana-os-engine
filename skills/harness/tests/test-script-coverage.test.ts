/**
 * The suite is split two ways for the dev loop: by AREA (`test:squads`,
 * `test:businesses`, `test:shared`, `test:harness`) so a cut runs only what it
 * touches, and by measured COST (`test:fast` = everything not in
 * scripts/slow-tests.json) so a whole-repo smell check stays under half a
 * minute. A split is only safe while it still adds up to the whole, and both
 * halves rot silently:
 *
 *   - a test lands under a directory no area script names, and from then on
 *     nothing but `test:full` ever runs it. Nobody notices, because every
 *     command anyone types still exits 0;
 *   - a file named in the slow manifest is renamed, so `test:fast` starts
 *     paying for a heavy file while excluding one that no longer exists;
 *   - the walk returns native separators. On Windows `path.relative` hands back
 *     `skills\harness\tests\x.test.ts` while package.json and the manifest
 *     hold `/`, nothing matches anything, and the split reads as total. That is
 *     what the Windows runner of PR #131 reported, and the reason the cases
 *     below feed a literal backslash: the normalization has to be provable on
 *     macOS and Linux, where `path.sep` alone would hide it.
 *
 * These checks read package.json and the disk. They never keep a second copy
 * of either list, so they fail on the drift itself and not on a stale mirror.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fastTests, posixPath, slowTests, testFiles } from "../../../scripts/test-timings.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const AREA_SCRIPTS = ["test:squads", "test:businesses", "test:shared", "test:harness"];

/** The path arguments a `bun test …` script hands to Bun. */
function pathsOf(script: string): string[] {
  const cmd: string | undefined = pkg.scripts?.[script];
  if (!cmd) throw new Error(`package.json declares no "${script}"`);
  return cmd.replace(/^bun test\s+/, "").trim().split(/\s+/).filter(Boolean);
}

const onDisk = testFiles();

describe("the area scripts still add up to the whole suite", () => {
  test("every test file on disk belongs to exactly one area script", () => {
    const roots = AREA_SCRIPTS.flatMap(pathsOf);
    const orphans = onDisk.filter((f) => !roots.some((r) => f.startsWith(r + "/")));
    const doubled = onDisk.filter((f) => roots.filter((r) => f.startsWith(r + "/")).length > 1);
    // Reported together so a failure names the file, not just a count.
    expect({ orphans, doubled }).toEqual({ orphans: [], doubled: [] });
  });

  test("a native-separator path lands on the same entry as the walk", () => {
    const sample = onDisk[0];
    expect(posixPath("skills\\harness\\tests\\x.test.ts")).toBe("skills/harness/tests/x.test.ts");
    expect(posixPath(sample)).toBe(sample);
    // The predicate the coverage check runs, fed the Windows spelling of a real file.
    const roots = AREA_SCRIPTS.flatMap(pathsOf);
    const windowsSpelling = sample.split("/").join("\\");
    expect(roots.some((r) => posixPath(windowsSpelling).startsWith(r + "/"))).toBe(true);
  });

  test("test:full is the whole tree, and `bun test` still means the same thing", () => {
    expect(pkg.scripts["test:full"]).toBe("bun test skills");
    expect(pkg.scripts["test"]).toBe(pkg.scripts["test:full"]);
  });

  test("every filter in test:gate still selects a file", () => {
    // test:gate is a deliberate SUBSET (the admission and quality gates), named
    // by path prefix. A renamed gate test would empty its filter in silence.
    const dead = pathsOf("test:gate").filter((p) => !onDisk.some((f) => f.startsWith(p)));
    expect(dead).toEqual([]);
  });
});

describe("the fast/slow split is a partition of the same set", () => {
  test("fast plus measured-slow is exactly what is on disk", () => {
    expect([...fastTests(), ...slowTests()].sort()).toEqual(onDisk);
  });

  test("no file is in both halves", () => {
    const slow = new Set(slowTests());
    expect(fastTests().filter((f) => slow.has(f))).toEqual([]);
  });

  test("every file the manifest calls slow still exists", () => {
    const disk = new Set(onDisk);
    expect(slowTests().filter((f) => !disk.has(f))).toEqual([]);
  });

  test("both halves, and the manifest on disk, are spelled in POSIX separators", () => {
    // Normalizing on read would still leave a Windows regeneration of
    // slow-tests.json checked in with backslashes, unreadable to a human diff
    // and to any reader that does not normalize. The file itself must be POSIX.
    expect([...fastTests(), ...slowTests()].filter((f) => f.includes("\\"))).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(REPO, "scripts", "slow-tests.json"), "utf8"));
    expect(manifest.files.map((f: any) => f.path).filter((p: string) => p.includes("\\"))).toEqual([]);
  });

  test("the measured heavyweights stay out of test:fast", () => {
    // These three dominate the suite (27.4s, 5.3s, 4.6s measured on 27/08/2026)
    // and routing-eval is the one that can lie: it memoizes its verdict, so a
    // warm run reports ~0.1s and would drop out of a naive re-measurement,
    // putting a 27s worst case back inside the fast loop the next time a
    // registry moves. scripts/test-timings.ts measures with the cache off for
    // exactly this reason; this check is the second lock.
    const named = [
      "skills/harness/tests/routing-eval.test.ts",
      "skills/harness/tests/routing-multilingual-probes.test.ts",
      "skills/harness/tests/multi-target-cli.test.ts",
    ];
    const slow = new Set(slowTests());
    expect(named.filter((f) => !slow.has(f))).toEqual([]);
  });
});
