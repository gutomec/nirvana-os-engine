// frontmatter-edit.ts — typed ESM face of frontmatter-edit.js.
//
// The implementation moved to the CJS sibling so a `.js` caller
// (business-fixers.js) can `require()` it directly, without crossing the ESM
// boundary that only Windows' Bun enforces as a hard error for a `.ts` whose
// dependency chain carries a top-level await (require() of an ESM module
// throws "require() async module" there, and tolerates it on macOS/ubuntu).
// This file re-exports the same values, typed, for the many ESM importers
// that already reference `frontmatter-edit.ts` by that path — an ESM
// `import` of a CJS module never crosses the broken boundary, on any
// platform. Mirrors brief-excerpt.ts/.js, log-paths.ts/.js,
// dependency-graph.ts/.js and entity-graph.ts/.js.
//
// An employee is a seat's method written as prose with a YAML header. The
// mechanical fixers of Business Protocol 2.0 rewrite the header — strip
// `heartbeat`, convert `self_score_contract` into `acceptance[]`, add a pin —
// and must not touch a single byte of what the author wrote below it. Reading
// the file, re-serializing the whole document and writing it back is how a
// fixer silently reflows 581 seats: trailing spaces, tab indentation, the blank
// line before a heading, the exact bytes the writer chose.
//
// So the edit is surgical. The frontmatter block is parsed through the `yaml`
// Document API (comments, key order and the formatting of untouched nodes
// survive), and the file is reassembled as
//
//   <BOM?> --- <eol> <new frontmatter> <eol> --- <tail> <body verbatim>
//
// where the body is the original slice, never re-encoded. Line endings are
// preserved: a CRLF checkout stays CRLF.
//
// `business.yaml`, `org-chart.yaml` and `routing.yaml` are plain YAML documents
// and use `editYaml` in verify/common.ts instead — same Document API, whole
// file.

import type { Document } from "yaml";
import * as impl from "./frontmatter-edit.js";

export interface SplitFrontmatter {
  /** Byte-order mark, when the file carries one. */
  bom: string;
  /** The YAML text between the fences, without its trailing newline. */
  block: string;
  /** Everything after the closing fence, byte for byte. */
  body: string;
  /** The line ending the header uses. */
  eol: "\n" | "\r\n";
  /** What follows the closing `---`: a newline, or nothing at end of file. */
  tail: string;
}

export interface ReadFrontmatter extends SplitFrontmatter {
  /** The parsed header. Null when it does not parse as YAML. */
  doc: Document.Parsed | null;
  /** The header as plain data; `{}` when it is empty or not a mapping. */
  data: Record<string, unknown>;
  parseError: string | null;
}

/** Splits the header from the body, or null when the file has no header. */
export const splitFrontmatter: (text: string) => SplitFrontmatter | null = impl.splitFrontmatter;

/** Reassembles a file from a split and a new frontmatter block. */
export const joinFrontmatter: (s: SplitFrontmatter, block: string) => string = impl.joinFrontmatter;

/** Reads a file's header without touching the body. Null when there is none. */
export const readFrontmatter: (file: string) => ReadFrontmatter | null = impl.readFrontmatter;

export const hasFrontmatter: (file: string) => boolean = impl.hasFrontmatter;

/**
 * Edits one file's frontmatter through the Document API. `mutate` returns true
 * when it changed something; nothing is written otherwise, so a second run over
 * an already-fixed file writes zero bytes (the idempotence every fixer
 * promises). Returns whether the file changed on disk.
 *
 * A file with no header, or a header that does not parse, is left alone — a
 * fixer that cannot read what it is about to rewrite must not rewrite it.
 */
export const editFrontmatter: (file: string, mutate: (doc: Document.Parsed) => boolean) => boolean = impl.editFrontmatter;

/**
 * Writes a header onto a file that has none, keeping the body verbatim. Used
 * by the seat-skeleton fixer; never overwrites an existing header.
 */
export const prependFrontmatter: (file: string, block: string, eol?: "\n" | "\r\n") => boolean = impl.prependFrontmatter;

/** Every `<dir>/employees/*.md`, sorted — the order every fixer iterates in. */
export const employeeFiles: (businessDir: string) => string[] = impl.employeeFiles;
