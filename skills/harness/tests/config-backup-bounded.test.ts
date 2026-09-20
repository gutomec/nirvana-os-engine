// config-backup-bounded.test.ts — a backup of a user's config, and not an
// unbounded pile of them.
//
// Every writer that edits a file the USER owns takes a copy first: Codex's
// config.toml, Hermes's config.yaml and allowlist, an agent's settings.json.
// Each invented its own name with a fresh nonce and nothing ever removed one,
// so a machine that reinstalls accumulates a backup per write per file, in the
// user's own config directory, forever. The engine reports that shape of litter
// elsewhere in `nrv doctor`; it should not be the thing producing it.
//
// A cap and not a single fixed name: the backup exists to recover from a bad
// write, and a fixed name is overwritten by the next write — which, if two runs
// go wrong in a row, is the copy that was needed.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BACKUP_KEEP, backupConfig, pruneBackups } from "../../_shared/lib/config-backup.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* the OS reclaims tmp */ } } });

function fixture(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-bk-"));
  dirs.push(d);
  fs.writeFileSync(path.join(d, "config.toml"), "model = \"gpt-6-astra\"\n");
  return d;
}

const backupsIn = (d: string) => fs.readdirSync(d).filter((n) => n.includes(".nirvana-backup."));

describe("the pile is bounded", () => {
  test(`ten writes leave ${BACKUP_KEEP} backups, not ten`, () => {
    const d = fixture();
    const file = path.join(d, "config.toml");
    for (let i = 0; i < 10; i++) backupConfig(file, `n${i}`);
    expect(backupsIn(d)).toHaveLength(BACKUP_KEEP);
  });

  test("and the ones kept are the newest", () => {
    const d = fixture();
    const file = path.join(d, "config.toml");
    // Same millisecond on a fast filesystem: every mtime ties, which is the
    // case that used to delete the copy just taken.
    for (let i = 0; i < 5; i++) backupConfig(file, `n${i}`);
    expect(backupsIn(d)).toContain("config.toml.nirvana-backup.n4");
    expect(backupsIn(d)).toHaveLength(BACKUP_KEEP);
  });
});

describe("what it must not do", () => {
  test("a nonce collision fails loudly instead of overwriting a backup", () => {
    const d = fixture();
    const file = path.join(d, "config.toml");
    backupConfig(file, "same");
    expect(() => backupConfig(file, "same")).toThrow();
  });

  test("it never touches a neighbour's backups", () => {
    const d = fixture();
    fs.writeFileSync(path.join(d, "other.yaml"), "a: 1\n");
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(d, `other.yaml.nirvana-backup.x${i}`), "a: 1\n");
    for (let i = 0; i < 5; i++) backupConfig(path.join(d, "config.toml"), `n${i}`);
    expect(fs.readdirSync(d).filter((n) => n.startsWith("other.yaml.nirvana-backup"))).toHaveLength(5);
  });

  test("pruning a file with no backups is a no-op, not an error", () => {
    const d = fixture();
    expect(pruneBackups(path.join(d, "config.toml"))).toBe(0);
  });

  test("an unreadable directory does not fail the write it was protecting", () => {
    // Litter beats a lost configuration edit: pruning is best-effort.
    expect(pruneBackups(path.join(os.tmpdir(), "nrv-does-not-exist", "config.toml"))).toBe(0);
  });
});
