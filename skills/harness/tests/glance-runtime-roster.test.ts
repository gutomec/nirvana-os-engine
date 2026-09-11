// glance-runtime-roster.test.ts — the cockpit shows every runtime, and never
// rewrites a rule it does not recognise.
//
// Glance carried four separate copies of the runtime roster and each had
// stopped at a different point: the settings panel offered four of nine in one
// picker and five in another, the chat override listed four names written into
// the page, and the rules editor kept two maps of seven.
//
// The rules editor's pair is the one that did damage rather than just hiding
// options. Reading a rule it did not recognise, it showed the row as a
// claude-code rule; writing the draft back, it emitted `USE_CLAUDE_CODE` and
// listed the original key for deletion. Opening the settings panel and pressing
// save was enough to turn a `USE_QWEN` rule into a claude one and destroy the
// user's. Nothing warned, and the .env had already changed.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getField } from "../lib/glance/config-schema.ts";
import { listRuntimes } from "../../_shared/lib/host-agent-driver.ts";

const VIEWS = path.join(import.meta.dir, "..", "lib", "glance", "views");
const ROSTER = listRuntimes().map((r) => r.name);

/** glance.js is browser code: one plain `glance()` factory returning the Alpine
 *  object, with its only global (localStorage) already guarded. Loading it here
 *  tests the real methods rather than asserting on the text of the file. */
function glanceApp(): any {
  const src = fs.readFileSync(path.join(VIEWS, "glance.js"), "utf8");
  return (new Function(`${src}; return glance;`)() as () => any)();
}

function editor(rules: Array<{ key: string; value: string }>) {
  const app = glanceApp();
  app.rulesData = { runtimes: [...ROSTER, "hermes"], runtimes_installed: ROSTER, project: rules, global: [] };
  app.settingsScopePicker = "project";
  app.loadRulesDraft();
  return app;
}

describe("the rules editor round-trips what it read", () => {
  test("a USE_ rule for every runtime on the roster survives read → write unchanged", () => {
    const keys = ROSTER.map((r) => `USE_${r.toUpperCase().replace(/-/g, "_")}`);
    const app = editor(keys.map((key) => ({ key, value: `regra ${key}` })));
    expect(app.rulesDraft.map((r: any) => r.runtime)).toEqual(ROSTER);
    expect(app.rulesToEnv()).toEqual(Object.fromEntries(keys.map((k) => [k, `regra ${k}`])));
  });

  test("the two runtimes the old maps never learned are read as themselves, not as claude-code", () => {
    const app = editor([
      { key: "USE_QWEN", value: "contexto enorme" },
      { key: "NOT_USE_OPENCODE", value: "nunca para isso" },
    ]);
    expect(app.rulesDraft.map((r: any) => [r.mode, r.runtime]))
      .toEqual([["use", "qwen-code"], ["not", "opencode"]]);
    expect(app.rulesToEnv()).toEqual({ USE_QWEN: "contexto enorme", NOT_USE_OPENCODE: "nunca para isso" });
  });

  test("a short alias keeps the exact key it was read from — no churn in the user's .env", () => {
    const app = editor([{ key: "USE_GEMINI", value: "contexto gigante" }]);
    expect(app.rulesDraft[0].runtime).toBe("gemini-cli");
    expect(Object.keys(app.rulesToEnv())).toEqual(["USE_GEMINI"]);   // not USE_GEMINI_CLI
  });

  test("a key this build does not recognise travels back untouched", () => {
    // The previous behaviour renamed it to USE_CLAUDE_CODE and deleted it.
    const app = editor([{ key: "USE_MISTERIO", value: "seja lá o que for" }]);
    expect(app.rulesDraft[0].runtime).toBe("");
    expect(app.rulesToEnv()).toEqual({ USE_MISTERIO: "seja lá o que for" });
  });

  test("changing the runtime on a row DOES rewrite the key — that is the edit", () => {
    const app = editor([{ key: "USE_QWEN", value: "contexto enorme" }]);
    app.rulesDraft[0].runtime = "codex";
    expect(app.rulesToEnv()).toEqual({ USE_CODEX: "contexto enorme" });
  });

  test("switching a rule to a veto rewrites the prefix", () => {
    const app = editor([{ key: "USE_CODEX", value: "imagens" }]);
    app.rulesDraft[0].mode = "not";
    expect(app.rulesToEnv()).toEqual({ NOT_USE_CODEX: "imagens" });
  });

  test("a new rule is seeded with a real runtime, never a literal", () => {
    const app = editor([]);
    app.addRule();
    expect(ROSTER).toContain(app.rulesDraft[0].runtime);
  });
});

describe("the pickers offer what the machine has", () => {
  test("the chat override lists the INSTALLED runtimes, and degrades to auto", async () => {
    const app = glanceApp();
    app.rulesData = { runtimes: [...ROSTER, "hermes"], runtimes_installed: ["codex", "pi"] };
    await app.ensureRuntimeOptions();
    expect(app.runtimeOptions).toEqual(["codex", "pi"]);
    // Naming a runtime that is not installed is refused downstream, so a picker
    // that sets one must never offer it.
    expect(app.runtimeOptions).not.toContain("hermes");
  });

  test("the page no longer writes runtime names into the markup", () => {
    const html = fs.readFileSync(path.join(VIEWS, "index.html"), "utf8");
    const bar = html.slice(html.indexOf('x-model="chatRuntime"'), html.indexOf('x-model="chatRuntime"') + 400);
    expect(bar).toContain("runtimeOptions");
    expect(bar).not.toContain('value="claude-code"');
  });

  test("both settings enums come from the roster", () => {
    expect(getField("NIRVANA_HOST_RUNTIME")?.options).toEqual(["", ...ROSTER]);
    expect(getField("NIRVANA_DEFAULT_HOST")?.options).toEqual(listRuntimes().map((r) => r.cli));
  });
});

describe("the rules endpoint is the single source the views read", () => {
  // `close()`, not `stop()`: startServer returns its own handle and a no-op
  // teardown leaves port 3737 bound for every Glance test that runs after this
  // file — 28 of them failed with EADDRINUSE the first time this was written.
  const servers: any[] = [];
  afterAll(() => { for (const s of servers.splice(0)) { try { s.close(); } catch { /* best-effort */ } } });

  test("/api/config/rules reports the whole roster and which of it is installed", async () => {
    const { startServer } = await import("../lib/glance/server.ts");
    const server = await startServer({ port: 0, open: false, idleMin: 60, allowActions: false, theme: "apple" });
    servers.push(server);
    const body = await fetch(`http://127.0.0.1:${server.port}/api/config/rules`).then((r) => r.json()) as any;
    expect(body.runtimes).toEqual([...ROSTER, "hermes"]);
    expect(Array.isArray(body.runtimes_installed)).toBe(true);
    for (const rt of body.runtimes_installed) expect(ROSTER).toContain(rt);
  }, 60_000);
});
