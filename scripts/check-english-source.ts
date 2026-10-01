#!/usr/bin/env bun
// check-english-source.ts — CI gate: source comments and agentic instruction
// files must be English.
//
// WHAT is checked (the contract, per CONTRIBUTING.md "Conventions"):
//   - Comments in .ts/.js/.mjs/.cjs files (repo root, scripts/, skills/,
//     packaging/) and `#` comments in .sh/.ps1/.py files and bin/ launchers.
//   - String literals in engine source (outside tests): everything the engine
//     prints, shows or sends to an agent is English. Test files are skipped:
//     their PT strings are user-language fixtures.
//   - Every markdown file under skills/ outside tests: instructions,
//     protocols, templates and docs. Fenced code blocks and inline code spans
//     are stripped first; example requests inside them are data.
//
// WHAT is allowed (never flagged):
//   - README locale variants, CHANGELOG history, docs/, localized assets.
//   - Double-quoted spans in markdown ("crie um squad ...") — quoted user
//     utterances and trigger phrases are user-language DATA.
//   - Files listed in FILE_ALLOWLIST (deliberate PT content kept as data).
//   - Any segment (or the line right after) carrying the pragma
//     `i18n-user-facing`, for PT that is data the engine matches against
//     input: stopword and alias lists, regexes, evaluation briefs.
//
// Heuristic (tuned on the live tree; tuning notes in the phase report):
//   A line of comment/prose is PT when EITHER
//     (a) >= 2 distinct PT-exclusive stopwords AND stopword-ratio >= 0.15, OR
//     (b) >= 2 PT-diacritic characters (see PT_DIACRITICS) AND >= 1
//         PT-exclusive stopword — so a lone loanword never fires.
//   A file is reported when it has >= 1 PT line. Report-only by default;
//   --strict exits 1 when any file is flagged.
//
// Usage:
//   bun scripts/check-english-source.ts            # report
//   bun scripts/check-english-source.ts --strict   # CI gate (exit 1 on hits)
//   bun scripts/check-english-source.ts --verbose  # every flagged line

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");
const verbose = process.argv.includes("--verbose");

// ── allowlists ──────────────────────────────────────────────────────────────

const PRAGMA = "i18n-user-facing";

// Path prefixes/segments never scanned (relative to ROOT, forward slashes).
const DIR_SKIPLIST = [
  "node_modules", "dist", "tmp", "_private", ".git",
  "docs", "examples",
  "skills/harness/baselines", "skills/harness/assets",
];

// Files with deliberate PT content (fixtures / user-language data).
const FILE_ALLOWLIST = new Set<string>([
  // Golden routing set + negatives: briefs are PT user data by design.
  "skills/harness/tests/routing-golden-set.jsonl",
  // Mind-clone content scaffold: clone personas are user-library content.
  "skills/_shared/templates/MIND_CLONE_TEMPLATE.md",
  // Bilingual writing contract: quotes PT-BR tells as data on purpose.
  "skills/_shared/templates/writing-contract-snippet.md",
]);

function isAllowedPath(rel: string): boolean {
  const norm = rel.split(sep).join("/");
  if (FILE_ALLOWLIST.has(norm)) return true;
  const base = norm.split("/").pop() || "";
  if (/^README(\..+)?\.md$/i.test(base)) return true;   // locale variants
  if (/^CHANGELOG/i.test(base)) return true;             // history
  if (/\.pt(-br)?\.md$/i.test(base)) return true;        // explicit locale doc
  for (const d of DIR_SKIPLIST) {
    if (norm === d || norm.startsWith(d + "/") || norm.includes("/" + d + "/")) return true;
  }
  return false;
}

// ── PT heuristic ────────────────────────────────────────────────────────────

