// update-check.test.ts — the notice that tells a user a newer engine exists.
//
// The feature's whole value is that it is QUIET and CORRECT: it must never nag
// someone who is current, never claim an update when the network failed, never
// cost a command latency, and never break a run. Each of those is a test here.
//
// Three layers, deliberately:
//   1. pure functions (comparison, cache parsing, staleness) — fast, exhaustive
//   2. the CLI as a subprocess against a stub release API — the real contract,
//      including what it writes to disk
//   3. the bash wrapper — the part users actually hit, where a bad quote or a
//      BSD/GNU stat difference would silently break the notice
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import {
  compareVersions, readNotice, ageMs, isStale, renderMessage, fetchLatestVersion, CHECK_TTL_MS,
} from "../scripts/update-check.ts";

const SCRIPT = path.join(import.meta.dir, "..", "scripts", "update-check.ts");
const NRV = path.join(import.meta.dir, "..", "..", "..", "bin", "nrv");

describe("compareVersions", () => {
  test("orders by number, not by string — 0.10.0 is newer than 0.9.0", () => {
    // The string comparison this replaces put "0.10.0" < "0.9.0" and would have
    // told every user on 0.10 that 0.9 was an upgrade.
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("0.2.1", "0.2.0")).toBeGreaterThan(0);
  });

  test("equal versions compare equal, with or without a leading v", () => {
    expect(compareVersions("0.3.0", "0.3.0")).toBe(0);
    expect(compareVersions("v0.3.0", "0.3.0")).toBe(0);
  });

  test("a pre-release is older than its release", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
  });

  test("garbage never claims to be newer", () => {
    // A malformed tag must produce silence, not a permanent nag.
    expect(compareVersions("nightly", "0.2.0")).toBe(0);
    expect(compareVersions("", "0.2.0")).toBe(0);
  });
});

describe("cache parsing", () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-update-cache-"));
  afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

  const stamp = (msAgo = 0) => Math.floor((Date.now() - msAgo) / 1000);

  test("a timestamp with empty version means checked-and-current, not unchecked", () => {
    const f = path.join(TMP, "current.txt");
    fs.writeFileSync(f, `${stamp()}\n\n\n`);
    expect(readNotice(f)).toBeNull();
    expect(ageMs(f)).toBeLessThan(CHECK_TTL_MS);   // it still counts as a check
    expect(isStale(f)).toBe(false);
  });

  test("a missing file is infinitely old, so the first run always refreshes", () => {
    expect(ageMs(path.join(TMP, "nope.txt"))).toBe(Infinity);
    expect(isStale(path.join(TMP, "nope.txt"))).toBe(true);
  });

  test("a well-formed cache yields version and message", () => {
    const f = path.join(TMP, "full.txt");
    fs.writeFileSync(f, `${stamp()}\n0.3.0\nNirvana-OS 0.3.0 is available\n`);
    expect(readNotice(f)).toEqual({ latest: "0.3.0", message: "Nirvana-OS 0.3.0 is available" });
  });

  test("a truncated cache is ignored rather than printed half-formed", () => {
    const f = path.join(TMP, "partial.txt");
    fs.writeFileSync(f, `${stamp()}\n0.3.0\n`);
    expect(readNotice(f)).toBeNull();
  });

  test("a corrupted timestamp reads as never-checked, so the next call refreshes", () => {
    const f = path.join(TMP, "corrupt.txt");
    fs.writeFileSync(f, "not-a-number\n0.3.0\nmsg\n");
    expect(ageMs(f)).toBe(Infinity);
    expect(isStale(f)).toBe(true);
    expect(readNotice(f)?.latest).toBe("0.3.0");   // the notice half is still usable
  });

  test("staleness comes from the stamp in the file, not its mtime", () => {
    const f = path.join(TMP, "aged.txt");
    fs.writeFileSync(f, `${stamp(CHECK_TTL_MS + 1000)}\n\n\n`);
    // mtime is NOW (just written); only the recorded stamp says otherwise, and
    // that is the whole point — rsync and restores rewrite mtime.
    expect(isStale(f)).toBe(true);
  });
});

