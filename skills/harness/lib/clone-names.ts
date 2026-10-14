// clone-names.ts — who a request names, in the words people actually use.
//
// The clone library is keyed by slug, and a request names a person (the quoted
// requests are user input, i18n-user-facing): "com a voz
// do Yoshua Bengio", "estilo Hormozi", "como o Naval pensaria", "à moda do
// Godin", "tipo MKBHD". A substring test over the display name recognised 22
// of 43 such phrasings (measured 2026-10-13), and every miss fell through to
// the lexical search, which then offered somebody else without a word.
//
// The rules, from the strongest evidence to the weakest:
//   1. A slug written as such (`clone alex-hormozi`, `alex-hormozi`) is that clone.
//   2. A full name (display name without its role or nickname, or the name the
//      slug spells) is that person, anywhere in the text: accents, case and
//      middle initials do not matter, word boundaries do.
//   3. A nickname the display name carries in parentheses ("(CZ)", "(MKBHD)",
//      "(Chivo)") is that person; a nickname of three letters or fewer only
//      after a voice cue, and only as written (upper case stays upper case).
//   4. A surname or a first name alone is that person only after a voice cue
//      ("estilo", "como o", "à moda do", "na linha do", "segundo", "tipo",
//      "in the style of"...), only when exactly one person in the library
//      carries it, and a first name only when no capitalised word follows it
//      ("Simon Sinek" is not Simon Carless).
//   5. A surname two people share is reported as ambiguous, never guessed.
//   6. A capitalised name after an explicit voice cue ("na voz do X", "in the
//      voice of X") that matches nobody is reported as missing.
//
// One person, one voice: 43 people carry two or three slugs (a role variant
// each). They are grouped by person, and a person resolves to one slug.

export interface CloneName { slug: string; name: string }

export interface Person {
  key: string;
  slugs: string[];
  /** The slug a person resolves to when the request names the person, not a slug. */
  canonical: string;
  /** Folded full names: at least two words each. */
  fullNames: string[];
  /** Nicknames as written in the display name's parentheses. */
  nicknames: string[];
  first: string | null;
  last: string | null;
}

export interface NameMatch { slug: string; person: string; via: "slug" | "full-name" | "nickname" | "surname" | "first-name" }

export interface NameScan {
  matches: NameMatch[];
  /** Names the request points at that match nobody in the library. */
  unknown: string[];
  /** Names more than one person carries: the request must say which. */
  ambiguous: Array<{ name: string; candidates: string[] }>;
}

/** Lower case, accents off, anything but letters and digits as one space. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/['’]s\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Words that name a role or a practice in a slug, never part of a person's name. */
const ROLE_WORDS = new Set([
  "ceo", "cfo", "cto", "coo", "cmo", "cso", "cco", "cgo", "cpo", "vp", "lead", "director", "head",
  "copy", "copywriter", "brand", "practice", "products", "product", "paid", "creator", "social", "data",
  "frontend", "backend", "music", "therapist", "speech", "analyzer", "perf", "motion", "cinematographer",
  "strategist", "writer", "editor", "designer", "photographer", "coach", "mentor", "advisor", "investor",
  "founder", "engineer", "architect", "researcher", "scientist", "growth", "sales", "seo", "ads", "media",
  "video", "design", "ux", "ui", "pm", "ops", "legal", "finance", "marketing", "content", "launch", "funnel",
]);

/** Connectors inside names ("de", "van", "da") that never stand alone as a name. */
const NAME_PARTICLES = new Set(["de", "da", "do", "dos", "das", "e", "van", "von", "der", "den", "la", "le", "di", "del", "du", "o", "a", "h"]);

/** What precedes a voice: "estilo", "como o", "à moda do", "na linha do", "tipo", "in the style of". */
const CUE = String.raw`(?:estilo|stylo|style|voz|voice|tom|tone|jeito|maneira|metodo|method|abordagem|moda|linha|como|feito|segundo|tipo|inspirad[oa]s?|inspired|cabeca|olhar|visao|la|like|pelo|pela|according|persona|clone|mente)`;
const FILLER = String.raw`(?:\s+(?:o|a|os|as|do|da|dos|das|de|of|the|by|to|um|uma|que|faria|escreveria|diria|pensaria|explicaria))*`; // i18n-user-facing: PT cue data matched against user input

