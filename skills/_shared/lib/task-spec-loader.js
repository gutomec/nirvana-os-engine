/**
 * task-spec-loader.js — parse YAML frontmatter from squad task .md files.
 *
 * Returns a normalized struct:
 *   {
 *     name,
 *     description,
 *     target_words,         // [min, max] | null
 *     word_target,          // number | null (alternative to range)
 *     tolerance,            // number | null (used with word_target)
 *     required_sections,    // string[] | null
 *     allowed_tools,        // string[] | null
 *     version,              // string | null
 *     raw,                  // entire frontmatter object
 *     body,                 // markdown body without frontmatter
 *   }
 *
 * Reuses the YAML parser bundled under the squads skill (no new deps).
 *
 * Robust to: missing frontmatter, malformed YAML, unknown fields, BOM.
 */

'use strict';

const fs = require('fs');

let _yaml = null;
function loadYaml() {
  if (_yaml) return _yaml;
  try { _yaml = require('yaml'); return _yaml; } catch { /* fall through */ }
  // Fallback: tiny inline parser for top-level scalars + arrays. Not full YAML.
  _yaml = {
    parse(src) { return parseSimpleYaml(src); },
  };
  return _yaml;
}

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
      // inline arrays: [a, b]
      if (val.startsWith('[') && val.endsWith(']')) {
        out[key] = val.slice(1, -1).split(',').map(s => parseScalar(s.trim())).filter(x => x !== '');
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

function loadTaskSpec(taskFilePath) {
  if (!fs.existsSync(taskFilePath)) {
    return { error: `task file not found: ${taskFilePath}` };
  }
  const content = fs.readFileSync(taskFilePath, 'utf8');
  const { frontmatter, body } = splitFrontmatter(content);
  let raw = {};
  if (frontmatter) {
    try {
      const yaml = loadYaml();
      raw = yaml.parse(frontmatter) || {};
    } catch (e) {
      return { error: `frontmatter parse failed: ${e.message}`, body };
    }
  }
  return {
    name: typeof raw.name === 'string' ? raw.name : null,
    description: typeof raw.description === 'string' ? raw.description : null,
    target_words: Array.isArray(raw.target_words) && raw.target_words.length === 2
      ? raw.target_words.map(Number)
      : null,
    word_target: Number.isFinite(raw.word_target) ? Number(raw.word_target) : null,
    tolerance: Number.isFinite(raw.tolerance) ? Number(raw.tolerance) : null,
    required_sections: Array.isArray(raw.required_sections)
      ? raw.required_sections.map(String)
      : null,
    allowed_tools: Array.isArray(raw.allowed_tools)
      ? raw.allowed_tools.map(String)
      : (typeof raw['allowed-tools'] === 'string' ? raw['allowed-tools'].split(',').map(s => s.trim()) : null),
    version: typeof raw.version === 'string' ? raw.version : null,
    raw,
    body,
    path: taskFilePath,
  };
}

/**
 * Build the volume_targets map that quality-judge expects from a list of
 * (relPath, taskSpec) pairs.
 */
function specsToVolumeTargets(specs) {
  const out = {};
  for (const { relPath, spec } of specs) {
    if (spec.target_words) out[relPath] = { target_words: spec.target_words };
    else if (spec.word_target != null) out[relPath] = { word_target: spec.word_target, tolerance: spec.tolerance ?? 0.20 };
  }
  return out;
}

module.exports = { loadTaskSpec, splitFrontmatter, specsToVolumeTargets };
