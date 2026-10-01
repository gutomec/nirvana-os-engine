// cascade-start.test.ts — LLM_CASCADE never chooses the runtime a run STARTS on.
//
// The owner's rule: every run uses the runtime the user is working in; the
// cascade may hand off to its next entry only after a classified quota/auth
// failure. Before, a requested runtime missing from LLM_CASCADE (or in
// cooldown) was silently replaced by the cascade head at start.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runtimeAvailable } from "../../_shared/lib/host-agent-driver.ts";
import { runWithCascade } from "../lib/cascade-runner.ts";
import { markCooldown, isInCooldown, getCooldown } from "../lib/cooldown-registry.ts";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

describe("cascade-runner starts on the requested runtime", () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-cascade-start-"));
  const BIN = path.join(TMP, "bin");
  const ENV_BEFORE = { PATH: process.env.PATH, HARNESS_LOGS_DIR: process.env.HARNESS_LOGS_DIR, LLM_CASCADE: process.env.LLM_CASCADE };

  /** A fresh project dir with its own .env, so cooldowns never leak across tests. */
  const project = (name: string, cascade: string): string => {
    const dir = path.join(TMP, name);
    fs.mkdirSync(path.join(dir, "outputs"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".env"), `LLM_CASCADE=${cascade}\n`);
    return dir;
  };
  const run = (proj: string, runtime: any, extra: Record<string, unknown> = {}) => runWithCascade({
    runtime, prompt: "p", brief: "p", cwd: proj, projectRoot: proj, outputsRoot: path.join(proj, "outputs"), ...extra,
  } as any);

  beforeAll(() => {
    fs.mkdirSync(BIN, { recursive: true });
    delete process.env.LLM_CASCADE;
    writeFakeCli(BIN, "gemini", `
      try { await Bun.stdin.text(); } catch {}
      console.error("Error authenticating: IneligibleTierError: no longer supported");
      process.exit(1);
    `);
    writeFakeCli(BIN, "agy", `
      try { await Bun.stdin.text(); } catch {}
      console.log(JSON.stringify({ response: "done" }));
      process.exit(0);
    `);
    process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;
    process.env.HARNESS_LOGS_DIR = path.join(TMP, "logs");
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(ENV_BEFORE)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  test("a runtime that is not in LLM_CASCADE is not replaced by the cascade head", () => {
    const proj = project("not-in-cascade", "gemini-cli");
    const res = run(proj, "antigravity-cli");
    expect(res.ok).toBe(true);
    expect(res.finalRuntime).toBe("antigravity-cli");
    expect(res.handoffs).toEqual([]);
  }, spawnBudgetMs(4));

  test("the user's runtime in cooldown still runs, instead of moving to another vendor", () => {
    const proj = project("cooldown", "gemini-cli,antigravity-cli");
    markCooldown(proj, "antigravity-cli", 3600, "old quota hit", "unknown");
    const res = run(proj, "antigravity-cli");
    expect(res.ok).toBe(true);
    expect(res.finalRuntime).toBe("antigravity-cli");
    expect(res.handoffs).toEqual([]);
  }, spawnBudgetMs(4));

  test("a classified auth failure hands off to the next entry (unpinned)", () => {
    const proj = project("handoff", "gemini-cli,antigravity-cli");
    const res = run(proj, "gemini-cli");
    expect(res.ok).toBe(true);
    expect(res.finalRuntime).toBe("antigravity-cli");
    expect(res.handoffs.map(h => `${h.from}->${h.to}`)).toEqual(["gemini-cli->antigravity-cli"]);
  }, spawnBudgetMs(6));

  test("a pinned run (flag or brief mention) never hands off, failure included", () => {
    const proj = project("pinned", "gemini-cli,antigravity-cli");
    const res = run(proj, "gemini-cli", { pinned: true });
    expect(res.ok).toBe(false);
    expect(res.finalRuntime).toBe("gemini-cli");
    expect(res.handoffs).toEqual([]);
  }, spawnBudgetMs(4));

  test("the requested runtime is not installed: clear failure, no switch, no 24 h cooldown", () => {
    if (runtimeAvailable("kimi-cli")) return;   // only meaningful where kimi is absent
    const proj = project("missing", "antigravity-cli");
    const res = run(proj, "kimi-cli");
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(127);
    expect(res.error).toContain("not installed");
    expect(res.handoffs).toEqual([]);
    expect(isInCooldown(proj, "kimi-cli")).toBe(false);
  });

  test("a handoff target that is missing gets a SHORT cooldown, which clears once the CLI is back", () => {
    if (runtimeAvailable("kimi-cli")) return;
    const proj = project("missing-target", "gemini-cli,kimi-cli,antigravity-cli");
    const res = run(proj, "gemini-cli");
    expect(res.finalRuntime).toBe("antigravity-cli");
    const cd = getCooldown(proj, "kimi-cli");
    expect(cd).not.toBeNull();
    expect(new Date(cd!.until_iso).getTime() - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000 + 5000);
    // The binary appears on PATH: the next run that reaches it drops the stale cooldown.
    writeFakeCli(BIN, "kimi", `try { await Bun.stdin.text(); } catch {} console.log("{}"); process.exit(0);`);
    run(proj, "kimi-cli");
    expect(getCooldown(proj, "kimi-cli")?.reason ?? "").not.toContain("not on PATH");
  }, spawnBudgetMs(8));
});
