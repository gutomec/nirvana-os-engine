#!/usr/bin/env node
/**
 * inject-capability.js — adds the canonical Pixelle capability to every
 * video-capable squad's squad.yaml. Idempotent: re-running is a no-op.
 *
 * Usage:
 *   node inject-capability.js                     # injects into the canonical list
 *   node inject-capability.js --list              # shows the canonical list
 *   node inject-capability.js --slug <slug>       # injects into one squad only
 *   node inject-capability.js --dry-run           # report what would change
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const SQUADS_DIR = process.env.SQUADS_DIR || path.join(HOME, 'squads');
const SHARED_DIR = path.dirname(__filename);

let YAML;
try { YAML = require('yaml'); }
catch {
  console.error('[inject-capability] yaml module not found. Re-run from a Nirvana host.');
  process.exit(2);
}

const CAPABILITY = YAML.parse(fs.readFileSync(path.join(SHARED_DIR, 'CAPABILITY.yaml'), 'utf8'));

const VIDEO_CAPABLE_SQUADS = [
  'brandcraft',
  'brandcraft-nirvana',
  'content-multiplier-squad',
  'instagram-intelligence-nirvana',
  'nirvana-agencia-marketing',
  'nirvana-coach-mentor',
  'nirvana-concessionaria',
  'nirvana-curso-online',
  'nirvana-hotelaria',
  'nirvana-imobiliaria',
  'nirvana-musico',
  'nirvana-personal-trainer',
  'nirvana-podcast',
  'nirvana-produtora-video',
  'nirvana-realestate-videomaker',
  'nirvana-restaurante',
  'nirvana-salao-beleza',
  'nirvana-video-creator',
  'notebooklm-automation',
  'proposal-forge-squad',
  'support-hub-squad',
];

function injectInto(slug, dryRun) {
  const yamlPath = path.join(SQUADS_DIR, slug, 'squad.yaml');
  if (!fs.existsSync(yamlPath)) {
    return { slug, ok: false, reason: 'squad.yaml not found' };
  }
  const raw = fs.readFileSync(yamlPath, 'utf8');
  const manifest = YAML.parse(raw);

  if (!Array.isArray(manifest.capabilities)) manifest.capabilities = [];

  const exists = manifest.capabilities.find(c => c.id === CAPABILITY.id);
  if (exists) {
    return { slug, ok: true, action: 'skipped (already present)' };
  }

  // Use the canonical capability as-is to keep description within v5 schema's
  // 500-char ceiling. Per-squad context is provided via examples below if needed.
  const local = JSON.parse(JSON.stringify(CAPABILITY));
  manifest.capabilities.push(local);

  if (dryRun) {
    return { slug, ok: true, action: 'would inject', cap_count_before: manifest.capabilities.length - 1, cap_count_after: manifest.capabilities.length };
  }

  fs.writeFileSync(yamlPath, YAML.stringify(manifest, { lineWidth: 0 }), 'utf8');
  return { slug, ok: true, action: 'injected', cap_count: manifest.capabilities.length };
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    console.log(VIDEO_CAPABLE_SQUADS.join('\n'));
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');
  const slugIdx = args.indexOf('--slug');
  const targets = slugIdx !== -1 ? [args[slugIdx + 1]] : VIDEO_CAPABLE_SQUADS;

  const results = targets.map(s => injectInto(s, dryRun));
  console.log(JSON.stringify({
    capability_id: CAPABILITY.id,
    dry_run: dryRun,
    targets: targets.length,
    ok: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    results,
  }, null, 2));
  process.exit(results.some(r => !r.ok) ? 1 : 0);
}

main();
