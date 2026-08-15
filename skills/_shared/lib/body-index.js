'use strict';
/**
 * body-index.js — the text a capability actually executes, made retrievable.
 *
 * What the index sees today is what a capability *says about itself*:
 * description, keywords, example_briefs, produces. What it never sees is the
 * task doc, the agent body, the workflow — 5,767 files and ~16 MB where the
 * method actually lives. A squad can name the exact tool, format, standard and
 * failure mode a user is asking about, and none of it is retrievable.
 *
 * Measured on a catalogue of ~80,000 skills (arXiv:2603.22455): routing that
 * sees only names and descriptions loses 37-44 percentage points against
 * routing that sees the body, and the gap holds "in every description-length
 * quartile, including the longest". Writing a longer description does not
 * substitute for indexing the body.
 *
 * Two constraints shape everything here:
 *
 * 1. **Index time, never route time.** route() runs thousands of times in an
 *    eval; reading files there would be ruinous. The extraction happens once,
 *    during `nrv index`, and the result is stored in the registry.
 * 2. **Recall, not precision.** The body is prose written for an executing
 *    agent, not for a matcher. It widens what can be *found*; the curated
 *    metadata keeps deciding what *wins*. See the score cap in router.js.
 */
const fs = require('fs');
const path = require('path');

/** Characters of retained text per capability. Measured on 106 task docs: median
 *  1,349, p90 3,022, and only 2% above this. The cap exists for the outlier —
 *  the largest agent body in the library is 36 KB, and indexing it whole would
 *  hand one capability more length budget than a hundred others together. */
const BODY_BUDGET = 4000;

/** Scaffold headings every task doc repeats. They are structure, not vocabulary. */
const SCAFFOLD = /^#{1,6}\s*(objetivo|objective|output|outputs?|input|inputs?|processo|process|anti-?patterns?|antipadr[õo]es|crit[ée]rios?|acceptance|checklist|passos?|steps?|formato|format|exemplo|example)s?\b.*$/gim;

/**
 * Strip everything a matcher cannot use.
 *
 * Code blocks, front matter, URLs and paths are noise with high token mass:
 * they would dominate a BM25 document without discriminating between
 * capabilities, since every squad's task docs contain the same shapes.
 */
function clean(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  return raw
    .replace(/^---[\s\S]*?^---/m, ' ')          // YAML front matter
    .replace(/```[\s\S]*?```/g, ' ')            // fenced code
    .replace(/`[^`\n]{1,120}`/g, ' ')           // inline code
    .replace(/https?:\/\/\S+/g, ' ')            // urls
    .replace(/[\w./-]*\/[\w./-]+\.\w{1,5}\b/g, ' ') // file paths
    .replace(SCAFFOLD, ' ')
    .replace(/[|>#*_`~\[\]()-]{2,}/g, ' ')      // table pipes, rules, markdown noise
    .replace(/\s+/g, ' ')
    .trim();
}

function readIfFile(p) {
  try {
    if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) return '';
    return fs.readFileSync(p, 'utf8');
  } catch { return ''; }
}

/** `ref` may carry an extension or not, and may name a dir-relative file. */
function resolveRef(squadDir, ref, kind) {
  if (typeof ref !== 'string' || !ref) return '';
  const exts = kind === 'workflow' ? ['', '.yaml', '.yml'] : ['', '.md'];
  const bases = [ref, path.join(kind === 'agent' ? 'agents' : kind === 'workflow' ? 'workflows' : 'tasks', ref)];
  for (const b of bases) {
    for (const e of exts) {
      const p = path.join(squadDir, b + e);
      const t = readIfFile(p);
      if (t) return t;
    }
  }
  return '';
}

/** A workflow expands to the union of what it runs — that is the material that
 *  decides whether the capability fits a brief, not the DAG itself. */
function expandWorkflow(squadDir, raw) {
  const parts = [raw];
  // Deliberately regex, not a YAML parse: a malformed workflow must degrade to
  // "less body text", never to a failed index.
  for (const m of raw.matchAll(/^\s*-?\s*(?:agent|task):\s*["']?([\w./-]+)["']?\s*$/gim)) {
    const name = m[1];
    parts.push(resolveRef(squadDir, name, 'task'));
    parts.push(resolveRef(squadDir, name, 'agent'));
  }
  return parts.filter(Boolean).join(' ');
}

/**
 * The body text for one capability, cleaned and capped.
 *
 * Never throws: a capability whose ref does not resolve simply has no body
 * document, and keeps the metadata document it always had. Body indexing is
 * additive — it cannot take a capability out of the index.
 */
function bodyTextFor(manifestPath, invoke) {
  try {
    if (!invoke || typeof invoke !== 'object') return '';
    const squadDir = path.dirname(manifestPath);
    const type = invoke.type;
    const ref = invoke.ref;
    let raw = '';
    if (type === 'workflow') {
      const wf = resolveRef(squadDir, ref, 'workflow');
      raw = wf ? expandWorkflow(squadDir, wf) : '';
    } else if (type === 'agent') {
      raw = resolveRef(squadDir, ref, 'agent');
    } else {
      // task, and anything unrecognised: a task doc plus its bound agent.
      raw = [resolveRef(squadDir, ref, 'task'), resolveRef(squadDir, invoke.agent, 'agent')]
        .filter(Boolean).join(' ');
    }
    const t = clean(raw);
    return t.length > BODY_BUDGET ? t.slice(0, BODY_BUDGET) : t;
  } catch { return ''; }
}

module.exports = { bodyTextFor, clean, BODY_BUDGET };
