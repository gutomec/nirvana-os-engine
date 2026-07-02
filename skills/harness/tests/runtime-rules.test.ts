// runtime-rules.test.ts — parser + resolver + precedência das regras USE_*.
// Roda com: bun test skills/harness/tests
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRuntimeRules,
  resolveRuntimeByRules,
  decideRuntime,
  detectCurrentHost,
  formatRulesForRouterPrompt,
  formatRulesForDirective,
  type RuntimeRule,
} from "../lib/runtime-rules.ts";

const RULES: RuntimeRule[] = [
  { runtime: "codex", rule: "Quando precisar gerar imagens ou refinar visuais", envKey: "USE_CODEX", sourceFile: null },
  { runtime: "antigravity-cli", rule: "Quando for fazer deep research na internet", envKey: "USE_ANTIGRAVITY", sourceFile: null },
  { runtime: "gemini-cli", rule: "Quando o contexto for gigante, um milhão de tokens", envKey: "USE_GEMINI", sourceFile: null },
  { runtime: "hermes", rule: "Quando precisar interagir com o usuário via mensageria", envKey: "USE_HERMES", sourceFile: null },
];

describe("loadRuntimeRules (parser + cadeia de .env)", () => {
  test("lê USE_* do .env do projeto, com aliases e aspas", () => {
    const root = mkdtempSync(join(tmpdir(), "rr-"));
    writeFileSync(join(root, ".env"), [
      'USE_CODEX="Quando precisar gerar imagens"',
      "USE_AGY='Deep research na internet'",
      "USE_GEMINI_CLI=Contexto gigante",
      'USE_FOO="runtime que não existe"',
      'USE_HERMES=""',
    ].join("\n"));
    const rules = loadRuntimeRules(root, {});
    const byKey = Object.fromEntries(rules.map(r => [r.envKey, r]));
    expect(byKey.USE_CODEX.runtime).toBe("codex");
    expect(byKey.USE_CODEX.rule).toBe("Quando precisar gerar imagens");
    expect(byKey.USE_AGY.runtime).toBe("antigravity-cli");
    expect(byKey.USE_GEMINI_CLI.runtime).toBe("gemini-cli");
    expect(byKey.USE_FOO).toBeUndefined();      // desconhecido → warn, ignora
    expect(byKey.USE_HERMES).toBeUndefined();   // valor vazio → ignora
  });

  test("projeto sobrepõe global; process.env é último recurso", () => {
    const root = mkdtempSync(join(tmpdir(), "rr-"));
    writeFileSync(join(root, ".env"), 'USE_CODEX="regra do projeto"');
    const rules = loadRuntimeRules(root, { USE_CODEX: "regra do process.env", USE_GEMINI: "só no env" });
    const byKey = Object.fromEntries(rules.map(r => [r.envKey, r]));
    expect(byKey.USE_CODEX.rule).toBe("regra do projeto");
    expect(byKey.USE_GEMINI.rule).toBe("só no env");
    expect(byKey.USE_GEMINI.sourceFile).toBeNull();
  });
});

describe("resolveRuntimeByRules (BM25, modo fast)", () => {
  test("brief de imagem → codex", () => {
    const hit = resolveRuntimeByRules("gere as imagens do hero da landing page", RULES);
    expect(hit?.rule.runtime).toBe("codex");
  });
  test("brief de research → antigravity", () => {
    const hit = resolveRuntimeByRules("faça um deep research na internet sobre o mercado", RULES);
    expect(hit?.rule.runtime).toBe("antigravity-cli");
  });
  test("brief de contexto gigante → gemini", () => {
    const hit = resolveRuntimeByRules("analise este repositório gigante, um milhão de tokens de contexto", RULES);
    expect(hit?.rule.runtime).toBe("gemini-cli");
  });
  test("sem match → null", () => {
    const hit = resolveRuntimeByRules("escreva um poema sobre montanhas", RULES);
    expect(hit).toBeNull();
  });
  test("sem regras ou brief vazio → null", () => {
    expect(resolveRuntimeByRules("qualquer brief", [])).toBeNull();
    expect(resolveRuntimeByRules("", RULES)).toBeNull();
  });
  test("hermes vencedor em fast → degrada para o próximo ou null", () => {
    const hit = resolveRuntimeByRules("preciso interagir com o usuário via mensageria", RULES);
    expect(hit === null || hit.rule.runtime !== "hermes").toBe(true);
  });
});

describe("decideRuntime (precedência)", () => {
  test("flag explícita SEMPRE vence regra", () => {
    const d = decideRuntime({ brief: "gere as imagens do hero", explicitRuntime: "claude-code", defaultRuntime: "claude-code", rules: RULES, mode: "fast" });
    expect(d.source).toBe("flag");
    expect(d.runtime).toBe("claude-code");
  });
  test("regra vence default", () => {
    const d = decideRuntime({ brief: "gere as imagens do hero", explicitRuntime: null, defaultRuntime: "claude-code", rules: RULES, mode: "fast" });
    expect(d.source).toBe("rule");
    expect(d.runtime).toBe("codex");
    expect(d.method).toBe("bm25");
  });
  test("sem match → default (o runtime que o usuário está usando)", () => {
    const d = decideRuntime({ brief: "escreva um poema", explicitRuntime: null, defaultRuntime: "gemini-cli", rules: RULES, mode: "fast" });
    expect(d.source).toBe("default");
    expect(d.runtime).toBe("gemini-cli");
  });
  test("runtime da regra indisponível → próximo do ranking → default", () => {
    const d = decideRuntime({
      brief: "gere as imagens do hero", explicitRuntime: null, defaultRuntime: "claude-code",
      rules: RULES, mode: "fast", available: (r) => r !== "codex",
    });
    expect(d.runtime).not.toBe("codex");
  });
});

describe("detectCurrentHost", () => {
  test("marcadores de sessão de cada CLI", () => {
    expect(detectCurrentHost({ CLAUDECODE: "1" })).toBe("claude-code");
    expect(detectCurrentHost({ CODEX_SANDBOX: "seatbelt" })).toBe("codex");
    expect(detectCurrentHost({ GEMINI_SESSION_ID: "x" })).toBe("gemini-cli");
    expect(detectCurrentHost({})).toBeNull();
  });
  test("NIRVANA_HOST_RUNTIME é override explícito", () => {
    expect(detectCurrentHost({ NIRVANA_HOST_RUNTIME: "codex", CLAUDECODE: "1" })).toBe("codex");
  });
});

describe("formatadores de prompt", () => {
  test("router prompt inclui as regras verbatim e o contrato do campo runtime", () => {
    const s = formatRulesForRouterPrompt(RULES);
    expect(s).toContain("USE_CODEX");
    expect(s).toContain("Quando precisar gerar imagens ou refinar visuais");
    expect(s).toContain('"runtime"');
    expect(s).toContain("hermes NUNCA");
  });
  test("directive inclui delegação hermes -z e --exec por runtime", () => {
    const s = formatRulesForDirective(RULES);
    expect(s).toContain("--exec=codex");
    expect(s).toContain("hermes -z");
  });
  test("vazio → string vazia", () => {
    expect(formatRulesForRouterPrompt([])).toBe("");
    expect(formatRulesForDirective([])).toBe("");
  });
});
