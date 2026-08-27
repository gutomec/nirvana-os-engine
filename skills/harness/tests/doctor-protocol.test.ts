// doctor-protocol.test.ts — the migration dashboard, and the promise it makes.
//
// The doctor's exit code is a CI signal: >= 2 means the machine is broken. A
// library still on Squad Protocol 5 and Business Protocol 1 is the DEFAULT
// state of every installed machine during a rollout, so counting it must never
// be able to turn a green CI red. These cases pin that: the Protocol section
// reports, and its worst status is WARN.
//
// Runs with: bun test skills/harness/tests
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const DOCTOR = join(REPO, "skills", "harness", "scripts", "doctor-system.ts");
const ROOTS: string[] = [];
afterAll(() => { for (const r of ROOTS) try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } });

function library(opts: { squads: Array<[string, string | null]>; businesses: Array<[string, string, boolean]> }): string {
  const home = mkdtempSync(join(tmpdir(), "nrv-doctor-protocol-"));
  ROOTS.push(home);
  for (const [slug, protocol] of opts.squads) {
    mkdirSync(join(home, "squads", slug), { recursive: true });
    writeFileSync(join(home, "squads", slug, "squad.yaml"),
      `name: ${slug}\nversion: 1.0.0\n${protocol ? `protocol: "${protocol}"\n` : ""}description: fixture\n`, "utf8");
  }
  for (const [slug, protocol, retired] of opts.businesses) {
    mkdirSync(join(home, "businesses", slug, "employees"), { recursive: true });
    writeFileSync(join(home, "businesses", slug, "business.yaml"),
      `name: ${slug}\nversion: 1.0.0\nprotocol: "${protocol}"\ndescription: fixture\n`, "utf8");
    writeFileSync(join(home, "businesses", slug, "employees", "ceo.md"),
      `---\nname: ceo\nis_brief_intake: true\n${retired ? "heartbeat:\n  enabled: true\n" : ""}---\n\n# CEO\n`, "utf8");
  }
  return home;
}

function doctor(home: string) {
  const r = spawnSync(process.execPath, [DOCTOR, "--json"], {
    cwd: home, encoding: "utf8",
    env: {
      ...process.env, HOME: home, NIRVANA_HOME: home,
      NIRVANA_SKILLS_DIR: join(REPO, "skills"), CLAUDE_SKILLS_DIR: join(REPO, "skills"),
      NIRVANA_SCOPE: "global", NIRVANA_SCOPE_QUIET: "1", NIRVANA_NO_UPDATE_CHECK: "1",
    } as Record<string, string>,
  });
  const report = JSON.parse(r.stdout);
  const checks: Array<{ name: string; status: string; note: string }> = report.checks;
  return {
    code: r.status ?? -1,
    protocol: Object.fromEntries(checks.filter((c) => c.name.startsWith("protocol:")).map((c) => [c.name, c])),
  };
}

describe("the Protocol section counts what the library declares", () => {
  test("a library mid-migration is WARN, with the spread and the command", () => {
    const out = doctor(library({
      squads: [["a", "5.0"], ["b", "5.0"], ["c", "6.0"], ["d", null]],
      businesses: [["biz-one", "1.0", true], ["biz-two", "2.0", false]],
    }));
    expect(out.protocol["protocol: squads"].status).toBe("WARN");
    expect(out.protocol["protocol: squads"].note).toContain("2×5.0");
    expect(out.protocol["protocol: squads"].note).toContain("3 below 6.0");
    expect(out.protocol["protocol: squads"].note).toContain("nrv migrate");
    expect(out.protocol["protocol: businesses"].status).toBe("WARN");
    expect(out.protocol["protocol: businesses"].note).toContain("1 of 2 still on protocol 1.0");
    expect(out.protocol["protocol: businesses"].note).toContain("1 carry fields v2 retired");
  }, 60_000);

  test("a fully migrated library passes and says so", () => {
    const out = doctor(library({
      squads: [["a", "6.0"], ["b", "6.0"]],
      businesses: [["biz-one", "2.0", false]],
    }));
    expect(out.protocol["protocol: squads"].status).toBe("PASS");
    expect(out.protocol["protocol: squads"].note).toContain("all on 6.0");
    expect(out.protocol["protocol: businesses"].status).toBe("PASS");
    expect(out.protocol["protocol: businesses"].note).toContain("no retired fields");
  }, 60_000);

  test("it is never a FAIL — the whole point, because CI reads exit >= 2", () => {
    const out = doctor(library({
      squads: [["a", "4.0"], ["b", null]],
      businesses: [["biz-one", "1.0", true], ["biz-two", "1.0", true]],
    }));
    for (const check of Object.values(out.protocol)) expect(check.status).not.toBe("FAIL");
    // A library that is entirely un-migrated must not be able to produce the
    // exit code CI reads as "this machine is broken" through THIS section.
    expect(Object.values(out.protocol).every((c) => c.status === "WARN")).toBe(true);
  }, 60_000);
});
