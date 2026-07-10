/**
 * artifact-existence-gate.js — deterministic check that asset references in
 * HTML/Markdown/CSS resolve to files that exist on disk.
 *
 * Catches the Foguero-style bug: a landing page references `assets/menu-01-xixo.png`
 * (and 15 others) that were never produced. Rendered with broken image icons.
 * No LLM needed — regex over href/src + fs.existsSync.
 *
 * Usage:
 *   const r = checkFile(path);
 *   // → { ok: bool, refs: [{ kind, target, line, exists }], missing: [...], placeholders: [...] }
 *
 *   const dir = checkDir(rootPath, { extensions: ['.html', '.md'] });
 *   // → { ok, files: [{ path, ...checkFile result }], totals: { missing, placeholders } }
 *
 * Placeholder convention: a reference is treated as expected-pending when an
 * adjacent comment marks it as such. Examples (case-insensitive):
 *   <!-- placeholder: assets/menu-01-xixo.png -->
 *   {/* placeholder: foo.png * /}              (markdown allows this loose form)
 *   <!-- pending-asset: hero.png expected after wave 2 -->
 * The path inside the placeholder must contain the same target string the
 * reference uses, otherwise the check still flags it. This avoids "wave 2 will
 * fix it" hand-waving without a concrete commit.
 *
 * External URLs (http/https/data:/mailto:/tel:) are skipped — only local paths
 * are validated.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PLACEHOLDER_RE = /(?:placeholder|pending-asset)\s*:\s*([^\s>*\/]+)/gi;

const PATTERNS = [
  // HTML: src="...", href="...", srcset="..."
  { kind: 'src',  re: /\bsrc\s*=\s*["']([^"'#?]+)["']/gi },
  { kind: 'href', re: /\bhref\s*=\s*["']([^"'#?]+)["']/gi },
  { kind: 'srcset', re: /\bsrcset\s*=\s*["']([^"']+)["']/gi },
  { kind: 'css-url', re: /url\(\s*["']?([^"')]+)["']?\s*\)/gi },
  // Markdown: ![alt](path), [text](path)
  { kind: 'md-img', re: /!\[[^\]]*\]\(([^)\s#?]+)/g },
  { kind: 'md-link', re: /(?<!!)\[[^\]]*\]\(([^)\s#?]+)/g },
];

function isExternal(url) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url);
}

function findPlaceholders(content) {
  const found = new Set();
  PLACEHOLDER_RE.lastIndex = 0;
  let m;
  while ((m = PLACEHOLDER_RE.exec(content)) !== null) {
    found.add(m[1].trim());
  }
  return found;
}

function lineFromOffset(content, offset) {
  return content.slice(0, offset).split('\n').length;
}

function extractRefs(content) {
  const refs = [];
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      let raw = m[1];
      if (kind === 'srcset') {
        // srcset values are comma-separated "url 1x, url 2x" — take URLs only
        for (const part of raw.split(',')) {
          const url = part.trim().split(/\s+/)[0];
          if (url) refs.push({ kind, target: url, offset: m.index });
        }
      } else {
        refs.push({ kind, target: raw.trim(), offset: m.index });
      }
    }
  }
  return refs;
}

function checkFile(filePath, opts = {}) {
  const baseDir = opts.baseDir || path.dirname(filePath);
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: 'file-not-found', path: filePath, refs: [], missing: [], placeholders: [] };
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const placeholders = findPlaceholders(content);
  const rawRefs = extractRefs(content);

  const refs = [];
  for (const r of rawRefs) {
    if (isExternal(r.target)) continue;
    const resolved = path.resolve(baseDir, r.target);
    const exists = fs.existsSync(resolved);
    const isPlaceheld = [...placeholders].some(p => r.target.includes(p) || p.includes(r.target));
    refs.push({
      kind: r.kind,
      target: r.target,
      resolved,
      line: lineFromOffset(content, r.offset),
      exists,
      placeholder: isPlaceheld,
    });
  }

  const missing = refs.filter(r => !r.exists && !r.placeholder);
  const placeholdersOnly = refs.filter(r => !r.exists && r.placeholder);

  return {
    ok: missing.length === 0,
    path: filePath,
    refs,
    missing,
    placeholders: placeholdersOnly,
  };
}

function walkFiles(root, exts) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        stack.push(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (exts.has(ext)) out.push(full);
      }
    }
  }
  return out;
}

function checkDir(root, opts = {}) {
  const exts = new Set((opts.extensions || ['.html', '.htm', '.md', '.markdown', '.css']).map(s => s.toLowerCase()));
  const files = walkFiles(root, exts);
  const results = files.map(f => checkFile(f, { baseDir: opts.baseDir || path.dirname(f) }));
  const totals = {
    files_scanned: results.length,
    refs_total: results.reduce((s, r) => s + (r.refs?.length || 0), 0),
    missing: results.reduce((s, r) => s + r.missing.length, 0),
    placeholders: results.reduce((s, r) => s + r.placeholders.length, 0),
  };
  return { ok: totals.missing === 0, files: results, totals };
}

module.exports = { checkFile, checkDir, extractRefs, findPlaceholders };
