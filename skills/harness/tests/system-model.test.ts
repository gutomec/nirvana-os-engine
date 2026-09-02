// system-model.test.ts — resolvedor do model do sistema + saneamento.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeModelId, resolveSystemModel, selectRuntimeModel, toAlias } from "../../_shared/lib/system-model.ts";

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
  test("provider-qualified ids and runtime model suffixes stay intact", () => {
    expect(sanitizeModelId("openrouter/z-ai/glm-4.7")).toBe("openrouter/z-ai/glm-4.7");
    expect(sanitizeModelId("provider/model:high")).toBe("provider/model:high");
  });
  test("vazio/nulo → string vazia", () => {
    expect(sanitizeModelId("")).toBe("");
    expect(sanitizeModelId(null)).toBe("");
    expect(sanitizeModelId(undefined)).toBe("");
  });
});

describe("explicit runtime model selections", () => {
  test("native provider hints do not bypass known family mismatches", () => {
    expect(selectRuntimeModel("codex", "fable-5", "explicit", "openai").fallback).toBe(true);
  });
  test("qualified models still receive family validation", () => {
    expect(selectRuntimeModel("codex", "anthropic/claude-sonnet-4-6").fallback).toBe(true);
  });
  test("OpenCode does not replace its local default with an unqualified model", () => {
    expect(selectRuntimeModel("opencode", "fable-5", "setting")).toMatchObject({
      effectiveModel: null, fallback: true, reason: "incompatible_model_format",
    });
  });
  test("configured multi-provider runtimes accept non-native families", () => {
    expect(selectRuntimeModel("kimi-cli", "gpt-5.5").effectiveModel).toBe("gpt-5.5");
  });
  test("keeps compatible full ids and multi-provider model families unchanged", () => {
    expect(selectRuntimeModel("claude-code", "claude-opus-4-7").effectiveModel).toBe("claude-opus-4-7");
    expect(selectRuntimeModel("pi", "claude-opus-4-7").effectiveModel).toBe("claude-opus-4-7");
    expect(selectRuntimeModel("pi", "glm-4.7").effectiveModel).toBe("glm-4.7");
  });
});

describe("resolveSystemModel", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.NIRVANA_MODEL;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "codex-model-"));
  });
  afterEach(() => { process.env = { ...saved }; });

  test("a configured custom Codex provider keeps its model without a provider hint", () => {
    writeFileSync(join(process.env.CODEX_HOME!, "config.toml"), 'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://example.invalid/v1"\n');
    process.env.NIRVANA_MODEL = "glm-4.7";
    expect(resolveSystemModel("codex")).toBe("glm-4.7");
  });

  test("Codex provider config works without the newer TOML API and refreshes changes", () => {
    const savedToml = Bun.TOML;
    const configPath = join(process.env.CODEX_HOME!, "config.toml");
    process.env.NIRVANA_MODEL = "glm-4.7";
    try {
      Object.assign(Bun, { TOML: undefined });
      writeFileSync(configPath, 'model_provider = "custom"\n');
      expect(resolveSystemModel("codex")).toBe("glm-4.7");
      writeFileSync(configPath, 'model_provider = "openai"\n');
      expect(resolveSystemModel("codex")).toBeNull();
    } finally { Object.assign(Bun, { TOML: savedToml }); }
  });

  test("Claude custom endpoints preserve an explicit non-native model", () => {
    process.env.ANTHROPIC_BASE_URL = "https://router.huggingface.co";
    expect(selectRuntimeModel("claude-code", "zai-org/GLM-5.1").effectiveModel).toBe("zai-org/GLM-5.1");
    delete process.env.ANTHROPIC_BASE_URL;
    const cfg = mkdtempSync(join(tmpdir(), "claude-provider-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://router.huggingface.co" } }));
    expect(selectRuntimeModel("claude-code", "zai-org/GLM-5.1").effectiveModel).toBe("zai-org/GLM-5.1");
  });

  test("NIRVANA_MODEL tem prioridade máxima (aliasado)", () => {
    process.env.NIRVANA_MODEL = "claude-opus-4-8";
    process.env.ANTHROPIC_MODEL = "haiku";
    expect(resolveSystemModel("claude-code")).toBe("opus");
  });
  test("ANTHROPIC_MODEL quando não há NIRVANA_MODEL", () => {
    process.env.ANTHROPIC_MODEL = "sonnet";
    expect(resolveSystemModel("claude-code")).toBe("sonnet");
  });
  test("settings.json 'model' saneado E aliasado (o caminho do bug do usuário)", () => {
    const cfg = mkdtempSync(join(tmpdir(), "cc-"));
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ model: "claude-fable-5[1m]" }));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    // corrupção "[1m]" saneada → "claude-fable-5" → alias "fable"
    expect(resolveSystemModel("claude-code")).toBe("fable");
  });
  test("id completo no settings → alias (sempre o alias)", () => {
    const cfg = mkdtempSync(join(tmpdir(), "cc-"));
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ model: "claude-opus-4-8" }));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    expect(resolveSystemModel("claude-code")).toBe("opus");
  });
  test("settings.json só vale para claude-code; codex/gemini → null sem env", () => {
    const cfg = mkdtempSync(join(tmpdir(), "cc-"));
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ model: "claude-fable-5" }));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    expect(resolveSystemModel("codex")).toBeNull();
    expect(resolveSystemModel("gemini-cli")).toBeNull();
  });
  test("a model configured for Claude falls back to the active Codex default", () => {
    process.env.NIRVANA_MODEL = "fable-5";
    expect(resolveSystemModel("codex")).toBeNull();
  });
  test("compatible configured models stay attached to their active runtime", () => {
    const cases = [
      ["codex", "gpt-5.5"],
      ["gemini-cli", "gemini-3-pro"],
      ["grok-cli", "grok-4"],
      ["kimi-cli", "kimi-k2.5"],
      ["qwen-code", "qwen3-coder"],
    ] as const;
    for (const [runtime, model] of cases) {
      process.env.NIRVANA_MODEL = model;
      expect(resolveSystemModel(runtime)).toBe(model);
    }
  });
  test("known cross-provider models fall back without blocking unknown future families", () => {
    process.env.NIRVANA_MODEL = "glm-4.7";
    expect(resolveSystemModel("codex")).toBeNull();
    process.env.NIRVANA_MODEL = "future-provider-model-v1";
    expect(resolveSystemModel("codex")).toBe("future-provider-model-v1");
  });
  test("sem env e sem settings → null (não força model, comportamento inalterado)", () => {
    const cfg = mkdtempSync(join(tmpdir(), "cc-empty-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    expect(resolveSystemModel("claude-code")).toBeNull();
  });
});
