// runtime-rules.test.ts — parser + resolver + precedência das regras USE_*.
// Roda com: bun test skills/harness/tests
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRuntimeRules,
  resolveRuntimeByRules,
  matchedVetoes,
  decideRuntime,
  detectCurrentHost,
  detectRuntimeMention,
  formatRulesForRouterPrompt,
  formatRulesForDirective,
  type RuntimeRule,
} from "../lib/runtime-rules.ts";

const RULES: RuntimeRule[] = [
  { runtime: "codex", rule: "Quando precisar gerar imagens ou refinar visuais", envKey: "USE_CODEX", sourceFile: null, negate: false },
  { runtime: "antigravity-cli", rule: "Quando for fazer deep research na internet", envKey: "USE_ANTIGRAVITY", sourceFile: null, negate: false },
  { runtime: "gemini-cli", rule: "Quando o contexto for gigante, um milhão de tokens", envKey: "USE_GEMINI", sourceFile: null, negate: false },
  { runtime: "hermes", rule: "Quando precisar interagir com o usuário via mensageria", envKey: "USE_HERMES", sourceFile: null, negate: false },
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

describe("vetos NOT_USE_* (regras negativas)", () => {
  // Caso do cliente: contexto gigante atrai o gemini, MAS análise de codebase o veta.
  const WITH_VETO: RuntimeRule[] = [
    ...RULES,
    { runtime: "gemini-cli", rule: "Quando for análise de codebase", envKey: "NOT_USE_GEMINI", sourceFile: null, negate: true },
  ];

  test("parser lê NOT_USE_* com negate=true e aliases", () => {
    const root = mkdtempSync(join(tmpdir(), "rr-"));
    writeFileSync(join(root, ".env"), [
      'USE_GEMINI="Quando o contexto for gigante"',
      'NOT_USE_GEMINI="Quando for análise de codebase"',
      'NOT_USE_AGY="Quando envolver dados sensíveis do cliente"',
    ].join("\n"));
    const rules = loadRuntimeRules(root, {});
    const byKey = Object.fromEntries(rules.map(r => [r.envKey, r]));
    expect(byKey.USE_GEMINI.negate).toBe(false);
    expect(byKey.NOT_USE_GEMINI.negate).toBe(true);
    expect(byKey.NOT_USE_GEMINI.runtime).toBe("gemini-cli");
    expect(byKey.NOT_USE_AGY.negate).toBe(true);
    expect(byKey.NOT_USE_AGY.runtime).toBe("antigravity-cli");
  });

  test("matchedVetoes casa o brief contra as negativas", () => {
    const v = matchedVetoes("faça a análise de codebase do repositório", WITH_VETO);
    expect(v.length).toBe(1);
    expect(v[0].rule.envKey).toBe("NOT_USE_GEMINI");
  });

  test("VETO VENCE regra positiva: brief casa com as duas → não usa gemini", () => {
    const d = decideRuntime({
      brief: "análise de codebase gigante, um milhão de tokens de contexto",
      explicitRuntime: null, defaultRuntime: "claude-code",
      rules: WITH_VETO, mode: "fast", available: () => true,
    });
    expect(d.runtime).not.toBe("gemini-cli");
    expect(d.vetoes?.some(v => v.envKey === "NOT_USE_GEMINI")).toBe(true);
  });

  test("veto vale para o DEFAULT: default vetado → próximo disponível", () => {
    const rules: RuntimeRule[] = [
      { runtime: "claude-code", rule: "Quando for análise de codebase", envKey: "NOT_USE_CLAUDE", sourceFile: null, negate: true },
    ];
    const d = decideRuntime({
      brief: "análise de codebase do repositório",
      explicitRuntime: null, defaultRuntime: "claude-code",
      rules, mode: "fast", available: () => true,
    });
    expect(d.runtime).not.toBe("claude-code");
    expect(d.source).toBe("default");
  });

  test("TUDO vetado → ignora vetos com aviso, nunca brica", () => {
    const rules: RuntimeRule[] = (["claude-code", "codex", "gemini-cli", "antigravity-cli", "kimi-cli", "grok-cli"] as const)
      .map((rt, i) => ({ runtime: rt, rule: "Quando for análise de codebase", envKey: `NOT_USE_X${i}`, sourceFile: null, negate: true }));
    // envKeys sintéticos: força TODOS os runtimes exec vetados
    rules.forEach((r, i) => (r.envKey = ["NOT_USE_CLAUDE", "NOT_USE_CODEX", "NOT_USE_GEMINI", "NOT_USE_AGY", "NOT_USE_KIMI", "NOT_USE_GROK"][i]));
    const d = decideRuntime({
      brief: "análise de codebase do repositório",
      explicitRuntime: null, defaultRuntime: "claude-code",
      rules, mode: "fast", available: () => true,
    });
    expect(d.runtime).toBe("claude-code"); // segue no default mesmo vetado
  });

  test("flag explícita vence até o veto", () => {
    const d = decideRuntime({
      brief: "análise de codebase",
      explicitRuntime: "gemini-cli", defaultRuntime: "claude-code",
      rules: WITH_VETO, mode: "fast", available: () => true,
    });
    expect(d.runtime).toBe("gemini-cli");
    expect(d.source).toBe("flag");
  });

  test("formatadores incluem os vetos como NUNCA", () => {
    expect(formatRulesForRouterPrompt(WITH_VETO)).toContain("NUNCA use gemini-cli");
    expect(formatRulesForDirective(WITH_VETO)).toContain("NUNCA use gemini-cli");
  });
});

describe("menção de runtime no brief (detectRuntimeMention)", () => {
  test("caso do dono: 'Use o agy para pesquisar...' → antigravity", () => {
    const m = detectRuntimeMention("Use o agy para pesquisar na internet sobre candidatos a presidência do Brasil");
    expect(m?.runtime).toBe("antigravity-cli");
  });
  test("variações PT/EN de cue", () => {
    expect(detectRuntimeMention("faça o site usando o codex")?.runtime).toBe("codex");
    expect(detectRuntimeMention("rode pelo gemini a análise")?.runtime).toBe("gemini-cli");
    expect(detectRuntimeMention("build this with claude code")?.runtime).toBe("claude-code");
    expect(detectRuntimeMention("despache via antigravity cli")?.runtime).toBe("antigravity-cli");
  });
  test("CONTEÚDO não é instrução: brief sobre Hermes/Gemini sem cue instrumental", () => {
    expect(detectRuntimeMention("escreva um artigo sobre a estátua de Hermes na mitologia")).toBeNull();
    expect(detectRuntimeMention("horóscopo do signo de gêmeos")).toBeNull();
  });
  test("dois runtimes citados → ambíguo → null", () => {
    expect(detectRuntimeMention("use o codex ou use o gemini, tanto faz")).toBeNull();
  });
  test("menção VENCE regra e veto; perde para flag", () => {
    const withVeto: RuntimeRule[] = [
      { runtime: "codex", rule: "Quando precisar gerar imagens", envKey: "USE_CODEX", sourceFile: null, negate: false },
      { runtime: "antigravity-cli", rule: "pesquisar na internet", envKey: "NOT_USE_AGY", sourceFile: null, negate: true },
    ];
    // brief pede agy explicitamente, mesmo com NOT_USE_AGY casando → menção vence
    const d = decideRuntime({ brief: "Use o agy para pesquisar na internet sobre eleições", explicitRuntime: null, defaultRuntime: "claude-code", rules: withVeto, mode: "fast", available: () => true });
    expect(d.runtime).toBe("antigravity-cli");
    expect(d.source).toBe("brief");
    // flag ainda é mais forte
    const df = decideRuntime({ brief: "Use o agy para pesquisar na internet", explicitRuntime: "claude-code", defaultRuntime: "claude-code", rules: withVeto, mode: "fast", available: () => true });
    expect(df.source).toBe("flag");
  });
  test("runtime citado indisponível → cai nas regras/default", () => {
    const d = decideRuntime({ brief: "Use o agy para pesquisar na internet", explicitRuntime: null, defaultRuntime: "claude-code", rules: RULES, mode: "fast", available: (r) => r === "claude-code" });
    expect(d.runtime).toBe("claude-code");
  });
  test("hermes citado no brief → não vira exec (segue fluxo normal)", () => {
    const d = decideRuntime({ brief: "use o hermes para avisar o cliente", explicitRuntime: null, defaultRuntime: "claude-code", rules: [], mode: "fast", available: () => true });
    expect(d.runtime).toBe("claude-code");
    expect(d.source).toBe("default");
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
