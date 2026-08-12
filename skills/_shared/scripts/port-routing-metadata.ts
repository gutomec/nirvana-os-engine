#!/usr/bin/env bun
/**
 * port-routing-metadata.ts — routing-360 Wave P: deterministic metadata port
 * from the LIVE library (canonical, enriched) into the PACK copies of the same
 * entities in the nirvana-packs content repo.
 *
 * The live library (~/businesses, ~/squads, ~/businesses/_library/dna) is the
 * source of truth for routing metadata. The packs repo carries snapshots of
 * many of the same slugs (starter-pack/ + packs-content/<pack>/). This tool
 * discovers slug matches and ports ONLY the routing-relevant fields, value by
 * value, with the same surgical merge discipline as enrich-routing-metadata.ts
 * (whose emit/span/verify helpers it reuses):
 *
 *   CLONES     — the MANIFEST.yaml `routing:` block (field-wise merge).
 *   BUSINESSES — business.yaml description / capabilities / keywords /
 *                example_briefs / produces, plus routing.yaml auto_routes
 *                (additive: only routes the pack copy does not have yet).
 *   SQUADS     — squad.yaml squad-level description / keywords / produces /
 *                example_briefs, plus capability-level keywords /
 *                example_briefs / not_for, matched by capability id — ported
 *                only where the live version is RICHER than the pack's.
 *
 * NEVER ported: content files (AGENT.md / SOUL.md / dna/*), version, author,
 * or anything outside the explicit field list above.
 *
 * Merge policy: where the pack field is non-empty and differs, the LIVE value
 * wins for the listed fields (default). --prefer-pack reverses that: existing
 * non-empty pack values stay, only empty/missing fields are filled.
 *
 * WATERMARK SAFETY (owner rule — see the strip-base-watermarks gate): only
 * YAML VALUES are ported (parsed then re-emitted — comments never cross over),
 * no end-of-file comment line is ever introduced, and every candidate write is
 * scanned for the per-copy watermark marker patterns BEFORE being written. A
 * hit fails the run loudly (exit 3) and the file is never written.
 *
 * CLI:
 *   bun port-routing-metadata.ts --dry --json [--repo=<packs path>] [--prefer-pack]
 *   bun port-routing-metadata.ts --json --repo=~/nirvana-packs        # real write
 *
 * Exit codes: 0 = done, 1 = entity errors (listed in the report),
 * 2 = bad usage, 3 = watermark marker detected (nothing contaminated).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { paths } from "../lib/bun-helpers.ts";
import {
  appendAutoRoutesBlock,
  appendTopLevelList,
  deepEqualNormalized,
  hasUsableRoutingBlock,
  replaceTopLevelScalar,
  topLevelBlockSpan,
  verifyYamlSurgical,
  wrapFolded,
  yamlScalar,
} from "./enrich-routing-metadata.ts";

const YAML = require("yaml");

// ═══════════════════════════════════════════════════════════════════════════
// Watermark self-check (mirror of strip-base-watermarks.mjs / watermark.ts)
// ═══════════════════════════════════════════════════════════════════════════

const WATERMARK_LINE_RES = [
  /^\/\/[A-Za-z0-9_-]{22}$/, // .ts / .js
  /^\[\/\/\]: # \([A-Za-z0-9_-]{22}\)$/, // .md
  /^#[A-Za-z0-9_-]{22}$/, // .yaml / .yml
];

/** Lines of `text` that match a per-copy watermark marker pattern. */
export function scanWatermarkMarkers(text: string): string[] {
  return text.split("\n").filter((line) => WATERMARK_LINE_RES.some((re) => re.test(line)));
}

// ═══════════════════════════════════════════════════════════════════════════
// Field-decision policy
// ═══════════════════════════════════════════════════════════════════════════

export function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** true when `live` carries strictly more material than `pack`
 *  (list: more items; string: longer after whitespace-normalize). */
export function isRicher(live: unknown, pack: unknown): boolean {
  if (isEmptyValue(live)) return false;
  if (isEmptyValue(pack)) return true;
  if (Array.isArray(live) && Array.isArray(pack)) return live.length > pack.length;
  if (typeof live === "string" && typeof pack === "string") {
    return live.replace(/\s+/g, " ").trim().length > pack.replace(/\s+/g, " ").trim().length;
  }
  return false;
}

