#!/usr/bin/env node
/**
 * inject-deps.js — adds the canonical Pixelle dependencies.yaml to every
 * video-capable squad. Idempotent (won't overwrite a custom dependencies.yaml).
 *
 * Squads that already have a custom dependencies.yaml are skipped — they
 * declared their own and we don't clobber. Squads with no dependencies.yaml
 * receive the canonical Pixelle template.
 *
 * Usage:
 *   node inject-deps.js
 *   node inject-deps.js --dry-run
 *   node inject-deps.js --slug instagram-intelligence-nirvana
 *   node inject-deps.js --force      # overwrite existing dependencies.yaml
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const SQUADS_DIR = process.env.SQUADS_DIR || path.join(HOME, 'squads');
const SHARED_DIR = path.dirname(__filename);
const TEMPLATE = path.join(SHARED_DIR, 'dependencies.yaml');

const VIDEO_CAPABLE_SQUADS = [
  'brandcraft', 'brandcraft-nirvana', 'content-multiplier-squad',
  'instagram-intelligence-nirvana', 'nirvana-agencia-marketing',
  'nirvana-coach-mentor', 'nirvana-concessionaria', 'nirvana-curso-online',
  'nirvana-hotelaria', 'nirvana-imobiliaria', 'nirvana-musico',
  'nirvana-personal-trainer', 'nirvana-podcast', 'nirvana-produtora-video',
  'nirvana-realestate-videomaker', 'nirvana-restaurante', 'nirvana-salao-beleza',
  'nirvana-video-creator', 'notebooklm-automation', 'proposal-forge-squad',
  'support-hub-squad',
];

function injectInto(slug, { dryRun, force }) {
  const squadDir = path.join(SQUADS_DIR, slug);
  if (!fs.existsSync(squadDir)) return { slug, ok: false, reason: 'squad_dir_missing' };
  const dst = path.join(squadDir, 'dependencies.yaml');
  if (fs.existsSync(dst) && !force) {
    return { slug, ok: true, action: 'skipped (already exists; use --force to overwrite)' };
  }
  if (dryRun) return { slug, ok: true, action: 'would_inject', dst };
  fs.copyFileSync(TEMPLATE, dst);
  return { slug, ok: true, action: 'injected', dst };
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const slugIdx = args.indexOf('--slug');
  const targets = slugIdx !== -1 ? [args[slugIdx + 1]] : VIDEO_CAPABLE_SQUADS;
  const results = targets.map(s => injectInto(s, { dryRun, force }));
  console.log(JSON.stringify({
    template: TEMPLATE,
    targets: targets.length,
    dry_run: dryRun,
    force,
    ok: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    results,
  }, null, 2));
}

main();
