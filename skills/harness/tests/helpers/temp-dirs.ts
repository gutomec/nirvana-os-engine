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