// PT-exclusive stopwords: common in PT prose, essentially absent from English
// comments. Deliberately EXCLUDED (English collisions): do, no, a, e, um, com
// (".com"), as-only forms that collide with EN words.
const PT_STOPWORDS = new Set([
  "que", "não", "nao", "são", "sao", "está", "esta", "estão", "você", "voce",
  "também", "tambem", "já", "então", "entao", "senão", "senao", "é",
  "para", "pra", "pelo", "pela", "pelos", "pelas", "como", "isso", "esse",
  "essa", "este", "isto", "aqui", "ali", "sempre", "nunca", "quando",
  "depois", "antes", "cada", "todos", "todas", "tudo", "mesmo", "mesma",
  "fazer", "feito", "feita", "sem", "sobre", "entre", "até", "porque",
  "porém", "porem", "mas", "ou", "uma", "umas", "uns", "de", "da", "das",
  "dos", "na", "nas", "aos", "às", "à", "ao", "seu", "sua", "seus", "suas",
  "ele", "ela", "eles", "elas", "nós", "vamos", "foi", "ser", "ter", "tem",
  "têm", "há", "só", "apenas", "muito", "muita", "pouco", "onde", "qual",
  "quais", "quem", "hoje", "ainda", "assim", "caso", "usar", "usado", "usa",
  "roda", "rodar", "rode", "escreva", "escreve", "arquivo", "arquivos",
  "nenhum", "nenhuma", "qualquer", "outro", "outra", "outros", "outras",
]);

const PT_DIACRITICS = /[ãõçáéíóúâêôàÃÕÇÁÉÍÓÚÂÊÔÀüÜ]/g;

interface LineVerdict { pt: boolean; stopHits: number; diacritics: number; }

function classifyLine(text: string): LineVerdict {
  const words = text.toLowerCase().normalize("NFC")
    .replace(/https?:\/\/\S+/g, " ")        // URLs are not prose
    .replace(/"[^"]*"/g, " ")               // double-quoted spans = quoted data
    .replace(/[`*_>#|]/g, " ")
    .split(/[^a-zà-ÿ0-9]+/i)
    .filter(w => w.length > 0);
  if (words.length === 0) return { pt: false, stopHits: 0, diacritics: 0 };
  const hits = new Set<string>();
  for (const w of words) if (PT_STOPWORDS.has(w)) hits.add(w);
  const diacritics = (text.match(PT_DIACRITICS) || []).length;
  const ratio = hits.size / words.length;
  const pt =
    (hits.size >= 2 && ratio >= 0.15) ||
    (diacritics >= 2 && hits.size >= 1);
  return { pt, stopHits: hits.size, diacritics };
}

// ── comment extraction (.ts / .js) ─────────────────────────────────────────

interface Segment { line: number; text: string; }

/** Extract comment text from JS/TS source, stripping string literals first so
 *  PT-BR output strings are never scanned. Line numbers preserved. */
function extractComments(src: string): Segment[] {
  const out: Segment[] = [];
  let i = 0, line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    // string literals — skip whole (incl. template literals, tolerating ${})
    if (c === '"' || c === "'" || c === "`") {
      const quote = c; i++;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "\n") { line++; if (quote !== "`") break; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const start = i + 2;
      let j = start;
      while (j < n && src[j] !== "\n") j++;
      out.push({ line, text: src.slice(start, j) });
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const start = i + 2;
      let j = start, startLine = line;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) {
        if (src[j] === "\n") line++;
        j++;
      }
      const body = src.slice(start, j);
      let ln = startLine;
      for (const partial of body.split("\n")) {
        out.push({ line: ln, text: partial.replace(/^\s*\*\s?/, "") });
        ln++;
      }
      i = j + 2;
      continue;
    }
    i++;
  }
  return out;
}

// ── markdown extraction ─────────────────────────────────────────────────────

/** Markdown prose lines with fenced code blocks, inline code spans and
 *  double-quoted spans removed (fences hold example briefs/commands; quoted
 *  spans hold user utterances and trigger phrases — user-language data). */
