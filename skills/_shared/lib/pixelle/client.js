/**
 * Pixelle-Video client — single dispatcher for all video-capable squads.
 *
 * Read the full research at (base de conhecimento interna) for architecture
 * and parameter reference. This client wraps the REST API:
 *
 *   POST /api/video/generate/sync   (≤30s videos)
 *   POST /api/video/generate/async  (longer; returns task_id)
 *   GET  /api/tasks/{task_id}       (poll until status === 'complete')
 *
 * Configuration source order (first non-empty wins):
 *   1. options passed to call site
 *   2. ~/.pixelle-video.yaml (user-level config; written by setup-wizard)
 *   3. ${NIRVANA_HOME}/.env via process.env.PIXELLE_*
 *   4. defaults.yaml
 *
 * Reference audio for voice cloning: pass `refAudioPath` (absolute path to
 * MP3/WAV/FLAC). The squad is responsible for capturing the user's audio
 * via the canonical flow in voice-clone-pipeline.md.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');

const SHARED_DIR = __dirname;
const HOME = os.homedir();

// ─────────────────────────────────────────────────────────────────────
// Config resolution
// ─────────────────────────────────────────────────────────────────────

function loadYaml(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const YAML = require('yaml');
    return YAML.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) { /* fall through */ }
  // Tiny fallback parser — handles only flat key:value YAML
  const out = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const m = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (m) {
      let v = m[2].trim();
      if (v === 'null' || v === '~') v = null;
      else if (v === 'true') v = true;
      else if (v === 'false') v = false;
      else if (/^\d+$/.test(v)) v = parseInt(v, 10);
      else if (/^\d+\.\d+$/.test(v)) v = parseFloat(v);
      else v = v.replace(/^["']|["']$/g, '');
      out[m[1]] = v;
    }
  }
  return out;
}

function getConfig(overrides = {}) {
  const userConfig = loadYaml(path.join(HOME, '.pixelle-video.yaml')) || {};
  const defaults = loadYaml(path.join(SHARED_DIR, 'defaults.yaml')) || {};

  return {
    apiBase:       overrides.apiBase       || process.env.PIXELLE_API_BASE   || userConfig.api_base       || defaults.api_base       || 'http://localhost:8000',
    llmProvider:   overrides.llmProvider   || process.env.PIXELLE_LLM        || userConfig.llm_provider   || defaults.llm_provider   || 'gemini',
    llmModel:      overrides.llmModel      || process.env.GEMINI_MODEL       || userConfig.llm_model      || defaults.llm_model      || 'gemini-2.5-pro',
    llmApiKey:     overrides.llmApiKey     || process.env.GEMINI_API_KEY     || userConfig.llm_api_key    || null,
    llmBaseUrl:    overrides.llmBaseUrl    || process.env.GEMINI_BASE_URL    || userConfig.llm_base_url   || 'https://generativelanguage.googleapis.com/v1beta/openai/',
    comfyUrl:      overrides.comfyUrl      || process.env.PIXELLE_COMFY_URL  || userConfig.comfy_url      || defaults.comfy_url      || 'http://127.0.0.1:8188',
    runninghubKey: overrides.runninghubKey || process.env.RUNNINGHUB_API_KEY || userConfig.runninghub_key || null,
    ttsWorkflow:   overrides.ttsWorkflow   || process.env.PIXELLE_TTS        || userConfig.tts_workflow   || defaults.tts_workflow   || 'edge-tts',
    voicesDir:     overrides.voicesDir     || process.env.PIXELLE_VOICES_DIR || userConfig.voices_dir     || path.join(HOME, '.pixelle-voices'),
    refAudioDefault: overrides.refAudioDefault || userConfig.ref_audio_default || null,
    bgmVolume:     overrides.bgmVolume ?? userConfig.bgm_volume ?? defaults.bgm_volume ?? 0.3,
    framePreset:   overrides.framePreset   || userConfig.frame_preset   || defaults.frame_preset   || 'instagram-reel',
    requestTimeoutMs: overrides.requestTimeoutMs || 600000,
    pollIntervalMs:   overrides.pollIntervalMs   || 5000,
    pollMaxMs:        overrides.pollMaxMs        || 7200000, // 2h
  };
}

// ─────────────────────────────────────────────────────────────────────
// Frame preset resolver — instagram-reel, tiktok, youtube-shorts, etc.
// ─────────────────────────────────────────────────────────────────────

