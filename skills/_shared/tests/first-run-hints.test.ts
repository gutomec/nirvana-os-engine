// The sentences a fresh install prints first. On a machine with nothing in
// the library these are the whole product for a minute, and two of them were
// wrong: the empty-state hint of `nrv list-clones` named a path that exists on
// no user's machine (`bun ~/nirvana-os/scripts/install.ts --starter`), and the
// quickstart taught `nrv list businesses`, a subcommand that does not exist.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fakeHomeEnv } from "../../harness/tests/helpers/fake-home.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");

test("list-clones on an empty library points at something real", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-hints-"));
  const r = spawnSync(process.execPath, [path.join(REPO, "skills", "_shared", "scripts", "list-clones.ts")], {
    env: fakeHomeEnv(home, { NIRVANA_SCOPE: "global" }), encoding: "utf8", cwd: home, timeout: 30_000,
  });
  const out = `${r.stdout}${r.stderr}`;
  expect(r.status).toBe(0);
  expect(out).toMatch(/No mind-clones found/);
  expect(out).not.toMatch(/nirvana-os\/scripts\/install\.ts/);
  expect(out).toMatch(/squads\.sh/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("the quickstart names subcommands that exist", () => {
  const text = fs.readFileSync(path.join(REPO, "AGENT-QUICKSTART.md"), "utf8");
  expect(text).toMatch(/`nrv list-businesses`/);
  expect(text).toMatch(/`nrv list-squads`/);
  expect(text).not.toMatch(/`nrv list businesses`|`nrv list squads`/);
});

test("list-clones reads the library the environment names, not a fixed ~/businesses path", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-hints-"));
  const lib = path.join(home, "elsewhere", "dna");
  fs.mkdirSync(path.join(lib, "test-clone"), { recursive: true });
  fs.writeFileSync(path.join(lib, "test-clone", "MANIFEST.yaml"), "name: test-clone\ndisplay_name: Test Clone\ncategory: test\n");
  const run = (extra: NodeJS.ProcessEnv) => spawnSync(process.execPath, [path.join(REPO, "skills", "_shared", "scripts", "list-clones.ts")], {
    env: fakeHomeEnv(home, { NIRVANA_SCOPE: "global", ...extra }), encoding: "utf8", cwd: home, timeout: 30_000,
  });
  const listed = run({ DNA_LIBRARY: lib });
  expect(listed.status).toBe(0);
  expect(`${listed.stdout}${listed.stderr}`).toMatch(/test-clone/);
  const empty = run({});
  // Windows prints the path with backslashes; the trailing slash is literal.
  expect(`${empty.stdout}${empty.stderr}`).toMatch(/No mind-clones found in ~[\\/]businesses[\\/]_library[\\/]dna\//);
  fs.rmSync(home, { recursive: true, force: true });
});