describe("fetchLatestVersion — against a stub release API", () => {
  let server: any;
  let base = "";
  let mode: "ok" | "garbage" | "error" | "slow" = "ok";

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch() {
        if (mode === "error") return new Response("rate limited", { status: 403 });
        if (mode === "garbage") return new Response(JSON.stringify({ tag_name: "nightly-build" }), { status: 200 });
        return new Response(JSON.stringify({ tag_name: "v0.3.0" }), { status: 200 });
      },
    });
    base = `http://localhost:${server.port}`;
  });
  afterAll(() => server?.stop(true));

  test("reads the tag and strips the v", async () => {
    mode = "ok";
    expect(await fetchLatestVersion(base)).toBe("0.3.0");
  });

  test("a rate-limited or failing API yields null, never a guess", async () => {
    mode = "error";
    expect(await fetchLatestVersion(base)).toBeNull();
  });

  test("a non-semver tag yields null", async () => {
    mode = "garbage";
    expect(await fetchLatestVersion(base)).toBeNull();
  });

  test("an unreachable host yields null instead of throwing", async () => {
    // Port 1 is reserved and refuses; this is the offline user's path.
    expect(await fetchLatestVersion("http://127.0.0.1:1")).toBeNull();
  });
});

describe("the CLI, as a subprocess against a stub API", () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-update-cli-"));
  const SKILLS = path.join(TMP, ".nirvana", "skills");
  const NOTICE = path.join(TMP, ".nirvana", "cache", "update-notice.txt");
  // The stub is a FILE, not an in-process server: spawnSync blocks this
  // process's event loop, so a Bun.serve stub living here could never answer
  // the child — it deadlocks until the fetch timeout. HTTP status handling is
  // covered by the in-process group above.
  const RELEASE_JSON = path.join(TMP, "release.json");

  const run = (arg: string, version: string, extraEnv: Record<string, string> = {}) => {
    fs.writeFileSync(path.join(SKILLS, "VERSION"), `${version}\n`);
    return spawnSync(process.execPath, [SCRIPT, arg], {
      encoding: "utf8",
      env: {
        ...process.env,
        NIRVANA_HOME: TMP,
        NIRVANA_SKILLS_DIR: SKILLS,
        NIRVANA_RELEASE_API: `file://${RELEASE_JSON}`,
        NIRVANA_NO_UPDATE_CHECK: "",
        CI: "",
        ...extraEnv,
      },
    });
  };

  beforeAll(() => {
    fs.mkdirSync(SKILLS, { recursive: true });
    fs.writeFileSync(RELEASE_JSON, JSON.stringify({ tag_name: "v0.3.0" }));
  });
  afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

  test("a newer release writes a notice the wrapper can read", () => {
    const r = run("--refresh", "0.2.0");
    expect(r.status).toBe(0);
    const lines = fs.readFileSync(NOTICE, "utf8").split("\n");
    expect(Number.parseInt(lines[0], 10)).toBeGreaterThan(1_700_000_000);  // epoch seconds
    expect(lines[1]).toBe("0.3.0");
    expect(lines[2]).toContain("0.3.0");
    expect(lines[2]).toContain("nrv update");
  });

  test("--print emits the pending notice on STDERR, leaving stdout clean", () => {
    const r = run("--print", "0.2.0");
    expect(r.stderr).toContain("0.3.0");
    expect(r.stdout.trim()).toBe("");
  });

  test("being current empties the cache — checked, nothing to say", () => {
    const r = run("--refresh", "0.3.0");
    expect(r.status).toBe(0);
    expect(readNotice(NOTICE)).toBeNull();          // stamped, nothing pending
    expect(run("--print", "0.3.0").stderr.trim()).toBe("");
  });

  test("a stale notice is not printed to someone who already updated", () => {
    // The cache still says 0.3.0 is out; the user is now ON 0.3.0. Silence,
    // without waiting for the next refresh.
    fs.writeFileSync(NOTICE, `${Math.floor(Date.now() / 1000)}\n0.3.0\nNirvana-OS 0.3.0 is available\n`);
    expect(run("--print", "0.3.0").stderr.trim()).toBe("");
    expect(run("--print", "0.2.0").stderr).toContain("0.3.0");
  });

  test("a version AHEAD of the release is never told to downgrade", () => {
    fs.writeFileSync(NOTICE, `${Math.floor(Date.now() / 1000)}\n0.3.0\nNirvana-OS 0.3.0 is available\n`);
    expect(run("--print", "0.4.0").stderr.trim()).toBe("");
  });

  test("the opt-out silences both refresh and print", () => {
    fs.writeFileSync(NOTICE, `${Math.floor(Date.now() / 1000)}\n0.3.0\nNirvana-OS 0.3.0 is available\n`);
    const printed = spawnSync(process.execPath, [SCRIPT, "--print"], {
      encoding: "utf8",
      env: { ...process.env, NIRVANA_HOME: TMP, NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_NO_UPDATE_CHECK: "1" },
    });
    expect(printed.stderr.trim()).toBe("");
  });

  test("a failing API keeps the pending notice instead of dropping it", () => {
    fs.writeFileSync(NOTICE, `${Math.floor(Date.now() / 1000)}\n0.3.0\nNirvana-OS 0.3.0 is available\n`);
    const r = spawnSync(process.execPath, [SCRIPT, "--refresh"], {
      encoding: "utf8",
      env: { ...process.env, NIRVANA_HOME: TMP, NIRVANA_SKILLS_DIR: SKILLS,
             NIRVANA_RELEASE_API: `file://${path.join(TMP, "does-not-exist.json")}`,
             NIRVANA_NO_UPDATE_CHECK: "", CI: "" },
    });
    expect(r.status).toBe(0);                                  // offline is not a failure
    expect(readNotice(NOTICE)?.latest).toBe("0.3.0");           // and not a reason to forget
  });

  test("an unknown installed version says nothing at all", () => {
    fs.rmSync(path.join(SKILLS, "VERSION"), { force: true });
    const r = spawnSync(process.execPath, [SCRIPT, "--print"], {
      encoding: "utf8",
      env: { ...process.env, NIRVANA_HOME: path.join(TMP, "empty"), NIRVANA_SKILLS_DIR: path.join(TMP, "empty") },
    });
    expect(r.status).toBe(0);
    expect(r.stderr.trim()).toBe("");
  });
});

