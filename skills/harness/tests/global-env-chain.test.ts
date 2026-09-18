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

describe("a USE_ variable that is not a rule", () => {
  // `USE_` is a common prefix in the wild. A CI runner with Bazel exports
  // USE_BAZEL_FALLBACK_VERSION, and every `nrv` call on that machine used to
  // print "[runtime-rules] unknown runtime ..." at it — alarming, useless, and
  // measured on this repo's own CI. A typo inside a .env is a different thing:
  // that file exists to hold these rules, so it is still worth saying.
  function captureStderr(fn: () => void): string {
    const original = console.error;
    let out = "";
    console.error = (...args: unknown[]) => { out += args.join(" ") + "\n"; };
    try { fn(); } finally { console.error = original; }
    return out;
  }

  test("a stray one in the ambient environment is ignored in silence", () => {
    const err = captureStderr(() => loadRuntimeRules(null, { USE_BAZEL_FALLBACK_VERSION: "8.1.0" }));
    expect(err).toBe("");
  });

  test("and it still produces no rule", () => {
    expect(loadRuntimeRules(null, { USE_BAZEL_FALLBACK_VERSION: "8.1.0" })).toEqual([]);
  });

  test("a real rule in the same environment is still read", () => {
    const rules = loadRuntimeRules(null, { USE_BAZEL_FALLBACK_VERSION: "8.1.0", USE_CODEX: "for code review" });
    expect(rules.map((r) => r.runtime)).toEqual(["codex"]);
  });

  test("a typo inside a project .env is still reported, because that file is only for rules", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-rules-env-"));
    try {
      fs.writeFileSync(path.join(dir, ".env"), "USE_CLAUDE_KODE=for prose\n", "utf8");
      const err = captureStderr(() => loadRuntimeRules(dir, {}));
      expect(err).toContain("USE_CLAUDE_KODE");
      expect(err).toContain("rule ignored");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
