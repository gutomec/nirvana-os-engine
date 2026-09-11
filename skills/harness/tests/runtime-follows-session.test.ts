// runtime-follows-session.test.ts — the work runs where the user is working.
//
// The house rule, in one line: the default runtime is the session the caller is
// sitting in. They may name another — flag, brief, or a USE_* rule — and that
// wins, provided it is installed here. A runtime that is not installed is
// refused with the list of what is, never silently served by another vendor.
//
// It is pinned because it was broken where it mattered most and nobody could
// see it. `dispatch.ts` resolved the session properly; `chain.ts` — the business
// director, and therefore every seat of every org chart — carried a literal
// `?? "claude-code"`. Measured on a client's machine (2026-09-11): working in
// Codex on Windows, their director ran on a Claude Code session they never use,
// died on its stale credential, and the maestro read that as "this business is
// unusable" and replaced the whole company with `agent-x`. Every run, every
// time, with the routing itself perfectly correct.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveRunRuntime, unavailableRuntimeMessage } from "../lib/runtime-rules.ts";
import { listRuntimes, type Runtime } from "../../_shared/lib/host-agent-driver.ts";

const only = (...installed: Runtime[]) => (r: Runtime) => installed.includes(r);

/** An environment with no session marker and no engine override, so each case
 *  declares exactly the one signal it is about. `bun test` runs inside a real
 *  agent session, so inheriting `process.env` would make every case answer
 *  "claude-code" and prove nothing. */
const bare: NodeJS.ProcessEnv = {};

describe("the default is the session the caller is in", () => {
  test.each([
    ["claude-code", { CLAUDECODE: "1" }],
    ["claude-code", { CLAUDE_CODE_SESSION_ID: "s1" }],
    ["codex", { CODEX_THREAD_ID: "t1" }],
    ["codex", { CODEX_SANDBOX: "1" }],
    ["gemini-cli", { GEMINI_SESSION_ID: "g1" }],
    ["antigravity-cli", { ANTIGRAVITY_SESSION_ID: "a1" }],
    ["kimi-cli", { KIMI_SESSION_ID: "k1" }],
    ["grok-cli", { GROK_SESSION_ID: "x1" }],
    ["pi", { PI_CODING_AGENT: "1" }],
  ] as Array<[Runtime, NodeJS.ProcessEnv]>)("a %s session runs the work in %s", (expected, env) => {
    const choice = resolveRunRuntime({ env, available: only("claude-code") });
    expect(choice.runtime).toBe(expected);
    expect(choice.hostDetected).toBe(expected);
    expect(choice.defaultFrom).toBe("host");
  });

  test("NIRVANA_HOST_RUNTIME is the explicit override of detection", () => {
    const choice = resolveRunRuntime({ env: { NIRVANA_HOST_RUNTIME: "codex" }, available: only("codex") });
    expect(choice.runtime).toBe("codex");
    expect(choice.defaultFrom).toBe("host");
  });

  test("no marker at all falls to what is INSTALLED, never to one vendor", () => {
    const choice = resolveRunRuntime({ env: bare, available: only("grok-cli", "pi") });
    // Roster order decides, not a hardcoded name: the point is that the choice
    // comes from what is on the machine, and claude-code is not on this one.
    expect(choice.installed).toEqual(listRuntimes().map((r) => r.name).filter(only("grok-cli", "pi")));
    expect(choice.runtime).toBe(choice.installed[0]);
    expect(choice.runtime).not.toBe("claude-code");
    expect(choice.defaultFrom).toBe("path-scan");
  });
});

describe("a runtime the caller named", () => {
  test("wins over the session, when it is installed", () => {
    const choice = resolveRunRuntime({
      explicit: "codex", env: { CLAUDECODE: "1" }, available: only("claude-code", "codex"),
    });
    expect(choice.runtime).toBe("codex");
    expect(choice.source).toBe("flag");
    expect(choice.unavailable).toBeUndefined();
  });

  test("is refused when it is not installed — the work is not moved to another vendor", () => {
    const choice = resolveRunRuntime({
      explicit: "codex", env: { CLAUDECODE: "1" }, available: only("claude-code"),
    });
    expect(choice.runtime).toBe("codex");     // the answer stays what they asked for
    expect(choice.unavailable).toBe(true);    // and it is marked, not substituted
    const msg = unavailableRuntimeMessage(choice);
    expect(msg).toContain("codex");
    expect(msg).toContain("claude-code");     // says what IS green
  });

  test("with nothing installed at all, the message still names the state honestly", () => {
    const choice = resolveRunRuntime({ explicit: "codex", env: bare, available: () => false });
    expect(choice.unavailable).toBe(true);
    expect(unavailableRuntimeMessage(choice)).toContain("none");
  });
});

