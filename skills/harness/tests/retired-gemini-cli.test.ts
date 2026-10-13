// retired-gemini-cli.test.ts — the Gemini CLI (`gemini-cli`, `gemini`) is no
// longer a runtime. A config written while it was one must not crash anything:
// a cascade entry is dropped, a USE_* rule is ignored, a named runtime reads as
// unavailable, each with "Gemini CLI is no longer supported; pick another
// runtime", and the usual fallback to the next runtime still applies.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { retiredRuntimeMessage, runtimeAvailable, type Runtime } from "../../_shared/lib/host-agent-driver.ts";
import { loadCascade } from "../lib/cascade.ts";
import { decideRuntime, loadRuntimeRules, unavailableRuntimeMessage } from "../lib/runtime-rules.ts";

const NOTICE = "Gemini CLI is no longer supported; pick another runtime";

let root: string;
let saved: string | undefined;
let errors: string[];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-retired-gemini-"));
  saved = process.env.LLM_CASCADE;
  delete process.env.LLM_CASCADE;
  errors = [];
  spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
});
afterEach(() => {
  spy.mockRestore();
  if (saved === undefined) delete process.env.LLM_CASCADE; else process.env.LLM_CASCADE = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the names it went by", () => {
  test("gemini-cli, gemini and GEMINI_CLI are recognised as retired; real runtimes are not", () => {
    for (const name of ["gemini-cli", "gemini", "GEMINI_CLI", " Gemini "]) expect(retiredRuntimeMessage(name)).toBe(NOTICE);
    for (const name of ["antigravity-cli", "codex", "claude-code", "gemini-3-pro", "", undefined]) expect(retiredRuntimeMessage(name)).toBeNull();
  });

  test("it is never available, whatever is on PATH", () => {
    expect(runtimeAvailable("gemini-cli" as Runtime)).toBe(false);
  });
});

describe("LLM_CASCADE", () => {
  test("a gemini-cli or gemini: entry is dropped with the notice; the next entries run", () => {
    fs.writeFileSync(path.join(root, ".env"), "LLM_CASCADE=gemini-cli:gemini-3-pro,gemini:gemini-3-flash$5,antigravity-cli:gemini-3-pro,codex\n");
    const cascade = loadCascade(root);
    expect(cascade.map((e) => e.runtime)).toEqual(["antigravity-cli", "codex"]);
    // Google models stay reachable through agy.
    expect(cascade[0].model).toBe("gemini-3-pro");
    const said = errors.join("\n");
    expect(said).toContain(NOTICE);
    expect(said).toContain("'gemini-cli:gemini-3-pro'");
    expect(said).toContain("'gemini:gemini-3-flash$5'");
  });

  test("a cascade of nothing but the Gemini CLI is empty, not an error", () => {
    fs.writeFileSync(path.join(root, ".env"), "LLM_CASCADE=gemini-cli\n");
    expect(loadCascade(root)).toEqual([]);
  });
});

describe("USE_* / NOT_USE_* rules", () => {
  test("a rule written for the Gemini CLI is ignored with the notice; the others load", () => {
    fs.writeFileSync(path.join(root, ".env"), [
      'USE_GEMINI="Quando o contexto for gigante"',
      'NOT_USE_GEMINI_CLI="Quando for análise de codebase"',
      'USE_AGY="Deep research"',
    ].join("\n"));
    const rules = loadRuntimeRules(root, {});
    expect(rules.map((r) => r.envKey)).toEqual(["USE_AGY"]);
    const said = errors.join("\n");
    expect(said).toContain(`USE_GEMINI (${path.join(root, ".env")}): ${NOTICE}`);
    expect(said).toContain(`NOT_USE_GEMINI_CLI (${path.join(root, ".env")}): ${NOTICE}`);
  });
});

describe("a runtime the user names", () => {
  test("is returned unavailable, and the refusal says why", () => {
    const d = decideRuntime({ brief: "x", explicitRuntime: "gemini-cli" as Runtime, defaultRuntime: "codex", rules: [], mode: "fast", available: runtimeAvailable });
    expect(d.unavailable).toBe(true);
    const msg = unavailableRuntimeMessage({ runtime: "gemini-cli" as Runtime, installed: ["codex"] as Runtime[] });
    expect(msg).toContain(NOTICE);
    expect(msg).toContain("Installed right now: codex");
  });

  test("a brief that says 'use o gemini' names no runtime any more", () => {
    const d = decideRuntime({ brief: "use o gemini para o html", explicitRuntime: null, defaultRuntime: "codex", rules: [], mode: "fast", available: () => true });
    expect(d).toMatchObject({ runtime: "codex", source: "default" });
  });
});
