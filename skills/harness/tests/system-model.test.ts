// system-model.test.ts — resolvedor do model do sistema + saneamento.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeModelId, resolveSystemModel, toAlias } from "../../_shared/lib/system-model.ts";

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

describe("resolveSystemModel", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.NIRVANA_MODEL;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.CLAUDE_CONFIG_DIR;
  });
  afterEach(() => { process.env = { ...saved }; });

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
  test("mas NIRVANA_MODEL vale para qualquer runtime", () => {
    process.env.NIRVANA_MODEL = "opus";
    expect(resolveSystemModel("codex")).toBe("opus");
  });
  test("sem env e sem settings → null (não força model, comportamento inalterado)", () => {
    const cfg = mkdtempSync(join(tmpdir(), "cc-empty-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    expect(resolveSystemModel("claude-code")).toBeNull();
  });
});
