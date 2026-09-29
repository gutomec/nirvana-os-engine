// state-db-test-isolation.test.ts — a test process never writes to the user's state.db.
//
// Every audit event goes to the JSONL AND to its SQLite mirror. The preload pinned
// the JSONL root only, and the mirror resolved on its own to the global database
// in the user's home, so each event a test emitted landed there.
import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { resolveDbPath } = require_("../lib/state-db.js") as { resolveDbPath: (projectRoot?: string) => string };

const REAL = path.join(os.homedir(), ".nirvana", "state.db");
// Other test files pin their own roots at module scope and bun runs every file in
// one process, so the assertion is about where the database may NEVER be.
const outsideTheUsersHome = (p: string) => !path.resolve(p).startsWith(path.join(os.homedir(), ".nirvana"));

describe("state.db under the test preload", () => {
  test("never resolves to the user's database", () => {
    const resolved = resolveDbPath();
    expect(resolved).not.toBe(REAL);
    expect(outsideTheUsersHome(resolved)).toBeTrue();
  });

  test("a test that deletes NIRVANA_STATE_DB still does not reach the user's database", () => {
    const previous = process.env.NIRVANA_STATE_DB;
    delete process.env.NIRVANA_STATE_DB;
    try {
      const resolved = resolveDbPath();
      expect(resolved).not.toBe(REAL);
      expect(resolved).toBe(path.join(path.resolve(process.env.NIRVANA_TEST_LOGS_HOME!), "state.db"));
    } finally {
      process.env.NIRVANA_STATE_DB = previous;
    }
  });
});
