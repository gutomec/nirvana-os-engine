/**
 * frontmatter-edit.js — CommonJS implementation: edit the `---` block of a
 * Markdown file and nothing else. frontmatter-edit.ts re-exports this file,
 * typed, so every ESM importer keeps working unchanged (mirrors
 * brief-excerpt.js/.ts, log-paths.js/.ts, dependency-graph.js/.ts and
 * entity-graph.js/.ts).
 *
 * Moved here so a `.js` caller (business-fixers.js) can `require()` it
 * directly instead of reaching for the `.ts` — a plain `.js` `require()`d
 * from another `.js` never crosses the CJS/ESM boundary that only Windows'
 * Bun enforces as a hard error for a `.ts` whose dependency chain carries a
 * top-level await.
 *
 * An employee is a seat's method written as prose with a YAML header. The
 * mechanical fixers of Business Protocol 2.0 rewrite the header — strip
 * `heartbeat`, convert `self_score_contract` into `acceptance[]`, add a pin —
 * and must not touch a single byte of what the author wrote below it. Reading
 * the file, re-serializing the whole document and writing it back is how a
 * fixer silently reflows 581 seats: trailing spaces, tab indentation, the blank
 * line before a heading, the exact bytes the writer chose.
 *
 * So the edit is surgical. The frontmatter block is parsed through the `yaml`
 * Document API (comments, key order and the formatting of untouched nodes
 * survive), and the file is reassembled as
 *
 *   <BOM?> --- <eol> <new frontmatter> <eol> --- <tail> <body verbatim>
 *
 * where the body is the original slice, never re-encoded. Line endings are
 * preserved: a CRLF checkout stays CRLF.
 *
 * `business.yaml`, `org-chart.yaml` and `routing.yaml` are plain YAML documents
 * and use `editYaml` in verify/common.ts instead — same Document API, whole
 * file.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseDocument } = require('yaml');

/**
 * The opening fence, the block, the closing fence. Both the block and its
 * trailing newline are optional so an empty header (`---\n---\n`) parses.
 * Captures: 1 BOM · 2 opening EOL · 3 block · 4 block EOL · 5 closing tail.
 */
const FENCE = /^(\uFEFF)?---[ \t]*(\r?\n)(?:([\s\S]*?)(\r?\n))?---[ \t]*(\r?\n|$)/;

/** Splits the header from the body, or null when the file has no header. */
function splitFrontmatter(text) {
  const m = FENCE.exec(text);
  if (!m) return null;
  const [whole, bom = "", openEol, block = "", blockEol, tail = ""] = m;
  return {
    bom,
    block,
    body: text.slice(whole.length),
    eol: (blockEol ?? openEol) === "\r\n" ? "\r\n" : "\n",
    tail,
  };
}

/** Reassembles a file from a split and a new frontmatter block. */
function joinFrontmatter(s, block) {
  const normalized = block.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const withEol = s.eol === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized;
  const head = withEol === "" || withEol === "{}"
    ? `${s.bom}---${s.eol}---${s.tail}`
    : `${s.bom}---${s.eol}${withEol}${s.eol}---${s.tail}`;
  return head + s.body;
}

/** Reads a file's header without touching the body. Null when there is none. */
function readFrontmatter(file) {
  const s = splitFrontmatter(fs.readFileSync(file, "utf8"));
  if (!s) return null;
  let doc = null;
  let parseError = null;
  try {
    // Duplicate keys are what yaml.safe_load tolerated and 581 installed seats
    // were written against: the loader accepts them, so the gate reads them.
    const d = parseDocument(s.block, { uniqueKeys: false });
    if (d.errors.length) parseError = d.errors[0].message;
    else doc = d;
  } catch (e) {
    parseError = String(e?.message ?? e).split("\n")[0];
  }
  const raw = doc ? doc.toJS() : null;
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return { ...s, doc, data, parseError };
}

function hasFrontmatter(file) {
  try { return splitFrontmatter(fs.readFileSync(file, "utf8")) !== null; } catch { return false; }
}

/**
 * Edits one file's frontmatter through the Document API. `mutate` returns true
 * when it changed something; nothing is written otherwise, so a second run over
 * an already-fixed file writes zero bytes (the idempotence every fixer
 * promises). Returns whether the file changed on disk.
 *
 * A file with no header, or a header that does not parse, is left alone — a
 * fixer that cannot read what it is about to rewrite must not rewrite it.
 */
function editFrontmatter(file, mutate) {
  const text = fs.readFileSync(file, "utf8");
  const s = splitFrontmatter(text);
  if (!s) return false;
  let doc;
  try {
    doc = parseDocument(s.block, { uniqueKeys: false });
    if (doc.errors.length) return false;
  } catch { return false; }
  if (!mutate(doc)) return false;
  // lineWidth 0: a header rewritten at the default 80 columns re-wraps every
  // long `description` in the library, which is a diff nobody asked for.
  const out = joinFrontmatter(s, doc.toString({ lineWidth: 0 }));
  if (out === text) return false;
  fs.writeFileSync(file, out, "utf8");
  return true;
}

/**
 * Writes a header onto a file that has none, keeping the body verbatim. Used
 * by the seat-skeleton fixer; never overwrites an existing header.
 */
function prependFrontmatter(file, block, eol = "\n") {
  const text = fs.readFileSync(file, "utf8");
  if (splitFrontmatter(text) !== null) return false;
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? text.slice(1) : text;
  const detected = /\r\n/.test(text) ? "\r\n" : eol;
  const out = joinFrontmatter({ bom, block: "", body, eol: detected, tail: detected }, block);
  fs.writeFileSync(file, out, "utf8");
  return true;
}

/** Every `<dir>/employees/*.md`, sorted — the order every fixer iterates in. */
function employeeFiles(businessDir) {
  const dir = path.join(businessDir, "employees");
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((f) => f.endsWith(".md")).sort().map((f) => path.join(dir, f));
}

module.exports = {
  splitFrontmatter,
  joinFrontmatter,
  readFrontmatter,
  hasFrontmatter,
  editFrontmatter,
  prependFrontmatter,
  employeeFiles,
};
