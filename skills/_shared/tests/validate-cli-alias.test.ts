// validate-cli-alias.test.ts — the verb `validate` changed owner. Bare
// `nrv validate` still runs the system doctor (with a deprecation notice,
// for one release), `nrv verify` is an alias, and `nrv validate-mind-clones`
// delegates to `validate mind-clone --all` keeping its JSON keys as a subset.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { COMMANDS } from "../../harness/lib/commands.ts";
import { REPO, VERIFY_CLI, cliEnv, cloneFixture, rmrf, tempRoot } from "./helpers/verify-fixture.ts";

const ROOTS: string[] = [];
afterAll(() => { for (const r of ROOTS) rmrf(r); });
function root(): string { const r = tempRoot(); ROOTS.push(r); return r; }
const LEGACY_CLI = path.join(REPO, "skills", "_shared", "scripts", "validate-mind-clones.ts");

function run(script: string, args: string[], r: string, extra: NodeJS.ProcessEnv = {}) {
  const p = spawnSync(process.execPath, [script, ...args], { cwd: path.join(r, "cwd"), env: cliEnv(r, extra), encoding: "utf8" });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

describe("bare `nrv validate` → doctor, deprecated", () => {
  test("prints the notice on stderr, forwards argv, propagates the doctor's exit code", () => {
    const r = root();
    const fake = path.join(r, "fake-doctor.ts");
    fs.writeFileSync(fake, 'console.log("FAKE DOCTOR argv=" + JSON.stringify(process.argv.slice(2)));\nprocess.exit(3);\n', "utf8");
    const out = run(VERIFY_CLI, ["--json"], r, { NIRVANA_VERIFY_DOCTOR_SCRIPT: fake });
    expect(out.code).toBe(3);
    expect(out.stderr).toContain("deprecated");
    expect(out.stderr).toContain("nrv doctor");
    expect(out.stdout).toContain('FAKE DOCTOR argv=["--json"]');
    const plain = run(VERIFY_CLI, [], r, { NIRVANA_VERIFY_DOCTOR_SCRIPT: fake });
    expect(plain.code).toBe(3);
    expect(plain.stdout).toContain("FAKE DOCTOR argv=[]");
  });

  test("the default doctor path exists", () => {
    expect(fs.existsSync(path.join(REPO, "skills", "harness", "scripts", "doctor-system.ts"))).toBe(true);
  });
});

describe("command table and dispatchers", () => {
  test("`validate` targets the gate, with `verify` as alias; `validate-mind-clones` keeps `mc-validate`", () => {
    const validate = COMMANDS.find((c) => c.name === "validate")!;
    expect(validate.target).toBe("_shared/scripts/verify.ts");
    expect(validate.aliases).toContain("verify");
    expect(validate.summary.toLowerCase()).toContain("admission");
    const legacy = COMMANDS.find((c) => c.name === "validate-mind-clones")!;
    expect(legacy.aliases).toContain("mc-validate");
    expect(legacy.target).toBe("_shared/scripts/validate-mind-clones.ts");
    expect(COMMANDS.find((c) => c.name === "doctor")).toBeDefined();
  });

  test("bin/nrv and nrv.ts route validate|verify to the gate script", () => {
    const bash = fs.readFileSync(path.join(REPO, "bin", "nrv"), "utf8");
    const m = bash.match(/^ {2}validate\|verify\)\n(?:\s*#.*\n)*\s*exec "\$BUN_BIN" "\$SKILLS\/_shared\/scripts\/verify\.ts" "\$@" ;;/m);
    expect(m).not.toBeNull();
    const ts = fs.readFileSync(path.join(REPO, "skills", "harness", "scripts", "nrv.ts"), "utf8");
    expect(ts).toMatch(/case "validate": case "verify": runScript\(join\(S, "verify\.ts"\), rest\);/);
  });

  test("`nrv validate --help` documents the exit codes", () => {
    const out = run(VERIFY_CLI, ["--help"], root());
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("64");
    expect(out.stdout).toContain("nrv doctor");
  });
});

describe("`nrv validate-mind-clones` delegates and keeps its JSON keys", () => {
  test("directory audit: legacy keys are a subset, findings are added, exit 1 on a failure", () => {
    const r = root();
    cloneFixture(r, "alpha");
    fs.rmSync(path.join(cloneFixture(r, "beta"), "agent", "SOUL.md"));
    const out = run(LEGACY_CLI, [path.join(r, "dna"), "--json", "--no-retrieval"], r);
    expect(out.code).toBe(1);
    const j = JSON.parse(out.stdout);
    expect(Object.keys(j).sort()).toEqual(["failed", "ok", "results", "target", "total"]);
    expect(j.total).toBe(2);
    expect(j.ok).toBe(1);
    expect(j.failed).toBe(1);
    const beta = j.results.find((x: any) => x.file.endsWith("beta/MANIFEST.yaml"));
    expect(beta.ok).toBe(false);
    expect(beta.errors[0]).toMatchObject({ code: "artifact_missing", path: "agent/SOUL.md" });
    expect(typeof beta.errors[0].message).toBe("string");
    expect(Array.isArray(beta.warnings)).toBe(true);
    expect(Array.isArray(beta.findings)).toBe(true);
    expect(beta.findings.find((f: any) => f.id === "artifact_missing").severity).toBe("error");
    const quiet = JSON.parse(run(LEGACY_CLI, [path.join(r, "dna"), "--json", "--quiet", "--no-retrieval"], r).stdout);
    expect(quiet.results[0].warnings).toBeUndefined();
  });

  test("text mode keeps the ✓/✗ lines and the Summary; default target is the DNA library", () => {
    const r = root();
    cloneFixture(r, "alpha");
    const out = run(LEGACY_CLI, ["--no-retrieval"], r);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("✓ ");
    expect(out.stdout).toContain("Summary: 1 mind-clones · 1 ok · 0 failed");
    expect(run(LEGACY_CLI, [path.join(r, "nowhere")], r).code).toBe(2);
  });

  test("a single clone directory and a legacy .md persona file are still accepted", () => {
    const r = root();
    const dir = cloneFixture(r, "alpha");
    expect(run(LEGACY_CLI, [dir, "--no-retrieval"], r).code).toBe(0);
    const md = run(LEGACY_CLI, [path.join(dir, "agent", "AGENT.md"), "--json"], r);
    expect(md.code).toBe(0);
    const j = JSON.parse(md.stdout);
    expect(j.total).toBe(1);
    expect(j.results[0].file.endsWith("AGENT.md")).toBe(true);
  });
});
