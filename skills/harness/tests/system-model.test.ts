// system-model.test.ts — resolvedor do model do sistema + saneamento.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEffortLevel, resolvePinnedEffort, resolveSystemModel, sanitizeModelId, toAlias } from "../../_shared/lib/system-model.ts";

describe("toAlias (sempre o alias para família Claude)", () => {
  test("ids completos → alias", () => {
    expect(toAlias("claude-fable-5")).toBe("fable");
    expect(toAlias("claude-opus-4-8")).toBe("opus");
    expect(toAlias("claude-sonnet-5")).toBe("sonnet");
    expect(toAlias("claude-haiku-4-5-20251001")).toBe("haiku");
  });
  test("aliases passam intactos", () => {
    expect(toAlias("opus")).toBe("opus");
    expect(toAlias("fable")).toBe("fable");
  });
  test("models não-Claude passam intactos", () => {
    expect(toAlias("gpt-5.3-codex")).toBe("gpt-5.3-codex");
    expect(toAlias("gemini-3-pro")).toBe("gemini-3-pro");
  });
});

describe("sanitizeModelId", () => {
  test("caso REAL do usuário: corrupção ANSI '[1m]' vazada pelo /model", () => {
    expect(sanitizeModelId("claude-fable-5[1m]")).toBe("claude-fable-5");
  });
  test("escape ANSI real (ESC [1m)", () => {
    expect(sanitizeModelId("\x1b[1mclaude-opus-4-8\x1b[22m")).toBe("claude-opus-4-8");
  });
  test("ids limpos passam intactos", () => {
    expect(sanitizeModelId("claude-fable-5")).toBe("claude-fable-5");
    expect(sanitizeModelId("opus")).toBe("opus");
    expect(sanitizeModelId("gpt-5.3-codex")).toBe("gpt-5.3-codex");
  });
  test("vazio/nulo → string vazia", () => {
    expect(sanitizeModelId("")).toBe("");
    expect(sanitizeModelId(null)).toBe("");
    expect(sanitizeModelId(undefined)).toBe("");
  });
});

describe("resolveSystemModel — nothing unless the user pinned it", () => {
  // Owner doctrine (2026-09-12): "Nenhum modelo ou effort deve ser especificado
  // por padrão. O padrão é sempre o que está por padrão no sistema do usuário."
  // So null is the normal answer and null means "pass no --model".
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.NIRVANA_MODEL;
    delete process.env.NIRVANA_EFFORT;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.CLAUDE_CONFIG_DIR;
  });
  afterEach(() => { process.env = { ...saved }; });

  test("no pin: every runtime gets nothing, so every CLI keeps its own default", () => {
    for (const rt of ["claude-code", "codex", "gemini-cli", "antigravity-cli", "kimi-cli", "grok-cli", "pi", "qwen-code", "opencode"]) {
      expect(resolveSystemModel(rt), `${rt} was given a model nobody asked for`).toBeNull();
    }
  });

  test("a VENDOR env var is not a pin — this is the leak that made it into nine CLIs", () => {
    // ANTHROPIC_MODEL is set on many machines and has nothing to do with
    // Nirvana. Measured before this cut: with it exported, the resolver
    // answered `opus` for all nine runtimes, so the driver ran
    // `gemini --model opus`, `pi --model opus`, `qwen --model opus` — ids those
    // vendors do not have.
    process.env.ANTHROPIC_MODEL = "claude-opus-5";
    expect(resolveSystemModel("claude-code")).toBeNull();
    expect(resolveSystemModel("gemini-cli")).toBeNull();
    expect(resolveSystemModel("pi")).toBeNull();
  });

  test("the user's own claude settings are not a pin either — claude reads that file itself", () => {
    const cfg = mkdtempSync(join(tmpdir(), "cc-"));
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ model: "claude-fable-5" }));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    expect(resolveSystemModel("claude-code")).toBeNull();
  });

  test("NIRVANA_MODEL IS a pin: the user set it for this engine, on purpose", () => {
    process.env.NIRVANA_MODEL = "claude-opus-4-8";
    expect(resolveSystemModel("claude-code")).toBe("opus");   // still aliased
  });

  test("a pin applies to whatever runtime is dispatched — the adapter guards the mismatch", () => {
    // Not silently rewritten: the codex adapter drops a non-OpenAI id and the
    // Orca worker does the same, so a Claude alias pinned while dispatching
    // codex never reaches `-m opus`.
    process.env.NIRVANA_MODEL = "opus";
    expect(resolveSystemModel("codex")).toBe("opus");
  });

  test("ANSI corruption in a pin is still sanitised (the /model '[1m]' case)", () => {
    process.env.NIRVANA_MODEL = "claude-fable-5[1m]";
    expect(resolveSystemModel("claude-code")).toBe("fable");
  });
});

describe("resolvePinnedEffort — same contract as the model", () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.NIRVANA_EFFORT; });
  afterEach(() => { process.env = { ...saved }; });

  test("unset is null, so a dispatch passes no effort at all", () => {
    // Measured on the owner's machine: ~/.codex/config.toml carries
    // `model_reasoning_effort = "xhigh"`. Passing nothing is what lets that
    // value stand; passing a guess is what overwrites it.
    expect(resolvePinnedEffort()).toBeNull();
  });

  test("a level the user pinned comes back, normalised", () => {
    process.env.NIRVANA_EFFORT = "  XHIGH ";
    expect(resolvePinnedEffort()).toBe("xhigh");
  });

  test("every level the CLIs accept is accepted here", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      process.env.NIRVANA_EFFORT = level;
      expect(resolvePinnedEffort()).toBe(level);
      expect(isEffortLevel(level)).toBe(true);
    }
  });

  test("a value that is not a level is refused, not forwarded", () => {
    process.env.NIRVANA_EFFORT = "altissimo";
    expect(resolvePinnedEffort()).toBeNull();
    expect(isEffortLevel("altissimo")).toBe(false);
  });
});
