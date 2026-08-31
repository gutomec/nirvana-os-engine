/**
 * org-chart-editor.ts — surgical, comment/formatting-preserving text edits
 * for the `chart: [{employee, reports, direct_reports}]` shape that 59 of
 * the 61 real org-chart.yaml files use (verified 2026-08-31).
 *
 * Why not the engine's own `editYaml` (verify/common.ts)? Tested against a
 * real file (aurum-contabil): a single one-line addition to a direct_reports
 * list forces the whole document through `Document#toString()`, which
 * re-flows every already-wrapped plain-scalar value elsewhere in the file
 * (the `routing_rules[].rationale` prose, in that file) — a large, unrelated
 * diff on content nobody touched. These functions instead treat the chart
 * list as line-oriented text and change only the exact lines that logically
 * changed; everything else survives byte-for-byte.
 *
 * All functions take/return the FULL file text — no fs I/O here, so they're
 * trivial to unit-test against fixtures. The caller (data-loader.ts) owns
 * reading/writing the file and deciding whether the result actually changed.
 *
 * Three list encodings coexist in the real registry (verified across all 59
 * chart[]-shaped files): a block list flush with its key (37 files — `-
 * item` at the SAME indent as `key:`), a block list indented one level
 * deeper (22 files), and an inline flow list, `key: [a, b, c]` or `key: []`
 * (1 file, ultra-eleicoes — always empty for a fresh key in the other two
 * styles, but this file uses it even with content). Reading auto-detects
 * per file; editing preserves whichever encoding a given key already uses,
 * and a from-empty key defaults to this file's dominant block style. A file
 * matching none of these (the 2 businesses on the legacy `org: {}` map)
 * throws OrgChartEditError so the API layer returns a 4xx instead of
 * guessing.
 */

export class OrgChartEditError extends Error {}

interface Lines {
  lines: string[];
  eol: "\n" | "\r\n";
  trailingNewline: boolean;
}

interface Style {
  /** Indent, in spaces, of the `- employee:` line itself (0 or 2 in the wild). */
  entryIndent: number;
  /** Indent of a mapping key inside an entry (reports:, direct_reports:). Always entryIndent + 2. */
  keyIndent: number;
  /** Indent of a `- item` line under one of those keys — same as keyIndent
   *  (flush) or keyIndent + 2 (indented), per whichever this file uses. */
  itemIndent: number;
}

type KeyList =
  | { kind: "empty"; keyLine: number }
  | { kind: "block"; keyLine: number; itemsStart: number; itemsEnd: number; items: string[] }
  | { kind: "flow"; keyLine: number; items: string[] };

function splitLines(text: string): Lines {
  const eol: "\n" | "\r\n" = text.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = text.endsWith(eol);
  const body = trailingNewline ? text.slice(0, -eol.length) : text;
  return { lines: body.split(eol), eol, trailingNewline };
}

function joinLines(l: Lines): string {
  return l.lines.join(l.eol) + (l.trailingNewline ? l.eol : "");
}

function pad(n: number): string { return " ".repeat(n); }

/** [start, end) line-index range of the chart: list body (after the `chart:`
 *  header, up to the next column-0 key or EOF). */
function findChartBounds(lines: string[]): { start: number; end: number } {
  const chartIdx = lines.findIndex((l) => /^chart:\s*$/.test(l));
  if (chartIdx === -1) throw new OrgChartEditError("no top-level `chart:` list — unsupported org-chart.yaml shape");
  let end = lines.length;
  for (let i = chartIdx + 1; i < lines.length; i++) {
    // A new column-0 key ends the list. A flush-style entry opener ("- employee:")
    // also starts at column 0 but isn't one — exclude it explicitly.
    if (/^\S/.test(lines[i]) && !/^-\s+employee:/.test(lines[i])) { end = i; break; }
  }
  return { start: chartIdx + 1, end };
}

/** Reads this file's own indentation convention from its first entry and
 *  its first block-style item list; falls back to the flush-vs-indented
 *  correlation confirmed across every real file when no block list exists
 *  to sample (e.g. a file using flow lists throughout). */