function extractMarkdownProse(src: string): Segment[] {
  const out: Segment[] = [];
  let inFence = false;
  const lines = src.split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const text = raw
      .replace(/`[^`]*`/g, " ")
      .replace(/"[^"]*"/g, " ")
      .replace(/[“”][^“”]*[“”]/g, " ");
    out.push({ line: idx + 1, text });
  }
  return out;
}

// ── file discovery ──────────────────────────────────────────────────────────

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(ROOT, full);
    if (isAllowedPath(rel)) continue;
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function codeFiles(): string[] {
  const out: string[] = [];
  // repo-root loose .ts (build scripts)
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile() && /\.(ts|js)$/.test(entry.name)) out.push(join(ROOT, entry.name));
  }
  for (const dir of ["scripts", "skills", "packaging"]) {
    const full = join(ROOT, dir);
    if (!existsSync(full)) continue;
    for (const f of walk(full)) if (/\.(ts|js|mjs|cjs)$/.test(f) && !f.endsWith(".d.ts")) out.push(f);
  }
  return out;
}

/** Shell, PowerShell and Python sources, plus the extensionless launchers in
 *  bin/: only their `#` comments are read. */
function hashCommentFiles(): string[] {
  const out: string[] = [];
  for (const dir of ["scripts", "skills", "packaging", "bin"]) {
    const full = join(ROOT, dir);
    if (!existsSync(full)) continue;
    for (const f of walk(full)) {
      const rel = relative(ROOT, f).split(sep).join("/");
      if (/\.(sh|ps1|py)$/.test(f) || /^bin\/[^/.]+$/.test(rel)) out.push(f);
    }
  }
  return out;
}

function extractHashComments(src: string): Segment[] {
  const out: Segment[] = [];
  src.split("\n").forEach((raw, idx) => {
    if (idx === 0 && raw.startsWith("#!")) return;
    const m = raw.match(/^\s*#(?!!)\s?(.*)$/);
    if (m) out.push({ line: idx + 1, text: m[1] });
  });
  return out;
}

function instructionMdFiles(): string[] {
  const out: string[] = [];
  const skills = join(ROOT, "skills");
  if (!existsSync(skills)) return out;
  // Every markdown file the engine ships is instructions or documentation, and
  // both are English. Fixtures live under tests/ and are skipped.
  for (const f of walk(skills)) {
    if (!f.endsWith(".md")) continue;
    const rel = relative(ROOT, f).split(sep).join("/");
    if (/(^|\/)tests?\//.test(rel)) continue;
    out.push(f);
  }
  return out;
}

// ── user-facing strings (.ts / .js) ─────────────────────────────────────────
//
// The strings a buyer reads, which this gate used to skip on purpose. It no
// longer does: English is the project default, and the buyer who reported the
// license bug got a Portuguese error. Comments and identifiers were already
// covered; the output was the half nobody was watching.
//
// Every quoted span is scanned, line by line: output calls, prompts sent to an
// agent, setting descriptions, help text. A slug, a path or a single keyword
// never trips the heuristic; a PT sentence does. Use the `i18n-user-facing`
// pragma on the line or the one above it for PT that is data (a stopword list,
// an example brief the router is evaluated on).
const isTestFile = (rel: string) => /(^|\/)tests?\//.test(rel) || /\.test\.[tj]s$/.test(rel);

function extractUserFacingStrings(src: string): Segment[] {
  // A small tokenizer: comments and regex literals are skipped, every string
  // body is kept with its line numbers, so a prompt written as a multi-line
  // template literal is read line by line like prose. Interpolations are
  // dropped: `${slug}` is an identifier, not prose.
  const out: Segment[] = [];
  let i = 0, line = 1, prev = "";
  const n = src.length;
  const emit = (body: string, startLine: number) => {
    let ln = startLine;
    for (const part of body.split("\n")) {
      const text = part.replace(/\\x1b\[[0-9;]*m/g, " ").trim();
      if (text) out.push({ line: ln, text });
      ln++;
    }
  };
  while (i < n) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") line++; i++; }
      i += 2; continue;
    }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || /\breturn$/.test(src.slice(Math.max(0, i - 7), i).trimEnd()))) {
      i++;
      let inClass = false;
      while (i < n && src[i] !== "\n") {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) { i++; break; }
        i++;
      }
      prev = "/"; continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c, startLine = line;
      let body = "";
      i++;
      while (i < n) {
        const d = src[i];
        if (d === "\\") { body += " "; i += 2; continue; }
        if (d === "\n") { line++; if (quote !== "`") break; }
        if (d === quote) { i++; break; }
        if (quote === "`" && d === "$" && src[i + 1] === "{") {
          let depth = 1; i += 2; body += " ";
          while (i < n && depth > 0) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") depth--;
            else if (src[i] === "\n") { line++; body += "\n"; }
            i++;
          }
          continue;
        }
        body += d; i++;
      }
      emit(body, startLine);
      prev = "x"; continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

// ── scan ────────────────────────────────────────────────────────────────────

interface FileReport { rel: string; hits: Array<Segment & LineVerdict>; }

function scanFile(file: string, kind: "code" | "hash" | "md"): FileReport | null {
  const rel = relative(ROOT, file);
  let src: string;
  try { src = readFileSync(file, "utf8"); } catch { return null; }
  if (src.includes(`${PRAGMA}: file`)) return null; // whole-file pragma
  const relPosix = rel.split(sep).join("/");
  const segments = kind === "code"
    ? [...extractComments(src), ...(isTestFile(relPosix) ? [] : extractUserFacingStrings(src))]
    : kind === "hash" ? extractHashComments(src) : extractMarkdownProse(src);
  const rawLines = src.split("\n");
  const hits: FileReport["hits"] = [];
  for (const seg of segments) {
    if (seg.text.includes(PRAGMA)) continue;
    // pragma on the segment's own source line or the line above exempts it
    const own = rawLines[seg.line - 1] || "";
    const above = rawLines[seg.line - 2] || "";
    if (own.includes(PRAGMA) || above.includes(PRAGMA)) continue;
    const v = classifyLine(seg.text);
    if (v.pt) hits.push({ ...seg, ...v });
  }
  return hits.length ? { rel, hits } : null;
}

const reports: FileReport[] = [];
let scannedCode = 0, scannedMd = 0;
for (const f of codeFiles()) { scannedCode++; const r = scanFile(f, "code"); if (r) reports.push(r); }
for (const f of hashCommentFiles()) { scannedCode++; const r = scanFile(f, "hash"); if (r) reports.push(r); }
for (const f of instructionMdFiles()) { scannedMd++; const r = scanFile(f, "md"); if (r) reports.push(r); }
reports.sort((a, b) => b.hits.length - a.hits.length);

// ── report ──────────────────────────────────────────────────────────────────

const totalLines = reports.reduce((s, r) => s + r.hits.length, 0);
console.log("ENGLISH SOURCE CHECK" + (strict ? " (--strict)" : " (report-only)"));
console.log(`  scanned ......... ${scannedCode} code files + ${scannedMd} instruction .md files`);
console.log(`  flagged ......... ${reports.length} files · ${totalLines} PT lines`);
console.log("");

for (const r of reports) {
  console.log(`${r.rel}  (${r.hits.length} PT line${r.hits.length === 1 ? "" : "s"})`);
  const show = verbose ? r.hits : r.hits.slice(0, 3);
  for (const h of show) {
    console.log(`    L${String(h.line).padStart(4)}  ${h.text.trim().slice(0, 96)}`);
  }
  if (!verbose && r.hits.length > 3) console.log(`    … ${r.hits.length - 3} more (use --verbose)`);
}
if (reports.length === 0) console.log("  (clean — all scanned comments/instructions are English)");

if (strict && reports.length > 0) process.exit(1);
process.exit(0);
