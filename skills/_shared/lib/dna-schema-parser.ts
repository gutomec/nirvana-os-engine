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
const ITEM_RE = /^\s*(\d+[.\)]|[-*])\s+/;

export function parseDnaSchema(md: string): ParsedDna {
  const layers: ParsedDna["layers"] = {};
  let coherence_map = "";
  // Split at each level-2 heading, keeping the heading with its section body.
  const parts = md.split(/^(?=##\s)/m);
  for (const part of parts) {
    const firstLine = part.split("\n", 1)[0] ?? "";
    const head = firstLine.match(LAYER_HEAD);
    if (head) {
      const key = ("L" + head[1]) as LayerKey;
      if (!layers[key]) {
        const raw = part.trim();
        const items = raw.split("\n").filter((l) => ITEM_RE.test(l)).map((l) => l.trim());
        layers[key] = { title: head[2].trim(), items, raw };
      }
      continue;
    }
    if (/^##\s*Inter-Layer Coherence Map/i.test(firstLine)) coherence_map = part.trim();
  }
  return { ok: Object.keys(layers).length >= 3, layers, coherence_map };
}