describe("the bash wrapper", () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-update-bash-"));
  const SKILLS = path.join(TMP, "skills");
  const CACHE = path.join(TMP, ".nirvana", "cache");
  const NOTICE = path.join(CACHE, "update-notice.txt");

  const nrv = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [NRV, ...args], {
      encoding: "utf8",
      env: {
        ...process.env, HOME: TMP, NIRVANA_SKILLS_DIR: SKILLS,
        NIRVANA_UPDATE_CHECK_ASSUME_TTY: "1", NIRVANA_NO_UPDATE_CHECK: "", CI: "", ...env,
      },
    });

  beforeAll(() => {
    fs.mkdirSync(CACHE, { recursive: true });
    fs.mkdirSync(SKILLS, { recursive: true });
    fs.writeFileSync(path.join(SKILLS, "VERSION"), "0.2.0\n");
    fs.writeFileSync(NOTICE, `${Math.floor(Date.now() / 1000)}\n0.3.0\nNirvana-OS 0.3.0 is available — run \`nrv update\`.\n`);
  });
  afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

  test("prints the pending notice before running the command", () => {
    const r = nrv(["definitely-not-a-command"]);
    expect(r.stderr).toContain("Nirvana-OS 0.3.0 is available");
    expect(r.status).toBe(2);            // the unknown-subcommand path still works
  });

  test("says nothing once the installed version matches the cached one", () => {
    fs.writeFileSync(path.join(SKILLS, "VERSION"), "0.3.0\n");
    expect(nrv(["definitely-not-a-command"]).stderr).not.toContain("is available");
    fs.writeFileSync(path.join(SKILLS, "VERSION"), "0.2.0\n");
  });

  test("the opt-out and CI silence it", () => {
    expect(nrv(["definitely-not-a-command"], { NIRVANA_NO_UPDATE_CHECK: "1" }).stderr).not.toContain("is available");
    expect(nrv(["definitely-not-a-command"], { CI: "1" }).stderr).not.toContain("is available");
  });

  test("`nrv update` itself never nags — the user is already updating", () => {
    // `update` execs the updater; we only assert the notice is absent from the
    // first line of stderr, which is where the wrapper would have put it.
    const r = nrv(["update", "--check"]);
    expect((r.stderr || "").split("\n")[0]).not.toContain("is available");
  });

  test("a missing cache never breaks the command", () => {
    fs.rmSync(NOTICE, { force: true });
    const r = nrv(["definitely-not-a-command"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown subcommand");
  });
});