function detectStyle(lines: string[], bodyStart: number, bodyEnd: number): Style {
  let entryIndent = -1;
  for (let i = bodyStart; i < bodyEnd; i++) {
    const m = /^(\s*)-\s+employee:\s*\S+\s*$/.exec(lines[i]);
    if (m) { entryIndent = m[1].length; break; }
  }
  if (entryIndent === -1) throw new OrgChartEditError("chart: has no `- employee:` entries");
  const keyIndent = entryIndent + 2;
  let itemIndent = keyIndent;
  const keyRe = new RegExp(`^ {${keyIndent}}\\w+:\\s*$`);
  for (let i = bodyStart; i < bodyEnd - 1; i++) {
    if (keyRe.test(lines[i])) {
      const m = /^(\s*)- \S+\s*$/.exec(lines[i + 1] || "");
      if (m) { itemIndent = m[1].length; break; }
    }
  }
  return { entryIndent, keyIndent, itemIndent };
}

/** [start, end) of one `- employee: <slug>` entry's lines within the chart body. */
function findEntryBounds(lines: string[], bodyStart: number, bodyEnd: number, style: Style, slug: string): { start: number; end: number } {
  const entryRe = new RegExp(`^ {${style.entryIndent}}-\\s+employee:\\s*(\\S+)\\s*$`);
  for (let i = bodyStart; i < bodyEnd; i++) {
    const m = entryRe.exec(lines[i]);
    if (m && m[1] === slug) {
      let entryEnd = bodyEnd;
      for (let j = i + 1; j < bodyEnd; j++) {
        if (entryRe.test(lines[j])) { entryEnd = j; break; }
      }
      return { start: i, end: entryEnd };
    }
  }
  throw new OrgChartEditError(`employee "${slug}" not found in chart:`);
}

