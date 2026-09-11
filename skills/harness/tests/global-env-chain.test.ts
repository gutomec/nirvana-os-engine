// global-env-chain.test.ts — what the cockpit writes, the engine reads.
//
// Three subsystems had three different ideas of where a user's GLOBAL settings
// live. The cascade read `~/.nirvana/.env` then `~/.claude/.env`; the runtime
// rules read only `~/.claude/.env`; and Glance — the panel a user actually
// clicks — reads and writes `~/.env`, which nothing in the engine ever opened.
//
// So a person could open the cockpit, write "USE_CODEX: quando precisar gerar
// imagens", press save, watch the panel report the rule as saved, reload the
// page and see it still there — and no dispatch on that machine would ever
// consult it. The same held for a global `LLM_CASCADE`.
//
// One chain now, and `~/.env` is in it.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { globalEnvFiles, readEnvFile } from "../lib/cascade.ts";
import { loadRuntimeRules } from "../lib/runtime-rules.ts";

const saved = process.env.NIRVANA_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.NIRVANA_HOME;
  else process.env.NIRVANA_HOME = saved;
});

describe("the global .env chain", () => {
  test("names the engine home, the pre-migration Claude dir and the file Glance writes", () => {
    const files = globalEnvFiles();
    expect(files[0]).toBe(path.join(process.env.NIRVANA_HOME || os.homedir(), ".nirvana", ".env"));
    expect(files[1]).toBe(path.join(os.homedir(), ".claude", ".env"));
    expect(files[2]).toBe(path.join(os.homedir(), ".env"));
  });

  test("it is the file Glance's global scope actually writes", () => {
    // Pinned against the server rather than restated: if the cockpit ever moves
    // its global file, this fails instead of going quiet again.
    const server = fs.readFileSync(path.join(import.meta.dir, "..", "lib", "glance", "server.ts"), "utf8");
    expect(server).toContain('path.join(os.homedir(), ".env")');
    expect(globalEnvFiles()).toContain(path.join(os.homedir(), ".env"));
  });

  test("NIRVANA_HOME moves the engine's own file and leaves the two legacy ones alone", () => {
    process.env.NIRVANA_HOME = path.join(os.tmpdir(), "nrv-home-fixture");
    expect(globalEnvFiles()[0]).toBe(path.join(os.tmpdir(), "nrv-home-fixture", ".nirvana", ".env"));
    expect(globalEnvFiles()[2]).toBe(path.join(os.homedir(), ".env"));
  });
});

describe("a rule written in the cockpit reaches the dispatch", () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

  /** A whole fake home, so the real `~/.env` is never read or written. */
  function home(files: Record<string, string>) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-genv-")));
    roots.push(root);
    for (const [rel, body] of Object.entries(files)) {
      const f = path.join(root, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, body, "utf8");
    }
    return root;
  }

  test("the project's own .env still wins over anything global", () => {
    const root = home({ ".env": 'USE_CODEX="do projeto"\n' });
    const rules = loadRuntimeRules(root, {} as NodeJS.ProcessEnv);
    expect(rules.map((r) => [r.envKey, r.rule])).toEqual([["USE_CODEX", "do projeto"]]);
  });

  test("a key defined twice keeps the first file that claimed it", () => {
    const root = home({ ".env": 'USE_CODEX="do projeto"\n', "outro/.env": 'USE_CODEX="de outro lugar"\n' });
    const rules = loadRuntimeRules(root, {} as NodeJS.ProcessEnv);
    expect(rules).toHaveLength(1);
    expect(rules[0].rule).toBe("do projeto");
  });

  test("readEnvFile takes only what it is asked for — the rest of a personal dotfile is untouched", () => {
    // `~/.env` is a file people keep other things in. Entering the chain must
    // not mean the engine acts on anything but its own keys.
    const root = home({ ".env": 'OPENAI_API_KEY="sk-segredo"\nUSE_CODEX="imagens"\n' });
    const parsed = readEnvFile(path.join(root, ".env"));
    expect(parsed.OPENAI_API_KEY).toBe("sk-segredo");   // readEnvFile parses it,
    const rules = loadRuntimeRules(root, {} as NodeJS.ProcessEnv);
    expect(rules.map((r) => r.envKey)).toEqual(["USE_CODEX"]);   // the loader ignores it
  });
});
