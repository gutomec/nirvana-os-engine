// dna-schema-parser.ts — parse a mind-clone's dna/dna-schema.md into its 5 layers.
//
// The schema is chunked by `## L<n> — <title>` headings (the em-dash/hyphen token
// is the STABLE anchor; titles vary across 502 clones in language and casing:
// "## L1 — Philosophies", "## L1 — FILOSOFIAS (...)", "## L1 — Philosophies (...)").
// Used by clone-resolver depth:"fragments" to inject only the layers relevant to
// the current phase instead of the whole persona. ~32/502 clones have no schema;
// parse returns ok=false → caller falls back to full persona.

export type LayerKey = "L1" | "L2" | "L3" | "L4" | "L5";

export type ParsedDna = {
  ok: boolean;
  layers: Partial<Record<LayerKey, { title: string; items: string[]; raw: string }>>;
  coherence_map: string; // the "## Inter-Layer Coherence Map" section verbatim ("" if absent)
};

const LAYER_HEAD = /^##\s*L([1-5])\s*[—-]\s*(.+)$/;
// Fallback: some clones (measured 2026-07-26: 5 of 548) carry the SAME five
// complete layers, with cited sources, but written as `### Layer 1 — VISION`
// — level 3 and the word spelled out. The strict parser rejected them and they
// fell back to full. It is a format defect, not a content one: rewriting the
// persona to fit the regex would destroy good material to please a parser.
const LAYER_HEAD_LOOSE = /^#{2,4}\s*(?:L|Layer\s+|Camada\s+)([1-5])\s*[—–:.-]\s*(.+)$/i;
const ITEM_RE = /^\s*(\d+[.\)]|[-*])\s+/;

export function parseDnaSchema(md: string): ParsedDna {
  const strict = collect(md, LAYER_HEAD, /^(?=##\s)/m);
  if (strict.ok) return strict;
  // Only when strict fails: also split on `###` to reach the clones that
  // title the layer at level 3. Keeping the two passes separate guarantees the
  // canonical path stays identical — splitting on `###` from the start would
  // shred the layer bodies of well-formed clones into pieces.
  const loose = collect(md, LAYER_HEAD_LOOSE, /^(?=#{2,4}\s)/m);
  return loose.ok ? loose : strict;
}

function collect(md: string, head: RegExp, splitter: RegExp): ParsedDna {
  const layers: ParsedDna["layers"] = {};
  let coherence_map = "";
  const parts = md.split(splitter);
  for (const part of parts) {
    const firstLine = part.split("\n", 1)[0] ?? "";
    const m = firstLine.match(head);
    if (m) {
      const key = ("L" + m[1]) as LayerKey;
      if (!layers[key]) {
        const raw = part.trim();
        const items = raw.split("\n").filter((l) => ITEM_RE.test(l)).map((l) => l.trim());
        layers[key] = { title: m[2].trim(), items, raw };
      }
      continue;
    }
    if (/^##\s*Inter-Layer Coherence Map/i.test(firstLine)) coherence_map = part.trim();
  }
  return { ok: Object.keys(layers).length >= 3, layers, coherence_map };
}
