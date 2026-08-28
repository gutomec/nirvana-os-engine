// runtime-failover.test.ts — what the system does when a runtime is DEAD.
//
// Regression cover for the gemini-cli incident (2026-08): Google retired the
// individual Code Assist tier, so the CLI authenticated and was then refused
// (`IneligibleTierError`, pointing users at Antigravity). A live six-runtime
// matrix caught it, and it exposed two defects of ours behind the external one:
//
//   1. `IneligibleTierError` matched no pattern in classifyGemini — the verdict
//      came back a generic `error`, which by policy does not rotate. The run
//      died with a working runtime sitting right below it in the cascade.
//   2. The failure the user saw was "YOLO mode is enabled. All tool calls will
//      be automatically approved." — benign chatter the CLI prints before the
//      real cause. The ledger's last_error, the router's warning and the
//      dispatch summary all led with it.
//
// The three tests below pin, in order: the cause survives the chatter; the EOL
// surface classifies as auth; a dead runtime hands off instead of ending the run.
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { salientError, runtimeAvailable } from "../../_shared/lib/host-agent-driver.ts";
import { classify } from "../lib/quota-detector.ts";
import { runWithCascade } from "../lib/cascade-runner.ts";
import { isInCooldown } from "../lib/cooldown-registry.ts";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

// Verbatim stderr from the failed gemini-cli run of the 2026-08-05 matrix.
const REAL_GEMINI_STDERR = [
  "YOLO mode is enabled. All tool calls will be automatically approved.",
  "Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google",
  "    at throwIneligibleOrProjectIdError (file:///opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/chunk-GPVT36PL.js:307463:11)",
  "    at _doSetupUser (file:///opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/chunk-GPVT36PL.js:307452:5)",
].join("\n");

describe("salientError — the cause outranks the chatter", () => {
  test("skips the benign headline and reports the real failure", () => {
    const msg = salientError(REAL_GEMINI_STDERR, "gemini failed");
    expect(msg).toContain("IneligibleTierError");
    expect(msg).not.toContain("YOLO mode is enabled");
  });

  test("survives more chatter than the old 500-byte window held", () => {
    // 12 skill-conflict lines (~140 chars each) is what the real run printed
    // before its final error — the old slice(0, 500) never reached the cause.
    const noise = Array.from({ length: 12 }, (_, i) =>
      `Skill conflict detected: "skill-${i}" from "/Users/x/.agents/skills/skill-${i}/SKILL.md" is overriding the same skill from "/Users/x/.gemini/skills/skill-${i}/SKILL.md".`,
    ).join("\n");
    const msg = salientError(`YOLO mode is enabled.\n${noise}\nquota exceeded for this project`, "fallback");
    expect(msg).toBe("quota exceeded for this project");
  });

  test("stack frames never become the message", () => {
    const msg = salientError("    at foo (/a/b.js:1:2)\n    at bar (/a/c.js:3:4)", "codex exec failed");
    expect(msg).toBe("codex exec failed");
  });

  test("falls back when stderr carries nothing but noise, and when it is empty", () => {
    expect(salientError("YOLO mode is enabled.\nnpm warn deprecated x@1", "agy failed")).toBe("agy failed");
    expect(salientError("", "agy failed")).toBe("agy failed");
  });

  test("a plain message with no error keyword still beats the fallback", () => {
    expect(salientError("the model refused to answer", "x failed")).toBe("the model refused to answer");
  });
});

describe("classify — a retired runtime tier is an auth failure, not a generic error", () => {
  test("IneligibleTierError classifies as auth_failed and names the successor", () => {
    const v = classify("gemini-cli", { ok: false, exitCode: 1, stderr: REAL_GEMINI_STDERR, error: "", result: "" } as any);
    expect(v.kind).toBe("auth_failed");
    // The user cannot re-auth their way out of a retired tier: the hint has to
    // point at the runtime that replaced it.
    expect((v as any).hint).toContain("antigravity-cli");
  });

  test("`Error authenticating:` alone is enough — the old regex wanted `authentication failed`", () => {
    const v = classify("gemini-cli", { ok: false, exitCode: 1, stderr: "Error authenticating: bad token", error: "", result: "" } as any);
    expect(v.kind).toBe("auth_failed");
  });
});

