/**
 * employee-frontmatter-editor.ts — surgical text edits to an employee .md's
 * frontmatter for exactly the fields the org-chart card editor exposes:
 * `role`, `description`, `assigned_mind_clones`, `squads_authorized`.
 *
 * Why not `editFrontmatter` (frontmatter-edit.js), the engine's own
 * comment-preserving YAML Document editor? Tested against a real file
 * (ac-bookkeeping-coord.md): setting just `role` and `description` through
 * it re-serializes the WHOLE frontmatter block, and any OTHER block list in
 * that same header — `self_score_contract.criteria`, `acceptance[]` — gets
 * silently re-indented (flush lists become indented) even though nothing
 * asked to touch them. Same class of problem as org-chart.yaml
 * (org-chart-editor.ts), same fix: change only the exact lines that
 * logically changed, leave everything else byte-for-byte.
 *
 * Frontmatter is flatter than org-chart's nested chart[] — no entry
 * wrapper, every field lives at column 0 — so this only needs the
 * empty/block/flow list handling, plus a scalar-line replace for role/
 * description. `splitFrontmatter`/`joinFrontmatter` (frontmatter-edit.js)
 * do the body-preserving header extraction; only the header text passes
 * through here.
 */

import { splitFrontmatter, joinFrontmatter } from "../../../_shared/lib/frontmatter-edit.ts";

export class FrontmatterEditError extends Error {}

type KeyList =
  | { kind: "absent" }
  | { kind: "empty"; keyLine: number }
  | { kind: "block"; keyLine: number; itemsStart: number; itemsEnd: number; items: string[] }
  | { kind: "flow"; keyLine: number; items: string[] };

const DEFAULT_ITEM_INDENT = 2; // freshly-inserted lists use the indented style

function pad(n: number): string { return " ".repeat(n); }

function findKeyList(lines: string[], key: string): KeyList {
  const emptyRe = new RegExp(`^${key}:\\s*\\[\\]\\s*$`);
  const flowRe = new RegExp(`^${key}:\\s*\\[(.+)\\]\\s*$`);
  const blockRe = new RegExp(`^${key}:\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    if (emptyRe.test(lines[i])) return { kind: "empty", keyLine: i };
    const flow = flowRe.exec(lines[i]);
    if (flow) return { kind: "flow", keyLine: i, items: flow[1].split(",").map((s) => s.trim()).filter(Boolean) };
    if (blockRe.test(lines[i])) {
      // \s* (zero or more), not \s+ — frontmatter list items are just as often
      // flush at column 0 (`squads_authorized:\n- foo`) as indented 2 deeper
      // (`\n  - foo`); verified both in the wild. Requiring \s+ silently
      // reported an existing flush item as "no items", so a write left the
      // real item behind and duplicated a new one under it (found live,
      // 2026-08-31, testing this exact feature against ac-bookkeeping-coord.md).
      const itemRe = /^(\s*)- (\S+)\s*$/;
      let j = i + 1;
      const items: string[] = [];
      while (j < lines.length) {
        const m = itemRe.exec(lines[j]);
        if (!m) break;
        items.push(m[2]);
        j++;
      }
      return { kind: "block", keyLine: i, itemsStart: i + 1, itemsEnd: j, items };
    }
  }
  return { kind: "absent" };
}

function currentItemIndent(lines: string[], kl: KeyList): number {
  if (kl.kind === "block" && kl.itemsEnd > kl.itemsStart) {
    const m = /^(\s*)- /.exec(lines[kl.itemsStart]);
    if (m) return m[1].length;
  }
  return DEFAULT_ITEM_INDENT;
}

function writeKeyList(lines: string[], key: string, kl: KeyList, newItems: string[]): void {
  if (kl.kind === "absent") {
    if (newItems.length === 0) return; // nothing to add, nothing to write
    // Append at the end of the frontmatter block — simplest safe position,
    // doesn't require guessing where among existing keys it "belongs".
    lines.push(`${key}:`, ...newItems.map((s) => `${pad(DEFAULT_ITEM_INDENT)}- ${s}`));
    return;
  }
  const itemIndent = currentItemIndent(lines, kl);
  if (newItems.length === 0) {
    const span = kl.kind === "block" ? kl.itemsEnd - kl.keyLine : 1;
    lines.splice(kl.keyLine, span, `${key}: []`);
    return;
  }
  if (kl.kind === "flow") {
    lines.splice(kl.keyLine, 1, `${key}: [${newItems.join(", ")}]`);
    return;
  }
  const itemLines = newItems.map((s) => `${pad(itemIndent)}- ${s}`);
  const span = kl.kind === "block" ? kl.itemsEnd - kl.keyLine : 1;
  lines.splice(kl.keyLine, span, `${key}:`, ...itemLines);
}

function items(kl: KeyList): string[] {
  return kl.kind === "block" || kl.kind === "flow" ? kl.items : [];
}

/** YAML-safe double-quoted scalar: escape backslash and double-quote. */
function quoteScalar(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** True when a plain (unquoted) scalar can't safely represent `value` —
 *  leading/trailing space, a YAML indicator character up front, a
 *  colon-space that would be read as a nested mapping, or a value that
 *  would parse as another type (number/bool/null). Slugs like
 *  `technical_accounting_director` or `ac-tech-director` never need this;
 *  quoting them anyway would be a stylistic diff nobody asked for. */
function needsQuoting(value: string): boolean {
  if (value === "") return true;
  if (/^\s|\s$/.test(value)) return true;
  if (/^[-?:,\[\]{}#&*!|>'"%@`]/.test(value)) return true;
  if (/: |:$/.test(value) || / #/.test(value)) return true;
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(value)) return true;
  if (/^[-+]?\d+(\.\d+)?$/.test(value)) return true;
  return false;
}