const FRAME_PRESETS = {
  'instagram-reel':  { template: '1080x1920/image_default.html', resolution: '1080x1920' },
  'instagram-feed':  { template: '1080x1080/image_default.html', resolution: '1080x1080' },
  'tiktok':          { template: '1080x1920/image_default.html', resolution: '1080x1920' },
  'youtube-shorts':  { template: '1080x1920/image_default.html', resolution: '1080x1920' },
  'youtube-landscape': { template: '1920x1080/image_default.html', resolution: '1920x1080' },
  'podcast-clip':    { template: '1080x1080/digital_human.html', resolution: '1080x1080' },
  'realestate-tour': { template: '1920x1080/realestate.html', resolution: '1920x1080' },
  'course-lesson':   { template: '1920x1080/course.html', resolution: '1920x1080' },
  'product-demo':    { template: '1080x1920/digital_human.html', resolution: '1080x1920' },
  'ads-creative':    { template: '1080x1080/ads.html', resolution: '1080x1080' },
};

function resolveFramePreset(presetName) {
  return FRAME_PRESETS[presetName] || FRAME_PRESETS['instagram-reel'];
}

// ─────────────────────────────────────────────────────────────────────
// HTTP helpers — node stdlib only (no axios dep)
// ─────────────────────────────────────────────────────────────────────