export interface PortPolicy {
  preferPack: boolean;
  /** squads: live must be richer to overwrite a non-empty pack value. */
  requireRicher?: boolean;
}

/** Should the live value replace the pack value for a listed routing field? */
export function shouldPort(live: unknown, pack: unknown, policy: PortPolicy): boolean {
  if (isEmptyValue(live)) return false;
  if (isEmptyValue(pack)) return true;
  if (policy.preferPack) return false;
  if (policy.requireRicher) return isRicher(live, pack);
  return !deepEqualNormalized(live, pack);
}

const asStringList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string")
    ? (v as string[]).map((s) => s.trim()).filter(Boolean)
    : null;

// ═══════════════════════════════════════════════════════════════════════════
// Clone routing block: value merge + partial-tolerant emission
// ═══════════════════════════════════════════════════════════════════════════

const ROUTING_KEY_ORDER = ["one_liner", "domains", "serves", "when_to_use", "not_for", "delegates_to", "refuses"];

/** Field-wise merge of two `routing:` mappings. Winner per policy; a losing
 *  side still fills fields the winner leaves empty; explicit pack keys never
 *  disappear (an empty pack `delegates_to: []` stays). */
export function mergeRoutingValues(
  packR: Record<string, unknown> | null | undefined,
  liveR: Record<string, unknown> | null | undefined,
  policy: PortPolicy,
): Record<string, unknown> {
  const p = (packR && typeof packR === "object" ? packR : {}) as Record<string, unknown>;
  const l = (liveR && typeof liveR === "object" ? liveR : {}) as Record<string, unknown>;
  const keys = [
    ...ROUTING_KEY_ORDER.filter((k) => k in p || k in l),
    ...Object.keys(p).filter((k) => !ROUTING_KEY_ORDER.includes(k)),
    ...Object.keys(l).filter((k) => !ROUTING_KEY_ORDER.includes(k) && !(k in p)),
  ];
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const winner = shouldPort(l[k], p[k], policy) ? l[k] : (k in p ? p[k] : l[k]);
    if (isEmptyValue(winner) && !(k in p)) continue; // never add an empty live key
    out[k] = winner;
  }
  return out;
}

/** Routing keys whose merged value differs from the pack's current value. */
export function routingChangedKeys(
  packR: Record<string, unknown> | null | undefined,
  merged: Record<string, unknown>,
): string[] {
  const p = (packR && typeof packR === "object" ? packR : {}) as Record<string, unknown>;
  const all = new Set([...Object.keys(p), ...Object.keys(merged)]);
  const norm = (v: unknown) => (isEmptyValue(v) ? undefined : v);
  return [...all].filter((k) => !deepEqualNormalized(norm(p[k]), norm(merged[k])));
}

/** Indent every line of a YAML.stringify() fragment by `pad`. */
function indentFragment(fragment: string, pad: string): string {
  return fragment.replace(/\n$/, "").split("\n").map((l) => (l ? pad + l : l)).join("\n");
}

/** Emit a `routing:` top-level block from a (possibly partial) mapping.
 *  Known keys in canonical order and canonical style (quoted one_liner,
 *  folded prose, dash lists); unknown keys via YAML.stringify. Values only —
 *  no comments can survive this emission. */
export function emitRoutingBlock(r: Record<string, unknown>): string {
  const out: string[] = ["routing:"];
  const dq = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const keys = [
    ...ROUTING_KEY_ORDER.filter((k) => k in r),
    ...Object.keys(r).filter((k) => !ROUTING_KEY_ORDER.includes(k)),
  ];
  for (const k of keys) {
    const v = r[k];
    if (k === "one_liner" && typeof v === "string") {
      out.push(`  one_liner: ${dq(v.trim())}`);
    } else if (["serves", "when_to_use", "not_for"].includes(k) && typeof v === "string") {
      out.push(`  ${k}: >-`);
      out.push(wrapFolded(v, "    "));
    } else if (Array.isArray(v)) {
      const items = v.filter((x) => typeof x === "string").map((x) => String(x).trim()).filter(Boolean);
      if (!items.length) { out.push(`  ${k}: []`); continue; }
      out.push(`  ${k}:`);
      for (const it of items) out.push(`    - ${yamlScalar(it)}`);
    } else if (typeof v === "string") {
      out.push(`  ${k}: ${yamlScalar(v.trim())}`);
    } else {
      out.push(indentFragment(YAML.stringify({ [k]: v }, { lineWidth: 0 }), "  "));
    }
  }
  return out.join("\n") + "\n";
}

