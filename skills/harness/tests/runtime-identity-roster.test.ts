// runtime-identity-roster.test.ts — nine runtimes, recognised nine ways.
//
// The engine has to answer three questions about a runtime, and until this cut
// it answered them from three hand-written tables that had each stopped
// growing at a different moment:
//
//   "which runtime am I running inside?"   detectCurrentHost — 7 of 9
//   "what did the user call it?"           RUNTIME_ALIASES   — 7 of 9
//   "did the brief name one?"              MENTION_NAMES     — 7 of 9
//                                          MENTION_CUE       — 5 of 9
//
// The cue is the one that shows how quiet this failure is: `kimi-cli` and
// `grok-cli` were listed in the map next to it, and nothing could ever reach
// them, because the cue's own alternation of names had never been extended.
// `USE_QWEN` was answered with "unknown runtime — rule ignored"; a session
// inside `qwen-code` or `opencode` identified as nobody and the work was handed
// to whichever vendor happened to be first on PATH.
//
// Every case below names its runtime literally. That is deliberate: a test that
// derives its expectations from the same table as the code would have passed
// against all four bugs.
import { describe, expect, test, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  canonicalRuntimeName, detectCurrentHost, detectRuntimeMention, loadRuntimeRules,
} from "../lib/runtime-rules.ts";
import { listRuntimes, type Runtime } from "../../_shared/lib/host-agent-driver.ts";
import { forwardedEnv } from "../../_shared/lib/orca-worker.ts";

/** The roster as it stands. A tenth adapter makes this list fail, which is the
 *  point: the reminder lands here, where all three answers are stated. */
const ROSTER: Runtime[] = [
  "claude-code", "codex", "antigravity-cli", "gemini-cli", "pi",
  "kimi-cli", "grok-cli", "qwen-code", "opencode",
];

test("the roster this file speaks for is the driver's roster", () => {
  expect(listRuntimes().map((r) => r.name).sort()).toEqual([...ROSTER].sort());
});

describe("which runtime am I running inside", () => {
  // One real marker per runtime, written out here rather than read from the
  // table the code uses.
  test.each([
    ["claude-code", "CLAUDECODE"],
    ["claude-code", "CLAUDE_CODE_SESSION_ID"],
    ["codex", "CODEX_THREAD_ID"],
    ["codex", "CODEX_SANDBOX"],
    ["gemini-cli", "GEMINI_SESSION_ID"],
    ["antigravity-cli", "ANTIGRAVITY_SESSION_ID"],
    ["antigravity-cli", "AGY_SESSION_ID"],
    ["pi", "PI_CODING_AGENT"],
    ["kimi-cli", "KIMI_SESSION_ID"],
    ["grok-cli", "GROK_SESSION_ID"],
    ["qwen-code", "QWEN_SESSION_ID"],
    ["opencode", "OPENCODE_SESSION_ID"],
  ] as Array<[Runtime, string]>)("%s is identified by %s", (expected, marker) => {
    expect(detectCurrentHost({ [marker]: "1" })).toBe(expected);
  });

  test("a bare shell identifies nobody, and says so", () => {
    expect(detectCurrentHost({})).toBeNull();
    expect(detectCurrentHost({ PATH: "/usr/bin", TERM_PROGRAM: "ghostty" })).toBeNull();
  });

  test("a derivative answers with itself, not with the CLI it forked", () => {
    // qwen-code is a gemini-cli fork and antigravity-cli is Gemini-family:
    // both can carry the parent's variables, so both are tested first.
    expect(detectCurrentHost({ GEMINI_CLI: "1", QWEN_SESSION_ID: "q" })).toBe("qwen-code");
    expect(detectCurrentHost({ GEMINI_SESSION_ID: "g", ANTIGRAVITY_SESSION_ID: "a" })).toBe("antigravity-cli");
  });

  test("NIRVANA_HOST_RUNTIME is checked before every vendor marker", () => {
    expect(detectCurrentHost({ NIRVANA_HOST_RUNTIME: "opencode", CLAUDECODE: "1" })).toBe("opencode");
    expect(detectCurrentHost({ NIRVANA_HOST_RUNTIME: "qwen-code", CLAUDECODE: "1" })).toBe("qwen-code");
  });
});

