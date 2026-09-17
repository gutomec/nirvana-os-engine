// secrets-hardening.test.ts — a dispatched agent sees an allowlist of the
// environment, and a deliverable never carries a secret out.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_ENV_NAMES, childEnvFor, declaredEnvNames } from "../lib/child-env.ts";
import { dotenvEntries, knownSecrets, redactText, scanText, secretLikeEntries } from "../lib/secret-scan.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");

describe("child-env allowlist", () => {
  const env = {
    PATH: "/usr/bin", HOME: "/home/u", LANG: "C", TERM: "xterm",
    NIRVANA_SCOPE: "global", HARNESS_LOGS_DIR: "/x",
    ANTHROPIC_API_KEY: "sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa", OPENAI_API_KEY: "sk-bbbbbbbbbbbbbbbbbbbbbbbbbb",
    DATABASE_URL: "postgres://user:hunter2hunter2@db/app", STRIPE_SECRET_KEY: "sk_live_cccccccccccccccc",
    ELEVENLABS_API_KEY: "el-dddddddddddddddd",
  };

  test("inherit passes everything; declared keeps the base, the engine scope, the runtime's credentials and the declared names", () => {
    expect(childEnvFor(env, { mode: "inherit" })).toEqual(env);
    const c = childEnvFor(env, { mode: "declared", runtime: "claude-code", declared: ["ELEVENLABS_API_KEY"] });
    for (const k of ["PATH", "HOME", "LANG", "TERM", "NIRVANA_SCOPE", "HARNESS_LOGS_DIR", "ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY"]) expect(c[k]).toBe((env as any)[k]);
    for (const k of ["OPENAI_API_KEY", "DATABASE_URL", "STRIPE_SECRET_KEY"]) expect(c[k]).toBeUndefined();
    expect(c.NIRVANA_CHILD_ENV).toBe("declared");
  });

  test("without a runtime pinned, every runtime's credentials pass (the cascade picks later); extras and NIRVANA_CHILD_ENV_EXTRA are honoured", () => {
    const c = childEnvFor({ ...env, NIRVANA_CHILD_ENV_EXTRA: "DATABASE_URL" }, { mode: "declared", runtime: null, declared: [], extra: ["STRIPE_SECRET_KEY"] });
    expect(c.ANTHROPIC_API_KEY).toBeDefined();
    expect(c.OPENAI_API_KEY).toBeDefined();
    expect(c.DATABASE_URL).toBeDefined();
    expect(c.STRIPE_SECRET_KEY).toBeDefined();
    expect(c.ELEVENLABS_API_KEY).toBeUndefined();
  });

  test("the base names cover what every child needs", () => {
    for (const k of ["PATH", "HOME", "LANG", "TERM", "TMPDIR"]) expect(BASE_ENV_NAMES).toContain(k);
  });

  test("declared names come from the installed squads' dependencies.yaml through the registry", () => {
    const home = mkdtempSync(join(tmpdir(), "nrv-child-env-"));
    try {
      const sq = join(home, "squads", "acme");
      mkdirSync(sq, { recursive: true });
      writeFileSync(join(sq, "squad.yaml"), "name: acme\n");
      writeFileSync(join(sq, "dependencies.yaml"), "env_vars:\n  - name: ACME_KEY\n    required: true\n  - ACME_REGION\n");
      writeFileSync(join(home, ".squads-registry.json"), JSON.stringify({ squads: { acme: { manifest_path: join(sq, "squad.yaml") } } }));
      expect(declaredEnvNames({ env: { HOME: home } })).toEqual(["ACME_KEY", "ACME_REGION"]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe("secret-scan", () => {
  test("credential-like variables and dotenv lines become known values; placeholders do not", () => {
    const entries = secretLikeEntries({ API_KEY: "real-value-12345", PATH: "/usr/bin", PASSWORD: "changeme", TOKEN: "short", DB_PASS: "p@ssw0rd-long" });
    expect(entries.map(([k]) => k).sort()).toEqual(["API_KEY", "DB_PASS"]);
    const dir = mkdtempSync(join(tmpdir(), "nrv-dotenv-"));
    try {
      writeFileSync(join(dir, ".env"), "# comment\nexport SECRET_ONE=\"quoted-value-0001\"\nSECRET_TWO=bare-value-0002 # trailing\nEMPTY=\nSHORT=abc\n");
      expect(dotenvEntries(join(dir, ".env"))).toEqual([["SECRET_ONE", "quoted-value-0001"], ["SECRET_TWO", "bare-value-0002"]]);
      const known = knownSecrets({ env: { API_KEY: "real-value-12345" }, dotenvFiles: [join(dir, ".env"), join(dir, "missing.env")] });
      expect(known.map(([k]) => k).sort()).toEqual(["API_KEY", "SECRET_ONE", "SECRET_TWO"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a known value is a blocking finding; shapes are redact findings; clean text has none", () => {
    const known: Array<[string, string]> = [["STRIPE_SECRET_KEY", "sk_live_cccccccccccccccc"]];
    const leak = scanText("the key is sk_live_cccccccccccccccc, use it", known);
    expect(leak).toEqual([{ kind: "known", name: "STRIPE_SECRET_KEY", severity: "block" }]);
    const shaped = scanText("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\nghp_abcdefghijklmnopqrstuvwxyz1234\nAPI_KEY=abcdefgh12345678\nDB_PASSWORD=supersecret99\n", []);
    expect(shaped.map((f) => f.kind).sort()).toEqual(["env-dump", "private-key", "token"]);
    expect(shaped.every((f) => f.severity === "redact")).toBe(true);
    expect(scanText("API_KEY=your-key-here\nTOKEN=xxxxxxxxxxxx\n# example only\n", [])).toEqual([]);
  });

  test("redaction masks values by name and shapes by kind, and counts what it did", () => {
    const known: Array<[string, string]> = [["DB_PASS", "hunter2hunter2"]];
    const { text, redactions } = redactText("pass hunter2hunter2 twice hunter2hunter2\ntoken sk-ant-abcdefghijklmnopqrstuvwxyz\n", known);
    expect(text).not.toContain("hunter2hunter2");
    expect(text).toContain("[redacted:DB_PASS]");
    expect(text).toContain("[redacted:anthropic-token]");
    expect(redactions).toBe(2);
  });
});

describe("secret-leak rubric through the gate", () => {
  test("an artifact carrying a known secret value fails the gate; one shaped like a secret passes with a note", () => {
    const dir = mkdtempSync(join(tmpdir(), "nrv-gate-secret-"));
    try {
      const gate = join(ROOT, "skills", "harness", "scripts", "quality-gate.ts");
      writeFileSync(join(dir, "leak.json"), JSON.stringify({ note: "config", key: "sk_live_zzzzzzzzzzzzzzzzzzzz" }));
      writeFileSync(join(dir, "example.json"), JSON.stringify({ example: "API_KEY=abcdefgh12345678", other: "ghp_abcdefghijklmnopqrstuvwxyz1234" }));
      const env = { ...process.env, STRIPE_SECRET_KEY: "sk_live_zzzzzzzzzzzzzzzzzzzz", NIRVANA_PROJECT_ROOT: dir, HARNESS_LOGS_DIR: join(dir, "logs"), NIRVANA_SKILLS_DIR: join(ROOT, "skills") };
      const leak = spawnSync("bun", [gate, join(dir, "leak.json"), "--auto", "--offline"], { encoding: "utf8", env, cwd: dir });
      expect(leak.status).not.toBe(0);
      const v = JSON.parse(leak.stdout);
      const r = v.results.find((x: any) => x.name === "secret-leak");
      expect(r.passed).toBe(false);
      expect(r.reasoning).toContain("STRIPE_SECRET_KEY");
      expect(r.reasoning).not.toContain("sk_live_zzzz");
      const ok = spawnSync("bun", [gate, join(dir, "example.json"), "--auto", "--offline"], { encoding: "utf8", env, cwd: dir });
      const v2 = JSON.parse(ok.stdout);
      const r2 = v2.results.find((x: any) => x.name === "secret-leak");
      expect(r2.passed).toBe(true);
      expect(r2.score).toBeLessThan(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});
