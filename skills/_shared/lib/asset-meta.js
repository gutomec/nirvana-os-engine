/**
 * asset-meta.js — universal frontmatter loader for Nirvana assets.
 *
 * Returns a normalized struct from any markdown/yaml file regardless of which
 * frontmatter convention it uses:
 *
 *   1. Universal frontmatter (preferred — see asset-meta.schema.json):
 *        ---
 *        type: business
 *        slug: ads-intelligence
 *        title: Ads Intelligence
 *        links: [media-monarch, performance-growth-lab]
 *        ---
 *
 *   2. Legacy v2 nested task frontmatter:
 *        ---
 *        task: writeFinalReport()
 *        responsavel: ReportWriter
 *        atomic_layer: Organism
 *        ---
 *
 *   3. v4 flat task frontmatter:
 *        ---
 *        name: write-final-report
 *        description: ...
 *        target_words: [1500, 3500]
 *        ---
 *
 *   4. business.yaml / squad.yaml top-level fields (no frontmatter, raw YAML).
 *
 * The lib never throws — every file is loadable. Missing fields return null.
 * It is host-agnostic and OS-agnostic: pure node/Bun, no shell, no platform
 * APIs.
 *
 * Usage:
 *   const meta = loadMeta('/path/to/file.md');
 *   // → { type, slug, title, links, tags, source, status,
 *   //     created, updated, version, raw, body, format, path }
 */

'use strict';

const fs = require('fs');
const path = require('path');

let _yaml = null;
function loadYamlParser() {
  if (_yaml) return _yaml;
  try { _yaml = require('yaml'); return _yaml; } catch { /* fall through */ }
  _yaml = { parse: parseSimpleYaml };
  return _yaml;
}

// Tiny YAML parser used as fallback when the squads `yaml` package is not
// resolvable. Handles the subset used in our frontmatter: top-level scalars,
// inline arrays `[a, b]`, and block lists `- item`. Does NOT support nested
// maps, anchors, or complex strings — those go through the real parser.
function parseSimpleYaml(src) {
  const out = {};
  const lines = src.split(/\r?\n/);
  let currentList = null;
  for (const ln of lines) {
    if (!ln.trim() || ln.trim().startsWith('#')) continue;
    const indent = ln.length - ln.trimStart().length;
    if (indent === 0) {
      const m = ln.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (!m) continue;
      const [, key, rawVal] = m;
      let val = rawVal.trim();
      if (val === '' || val === '|' || val === '>') {
        currentList = key; out[key] = []; continue;
      }
      currentList = null;
      if (val.startsWith('[') && val.endsWith(']')) {
        out[key] = val.slice(1, -1).split(',').map(s => parseScalar(s.trim())).filter(x => x !== '' && x != null);
        continue;
      }
      out[key] = parseScalar(val);
    } else if (currentList && ln.trim().startsWith('- ')) {
      out[currentList].push(parseScalar(ln.trim().slice(2).trim()));
    }
  }
  return out;
}

function parseScalar(s) {
  if (s === 'null' || s === '~' || s === '') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

function splitFrontmatter(content) {
  const text = stripBom(content);
  const m = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: null, body: text };
  return { frontmatter: m[1], body: m[2] };
}

function looksLikeYamlFile(filePath) {
  return /\.(ya?ml)$/i.test(filePath);
}

function looksLikeMarkdown(filePath) {
  return /\.(md|markdown)$/i.test(filePath);
}

function inferType(filePath, raw) {
  if (raw && typeof raw.type === 'string') return raw.type;
  // Infer from path heuristics
  const lower = filePath.toLowerCase().replace(/\\/g, '/');
  if (/\/squads\/[^/]+\/squad\.ya?ml$/i.test(lower)) return 'squad';
  if (/\/businesses\/[^/]+\/business\.ya?ml$/i.test(lower)) return 'business';
  if (/\/mind-clones\//i.test(lower)) return 'mind-clone';
  if (/\/research\//i.test(lower)) return 'research';
  if (/\/decisions\.md$/i.test(lower)) return 'decision';
  if (/\/brief\.md$/i.test(lower)) return 'brief';
  if (/\/tasks\/[^/]+\.md$/i.test(lower)) return 'task';
  if (/\/agents\/[^/]+\.md$/i.test(lower)) return 'agent';
  if (/\/employees\/[^/]+\.md$/i.test(lower)) return 'employee';
  if (/\/workflows\/[^/]+\.ya?ml$/i.test(lower)) return 'workflow';
  return null;
}

function inferSlug(filePath, raw) {
  if (raw) {
    if (typeof raw.slug === 'string') return raw.slug;
    if (typeof raw.name === 'string') return String(raw.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  }
  // From file path: <dir>/<slug>.md OR <slug>/squad.yaml etc
  const base = path.basename(filePath, path.extname(filePath));
  if (base === 'squad' || base === 'business' || base === 'index' || base === 'README') {
    return path.basename(path.dirname(filePath));
  }
  return base;
}

function inferTitle(raw, fallback) {
  if (!raw) return fallback;
  if (typeof raw.title === 'string') return raw.title;
  if (typeof raw.name === 'string' && raw.name.length < 256) return raw.name;
  if (typeof raw.task === 'string') return raw.task;
  return fallback;
}

function asArray(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

function loadMeta(filePath) {
  const result = {
    path: filePath,
    type: null,
    slug: null,
    title: null,
    links: [],
    tags: [],
    source: null,
    status: null,
    created: null,
    updated: null,
    version: null,
    raw: {},
    body: '',
    format: 'unknown',
    error: null,
  };
  if (!fs.existsSync(filePath)) {
    result.error = 'file-not-found';
    return result;
  }
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); }
  catch (e) { result.error = `read-failed: ${e.message}`; return result; }

  const yaml = loadYamlParser();
  let raw = {};
  let body = content;

  if (looksLikeYamlFile(filePath)) {
    result.format = 'yaml';
    try { raw = yaml.parse(content) || {}; }
    catch (e) { result.error = `yaml-parse-failed: ${e.message}`; }
  } else {
    const split = splitFrontmatter(content);
    body = split.body;
    if (split.frontmatter) {
      result.format = 'frontmatter';
      try { raw = yaml.parse(split.frontmatter) || {}; }
      catch (e) { result.error = `frontmatter-parse-failed: ${e.message}`; }
    } else {
      result.format = 'markdown-bare';
    }
  }

  // Legacy v2 task: `task` field nested + responsavel
  if (raw && typeof raw.task === 'object' && raw.task !== null) {
    // v2-deep nested form
    const inner = raw.task;
    raw = Object.assign({}, raw, inner);
  }

  result.raw = raw;
  result.body = body;
  result.type = inferType(filePath, raw);
  result.slug = inferSlug(filePath, raw);
  result.title = inferTitle(raw, result.slug);
  result.links = asArray(raw.links);
  result.tags = asArray(raw.tags);
  result.source = typeof raw.source === 'string' ? raw.source : null;
  result.status = typeof raw.status === 'string' ? raw.status : null;
  result.created = typeof raw.created === 'string' ? raw.created : null;
  result.updated = typeof raw.updated === 'string' ? raw.updated : null;
  result.version = typeof raw.version === 'string' ? raw.version : null;
  return result;
}

module.exports = { loadMeta, splitFrontmatter, parseSimpleYaml, asArray };
