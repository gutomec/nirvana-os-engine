// html-valid.ts — HEURISTIC HTML validation (offline, zero-dep: there is no HTML
// parser installed in the engine). Checks non-emptiness, balancing of non-void tags
// and presence of structure. It is a structural smoke gate, not a W3C validator nor
// the VISUAL gate (which renders in a browser — see SKILL.md; absent for now).
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

export async function evaluate(args: { artifact: string; content: string; offline?: boolean }) {
  const { content } = args;
  if (!content || !content.trim()) {
    return { name: "html-valid", passed: false, score: 0, reasoning: "HTML vazio.", fix_list: ["Escreva conteúdo HTML."] };
  }

  // Ignore comments and <script>/<style> content (they may contain '<' that are not tags).
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
