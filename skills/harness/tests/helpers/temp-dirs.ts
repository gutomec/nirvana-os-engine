// temp-dirs.ts — teardown for the temporary roots the harness tests create.
//
// On Windows a file that any process still holds open cannot be deleted. A
// dispatch child that is still exiting, or a SQLite kernel a test left open,
// turns `rmSync` into EBUSY inside afterEach, where it hides the real failure
// and skips whatever cleanup follows it: on CI a leaked NIRVANA_PROJECT_ROOT
// from one file reached `nrv installed` two files later. The retry gives a
// departing child the moment it needs to release its handles; a leak that
// never resolves still throws, so nothing is masked.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const RETRYABLE = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);

export function removeDir(dir: string, attempts = 10, delayMs = 100): void {
  for (let attempt = 1; ; attempt++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE.has(code) || attempt >= attempts) throw error;
      Bun.sleepSync(delayMs);
    }
  }
}

/**
 * Create a temporary root and return it in the OS's CANONICAL form — the same
 * form the engine answers with.
 *
 * `fs.realpathSync` is NOT enough, and the difference is invisible on macOS and
 * Ubuntu. On Windows `os.tmpdir()` answers with an 8.3 SHORT path
 * (`C:\Users\RUNNER~1\...` on the CI runner) and the JS resolver hands it
 * straight back, while every project root inside the engine goes through
 * `realpathSync.native` (run-ledger.ts `normalizeRoot`, paths.js `canonical`) —
 * which is the resolver that expands 8.3. A fixture built on the short form then
 * compares `C:\Users\RUNNER~1\…` against the engine's
 * `C:\Users\runneradmin\…`: one directory, two strings, and an assertion that
 * is green on two systems and red on the third.
 *
 * The macOS analogue is `/var` vs `/private/var`, which is why the fixtures
 * already resolved at all — they just used the resolver that stops short of
 * Windows. Both sides go through the same function here.
 */
export function makeTempRoot(prefix: string): string {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return fs.realpathSync.native ? fs.realpathSync.native(created) : fs.realpathSync(created);
}
