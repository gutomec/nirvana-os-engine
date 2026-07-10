/**
 * link-extractor.js — discover outbound cross-references in markdown/yaml
 * content for graph building and consistency lint.
 *
 * Detects:
 *   - Wikilinks:           [[slug]] or [[slug|alias]]
 *   - Markdown links:      [text](slug.md) or [text](path/to/slug)
 *   - YAML refs:           `links: [a, b]` and `dependencies: [...]`
 *   - Squad capability ID: capabilities[].id (e.g. "marketing.funnel.create")
 *   - Mind-clone refs:     `dna: [name]`, `mind_clone: name`
 *
 * Skips http(s)://, mailto:, tel:, anchor-only #foo, and resolved absolute
 * paths whose targets cannot be slug-mapped.
 *
 * Returns Array<{ target, kind, raw, line? }> — caller normalizes/dedupes.
 *
 * Pure JS, zero deps. Cross-OS via path.posix for slug normalization.
 */

'use strict';

const path = require('path');

const WIKILINK_RE = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
const MD_LINK_RE = /(?<!!)\[[^\]]*\]\(([^)\s#?]+)/g;
const EXTERNAL_RE = /^(?:[a-z][a-z0-9+.\-]*:|\/\/|#)/i;

function isExternal(t) { return EXTERNAL_RE.test(t); }

function targetToSlug(t) {
  if (!t || typeof t !== 'string') return null;
  let s = t.trim();
  if (isExternal(s)) return null;
  // strip query + fragment
  s = s.replace(/[?#].*$/, '');
  // file extensions
  s = s.replace(/\.(md|markdown|ya?ml|html?)$/i, '');
  // path → basename when it looks like a relative file
  if (s.includes('/')) {
    const parts = s.split(/\/+/).filter(Boolean);
    s = parts[parts.length - 1];
  }
  s = s.toLowerCase().trim();
  if (!s || s === '.' || s === '..') return null;
  return s;
}

function lineOfOffset(content, offset) {
  return content.slice(0, offset).split('\n').length;
}

function extractFromContent(content) {
  const out = [];
  if (typeof content !== 'string' || !content) return out;
  WIKILINK_RE.lastIndex = 0;
  let m;
  while ((m = WIKILINK_RE.exec(content)) !== null) {
    const slug = targetToSlug(m[1]);
    if (slug) out.push({ target: slug, kind: 'wikilink', raw: m[0], line: lineOfOffset(content, m.index) });
  }
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(content)) !== null) {
    const slug = targetToSlug(m[1]);
    if (slug) out.push({ target: slug, kind: 'mdlink', raw: m[0], line: lineOfOffset(content, m.index) });
  }
  return out;
}

function extractFromYaml(yamlObj) {
  const out = [];
  if (!yamlObj || typeof yamlObj !== 'object') return out;
  // Frontmatter universal: links: [...]
  if (Array.isArray(yamlObj.links)) {
    for (const v of yamlObj.links) {
      const slug = targetToSlug(String(v));
      if (slug) out.push({ target: slug, kind: 'yaml-link' });
    }
  }
  // dependencies (used by squads)
  if (Array.isArray(yamlObj.dependencies)) {
    for (const v of yamlObj.dependencies) {
      const slug = targetToSlug(String(v));
      if (slug) out.push({ target: slug, kind: 'yaml-dep' });
    }
  }
  // Single dna reference
  if (typeof yamlObj.mind_clone === 'string') {
    const slug = targetToSlug(yamlObj.mind_clone);
    if (slug) out.push({ target: slug, kind: 'mind-clone' });
  }
  if (Array.isArray(yamlObj.dna)) {
    for (const v of yamlObj.dna) {
      const slug = targetToSlug(typeof v === 'string' ? v : (v && v.name) || '');
      if (slug) out.push({ target: slug, kind: 'dna' });
    }
  }
  // Squad capabilities — emit capability IDs as nodes
  if (Array.isArray(yamlObj.capabilities)) {
    for (const cap of yamlObj.capabilities) {
      if (cap && typeof cap.id === 'string') {
        out.push({ target: cap.id, kind: 'capability' });
      }
    }
  }
  // Routing matrix (businesses): routes: { capability_id: { squad: <slug>, ... } }
  if (yamlObj.routes && typeof yamlObj.routes === 'object') {
    for (const [capId, route] of Object.entries(yamlObj.routes)) {
      if (route && typeof route === 'object' && typeof route.squad === 'string') {
        out.push({ target: targetToSlug(route.squad) || route.squad, kind: 'route-squad', via: capId });
      }
    }
  }
  return out;
}

function dedupe(links) {
  const seen = new Set();
  const out = [];
  for (const l of links) {
    const key = `${l.kind}|${l.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

/**
 * Convenience: extract from a meta object (output of asset-meta.loadMeta).
 * Uses both the body content and the parsed frontmatter.
 */
function extractFromMeta(meta) {
  const out = [];
  if (!meta) return out;
  out.push(...extractFromContent(meta.body || ''));
  out.push(...extractFromYaml(meta.raw || {}));
  return dedupe(out);
}

module.exports = { extractFromContent, extractFromYaml, extractFromMeta, targetToSlug, dedupe };
