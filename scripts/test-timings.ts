#!/usr/bin/env bun
// test-timings.ts — per-file wall time for the test suite, slowest first.
//
// Why a separate script instead of reading Bun's own reporter: the JUnit
// reporter times TEST CASES, and the files that actually dominate the suite
// spend their seconds at module scope (top-level await building a corpus,
// spawning a child process, warming a registry) where no test case is running.
// `routing-eval.test.ts` is the extreme case — it costs ~30s and reports ~0s
// of test-case time. Only wall clock per `bun test <file>` tells the truth, so
// that is what this measures: one Bun process per file, exactly the cost a
// developer pays when running that file alone.
//
// The output is the input for the `test:fast` split in package.json: exclude
// what measurement says is heavy, never what intuition says.
//
// The slow half it finds is recorded in scripts/slow-tests.json, and
// `--run-fast` (what `bun run test:fast` calls) runs the complement. Keeping
// the two together is deliberate: the list of slow files is the OUTPUT of the
// measurement, and a hand-maintained list would rot the moment a test grows a
// subprocess.
//
// Usage:
//   bun scripts/test-timings.ts                     # every test file under skills/
//   bun scripts/test-timings.ts skills/harness      # one subtree
//   bun scripts/test-timings.ts --threshold 2       # flag files at or over 2s
//   bun scripts/test-timings.ts --json              # machine-readable
//   bun scripts/test-timings.ts --write             # re-measure, rewrite slow-tests.json
//   bun scripts/test-timings.ts --run-fast          # run everything NOT in slow-tests.json
//   bun scripts/test-timings.ts --list-fast         # print that file list, one per line
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SLOW_MANIFEST = join(ROOT, "scripts", "slow-tests.json");
const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const write = argv.includes("--write");
const thresholdIdx = argv.indexOf("--threshold");
const threshold = thresholdIdx === -1 ? 1 : Number(argv[thresholdIdx + 1]);
const roots = argv.filter((a, i) => !a.startsWith("--") && i !== thresholdIdx + 1);
const scope = roots.length ? roots : ["skills"];

/**
 * A repo-relative path the way package.json and the manifest spell it: POSIX
 * separators on every platform.
 *
 * `path.relative` hands back `skills\harness\tests\x.test.ts` on Windows while
 * the `bun test <dir>` arguments in package.json and every entry in
 * scripts/slow-tests.json hold `/`. Unnormalized, no path ever matches a root
 * and the whole suite reads as uncovered: the Windows runner of PR #131
 * reported every file on disk as orphaned, and the fast and slow halves as
 * two sets with nothing in common. Same idiom as
 * `squad-exec.ts`'s `promptPath`, literal backslash included, which is what
 * makes the normalization provable off Windows instead of only on it.
 */
export function posixPath(p: string): string {
  return p.split(sep).join("/").replace(/\\/g, "/");
}

/** Every `*.test.ts` under the given repo-relative roots, repo-relative, sorted. */
export function testFiles(dirs: string[] = ["skills"]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    const glob = new Bun.Glob("**/*.test.ts");
    for (const hit of glob.scanSync({ cwd: resolve(ROOT, dir), absolute: true })) out.push(posixPath(relative(ROOT, hit)));
  }
  return out.sort();
}

/** The measured-slow set. Missing manifest = nothing is slow yet. */
export function slowTests(): string[] {
  if (!existsSync(SLOW_MANIFEST)) return [];
  const m = JSON.parse(readFileSync(SLOW_MANIFEST, "utf8"));
  // Normalized on read as well as on write: a manifest regenerated on Windows
  // before this fix landed would otherwise stay unmatchable for everyone else.
  return (m.files ?? []).map((f: any) => posixPath(String(f.path))).sort();
}

/** The fast half: every test file minus the measured-slow set. A test file added
 *  since the last measurement is fast until measured otherwise. */
export function fastTests(): string[] {
  const slow = new Set(slowTests());
  return testFiles().filter((f) => !slow.has(f));
}