/** A display name without its role ("— Brand Practice Lead") and with its nicknames apart. */
function splitDisplay(display: string): { base: string; nicknames: string[] } {
  const nicknames = [...display.matchAll(/\(([^)]+)\)/g)].map((m) => m[1].trim()).filter(Boolean);
  const base = display.replace(/\([^)]*\)/g, " ").split(/\s+[—–-]\s+|\s*[—–]\s*/)[0].trim();
  return { base, nicknames };
}

/** The name a slug spells, up to its first role word: washington-olivetto-copy → washington olivetto. */
function slugName(slug: string): string {
  const out: string[] = [];
  for (const t of slug.split("-")) {
    if (ROLE_WORDS.has(t)) break;
    out.push(t);
  }
  return out.join(" ");
}

/** A folded name worth trusting as a full name: two words or more, none of them a role. */
function personLike(folded: string): boolean {
  const toks = folded.split(" ").filter(Boolean);
  return toks.length >= 2 && !toks.some((t) => ROLE_WORDS.has(t));
}

/** One entry per person, each slug filed under the person it belongs to. */
export function buildPeople(names: CloneName[]): Person[] {
  const byKey = new Map<string, { slugs: string[]; full: Set<string>; nicks: Set<string> }>();
  for (const { slug, name } of names) {
    const { base, nicknames } = splitDisplay(name || slug);
    const fromDisplay = fold(base);
    const fromSlug = slugName(slug);
    // The display name when it is a person's name; the slug's spelling when the
    // display name is a role ("Copywriter Brand") or the slug itself.
    const key = personLike(fromDisplay) ? fromDisplay : personLike(fromSlug) ? fromSlug : fold(slug.replace(/-/g, " "));
    const entry = byKey.get(key) ?? { slugs: [], full: new Set<string>(), nicks: new Set<string>() };
    entry.slugs.push(slug);
    for (const n of [key, fromDisplay, fromSlug]) if (personLike(n)) entry.full.add(n);
    for (const n of nicknames) entry.nicks.add(n);
    byKey.set(key, entry);
  }
  // Two keys can be one person spelled two ways ("cole nussbaumer knaflic" and
  // "cole knaflic"): a full name of one that is another's key joins them.
  const people: Person[] = [];
  for (const [key, e] of byKey) {
    const words = key.split(" ").filter((t) => !NAME_PARTICLES.has(t) && t.length > 1);
    const slugs = [...e.slugs].sort((a, b) => a.split("-").length - b.split("-").length || a.length - b.length || a.localeCompare(b));
    const exact = slugs.find((s) => s === key.replace(/ /g, "-"));
    people.push({
      key, slugs, canonical: exact ?? slugs[0],
      fullNames: [...e.full],
      nicknames: [...e.nicks],
      first: words.length >= 2 ? words[0] : null,
      last: words.length >= 2 ? words[words.length - 1] : null,
    });
  }
  return people;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The person a slug belongs to, for grouping a list of slugs by person. */
export function personOf(people: Person[], slug: string): Person | undefined {
  return people.find((p) => p.slugs.includes(slug));
}

/**
 * Who the text names. `text` is what the user wrote (the request, and the
 * decisions made with them), never the parts of a brief the orchestrator
 * wrote about other businesses.
 */
export function scanNames(text: string, people: Person[]): NameScan {
  const folded = ` ${fold(text)} `;
  // Middle initials ("Roy H. Williams") do not separate a first from a last name.
  const foldedNoInitials = folded.replace(/ [a-z](?= )/g, "");
  const matches: NameMatch[] = [];
  const ambiguous: NameScan["ambiguous"] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  const add = (p: Person, slug: string, via: NameMatch["via"]) => {
    if (seen.has(p.key)) return;
    seen.add(p.key);
    matches.push({ slug, person: p.key, via });
  };
  // A name glued by hyphens to other words is part of a slug ("sherlock-holmes-nirvana"
  // is a squad, not Sherlock Holmes); a slug written as such is rule 1's business.
  const plainLower = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const insideSlug = (phrase: string) => new RegExp(`(?:[a-z0-9]-${escapeRe(phrase.replace(/ /g, "-"))}|${escapeRe(phrase.replace(/ /g, "-"))}-[a-z0-9])`).test(plainLower)
    && !new RegExp(`(^|[^a-z0-9-])${escapeRe(phrase).replace(/ /g, "\\s+")}($|[^a-z0-9-])`).test(plainLower);
  const has = (phrase: string) => (folded.includes(` ${phrase} `) || foldedNoInitials.includes(` ${phrase} `)) && !insideSlug(phrase);
  const plain = text.normalize("NFD").replace(/[̀-ͯ]/g, "");
  // Words already accounted for by a full name ("Cole" in "Cole Knaflic") are
  // not read again as another person's surname.
  let rest = folded;
  const afterCue = (word: string) => new RegExp(`(?:^| )${CUE}${FILLER}\\s+${escapeRe(word)}(?= )`).test(rest)
    // "Hormozi's value equation": a possessive is a cue of its own.
    || new RegExp(`(^|[^\\p{L}])${escapeRe(word)}['’]s\\b`, "iu").test(plain);
  const followedByCapital = (word: string) => {
    for (const m of plain.matchAll(new RegExp(`(^|[^\\p{L}])${escapeRe(word)}\\s+(\\p{L})`, "giu"))) {
      if (m[2] === m[2].toUpperCase() && m[2] !== m[2].toLowerCase()) return true;
    }
    return false;
  };

  // 1. Slugs written as such (multi-word slugs, so a slug is never a common word).
  for (const p of people) for (const s of p.slugs) {
    if (s.includes("-") && new RegExp(`(^|[^a-z0-9-])${escapeRe(s)}($|[^a-z0-9-])`, "i").test(text)) add(p, s, "slug");
  }
  // 2. Full names.
  for (const p of people) {
    const hit = p.fullNames.filter(has);
    if (!hit.length) continue;
    add(p, p.canonical, "full-name");
    for (const n of hit) rest = rest.split(` ${n} `).join("  ");
  }
  // 3. Nicknames, as written.
  for (const p of people) for (const n of p.nicknames) {
    const short = n.replace(/\s+/g, "").length <= 3;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}($|[^\\p{L}\\p{N}])`, short ? "u" : "iu");
    if (!re.test(text)) continue;
    if (short && !afterCue(fold(n))) continue;
    add(p, p.canonical, "nickname");
  }
  // 4-5. A surname or a first name after a voice cue, when only one person carries it.
  const lastIndex = new Map<string, Person[]>();
  const firstIndex = new Map<string, Person[]>();
  for (const p of people) {
    if (p.last && p.last.length >= 4) lastIndex.set(p.last, [...(lastIndex.get(p.last) ?? []), p]);
    if (p.first && p.first.length >= 4) firstIndex.set(p.first, [...(firstIndex.get(p.first) ?? []), p]);
  }
  const consider = (index: Map<string, Person[]>, via: "surname" | "first-name") => {
    for (const [word, owners] of index) {
      if (!afterCue(word)) continue;
      // A first name followed by a capitalised word is someone's full name, and not this one's.
      if (via === "first-name" && followedByCapital(word)) continue;
      const fresh = owners.filter((p) => !seen.has(p.key));
      if (fresh.length !== owners.length) continue; // already named in full
      if (owners.length === 1) add(owners[0], owners[0].canonical, via);
      else ambiguous.push({ name: word, candidates: owners.map((p) => p.canonical) });
    }
  };
  consider(lastIndex, "surname");
  consider(firstIndex, "first-name");

  // 6. "na voz do X", "in the voice of X": a name the user meant, matched by nobody.
  const explicit = /(?:\bvoz\s+(?:d[oa]s?|de)|\bin the voice of|\bpersona\s+d[oa]|\bclone\s+d[oa]|\bmind[- ]clone\s+d[oa])\s+((?:\p{Lu}[\p{L}'.-]*)(?:\s+(?:de|da|do|van|von)?\s*\p{Lu}[\p{L}'.-]*){0,3})/gu;
  for (const m of text.matchAll(explicit)) {
    const phrase = m[1].trim();
    const f = fold(phrase);
    const known = people.some((p) => p.fullNames.some((n) => n === f || n.includes(f) || f.includes(n))
      || (p.last && f.split(" ").includes(p.last) && seen.has(p.key)));
    if (!known && !unknown.includes(phrase)) unknown.push(phrase);
  }
  return { matches, unknown, ambiguous };
}