function splitFlowItems(inner: string): string[] {
  return inner.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Finds a `<key>:` line within [start, end) at this file's key indent, in
 *  whichever of the three encodings it uses. */
function findKeyList(lines: string[], start: number, end: number, style: Style, key: string): KeyList | null {
  const emptyRe = new RegExp(`^ {${style.keyIndent}}${key}:\\s*\\[\\]\\s*$`);
  const flowRe = new RegExp(`^ {${style.keyIndent}}${key}:\\s*\\[(.+)\\]\\s*$`);
  const blockRe = new RegExp(`^ {${style.keyIndent}}${key}:\\s*$`);
  const itemRe = new RegExp(`^ {${style.itemIndent}}- \\S+\\s*$`);
  for (let i = start; i < end; i++) {
    if (emptyRe.test(lines[i])) return { kind: "empty", keyLine: i };
    const flow = flowRe.exec(lines[i]);
    if (flow) return { kind: "flow", keyLine: i, items: splitFlowItems(flow[1]) };
    if (blockRe.test(lines[i])) {
      let j = i + 1;
      while (j < end && itemRe.test(lines[j])) j++;
      const items = lines.slice(i + 1, j).map((l) => /^\s*- (\S+)\s*$/.exec(l)![1]);
      return { kind: "block", keyLine: i, itemsStart: i + 1, itemsEnd: j, items };
    }
  }
  return null;
}

function items(kl: KeyList): string[] {
  return kl.kind === "empty" ? [] : kl.items;
}

/** Rewrites a key's list to `newItems`, preserving its current encoding
 *  (flow stays flow, block stays block) — only a from-empty key picks this
 *  file's dominant block style, so a file written entirely in flow style
 *  (ultra-eleicoes) doesn't get a stray block-style key mixed in. */
function writeKeyList(lines: string[], style: Style, key: string, kl: KeyList, newItems: string[]): void {
  if (newItems.length === 0) {
    const span = kl.kind === "block" ? kl.itemsEnd - kl.keyLine : 1;
    lines.splice(kl.keyLine, span, `${pad(style.keyIndent)}${key}: []`);
    return;
  }
  if (kl.kind === "flow") {
    lines.splice(kl.keyLine, 1, `${pad(style.keyIndent)}${key}: [${newItems.join(", ")}]`);
    return;
  }
  const itemLines = newItems.map((s) => `${pad(style.itemIndent)}- ${s}`);
  const span = kl.kind === "block" ? kl.itemsEnd - kl.keyLine : 1;
  lines.splice(kl.keyLine, span, `${pad(style.keyIndent)}${key}:`, ...itemLines);
}

/** Adds `childSlug` to `parentSlug`'s `direct_reports:` list. No-op if already present. */
export function addDirectReport(text: string, parentSlug: string, childSlug: string): string {
  const parsed = splitLines(text);
  const body = findChartBounds(parsed.lines);
  const style = detectStyle(parsed.lines, body.start, body.end);
  const entry = findEntryBounds(parsed.lines, body.start, body.end, style, parentSlug);
  const dr = findKeyList(parsed.lines, entry.start, entry.end, style, "direct_reports");
  if (!dr) throw new OrgChartEditError(`"${parentSlug}" has no direct_reports: key`);
  const current = items(dr);
  if (current.includes(childSlug)) return text;
  writeKeyList(parsed.lines, style, "direct_reports", dr, [...current, childSlug]);
  return joinLines(parsed);
}

/** Removes `childSlug` from `parentSlug`'s `direct_reports:` list, collapsing
 *  to the empty form when it was the last one. No-op if absent. */
export function removeDirectReport(text: string, parentSlug: string, childSlug: string): string {
  const parsed = splitLines(text);
  const body = findChartBounds(parsed.lines);
  const style = detectStyle(parsed.lines, body.start, body.end);
  const entry = findEntryBounds(parsed.lines, body.start, body.end, style, parentSlug);
  const dr = findKeyList(parsed.lines, entry.start, entry.end, style, "direct_reports");
  if (!dr) return text;
  const current = items(dr);
  if (!current.includes(childSlug)) return text;
  writeKeyList(parsed.lines, style, "direct_reports", dr, current.filter((s) => s !== childSlug));
  return joinLines(parsed);
}

/** Rewrites `employeeSlug`'s own single-parent `reports:` line. */
export function setReportsTo(text: string, employeeSlug: string, newParentSlug: string): string {
  const parsed = splitLines(text);
  const body = findChartBounds(parsed.lines);
  const style = detectStyle(parsed.lines, body.start, body.end);
  const entry = findEntryBounds(parsed.lines, body.start, body.end, style, employeeSlug);
  const rep = findKeyList(parsed.lines, entry.start, entry.end, style, "reports");
  if (!rep) throw new OrgChartEditError(`"${employeeSlug}" has no reports: key`);
  writeKeyList(parsed.lines, style, "reports", rep, [newParentSlug]);
  return joinLines(parsed);
}

/** Appends a brand-new `- employee: <slug>` entry at the end of the chart
 *  list (reporting to `reportsTo`, no children yet). Does NOT link it into
 *  the parent's direct_reports — call addDirectReport() for that. */
export function appendChartEntry(text: string, employeeSlug: string, reportsTo: string): string {
  const parsed = splitLines(text);
  const body = findChartBounds(parsed.lines);
  const style = detectStyle(parsed.lines, body.start, body.end);
  const entryRe = new RegExp(`^ {${style.entryIndent}}-\\s+employee:\\s*${employeeSlug}\\s*$`);
  if (parsed.lines.slice(body.start, body.end).some((l) => entryRe.test(l))) {
    throw new OrgChartEditError(`"${employeeSlug}" already exists in chart:`);
  }
  const block = [
    `${pad(style.entryIndent)}- employee: ${employeeSlug}`,
    `${pad(style.keyIndent)}reports:`,
    `${pad(style.itemIndent)}- ${reportsTo}`,
    `${pad(style.keyIndent)}direct_reports: []`,
  ];
  parsed.lines.splice(body.end, 0, ...block);
  return joinLines(parsed);
}

/** Full reparent: remove from old parent, add to new parent, rewrite the
 *  employee's own reports: line. A null old parent (root) skips the removal. */
export function reparentEmployee(text: string, employeeSlug: string, oldParentSlug: string | null, newParentSlug: string): string {
  let out = text;
  if (oldParentSlug) out = removeDirectReport(out, oldParentSlug, employeeSlug);
  out = addDirectReport(out, newParentSlug, employeeSlug);
  out = setReportsTo(out, employeeSlug, newParentSlug);
  return out;
}

/** True if `candidateParent` is `employeeSlug` itself or one of its current
 *  descendants — assigning it as the new parent would create a cycle.
 *  Reads structurally (via the caller's yaml.parse), not the line editor,
 *  since this check is read-only. */
export function wouldCreateCycle(chartRaw: string, yamlParse: (s: string) => any, employeeSlug: string, candidateParent: string): boolean {
  if (employeeSlug === candidateParent) return true;
  const parsed = yamlParse(chartRaw) || {};
  const entries: Array<{ employee: string; direct_reports?: string[] }> = Array.isArray(parsed.chart) ? parsed.chart : [];
  const byId = new Map(entries.map((e) => [e.employee, e]));
  const visiting = new Set<string>();
  function isDescendant(id: string): boolean {
    if (id === candidateParent) return true;
    if (visiting.has(id)) return false;
    visiting.add(id);
    const kids = byId.get(id)?.direct_reports || [];
    return kids.some(isDescendant);
  }
  return isDescendant(employeeSlug);
}