/** Finds a top-level `key: value` scalar line; -1 if absent. Matches both
 *  quoted and plain forms — only the VALUE changes on write, never the
 *  quoting convention of an unrelated field. */
function findScalarLine(lines: string[], key: string): number {
  const re = new RegExp(`^${key}:\\s`);
  return lines.findIndex((l) => re.test(l));
}

/** Renders `key: value`, choosing quotes by: forced (opts.alwaysQuote) →
 *  preserve whatever style the field already had (an author's quoted
 *  em-dash title shouldn't get its quotes stripped just because the new
 *  value happens not to strictly need them) → the safety heuristic only
 *  for a field with no prior line to take a style from. Quoting can only
 *  be upgraded by the heuristic, never downgraded below what safety
 *  requires. */
function writeScalarLine(lines: string[], key: string, value: string, opts: { alwaysQuote?: boolean } = {}): void {
  const idx = findScalarLine(lines, key);
  let shouldQuote: boolean;
  if (opts.alwaysQuote) shouldQuote = true;
  else if (idx !== -1) {
    const currentValue = lines[idx].slice(lines[idx].indexOf(":") + 1).trim();
    shouldQuote = currentValue.startsWith('"') || needsQuoting(value);
  } else {
    shouldQuote = needsQuoting(value);
  }
  const line = `${key}: ${shouldQuote ? quoteScalar(value) : value}`;
  if (idx === -1) lines.push(line);
  else lines[idx] = line;
}

export interface EmployeePatch {
  role?: string;
  description?: string;
  reportsTo?: string;
  assignedMindClones?: string[];
  squadsAuthorized?: string[];
}

/** Applies `patch` to one employee .md's frontmatter, returning the full new
 *  file text. Only the fields present in `patch` are touched; the body and
 *  every other frontmatter field survive byte-for-byte. Throws
 *  FrontmatterEditError if the file has no parseable `---` header.
 *
 *  Note: `reportsTo` here only updates the employee's OWN frontmatter
 *  mirror of the relationship — the org-chart.yaml `chart[]` entries (the
 *  real hierarchy edges) are a separate write via org-chart-editor.ts,
 *  done by the caller alongside this one so both sources of truth move
 *  together. */
export function applyEmployeePatch(fileText: string, patch: EmployeePatch): string {
  const split = splitFrontmatter(fileText);
  if (!split) throw new FrontmatterEditError("file has no frontmatter header");
  const lines = split.block.split(/\r?\n/);

  if (patch.role !== undefined) writeScalarLine(lines, "role", patch.role);
  if (patch.description !== undefined) writeScalarLine(lines, "description", patch.description, { alwaysQuote: true });
  if (patch.reportsTo !== undefined) writeScalarLine(lines, "reports_to", patch.reportsTo);
  if (patch.assignedMindClones !== undefined) {
    writeKeyList(lines, "assigned_mind_clones", findKeyList(lines, "assigned_mind_clones"), patch.assignedMindClones);
  }
  if (patch.squadsAuthorized !== undefined) {
    writeKeyList(lines, "squads_authorized", findKeyList(lines, "squads_authorized"), patch.squadsAuthorized);
  }

  return joinFrontmatter(split, lines.join(split.eol));
}

/** Reads the current values of the editable fields, for populating the editor. */
export function readEmployeeEditable(fileText: string): { role: string; description: string; reportsTo: string; assignedMindClones: string[]; squadsAuthorized: string[] } {
  const split = splitFrontmatter(fileText);
  if (!split) throw new FrontmatterEditError("file has no frontmatter header");
  const lines = split.block.split(/\r?\n/);
  const roleIdx = findScalarLine(lines, "role");
  const descIdx = findScalarLine(lines, "description");
  const reportsToIdx = findScalarLine(lines, "reports_to");
  const unquote = (raw: string) => raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return {
    role: roleIdx === -1 ? "" : unquote(lines[roleIdx].slice(lines[roleIdx].indexOf(":") + 1)),
    description: descIdx === -1 ? "" : unquote(lines[descIdx].slice(lines[descIdx].indexOf(":") + 1)),
    reportsTo: reportsToIdx === -1 ? "" : unquote(lines[reportsToIdx].slice(lines[reportsToIdx].indexOf(":") + 1)),
    assignedMindClones: items(findKeyList(lines, "assigned_mind_clones")),
    squadsAuthorized: items(findKeyList(lines, "squads_authorized")),
  };
}
