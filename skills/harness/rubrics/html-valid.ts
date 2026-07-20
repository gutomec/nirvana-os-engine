// html-valid.ts — validação HEURÍSTICA de HTML (offline, zero-dep: não há parser
// HTML instalado no engine). Checa não-vazio, balanceamento de tags não-void e
// presença de estrutura. É um smoke gate estrutural, não um validador W3C nem o
// gate VISUAL (que renderiza em browser — ver SKILL.md; ausente por ora).
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

export async function evaluate(args: { artifact: string; content: string; offline?: boolean }) {
  const { content } = args;
  if (!content || !content.trim()) {
    return { name: "html-valid", passed: false, score: 0, reasoning: "HTML vazio.", fix_list: ["Escreva conteúdo HTML."] };
  }

  // Ignora comentários e conteúdo de <script>/<style> (podem conter '<' que não são tags).
  const clean = content
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");

  const counts = new Map<string, number>();
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  let total = 0;
  while ((m = tagRe.exec(clean))) {
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    const selfClosed = m[3] === "/";
    if (VOID_TAGS.has(name) || selfClosed) continue;
    total++;
    counts.set(name, (counts.get(name) ?? 0) + (closing ? -1 : 1));
  }

  const fix_list: string[] = [];
  const unbalanced = [...counts.entries()].filter(([, n]) => n !== 0);
  for (const [name, n] of unbalanced) {
    fix_list.push(n > 0 ? `<${name}> aberto ${n}× sem fechar` : `</${name}> fechado ${-n}× a mais`);
  }
  const hasStructure = /<(html|body|div|section|main|article|p|h[1-6]|ul|ol|table|nav|header|footer)\b/i.test(clean);
  if (total > 0 && !hasStructure) fix_list.push("Sem elementos estruturais reconhecíveis (div/section/p/…).");

  const passed = total > 0 && unbalanced.length === 0 && hasStructure;
  const score = total === 0 ? 0 : Math.max(0, 1 - unbalanced.length * 0.25 - (hasStructure ? 0 : 0.25));
  return {
    name: "html-valid",
    passed,
    score: passed ? 1.0 : score,
    reasoning: total === 0
      ? "Nenhuma tag HTML encontrada."
      : unbalanced.length === 0
        ? `HTML estruturalmente bem-formado (${total} tags balanceadas).`
        : `${unbalanced.length} tag(s) desbalanceada(s) de ${total}.`,
    fix_list,
  };
}