// ── CLI ─────────────────────────────────────────────────────────────────────
//
// Guarded: the functions above are imported by
// skills/harness/tests/test-script-coverage.test.ts to check that the area
// scripts and the fast/slow split still cover every file on disk. Without the
// guard that import would run a 140s measurement of the whole suite.
if (import.meta.main) {
  if (argv.includes("--list-fast")) {
    console.log(fastTests().join("\n"));
    process.exit(0);
  }

  if (argv.includes("--run-fast")) {
    const fast = fastTests();
    const r = spawnSync(process.execPath, ["test", ...fast], { cwd: ROOT, stdio: "inherit" });
    process.exit(r.status ?? 1);
  }

  const files = testFiles(scope).map((f) => resolve(ROOT, f));

  if (!files.length) {
    console.error(`test-timings: no *.test.ts under ${scope.join(", ")}`);
    process.exit(1);
  }

  interface Row { file: string; seconds: number; ok: boolean }
  const rows: Row[] = [];
  const startedAll = Date.now();

  for (const [i, file] of files.entries()) {
    const rel = posixPath(relative(ROOT, file));
    if (!asJson) process.stderr.write(`[${i + 1}/${files.length}] ${rel}\r`);
    const t0 = Date.now();
    // Cold cache on purpose. `routing-eval.test.ts` memoizes its verdict on a
    // content key, so a warm run reports ~1s and would drop out of the slow
    // manifest — putting a 27s worst case inside `test:fast` the next time a
    // registry moves. The manifest must record what a developer pays when the
    // key misses, which is the number that decides the split.
    const r = spawnSync(process.execPath, ["test", file], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, NIRVANA_EVAL_NO_CACHE: "1" },
    });
    rows.push({ file: rel, seconds: (Date.now() - t0) / 1000, ok: r.status === 0 });
  }

  const wallAll = (Date.now() - startedAll) / 1000;
  rows.sort((a, b) => b.seconds - a.seconds);
  const total = rows.reduce((n, r) => n + r.seconds, 0);
  const heavy = rows.filter((r) => r.seconds >= threshold);

  if (asJson) {
    console.log(JSON.stringify({ threshold, wall_seconds: wallAll, sum_seconds: total, files: rows }, null, 2));
    process.exit(0);
  }

  process.stderr.write("\n");
  console.log(`${"seconds".padStart(8)}  ${"cum%".padStart(6)}  file`);
  let cum = 0;
  for (const r of rows) {
    cum += r.seconds;
    const flag = r.ok ? " " : "!";
    console.log(`${r.seconds.toFixed(2).padStart(8)}  ${((cum / total) * 100).toFixed(1).padStart(6)}  ${flag}${r.file}`);
  }
  console.log("");
  console.log(`files ................ ${rows.length}`);
  console.log(`sum of per-file runs . ${total.toFixed(1)}s (one Bun process each)`);
  console.log(`wall clock ........... ${wallAll.toFixed(1)}s`);
  console.log(`at or over ${threshold}s ........ ${heavy.length} file(s), ${heavy.reduce((n, r) => n + r.seconds, 0).toFixed(1)}s`);
  for (const r of heavy) console.log(`  ${r.seconds.toFixed(2).padStart(7)}s  ${r.file}`);
  const failed = rows.filter((r) => !r.ok);
  if (failed.length) console.log(`\nnon-zero exit (marked !): ${failed.map((r) => r.file).join(", ")}`);

  if (write) {
    if (scope.length !== 1 || scope[0] !== "skills") {
      console.error("\n--write needs a full run (no subtree argument): the manifest covers the whole suite.");
      process.exit(1);
    }
    const manifest = {
      threshold_seconds: threshold,
      measured_at: new Date().toISOString().slice(0, 10),
      note: "Files at or over threshold_seconds, measured one Bun process each by scripts/test-timings.ts. `bun run test:fast` runs the complement; `bun run test:full` runs everything.",
      files: heavy.map((r) => ({ path: r.file, seconds: Number(r.seconds.toFixed(2)) })),
    };
    writeFileSync(SLOW_MANIFEST, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    console.log(`\nslow manifest written: ${relative(ROOT, SLOW_MANIFEST)} (${heavy.length} files)`);
  }
}