function _request(urlString, { method = 'GET', body, headers = {}, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === 'https:' ? https : http;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', ...headers },
      timeout: timeoutMs,
    };
    const req = lib.request(opts, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          const json = JSON.parse(text);
          resolve({ status: res.statusCode, body: json });
        } catch {
          resolve({ status: res.statusCode, body: text });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('request_timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the request payload that Pixelle accepts. Squads use this when
 * they want to construct a payload but dispatch later.
 *
 * @param {object} input
 * @param {string} input.text              — topic (mode=generate) or full script (mode=fixed)
 * @param {string} [input.mode='generate'] — 'generate' | 'fixed'
 * @param {number} [input.nScenes=5]       — 1..20
 * @param {string} [input.title]
 * @param {string} [input.framePreset]     — see FRAME_PRESETS keys
 * @param {string} [input.mediaWorkflow]   — image/video workflow name in ComfyUI
 * @param {string} [input.ttsWorkflow]
 * @param {string} [input.refAudioPath]    — absolute path to MP3/WAV/FLAC for voice cloning
 * @param {string} [input.promptPrefix]    — style prefix for image prompts
 * @param {string} [input.bgmPath]
 * @param {number} [input.bgmVolume]
 * @param {object} [input.templateParams]
 * @returns {object} payload ready for POST
 */
function buildPayload(input) {
  const cfg = getConfig({});
  const preset = resolveFramePreset(input.framePreset || cfg.framePreset);
  return {
    text: input.text,
    mode: input.mode || 'generate',
    n_scenes: input.nScenes ?? 5,
    title: input.title,
    frame_template: preset.template,
    template_params: input.templateParams || {},
    media_workflow: input.mediaWorkflow,
    tts_workflow: input.ttsWorkflow || cfg.ttsWorkflow,
    ref_audio: input.refAudioPath || cfg.refAudioDefault || null,
    prompt_prefix: input.promptPrefix,
    bgm_path: input.bgmPath,
    bgm_volume: input.bgmVolume ?? cfg.bgmVolume,
  };
}

/**
 * Dispatch a synchronous video generation. Use only for short videos (<30s).
 */
async function generateSync(input, opts = {}) {
  const cfg = getConfig(opts);
  const payload = buildPayload(input);
  const r = await _request(`${cfg.apiBase}/api/video/generate/sync`, {
    method: 'POST', body: payload, timeoutMs: cfg.requestTimeoutMs,
  });
  if (r.status >= 400) throw new Error(`pixelle sync failed: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
}

/**
 * Dispatch an asynchronous video generation. Returns task_id immediately.
 */
async function generateAsync(input, opts = {}) {
  const cfg = getConfig(opts);
  const payload = buildPayload(input);
  const r = await _request(`${cfg.apiBase}/api/video/generate/async`, {
    method: 'POST', body: payload, timeoutMs: 60000,
  });
  if (r.status >= 400) throw new Error(`pixelle async failed: ${r.status}`);
  if (!r.body.task_id) throw new Error(`pixelle async: no task_id in response: ${JSON.stringify(r.body)}`);
  return r.body.task_id;
}

/**
 * Poll a task until completion or timeout.
 */
async function pollTask(taskId, opts = {}) {
  const cfg = getConfig(opts);
  const start = Date.now();
  while (true) {
    const r = await _request(`${cfg.apiBase}/api/tasks/${taskId}`, { method: 'GET' });
    if (r.status === 200 && r.body && r.body.status) {
      if (r.body.status === 'complete') return r.body;
      if (r.body.status === 'failed') throw new Error(`pixelle task ${taskId} failed: ${JSON.stringify(r.body)}`);
    }
    if (Date.now() - start > cfg.pollMaxMs) {
      throw new Error(`pixelle task ${taskId} timeout after ${cfg.pollMaxMs}ms`);
    }
    await new Promise(r => setTimeout(r, cfg.pollIntervalMs));
  }
}

/**
 * One-shot dispatch + await: chooses sync vs async based on expected duration.
 */
async function generate(input, opts = {}) {
  const expectedSeconds = (input.nScenes || 5) * 7; // ~7s per scene rough estimate
  if (expectedSeconds <= 25) {
    return await generateSync(input, opts);
  }
  const taskId = await generateAsync(input, opts);
  return await pollTask(taskId, opts);
}

/**
 * Health probe — used by setup-wizard to verify Pixelle is reachable.
 */
async function ping(opts = {}) {
  const cfg = getConfig(opts);
  try {
    const r = await _request(`${cfg.apiBase}/docs`, { method: 'GET', timeoutMs: 5000 });
    return { ok: r.status >= 200 && r.status < 500, status: r.status, apiBase: cfg.apiBase };
  } catch (e) {
    return { ok: false, error: e.message, apiBase: cfg.apiBase };
  }
}

/**
 * Validate a reference audio file before passing to the API.
 * Returns { ok, reason, durationSec? }.
 */
function validateRefAudio(audioPath) {
  if (!audioPath) return { ok: false, reason: 'no_path' };
  if (!fs.existsSync(audioPath)) return { ok: false, reason: 'file_not_found', path: audioPath };
  const ext = path.extname(audioPath).toLowerCase();
  if (!['.mp3', '.wav', '.flac', '.m4a', '.ogg'].includes(ext)) {
    return { ok: false, reason: 'unsupported_format', ext };
  }
  const stats = fs.statSync(audioPath);
  if (stats.size < 50_000) return { ok: false, reason: 'file_too_small', sizeBytes: stats.size };
  if (stats.size > 50_000_000) return { ok: false, reason: 'file_too_large', sizeBytes: stats.size };
  return { ok: true, sizeBytes: stats.size };
}

/**
 * Save a reference voice into the user's voices dir with a stable name.
 * Returns the canonical path squads should use as refAudioPath.
 */
function saveVoiceReference(srcPath, voiceName) {
  const cfg = getConfig({});
  if (!fs.existsSync(cfg.voicesDir)) fs.mkdirSync(cfg.voicesDir, { recursive: true });
  const slug = String(voiceName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const ext = path.extname(srcPath).toLowerCase() || '.wav';
  const dst = path.join(cfg.voicesDir, `${slug}${ext}`);
  fs.copyFileSync(srcPath, dst);
  return dst;
}

function listVoiceReferences() {
  const cfg = getConfig({});
  if (!fs.existsSync(cfg.voicesDir)) return [];
  return fs.readdirSync(cfg.voicesDir)
    .filter(f => /\.(mp3|wav|flac|m4a|ogg)$/i.test(f))
    .map(f => ({ name: path.basename(f, path.extname(f)), path: path.join(cfg.voicesDir, f) }));
}

module.exports = {
  getConfig,
  resolveFramePreset,
  FRAME_PRESETS,
  buildPayload,
  generate,
  generateSync,
  generateAsync,
  pollTask,
  ping,
  validateRefAudio,
  saveVoiceReference,
  listVoiceReferences,
};

// CLI
if (require.main === module) {
  const cmd = process.argv[2];
  (async () => {
    if (cmd === 'ping') {
      const r = await ping();
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    }
    if (cmd === 'config') {
      console.log(JSON.stringify(getConfig({}), null, 2));
      process.exit(0);
    }
    if (cmd === 'voices') {
      console.log(JSON.stringify(listVoiceReferences(), null, 2));
      process.exit(0);
    }
    if (cmd === 'validate-audio') {
      console.log(JSON.stringify(validateRefAudio(process.argv[3]), null, 2));
      process.exit(0);
    }
    if (cmd === 'save-voice') {
      console.log(JSON.stringify({ saved: saveVoiceReference(process.argv[3], process.argv[4]) }, null, 2));
      process.exit(0);
    }
    console.error('usage: client.js {ping|config|voices|validate-audio <path>|save-voice <src> <name>}');
    process.exit(64);
  })();
}
