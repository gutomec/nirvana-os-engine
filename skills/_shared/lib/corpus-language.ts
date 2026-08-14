/**
 * How many languages does this library speak, and which entities still speak the
 * minority one?
 *
 * This exists because of a measurement, not a hunch. The agentic router — the
 * default — reads the digest and reasons, so it does not care what language an
 * entity is declared in. `fast` mode is BM25, which matches tokens: a brief and
 * an entity written in different languages share none and never meet. On this
 * library, 20 held-out paraphrase pairs reached the same destination in
 * Portuguese and English 25% of the time.
 *
 * So the fix for `fast` is one language across the corpus, and getting there is
 * gradual work. That needs two things this module provides: a number that says
 * how far along it is, and a queue that says what to do next.
 *
 * The classifier is a stopword vote, deliberately crude. It only has to separate
 * two halves that are genuinely far apart, and a wrong call on a handful of
 * entities moves a percentage point rather than a decision.
 */
export const PT_MARKERS = /\b(para|com|uma|dos|das|não|criar|fazer|sobre|meu|minha|nossa|nosso|que|quero|preciso|empresa|conteúdo|vendas|entrega|cliente|também|já|até|pelo|pela)\b/gi;
export const EN_MARKERS = /\b(the|for|with|and|create|build|make|write|our|my|need|want|about|from|into|report|content|sales|delivery|client|also|already|until|through)\b/gi;

export type Lang = "pt" | "en" | "undetermined";

export function classify(text: string): Lang {
  const pt = (text.match(PT_MARKERS) || []).length;
  const en = (text.match(EN_MARKERS) || []).length;
  if (pt === en) return "undetermined";
  return pt > en ? "pt" : "en";
}

export interface EntityLanguage {
  slug: string;
  kind: "squad" | "business";
  lang: Lang;
  /** Characters of routing-relevant text weighed, for ordering the queue. */
  weight: number;
}

export interface CorpusMix {
  entities: number;
  enPct: number;
  ptPct: number;
  /** The smaller of the two — how much of the corpus is on the wrong side. */
  minorityPct: number;
  /** Entities not yet in English, heaviest first: the translation queue. */
  queue: EntityLanguage[];
}

/**
 * The text that decides routing: description, domains, keywords, example_briefs.
 * Deliberately NOT the whole manifest — a squad's task files can stay in any
 * language, because BM25 never sees them.
 */
function routingText(entry: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const k of ["description", "name"]) {
    const v = entry[k];
    if (typeof v === "string") parts.push(v);
  }
  for (const k of ["domains", "keywords", "example_briefs", "produces"]) {
    const v = entry[k];
    if (Array.isArray(v)) parts.push(v.filter((x) => typeof x === "string").join(" "));
  }
  return parts.join(" ");
}

export function corpusMix(registries: Record<string, any>): CorpusMix | null {
  const byEntity = new Map<string, { kind: "squad" | "business"; text: string }>();

  for (const list of Object.values(registries?.squads?.capabilities ?? {})) {
    for (const cap of (Array.isArray(list) ? list : []) as Array<Record<string, unknown>>) {
      const slug = (cap.squad ?? cap.business) as string | undefined;
      if (!slug) continue;
      const prev = byEntity.get(slug);
      const text = routingText(cap);
      byEntity.set(slug, { kind: cap.squad ? "squad" : "business", text: prev ? `${prev.text} ${text}` : text });
    }
  }
  for (const [slug, b] of Object.entries(registries?.businesses?.businesses ?? {})) {
    const text = routingText(b as Record<string, unknown>);
    const prev = byEntity.get(slug);
    byEntity.set(slug, { kind: "business", text: prev ? `${prev.text} ${text}` : text });
  }
  if (byEntity.size === 0) return null;

  const entities: EntityLanguage[] = [];
  for (const [slug, { kind, text }] of byEntity) {
    entities.push({ slug, kind, lang: classify(text), weight: text.length });
  }
  const en = entities.filter((e) => e.lang === "en").length;
  const pt = entities.filter((e) => e.lang === "pt").length;
  const total = entities.length;
  const enPct = Math.round((100 * en) / total);
  const ptPct = Math.round((100 * pt) / total);

  return {
    entities: total,
    enPct,
    ptPct,
    minorityPct: Math.min(enPct, ptPct),
    // English is the destination, so the queue is whatever is not there yet —
    // not "the smaller side". Heaviest first: translating a squad with 40
    // example_briefs moves the number further than one with a single line, for
    // the same effort of opening the file.
    queue: entities.filter((e) => e.lang === "pt").sort((a, b) => b.weight - a.weight),
  };
}
