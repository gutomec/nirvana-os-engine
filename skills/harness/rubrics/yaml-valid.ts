// yaml-valid.ts — valida que o YAML é parseável e tem conteúdo estruturado.
// Usa a lib `yaml` (v2) já presente no engine (cf. lib/budget.js).
import { parse } from "yaml";

export async function evaluate(args: { artifact: string; content: string; offline?: boolean }) {
  const { content } = args;
  if (!content || !content.trim()) {
    return { name: "yaml-valid", passed: false, score: 0, reasoning: "YAML vazio.", fix_list: ["Escreva conteúdo YAML."] };
  }
  try {
    const parsed = parse(content);
    const isStruct = parsed !== null && typeof parsed === "object";
    const count = Array.isArray(parsed) ? parsed.length : (isStruct ? Object.keys(parsed).length : 0);
    const passed = isStruct && count > 0;
    return {
      name: "yaml-valid",
      passed,
      score: passed ? 1.0 : 0.5,
      reasoning: passed
        ? `YAML válido com ${count} ${Array.isArray(parsed) ? "itens" : "chaves"} no topo.`
        : "YAML parseável mas a raiz é escalar ou vazia.",
      fix_list: passed ? [] : ["A raiz deveria ser um mapa ou lista com conteúdo."],
    };
  } catch (e: any) {
    return {
      name: "yaml-valid",
      passed: false,
      score: 0,
      reasoning: `Erro de parse YAML: ${e.message}`,
      fix_list: [`Corrija a sintaxe YAML: ${String(e.message).slice(0, 100)}`],
    };
  }
}