describe("a runtime named in the brief is a weaker signal than a flag", () => {
  // Deliberate asymmetry, pinned so it stays a decision. A flag is machine
  // input and unambiguous: an uninstalled one is refused. A mention in prose
  // is a regex reading a sentence, and refusing a whole run because the parser
  // thought it saw a runtime name would turn a false positive into a blocked
  // brief. So the mention warns and the run proceeds on the session instead —
  // it is never served by the vendor that was named, because that one is not here.
  test("an installed runtime named in the brief still wins", () => {
    const choice = resolveRunRuntime({
      brief: "use o codex para gerar as imagens", env: { CLAUDECODE: "1" },
      available: only("claude-code", "codex"),
    });
    expect(choice.runtime).toBe("codex");
    expect(choice.source).toBe("brief");
  });

  test("an uninstalled one falls back to the session, warned, instead of blocking the run", () => {
    const choice = resolveRunRuntime({
      brief: "use o qwen para isso", env: { CLAUDECODE: "1" },
      available: only("claude-code"),
    });
    expect(choice.runtime).toBe("claude-code");
    expect(choice.source).not.toBe("brief");
    expect(choice.unavailable).toBeUndefined();
  });

  test("the same runtime as a FLAG is refused — that is the difference", () => {
    const choice = resolveRunRuntime({
      explicit: "qwen-code", env: { CLAUDECODE: "1" }, available: only("claude-code"),
    });
    expect(choice.unavailable).toBe(true);
  });
});

describe("the chain no longer carries a vendor literal", () => {
  const chain = fs.readFileSync(path.join(import.meta.dir, "..", "scripts", "chain.ts"), "utf8");

  test("chain.ts resolves the runtime instead of defaulting to one", () => {
    expect(chain).toContain("resolveRunRuntime");
    // The only surviving mention is the comment recording what the line was.
    const code = chain.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    expect(code.join("\n")).not.toContain('"claude-code"');
  });

  test("it refuses a named runtime that is not installed", () => {
    expect(chain).toContain("unavailableRuntimeMessage");
  });

  test("the plan records WHICH runtime decided, so a reader can tell", () => {
    expect(chain).toContain("runtime: runtimeChoice.runtime");
  });
});

describe("the sites that used to default to one vendor", () => {
  test("the brief proxy requires its caller to say which runtime", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "..", "lib", "brief-proxy.ts"), "utf8");
    expect(src).not.toContain('runtime: Runtime = "claude-code"');
    expect(src).not.toContain('rtArg || "claude-code"');
  });

  test("the supervisor resumes a runtime-less row on the session, not on a vendor", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "..", "scripts", "supervisor.ts"), "utf8");
    expect(src).not.toContain('|| "claude-code"');
    expect(src).toContain("recoveryRuntime()");
  });

  test("dispatch enriches the brief on the runtime it already decided", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "..", "scripts", "dispatch.ts"), "utf8");
    expect(src).toContain("proxyEnrichBrief(brief, slug, runtimeDecision.runtime");
    // `--exec` says WHETHER to execute; it never names a runtime.
    expect(src).not.toContain('normRuntime(runtime || "claude-code")');
  });
});

describe("one roster, derived — not copied", () => {
  // Three files carried their own list of runtimes and all three had stopped at
  // seven names while the driver grew to nine. A user whose `LLM_CASCADE` named
  // `qwen-code` or `opencode` had the entry filtered out without a word, and the
  // agentic router would not pick them either. The driver owns the list.
  test.each([
    ["../lib/cascade.ts", "VALID_RUNTIMES"],
    ["../lib/agentic-router.ts", "EXEC_RUNTIMES"],
    ["../lib/runtime-rules.ts", "EXEC_RUNTIMES"],
  ])("%s builds %s from listRuntimes()", (file, constant) => {
    const src = fs.readFileSync(path.join(import.meta.dir, file), "utf8");
    const line = src.split("\n").find((l) => l.includes(`const ${constant}`))!;
    expect(line).toContain("listRuntimes()");
    expect(line).not.toContain('"claude-code"');
  });

  test("a runtime the old copies omitted is eligible now", () => {
    const choice = resolveRunRuntime({ env: bare, available: only("qwen-code", "opencode") });
    expect(["qwen-code", "opencode"]).toContain(choice.runtime);
  });
});
