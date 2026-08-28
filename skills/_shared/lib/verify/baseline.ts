// baseline.ts — recorded metadata debt for the admission gate.
//
// The file lives beside the machine's global state
// (`$NIRVANA_HOME/.nirvana/.verify-baseline.json`): it names library
// entities, which never belong in the engine repo, and it must not move with
// the working directory. Shape:
//
//   { recorded_at, imported_from?: [...], entities: { "<kind>:<slug>": ["<id>[:<where>]", ...] } }
//
// Rules, inherited from scripts/check-entity-admission.ts:
//   - only `baselineable` criteria become debt; an error not marked
//     `baselineable` never does (the two audit-contract errors are marked, and
//     §16.2 of BUSINESS_PROTOCOL_V2.md records why);
//   - `--record` MERGES per entity (recording from pack A must not erase what
//     only pack B can see); an entity scanned and clean is cleared;
//   - recording refuses to ADD debt unless `--allow-regression`;
//   - the two legacy files (`.admission-baseline.json`,
//     `.seat-sufficiency-baseline.json`) are imported once, the first time no
//     verify baseline exists, and left untouched.

import * as fs from "node:fs";
import * as path from "node:path";
import { paths } from "../bun-helpers.ts";
import { entityKey, findingKey, type Finding, type Kind, type VerifyReport } from "./types.ts";

export interface Baseline {
  recorded_at: string;
  imported_from?: string[];
  entities: Record<string, string[]>;
}

export function defaultBaselinePath(): string {
  const home = (paths as Record<string, string>).NIRVANA_HOME ?? ".";
  return path.join(home, ".nirvana", ".verify-baseline.json");
}

function readJson(file: string): any | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** Legacy admission baseline → verify keys. Unknown gaps are dropped. */
export function importLegacy(dir: string): { entities: Record<string, string[]>; sources: string[] } {
  const entities: Record<string, string[]> = {};
  const sources: string[] = [];
  const add = (key: string, id: string) => { (entities[key] ??= []); if (!entities[key].includes(id)) entities[key].push(id); };

  const admission = path.join(dir, ".admission-baseline.json");
  const adm = readJson(admission);
  if (adm && adm.entities && typeof adm.entities === "object") {
    sources.push(admission);
    for (const [slug, gaps] of Object.entries(adm.entities as Record<string, string[]>)) {
      for (const g of Array.isArray(gaps) ? gaps : []) {
        if (g === "no_verdict") add(entityKey("mind-clone", slug), "validation_verdict_missing");
        else if (g === "no_source") add(entityKey("mind-clone", slug), "source_material_missing");
        else if (g === "thin_seat") {
          // key is "<business>/<employee>.md"
          const i = slug.indexOf("/");
          if (i > 0) add(entityKey("business", slug.slice(0, i)), `seat_thin:employees/${slug.slice(i + 1)}`);
        }
      }
    }
  }
  const seats = path.join(dir, ".seat-sufficiency-baseline.json");
  const st = readJson(seats);
  if (st && Array.isArray(st.thin_seats)) {
    sources.push(seats);
    for (const key of st.thin_seats as string[]) {
      const i = String(key).indexOf("/");
      if (i > 0) add(entityKey("business", key.slice(0, i)), `seat_thin:employees/${key.slice(i + 1)}`);
    }
  }
  for (const k of Object.keys(entities)) entities[k].sort();
  return { entities, sources };
}

/**
 * Loads the baseline. When the file is absent and legacy baselines exist next
 * to it, they are imported ONCE (the verify baseline is written so the import
 * never repeats). Returns null when there is nothing at all.
 */
export function loadBaseline(file: string = defaultBaselinePath()): Baseline | null {
  if (fs.existsSync(file)) {
    const b = readJson(file);
    if (b && b.entities && typeof b.entities === "object") return b as Baseline;
    return null;
  }
  const { entities, sources } = importLegacy(path.dirname(file));
  if (sources.length === 0) return null;
  const b: Baseline = { recorded_at: new Date().toISOString(), imported_from: sources, entities };
  writeBaseline(file, b);
  return b;
}

export function writeBaseline(file: string, b: Baseline): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(b, null, 2) + "\n", "utf8");
}

/** Marks `baselined` on the findings the baseline already records. Mutates and returns the list. */
export function applyBaseline(kind: Kind, slug: string, findings: Finding[], baselineable: Set<string>, baseline: Baseline | null): Finding[] {
  const recorded = new Set(baseline?.entities[entityKey(kind, slug)] ?? []);
  for (const f of findings) {
    f.baselined = baselineable.has(f.id) && recorded.has(findingKey(f));
  }
  return findings;
}

/** The debt keys an entity carries right now (baselineable findings only). */
export function debtOf(findings: Finding[], baselineable: Set<string>): string[] {
  return [...new Set(findings.filter((f) => baselineable.has(f.id) && f.severity !== "info").map(findingKey))].sort();
}

export interface RecordResult {
  ok: boolean;
  path: string;
  /** entities that would gain debt (present only when refused) */
  regressions: Array<{ entity: string; added: string[] }>;
  entities_with_debt: number;
}

/**
 * Merge the current debt of the scanned entities into the baseline. Refuses
 * to add debt to a known baseline without `allowRegression`.
 */
export function recordBaseline(
  file: string,
  scanned: Array<{ kind: Kind; slug: string; debt: string[] }>,
  opts: { allowRegression?: boolean } = {},
): RecordResult {
  const previous = fs.existsSync(file) ? (readJson(file) as Baseline | null) : null;
  const prevEntities = previous?.entities ?? {};
  const regressions: Array<{ entity: string; added: string[] }> = [];
  for (const s of scanned) {
    const key = entityKey(s.kind, s.slug);
    const before = new Set(prevEntities[key] ?? []);
    const added = s.debt.filter((d) => !before.has(d));
    if (added.length) regressions.push({ entity: key, added });
  }
  if (previous && regressions.length && !opts.allowRegression) {
    return { ok: false, path: file, regressions, entities_with_debt: Object.keys(prevEntities).length };
  }
  const merged: Record<string, string[]> = { ...prevEntities };
  for (const s of scanned) {
    const key = entityKey(s.kind, s.slug);
    if (s.debt.length) merged[key] = [...s.debt].sort();
    else delete merged[key];
  }
  const out: Baseline = {
    recorded_at: new Date().toISOString(),
    ...(previous?.imported_from ? { imported_from: previous.imported_from } : {}),
    entities: Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]])),
  };
  writeBaseline(file, out);
  return { ok: true, path: file, regressions: [], entities_with_debt: Object.keys(out.entities).length };
}

export function debtFromReport(r: VerifyReport, baselineable: Set<string>): string[] {
  return debtOf(r.findings, baselineable);
}
