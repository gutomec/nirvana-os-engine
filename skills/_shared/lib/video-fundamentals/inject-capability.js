#!/usr/bin/env node
/**
 * inject-capability.js — injeta a capability canônica de vídeo (media.video.compose)
 * na squad.yaml de cada squad que produz vídeo, e dropa um tasks/video-compose.md
 * apontando para os fundamentos compartilhados (para o invoke.ref resolver → zero warning).
 * Idempotente: re-rodar é no-op.
 *
 * Uso:
 *   node inject-capability.js                 # injeta na lista canônica
 *   node inject-capability.js --list          # mostra a lista
 *   node inject-capability.js --slug <slug>   # injeta em um squad só
 *   node inject-capability.js --dry-run       # relata o que mudaria
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
  console.error('[inject-capability] módulo yaml não encontrado. Rode de um host Nirvana.');
  process.exit(2);
}

const CAPABILITY = YAML.parse(fs.readFileSync(path.join(SHARED_DIR, 'CAPABILITY.yaml'), 'utf8'));

// Os geradores de vídeo (squads). Businesses são retrofitados no employee, não aqui.
const VIDEO_GENERATOR_SQUADS = [
  'higgsfield-studio-nirvana',
  'grok-studio-nirvana',
  'brandcraft',
  'content-multiplier-squad',
  'instagram-intelligence-nirvana',
  'nirvana-video-creator',
  'nirvana-realestate-videomaker',
  'veo-motion-studio',
  'vivid-pancake-keyframe-i2v',
  'nirvana-podcast',
];

// Task doc dropado em cada squad para o invoke.ref resolver. Aponta para a lib
// compartilhada — não duplica método, só instrui a aplicá-lo.
const TASK_DOC = `# Compor vídeo (aplica os fundamentos compartilhados)

Tarefa canônica da capability \`media.video.compose\`. Não reimplemente método aqui — aplique a lib
compartilhada de fundamentos de vídeo, em \`CLAUDE_SKILLS_DIR/_shared/lib/video-fundamentals/\`.

## Input
- \`brief\`: o que produzir (formato, plataforma, duração, com/sem áudio).
- \`references\` (opcional): fotos reais do produto/pessoa (a hero-image âncora).

## Passos
1. Leia \`_shared/lib/video-fundamentals/FUNDAMENTALS.md\` — aplique hero-image (uma âncora reusada em
   todo clipe), encadeamento de clipes para jornadas, 2-3 takes só no hero, e as regras anti-cara-de-IA.
2. Escolha o engine em \`_shared/lib/video-fundamentals/ENGINE-MENU.md\` — inclui **Higgsfield**
   (Soul ID = consistência; Seedance = keyframe-chaining; Marketing Studio = UGC ad), Veo 3.1,
   Fal/Kling, Runway, Luma. Execução do Higgsfield: \`_shared/lib/video-fundamentals/higgsfield-cli.md\`.
3. Aplique \`_shared/lib/video-fundamentals/AUDIO-POLICY.md\` — **sem áudio** para hero/background loop;
   **com áudio + legenda** para publicar (Instagram/YouTube/TikTok).
4. Aplique \`_shared/lib/video-fundamentals/CREDIT-DISCIPLINE.md\` — default std/1080p/~8s; cost-check
   antes de gerar; compress-for-web; 4K só no showpiece.
5. Para fala (áudio ON), consulte os exemplos locais deste squad (conteúdo dos packs de vídeo pagos):
   \`references/roteiro-method/\` (roteiro-antes-de-pixel, fonética PT-BR, cláusula de enunciação) e
   \`scripts/post-kit/\` (QA de áudio whisper, unir clipes, cortar mudos, end-card, acelerar).

## Acceptance
- O clipe existe no diretório de execução (verify-de-disco).
- Áudio bate com o destino (hero mudo vs publicar com áudio+legenda).
- Engine e custo registrados no handoff.
`;

function injectInto(slug, dryRun) {
  const squadDir = path.join(SQUADS_DIR, slug);
  const yamlPath = path.join(squadDir, 'squad.yaml');
  if (!fs.existsSync(yamlPath)) {
    return { slug, ok: false, reason: 'squad.yaml not found' };
  }
  const manifest = YAML.parse(fs.readFileSync(yamlPath, 'utf8'));
  if (!Array.isArray(manifest.capabilities)) manifest.capabilities = [];

  const existing = manifest.capabilities.find(c => c && c.id === CAPABILITY.id);
  const taskPath = path.join(squadDir, 'tasks', 'video-compose.md');
  const hasTask = fs.existsSync(taskPath);
  // Auto-corretivo: capability presente mas com invoke divergente (ex.: ref antigo) → reconciliar.
  const invokeStale = existing && JSON.stringify(existing.invoke) !== JSON.stringify(CAPABILITY.invoke);

  if (existing && hasTask && !invokeStale) {
    return { slug, ok: true, action: 'skipped (já presente)' };
  }
  if (dryRun) {
    return { slug, ok: true, action: 'injetaria', cap: !existing, task: !hasTask, invoke_fix: !!invokeStale };
  }

  if (!hasTask) {
    fs.mkdirSync(path.dirname(taskPath), { recursive: true });
    fs.writeFileSync(taskPath, TASK_DOC, 'utf8');
  }
  let yamlDirty = false;
  if (!existing) {
    manifest.capabilities.push(JSON.parse(JSON.stringify(CAPABILITY)));
    yamlDirty = true;
  } else if (invokeStale) {
    existing.invoke = JSON.parse(JSON.stringify(CAPABILITY.invoke));
    yamlDirty = true;
  }
  if (yamlDirty) fs.writeFileSync(yamlPath, YAML.stringify(manifest, { lineWidth: 0 }), 'utf8');
  return { slug, ok: true, action: 'injetado', cap_added: !existing, task_added: !hasTask, invoke_fixed: !!invokeStale };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) { console.log(VIDEO_GENERATOR_SQUADS.join('\n')); process.exit(0); }
  const dryRun = args.includes('--dry-run');
  const slugIdx = args.indexOf('--slug');
  const targets = slugIdx !== -1 ? [args[slugIdx + 1]] : VIDEO_GENERATOR_SQUADS;
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