describe("what the user called it", () => {
  test.each([
    ["claude-code", "claude"], ["claude-code", "claude-code"],
    ["codex", "codex"], ["codex", "codex-cli"],
    ["gemini-cli", "gemini"], ["gemini-cli", "gemini-cli"],
    ["antigravity-cli", "agy"], ["antigravity-cli", "antigravity"],
    ["pi", "pi"], ["pi", "pi-dev"],
    ["kimi-cli", "kimi"], ["kimi-cli", "kimi-code"],
    ["grok-cli", "grok"],
    ["qwen-code", "qwen"], ["qwen-code", "qwen-code"],
    ["opencode", "opencode"], ["opencode", "open-code"],
  ] as Array<[Runtime, string]>)("%s answers to '%s'", (expected, typed) => {
    expect(canonicalRuntimeName(typed)).toBe(expected);
  });

  test("a USE_ rule is accepted for every runtime on the roster", () => {
    const suffix = (r: Runtime) => r.toUpperCase().replace(/-/g, "_");
    const env = Object.fromEntries(ROSTER.map((r) => [`USE_${suffix(r)}`, `regra de ${r}`]));
    const rules = loadRuntimeRules(null, env as NodeJS.ProcessEnv);
    expect(rules.map((r) => r.runtime).sort()).toEqual([...ROSTER].sort());
  });

  test("an unknown suffix is still ignored, not guessed", () => {
    expect(loadRuntimeRules(null, { USE_NOTHING: "x" } as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe("did the brief name one", () => {
  test.each([
    ["claude-code", "use o claude para isso"],
    ["codex", "run it on codex"],
    ["gemini-cli", "despache via gemini-cli"],
    ["antigravity-cli", "use o agy para pesquisar"],
    ["pi", "rode no pi"],
    ["kimi-cli", "use o kimi para isso"],
    ["grok-cli", "despache via grok"],
    ["qwen-code", "use o qwen para isso"],
    ["opencode", "use o opencode para isso"],
    ["hermes", "avise pelo hermes"],
  ] as Array<[string, string]>)("%s, from: %s", (expected, brief) => {
    expect(detectRuntimeMention(brief)?.runtime).toBe(expected as Runtime);
  });

  test("the name alone is content, not an instruction", () => {
    expect(detectRuntimeMention("escreva sobre a estátua de Hermes")).toBeNull();
    expect(detectRuntimeMention("um artigo sobre o número pi")).toBeNull();
    expect(detectRuntimeMention("um livro sobre o codex de Leonardo")).toBeNull();
  });

  test("two runtimes named is ambiguous, and nothing is guessed", () => {
    expect(detectRuntimeMention("use o codex e depois use o qwen")).toBeNull();
  });
});

describe("a dispatched child answers with itself", () => {
  // A CLI exports its session markers to everything it starts, so a child
  // spawned from a Claude Code session inherits CLAUDECODE=1. Without a stamp,
  // any `nrv` that child runs reads the session as claude-code and routes the
  // next step back to a vendor the user is not in.
  const roots: string[] = [];
  afterAll(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

  test("the Orca worker terminal is pinned to the runtime it IS", () => {
    const parent = { CLAUDECODE: "1", NIRVANA_HOST_RUNTIME: "claude-code", NIRVANA_TRACE_ID: "t1", PATH: "/bin" };
    const env = forwardedEnv(parent, "codex");
    expect(env.NIRVANA_HOST_RUNTIME).toBe("codex");
    expect(env.NIRVANA_TRACE_ID).toBe("t1");   // the engine's own vars still travel
    expect(env.PATH).toBeUndefined();          // and nothing else does
  });

  test("a real spawned child reads its OWN runtime, not the session's", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-stamp-")));
    roots.push(root);
    const binDir = path.join(root, "bin");
    const seen = path.join(root, "seen.txt");
    // The fake reports the one variable this test is about and exits clean.
    const { writeFakeCli } = await import("./helpers/fake-cli.ts");
    writeFakeCli(binDir, "grok", `
      import * as fs from "node:fs";
      try { await Bun.stdin.text(); } catch {}
      fs.writeFileSync(${JSON.stringify(seen)}, process.env.NIRVANA_HOST_RUNTIME ?? "<unset>");
      console.log("done");
    `);
    const { runHeadless } = await import("../../_shared/lib/host-agent-driver.ts");
    const previousPath = process.env.PATH;
    const previousHost = process.env.NIRVANA_HOST_RUNTIME;
    // The session this dispatch runs FROM says claude-code, loudly.
    process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
    process.env.NIRVANA_HOST_RUNTIME = "claude-code";
    try {
      runHeadless({ runtime: "grok-cli", prompt: "oi", cwd: root, yolo: true, timeoutMs: 30_000 });
    } finally {
      process.env.PATH = previousPath;
      if (previousHost === undefined) delete process.env.NIRVANA_HOST_RUNTIME;
      else process.env.NIRVANA_HOST_RUNTIME = previousHost;
    }
    expect(fs.readFileSync(seen, "utf8")).toBe("grok-cli");
  }, 60_000);

  test("outside a dispatch the stamp is not left behind", () => {
    // The spawn context is restored after the runner returns, so an unrelated
    // later spawn does not inherit the last dispatched runtime's name.
    expect(process.env.NIRVANA_HOST_RUNTIME ?? "<unset>").not.toBe("grok-cli");
  });
});

describe("the declarable roster agrees with the executable one", () => {
  // `requirements.minimum[].runtime` is declared in four places: the Zod
  // validator, its Python twin, the generated squad schema and the
  // hand-authored business schema. They had drifted into three different
  // answers — the business schema rejected `pi` and `antigravity-cli` that the
  // squad schema accepted, and none of the four had heard of kimi, grok or
  // qwen, so a squad could not say which runtime it actually needs.
  const REPO = path.resolve(import.meta.dir, "..", "..", "..");
  // `\r` stripped: git checks these files out with CRLF on Windows, and a
  // pattern anchored on "\n\n\nclass " then matches nothing there. A test that
  // only passes on the machine it was written on proves nothing about the code.
  const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8").replace(/\r\n/g, "\n");
  const runtimeEnumOf = (schema: string): string[] => {
    const found: string[] = [];
    const walk = (node: any) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries<any>(node)) {
        if (k === "runtime" && v && typeof v === "object" && Array.isArray(v.enum)) found.push(...v.enum);
        else walk(v);
      }
    };
    walk(JSON.parse(read(schema)));
    return found;
  };

  /** Every exec runtime must be declarable; the two extras are hosts that can
   *  be required but never dispatched to. */
  const DECLARABLE = [...ROSTER, "antigravity", "cursor", "openclaw"];

  test("the Zod validator covers every runtime the driver can execute", () => {
    const block = read("skills/_shared/validators/validators.ts").match(/const Runtime = z\.enum\(\[([\s\S]*?)\]\)/)![1];
    const names = [...block.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
    expect(names.sort()).toEqual([...DECLARABLE].sort());
  });

  test("the Python twin says the same thing", () => {
    const block = read("skills/_shared/validators/validators.py").match(/class Runtime\(str, Enum\):([\s\S]*?)\n\n\nclass /)![1];
    const names = [...block.matchAll(/= "([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(names.sort()).toEqual([...DECLARABLE].sort());
  });

  test("both JSON schemas publish that same list, and agree with each other", () => {
    const squad = runtimeEnumOf("skills/_shared/schemas/squad.schema.json");
    const business = runtimeEnumOf("skills/_shared/schemas/business.schema.json");
    expect(squad.sort()).toEqual([...DECLARABLE].sort());
    expect(business.sort()).toEqual(squad);
  });
});