/** Insert (append) or replace a top-level block; every other byte preserved. */
export function upsertTopLevelBlock(text: string, key: string, emitted: string): string {
  const span = topLevelBlockSpan(text, key);
  if (span) return text.slice(0, span.start) + emitted + text.slice(span.end);
  let t = text;
  if (!t.endsWith("\n")) t += "\n";
  return t + "\n" + emitted;
}

// ═══════════════════════════════════════════════════════════════════════════
// Squad capability-level surgery (nested, text-span based)
// ═══════════════════════════════════════════════════════════════════════════

const stripQuotes = (s: string) => s.trim().replace(/^["']|["']$/g, "");

/** Upsert a string-list field of one capability entry (matched by id) inside
 *  the `capabilities:` block. All bytes outside the field's own sub-span (or
 *  the insertion point) are preserved. Returns null when the capabilities
 *  block or the capability id is not found. */
export function upsertCapabilityField(
  squadText: string,
  capId: string,
  field: string,
  items: string[],
): string | null {
  const span = topLevelBlockSpan(squadText, "capabilities");
  if (!span) return null;
  const block = squadText.slice(span.start, span.end);
  const lines = block.split("\n");

  const itemRe = /^(\s*)- id:\s*(.+?)\s*$/;
  let itemIndent: string | null = null;
  const itemStarts: Array<{ line: number; id: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(itemRe);
    if (!m) continue;
    if (itemIndent === null) itemIndent = m[1];
    if (m[1] === itemIndent) itemStarts.push({ line: i, id: stripQuotes(m[2]) });
  }
  const idx = itemStarts.findIndex((s) => s.id === capId);
  if (idx === -1 || itemIndent === null) return null;

  const startLine = itemStarts[idx].line;
  const endLine = idx + 1 < itemStarts.length ? itemStarts[idx + 1].line : lines.length;
  const childIndent = itemIndent.length + 2;
  const childPad = " ".repeat(childIndent);
  const fieldRe = new RegExp(`^ {${childIndent}}${field}:`);
  const siblingRe = new RegExp(`^ {${childIndent}}[A-Za-z_"']`);

  const emitted = [`${childPad}${field}:`, ...items.map((it) => `${childPad}  - ${yamlScalar(it)}`)];

  let fieldStart = -1;
  for (let i = startLine + 1; i < endLine; i++) {
    if (fieldRe.test(lines[i])) { fieldStart = i; break; }
  }

  let newLines: string[];
  if (fieldStart !== -1) {
    let fieldEnd = endLine;
    for (let i = fieldStart + 1; i < endLine; i++) {
      // A sibling key at child indent ends the field; deeper lines and
      // dedented-to-key-level `- ` items belong to the field's value.
      if (siblingRe.test(lines[i]) && !new RegExp(`^ {${childIndent}}- `).test(lines[i])) { fieldEnd = i; break; }
    }
    newLines = [...lines.slice(0, fieldStart), ...emitted, ...lines.slice(fieldEnd)];
  } else {
    // Insert at the end of the item span, before the next `- id:` line.
    // Trailing blank lines of the block stay after the insertion.
    let insertAt = endLine;
    while (insertAt > startLine + 1 && lines[insertAt - 1].trim() === "") insertAt--;
    newLines = [...lines.slice(0, insertAt), ...emitted, ...lines.slice(insertAt)];
  }
  return squadText.slice(0, span.start) + newLines.join("\n") + squadText.slice(span.end);
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-entity planners (read-only: they RETURN planned writes)
// ═══════════════════════════════════════════════════════════════════════════

export interface PlannedWrite {
  file: string;
  oldText: string | null; // null = file did not exist
  newText: string;
}

export interface EntityPlan {
  fields: string[];
  writes: PlannedWrite[];
  notes: string[];
  errors: string[];
}

const emptyPlan = (): EntityPlan => ({ fields: [], writes: [], notes: [], errors: [] });

function parseYamlFile(file: string): { doc: any; text: string } | { error: string } {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return { error: `unreadable: ${e}` }; }
  try { return { doc: YAML.parse(text) || {}, text }; } catch (e) { return { error: `unparseable YAML: ${e}` }; }
}

export function planClonePort(packDir: string, liveDir: string, policy: PortPolicy): EntityPlan {
  const plan = emptyPlan();
  const packFile = path.join(packDir, "MANIFEST.yaml");
  const liveFile = path.join(liveDir, "MANIFEST.yaml");
  const pack = parseYamlFile(packFile);
  const live = parseYamlFile(liveFile);
  if ("error" in pack) { plan.errors.push(`pack MANIFEST ${pack.error}`); return plan; }
  if ("error" in live) { plan.errors.push(`live MANIFEST ${live.error}`); return plan; }

  const liveR = live.doc.routing;
  if (isEmptyValue(liveR) || typeof liveR !== "object") {
    plan.notes.push("live has no routing block");
    return plan;
  }
  const packR = pack.doc.routing;
  const merged = mergeRoutingValues(packR, liveR as Record<string, unknown>, policy);
  const changed = routingChangedKeys(packR, merged);
  if (!changed.length) { plan.notes.push("routing already up-to-date"); return plan; }

  const newText = upsertTopLevelBlock(pack.text, "routing", emitRoutingBlock(merged));
  const integrity = verifyYamlSurgical(pack.text, newText, ["routing"], { routing: merged });
  if (!integrity.ok) { plan.errors.push(...integrity.errors.map((e) => `integrity: ${e}`)); return plan; }

  plan.fields = changed.map((k) => `routing.${k}`);
  plan.writes.push({ file: packFile, oldText: pack.text, newText });
  return plan;
}

const BUSINESS_LIST_FIELDS = ["capabilities", "keywords", "example_briefs", "produces"];

interface RoutesFile {
  file: string;
  text: string | null;
  routes: Array<Record<string, unknown>>;
  nestedOnly: boolean;
}

function readRoutesFile(dir: string): RoutesFile {
  const file = path.join(dir, "routing.yaml");
  if (!fs.existsSync(file)) return { file, text: null, routes: [], nestedOnly: false };
  const text = fs.readFileSync(file, "utf8");
  let data: any = {};
  try { data = YAML.parse(text) || {}; } catch { /* keep {} */ }
  const raw = data.auto_routes ?? data.routing?.auto_routes ?? [];
  const routes = (Array.isArray(raw) ? raw : []).filter(
    (r: any) => r && typeof r === "object" && typeof r.pattern === "string" && typeof r.route_to === "string",
  );
  const nestedOnly = data.auto_routes === undefined && Array.isArray(data.routing?.auto_routes);
  return { file, text, routes, nestedOnly };
}

export function planBusinessPort(packDir: string, liveDir: string, policy: PortPolicy): EntityPlan {
  const plan = emptyPlan();
  const packFile = path.join(packDir, "business.yaml");
  const liveFile = path.join(liveDir, "business.yaml");
  const pack = parseYamlFile(packFile);
  const live = parseYamlFile(liveFile);
  if ("error" in pack) { plan.errors.push(`pack business.yaml ${pack.error}`); return plan; }
  if ("error" in live) { plan.errors.push(`live business.yaml ${live.error}`); return plan; }

  let newText = pack.text;
  const touched: string[] = [];
  const intended: Record<string, unknown> = {};

  const liveDesc = typeof live.doc.description === "string" ? live.doc.description.trim() : "";
  if (shouldPort(liveDesc, pack.doc.description, policy)) {
    newText = replaceTopLevelScalar(newText, "description", liveDesc);
    touched.push("description");
    intended.description = liveDesc;
  }

  for (const key of BUSINESS_LIST_FIELDS) {
    const liveItems = asStringList(live.doc[key]);
    if (liveItems === null) {
      if (!isEmptyValue(live.doc[key])) plan.notes.push(`${key}: live value is not a string list — skipped`);
      continue;
    }
    if (!shouldPort(liveItems, pack.doc[key], policy)) continue;
    newText = appendTopLevelList(newText, key, liveItems);
    touched.push(key);
    intended[key] = liveItems;
  }

  if (touched.length) {
    const integrity = verifyYamlSurgical(pack.text, newText, touched, intended);
    if (!integrity.ok) { plan.errors.push(...integrity.errors.map((e) => `integrity: ${e}`)); return plan; }
    plan.writes.push({ file: packFile, oldText: pack.text, newText });
    plan.fields.push(...touched);
  }

  // auto_routes — additive in BOTH modes: pack routes are never removed or
  // rewritten; only live routes the pack copy lacks are appended.
  const liveRoutes = readRoutesFile(liveDir);
  const packRoutes = readRoutesFile(packDir);
  const has = (r: Record<string, unknown>) =>
    packRoutes.routes.some((p) => p.pattern === r.pattern && p.route_to === r.route_to);
  const missing = liveRoutes.routes.filter((r) => !has(r));
  if (missing.length) {
    if (packRoutes.nestedOnly) {
      plan.notes.push("auto_routes: pack routing.yaml uses nested routing.auto_routes — skipped to avoid shadowing");
    } else {
      // Group by confidence so each appended entry keeps its live threshold.
      const groups = new Map<number, Array<{ pattern: string; route_to: string }>>();
      for (const r of missing) {
        const conf = typeof r.confidence_threshold === "number" ? r.confidence_threshold : 0.95;
        if (!groups.has(conf)) groups.set(conf, []);
        groups.get(conf)!.push({ pattern: String(r.pattern), route_to: String(r.route_to) });
      }
      let routingText = packRoutes.text;
      const appliedRoutes: Array<{ pattern: string; route_to: string; confidence_threshold: number }> = [];
      for (const [conf, routes] of groups) {
        const next = appendAutoRoutesBlock(routingText, routes, { confidence: conf });
        if (next === routingText && routingText !== null) {
          plan.notes.push("auto_routes: pack block is an inline flow sequence — skipped");
          continue;
        }
        routingText = next;
        appliedRoutes.push(...routes.map((r) => ({ ...r, confidence_threshold: conf })));
      }
      if (appliedRoutes.length && routingText !== null && routingText !== packRoutes.text) {
        const expected = [...packRoutes.routes, ...appliedRoutes];
        const integrity = verifyYamlSurgical(
          packRoutes.text ?? "", routingText, ["auto_routes"], { auto_routes: expected },
        );
        if (!integrity.ok) {
          plan.errors.push(...integrity.errors.map((e) => `routing.yaml integrity: ${e}`));
          return plan;
        }
        plan.writes.push({ file: packRoutes.file, oldText: packRoutes.text, newText: routingText });
        plan.fields.push(`auto_routes (+${appliedRoutes.length})`);
      }
    }
  }

  if (!plan.fields.length && !plan.errors.length) plan.notes.push("already up-to-date");
  return plan;
}

const SQUAD_TOP_LIST_FIELDS = ["keywords", "produces", "example_briefs"];
const SQUAD_CAP_FIELDS = ["keywords", "example_briefs", "not_for"];

export function planSquadPort(packDir: string, liveDir: string, policy: PortPolicy): EntityPlan {
  const plan = emptyPlan();
  const squadPolicy: PortPolicy = { ...policy, requireRicher: true };
  const packFile = path.join(packDir, "squad.yaml");
  const liveFile = path.join(liveDir, "squad.yaml");
  const pack = parseYamlFile(packFile);
  const live = parseYamlFile(liveFile);
  if ("error" in pack) { plan.errors.push(`pack squad.yaml ${pack.error}`); return plan; }
  if ("error" in live) { plan.errors.push(`live squad.yaml ${live.error}`); return plan; }

  let newText = pack.text;
  const touched: string[] = [];
  const intended: Record<string, unknown> = {};

  const liveDesc = typeof live.doc.description === "string" ? live.doc.description.trim() : "";
  if (shouldPort(liveDesc, pack.doc.description, squadPolicy)) {
    newText = replaceTopLevelScalar(newText, "description", liveDesc);
    touched.push("description");
    intended.description = liveDesc;
  }

  for (const key of SQUAD_TOP_LIST_FIELDS) {
    const liveItems = asStringList(live.doc[key]);
    if (liveItems === null) {
      if (!isEmptyValue(live.doc[key])) plan.notes.push(`${key}: live value is not a string list — skipped`);
      continue;
    }
    if (!shouldPort(liveItems, pack.doc[key], squadPolicy)) continue;
    newText = appendTopLevelList(newText, key, liveItems);
    touched.push(key);
    intended[key] = liveItems;
  }

  // Capability-level fields, matched by capability id.
  const packCaps: any[] = Array.isArray(pack.doc.capabilities) ? pack.doc.capabilities : [];
  const liveCaps: any[] = Array.isArray(live.doc.capabilities) ? live.doc.capabilities : [];
  const liveById = new Map<string, any>(
    liveCaps.filter((c) => c && typeof c.id === "string").map((c) => [c.id, c]),
  );
  const capFieldsPorted: string[] = [];
  let intendedCaps: any[] | null = null;
  for (let i = 0; i < packCaps.length; i++) {
    const packCap = packCaps[i];
    if (!packCap || typeof packCap.id !== "string") continue;
    const liveCap = liveById.get(packCap.id);
    if (!liveCap) continue;
    for (const field of SQUAD_CAP_FIELDS) {
      const liveItems = asStringList(liveCap[field]);
      if (liveItems === null || !shouldPort(liveItems, packCap[field], squadPolicy)) continue;
      const next = upsertCapabilityField(newText, packCap.id, field, liveItems);
      if (next === null) {
        plan.notes.push(`capability ${packCap.id}: could not locate entry for ${field} — skipped`);
        continue;
      }
      newText = next;
      if (!intendedCaps) intendedCaps = JSON.parse(JSON.stringify(packCaps));
      intendedCaps[i] = { ...intendedCaps[i], [field]: liveItems };
      capFieldsPorted.push(`capabilities[${packCap.id}].${field}`);
    }
  }
  if (intendedCaps) {
    touched.push("capabilities");
    intended.capabilities = intendedCaps;
  }

  if (touched.length) {
    const integrity = verifyYamlSurgical(pack.text, newText, touched, intended);
    if (!integrity.ok) { plan.errors.push(...integrity.errors.map((e) => `integrity: ${e}`)); return plan; }
    plan.writes.push({ file: packFile, oldText: pack.text, newText });
    plan.fields.push(...touched.filter((k) => k !== "capabilities"), ...capFieldsPorted);
  }

  if (!plan.fields.length && !plan.errors.length) plan.notes.push("already up-to-date");
  return plan;
}

// ═══════════════════════════════════════════════════════════════════════════
// Discovery
// ═══════════════════════════════════════════════════════════════════════════

export type EntityKind = "clone" | "business" | "squad";

export interface PackEntity {
  slug: string;
  kind: EntityKind;
  dir: string;
  /** "starter-pack" or "packs-content/<pack>" */
  pack: string;
}

const KIND_DIRS: Array<{ sub: string; kind: EntityKind; marker: string }> = [
  { sub: "businesses", kind: "business", marker: "business.yaml" },
  { sub: "squads", kind: "squad", marker: "squad.yaml" },
  { sub: "mind-clones", kind: "clone", marker: "MANIFEST.yaml" },
];

export function discoverPackEntities(repo: string): { entities: PackEntity[]; unmarked: string[] } {
  const entities: PackEntity[] = [];
  const unmarked: string[] = [];
  const roots: Array<{ pack: string; dir: string }> = [];
  const starter = path.join(repo, "starter-pack");
  if (fs.existsSync(starter)) roots.push({ pack: "starter-pack", dir: starter });
  const content = path.join(repo, "packs-content");
  if (fs.existsSync(content)) {
    for (const e of fs.readdirSync(content, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name.startsWith("_") || e.name.startsWith(".")) continue;
      roots.push({ pack: `packs-content/${e.name}`, dir: path.join(content, e.name) });
    }
  }
  for (const root of roots) {
    for (const { sub, kind, marker } of KIND_DIRS) {
      const kindDir = path.join(root.dir, sub);
      if (!fs.existsSync(kindDir)) continue;
      for (const e of fs.readdirSync(kindDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!e.isDirectory() || e.name.startsWith(".") || e.name.startsWith("_")) continue;
        const dir = path.join(kindDir, e.name);
        if (fs.existsSync(path.join(dir, marker))) entities.push({ slug: e.name, kind, dir, pack: root.pack });
        else unmarked.push(`${root.pack}/${sub}/${e.name}`);
      }
    }
  }
  return { entities, unmarked };
}

// ── pack_only "missing metadata" probes (input for the later LLM batch) ─────

function missingMetadata(entity: PackEntity): string[] {
  const missing: string[] = [];
  try {
    if (entity.kind === "clone") {
      const m = YAML.parse(fs.readFileSync(path.join(entity.dir, "MANIFEST.yaml"), "utf8")) || {};
      if (!hasUsableRoutingBlock(m)) missing.push("routing");
    } else if (entity.kind === "business") {
      const m = YAML.parse(fs.readFileSync(path.join(entity.dir, "business.yaml"), "utf8")) || {};
      if (isEmptyValue(m.description)) missing.push("description");
      for (const k of BUSINESS_LIST_FIELDS) if (isEmptyValue(m[k])) missing.push(k);
      if (!readRoutesFile(entity.dir).routes.length) missing.push("auto_routes");
    } else {
      const m = YAML.parse(fs.readFileSync(path.join(entity.dir, "squad.yaml"), "utf8")) || {};
      if (isEmptyValue(m.description)) missing.push("description");
      for (const k of SQUAD_TOP_LIST_FIELDS) if (isEmptyValue(m[k])) missing.push(k);
      const caps: any[] = Array.isArray(m.capabilities) ? m.capabilities : [];
      for (const f of SQUAD_CAP_FIELDS) {
        if (caps.some((c) => c && typeof c === "object" && isEmptyValue(c[f]))) missing.push(`capabilities[].${f}`);
      }
    }
  } catch {
    missing.push("(unparseable)");
  }
  return missing;
}

// ═══════════════════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════════════════

export interface PortOptions {
  repo: string;
  liveBusinesses?: string;
  liveSquads?: string;
  liveDna?: string;
  dry: boolean;
  preferPack: boolean;
}

export interface PortReport {
  mode: "dry" | "write";
  prefer_pack: boolean;
  repo: string;
  live: { businesses: string; squads: string; dna: string };
  matched: { total: number; clone: number; business: number; squad: number; unique_slugs: number };
  ported: Array<{ slug: string; kind: EntityKind; pack: string; fields: string[]; files: string[] }>;
  skipped: Array<{ slug: string; kind: EntityKind; pack: string; reason: string }>;
  pack_only: Array<{ slug: string; kind: EntityKind; packs: string[]; missing: string[] }>;
  errors: Array<{ slug: string; kind: EntityKind; pack: string; errors: string[] }>;
  watermark_violations: Array<{ file: string; lines: string[] }>;
  unmarked_dirs: string[];
}

export function runPort(opts: PortOptions): PortReport {
  const liveRoots = {
    businesses: opts.liveBusinesses || paths.BUSINESSES_DIR,
    squads: opts.liveSquads || paths.SQUADS_DIR,
    dna: opts.liveDna || paths.DNA_LIBRARY,
  };
  const report: PortReport = {
    mode: opts.dry ? "dry" : "write",
    prefer_pack: opts.preferPack,
    repo: opts.repo,
    live: liveRoots,
    matched: { total: 0, clone: 0, business: 0, squad: 0, unique_slugs: 0 },
    ported: [],
    skipped: [],
    pack_only: [],
    errors: [],
    watermark_violations: [],
    unmarked_dirs: [],
  };

  const { entities, unmarked } = discoverPackEntities(opts.repo);
  report.unmarked_dirs = unmarked;

  const liveDirFor = (e: PackEntity): string | null => {
    const map = { clone: [liveRoots.dna, "MANIFEST.yaml"], business: [liveRoots.businesses, "business.yaml"], squad: [liveRoots.squads, "squad.yaml"] } as const;
    const [root, marker] = map[e.kind];
    const dir = path.join(root, e.slug);
    return fs.existsSync(path.join(dir, marker)) ? dir : null;
  };

  const packOnly = new Map<string, { slug: string; kind: EntityKind; packs: string[] }>();
  const matchedSlugs = new Set<string>();
  const policy: PortPolicy = { preferPack: opts.preferPack };

  for (const e of entities) {
    const liveDir = liveDirFor(e);
    if (!liveDir) {
      const key = `${e.kind}:${e.slug}`;
      if (!packOnly.has(key)) packOnly.set(key, { slug: e.slug, kind: e.kind, packs: [] });
      packOnly.get(key)!.packs.push(e.pack);
      continue;
    }
    report.matched.total++;
    report.matched[e.kind]++;
    matchedSlugs.add(`${e.kind}:${e.slug}`);

    const plan =
      e.kind === "clone" ? planClonePort(e.dir, liveDir, policy)
      : e.kind === "business" ? planBusinessPort(e.dir, liveDir, policy)
      : planSquadPort(e.dir, liveDir, policy);

    if (plan.errors.length) {
      report.errors.push({ slug: e.slug, kind: e.kind, pack: e.pack, errors: plan.errors });
      continue;
    }
    if (!plan.writes.length) {
      report.skipped.push({ slug: e.slug, kind: e.kind, pack: e.pack, reason: plan.notes.join("; ") || "nothing to port" });
      continue;
    }

    // Watermark self-check on every candidate write BEFORE touching disk.
    // The ORIGINAL text is scanned too: a marker inside a to-be-replaced block
    // would otherwise be silently swallowed, masking a contaminated source.
    const violations = plan.writes
      .map((w) => ({
        file: w.file,
        lines: [...scanWatermarkMarkers(w.newText), ...scanWatermarkMarkers(w.oldText ?? "")],
      }))
      .filter((v) => v.lines.length > 0);
    if (violations.length) {
      report.watermark_violations.push(...violations);
      report.errors.push({
        slug: e.slug, kind: e.kind, pack: e.pack,
        errors: violations.map((v) => `watermark marker in candidate write: ${v.file}`),
      });
      continue; // never write a violating file
    }

    if (!opts.dry) {
      for (const w of plan.writes) fs.writeFileSync(w.file, w.newText, "utf8");
    }
    report.ported.push({
      slug: e.slug, kind: e.kind, pack: e.pack,
      fields: plan.fields,
      files: plan.writes.map((w) => path.relative(opts.repo, w.file)),
    });
  }

  report.matched.unique_slugs = matchedSlugs.size;
  report.pack_only = [...packOnly.values()]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((p) => {
      const sample = entities.find((e) => e.kind === p.kind && e.slug === p.slug)!;
      return { ...p, missing: missingMetadata(sample) };
    });
  return report;
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const has = (name: string) => argv.includes(`--${name}`);
  const known = argv.every((a) =>
    a === "--dry" || a === "--json" || a === "--prefer-pack" || a.startsWith("--repo="),
  );
  if (!known || has("help")) {
    console.error("usage: bun port-routing-metadata.ts [--dry] [--json] [--prefer-pack] [--repo=<packs path>]");
    process.exit(2);
  }

  const repo = path.resolve((flag("repo") || path.join(paths.HOME, "nirvana-packs")).replace(/^~(?=$|\/)/, paths.HOME));
  if (!fs.existsSync(repo)) {
    console.error(`port: packs repo not found: ${repo}`);
    process.exit(2);
  }

  const report = runPort({ repo, dry: has("dry"), preferPack: has("prefer-pack") });

  const log = has("json") ? console.error : console.log;
  log(`[port] mode=${report.mode} prefer_pack=${report.prefer_pack} repo=${report.repo}`);
  log(`[port] matched: total=${report.matched.total} (clone=${report.matched.clone} business=${report.matched.business} squad=${report.matched.squad}, unique slugs=${report.matched.unique_slugs})`);
  log(`[port] ported=${report.ported.length} skipped=${report.skipped.length} pack_only=${report.pack_only.length} errors=${report.errors.length}`);
  if (report.watermark_violations.length) {
    for (const v of report.watermark_violations) log(`[port] WATERMARK MARKER — NOT WRITTEN: ${v.file}`);
  }
  if (has("json")) console.log(JSON.stringify(report, null, 2));

  process.exit(report.watermark_violations.length ? 3 : report.errors.length ? 1 : 0);
}