describe("cascade — a dead runtime hands off instead of ending the run", () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-failover-test-"));
  const BIN = path.join(TMP, "bin");
  const PROJ = path.join(TMP, "project");
  const ENV_BEFORE = { PATH: process.env.PATH, HARNESS_LOGS_DIR: process.env.HARNESS_LOGS_DIR };

  beforeAll(() => {
    fs.mkdirSync(BIN, { recursive: true });
    fs.mkdirSync(path.join(PROJ, "outputs"), { recursive: true });
    // `gemini` reproduces the retired tier: the real stderr, exit 1. On Windows
    // these land as `.cmd` launchers — the same shape npm installs a real agent
    // CLI as — so the driver's own .cmd handling is exercised, not assumed.
    writeFakeCli(BIN, "gemini", `
      try { await Bun.stdin.text(); } catch {}
      console.error(${JSON.stringify(REAL_GEMINI_STDERR)});
      process.exit(1);
    `);
    // `agy` is the successor and works.
    writeFakeCli(BIN, "agy", `
      try { await Bun.stdin.text(); } catch {}
      console.log(JSON.stringify({ response: "guide written" }));
      process.exit(0);
    `);
    fs.writeFileSync(path.join(PROJ, ".env"), "LLM_CASCADE=gemini-cli,antigravity-cli\n");
    process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;
    process.env.HARNESS_LOGS_DIR = path.join(TMP, "logs");
  });

  afterAll(() => {
    // Restore exactly what was there — including "was not set" (a previous bug
    // in this suite deleted vars it did not own and leaked runs into ~/.harness-logs).
    for (const [k, v] of Object.entries(ENV_BEFORE)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  test("shims are the ones being exercised, not any real CLI on this machine", () => {
    expect(runtimeAvailable("gemini-cli")).toBe(true);
    expect(runtimeAvailable("antigravity-cli")).toBe(true);
    // The probe must answer about the CURRENT PATH. Under Bun a spawn without an
    // explicit `env` uses the environment captured at process start, so this
    // suite passed on a machine that happened to have the real binaries and
    // failed on CI, which has neither — the shims were never being exercised.
    // A name no CLI on earth claims proves the mutation is what is seen.
    const probeDir = path.join(TMP, "probe-bin");
    writeFakeCli(probeDir, "kimi", `process.exit(0);`);
    const before = runtimeAvailable("kimi-cli");
    process.env.PATH = `${probeDir}${path.delimiter}${process.env.PATH}`;
    try {
      expect(runtimeAvailable("kimi-cli")).toBe(true);
      if (!before) expect(before).toBe(false);   // only meaningful where kimi is absent
    } finally {
      process.env.PATH = process.env.PATH!.replace(`${probeDir}${path.delimiter}`, "");
    }
  }, spawnBudgetMs(4));

  test("auth failure rotates to the next runtime and the work completes", () => {
    const res = runWithCascade({
      runtime: "gemini-cli",
      prompt: "write a short code-review guide",
      brief: "write a short code-review guide",
      cwd: PROJ,
      projectRoot: PROJ,
      outputsRoot: path.join(PROJ, "outputs"),
      projectId: "failover-test",
    });

    expect(res.ok).toBe(true);
    expect(res.finalRuntime).toBe("antigravity-cli");
    expect(res.handoffs.map(h => `${h.from}->${h.to}`)).toContain("gemini-cli->antigravity-cli");
  });

  test("the dead runtime is cooled down, so no later step of the run picks it again", () => {
    // The live incident hit gemini three times in one run (route, retry, agent-x)
    // because nothing recorded that it was down.
    expect(isInCooldown(PROJ, "gemini-cli")).toBe(true);
    expect(isInCooldown(PROJ, "antigravity-cli")).toBe(false);
  });

  test("handing off does not hide the broken credential — the audit still says so", () => {
    const dir = path.join(TMP, "logs", new Date().toISOString().slice(0, 10));
    const events = fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8")
      .split("\n").filter(Boolean).map(l => parseAuditLine(l));
    const auth = events.find(e => e.event === "runtime_auth_failed");
    expect(auth).toBeDefined();
    expect(auth.runtime).toBe("gemini-cli");
    expect(auth.hint).toContain("antigravity-cli");
    expect(events.some(e => e.event === "runtime_handoff" && e.to === "antigravity-cli")).toBe(true);
  });
});
