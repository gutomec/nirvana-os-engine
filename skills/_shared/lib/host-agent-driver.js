/**
 * host-agent-driver.js — CommonJS companion of host-agent-driver.ts.
 *
 * Same API as the .ts version, kept in sync manually. We need this so plain
 * `node` callers (e.g. router.js invoked via `node router.js find ...`) can
 * load the driver via require() — Node does not strip TypeScript natively.
 *
 * If you change one of the two files, change the other.
 */

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Model do sistema (espelho CJS de _shared/lib/system-model.ts). Sem propagar
// isto, o audit-consensus/verifier disparava `claude -p` no default do CLI
// (sonnet) em vez de herdar o fable/opus da sessão. Mantenha em sincronia.
function sanitizeModelId(raw) {
  if (!raw) return '';
  let s = String(raw)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\[[0-9;]*m\]?/g, '')
    .replace(/[^\x20-\x7e]/g, '')
    .trim();
  const m = s.match(/^[A-Za-z0-9][A-Za-z0-9._-]*/);
  return m ? m[0] : '';
}
function toAlias(model) {
  if (!model) return model;
  const m = model.toLowerCase();
  if (['opus', 'sonnet', 'haiku', 'fable'].includes(m)) return m;
  const fam = m.match(/^claude-(opus|sonnet|haiku|fable)\b/);
  return fam ? fam[1] : model;
}
function resolveSystemModel(runtime) {
  const fromEnv = sanitizeModelId(process.env.NIRVANA_MODEL) || sanitizeModelId(process.env.ANTHROPIC_MODEL);
  if (fromEnv) return toAlias(fromEnv);
  if (runtime && runtime !== 'claude-code') return null;
  try {
    const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const j = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
    const m = sanitizeModelId(j.model);
    if (m) return toAlias(m);
  } catch {}
  return null;
}

function whichSync(cli) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'command', ['-v', cli], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split('\n')[0];
  const PATH = (process.env.PATH || '').split(path.delimiter);
  for (const dir of PATH) {
    const full = path.join(dir, cli);
    try { if (fs.statSync(full).isFile()) return full; } catch {}
    try { if (fs.statSync(full + '.exe').isFile()) return full + '.exe'; } catch {}
  }
  return null;
}

const RUNTIMES = [
  {
    name: 'claude-code',
    cli: 'claude',
    buildArgs(persona, userMsg) {
      const args = ['-p', '--no-session-persistence', '--output-format', 'json'];
      const model = resolveSystemModel('claude-code');
      if (model) args.push('--model', model);
      if (persona) args.push('--append-system-prompt', persona.slice(0, 8000));
      args.push(userMsg);
      return args;
    },
    parseStdout(stdout) {
      try { const o = JSON.parse(stdout); return (o.result || o.text || o.content || '').trim(); }
      catch { return stdout.trim(); }
    },
    envHints: ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'],
  },
  {
    name: 'codex',
    cli: 'codex',
    buildArgs(persona, userMsg) {
      const merged = persona ? `${persona}\n\n---\n\n${userMsg}` : userMsg;
      return ['exec', merged];
    },
    parseStdout(stdout) { return stdout.trim(); },
    envHints: ['CODEX_HOME'],
  },
  {
    name: 'gemini-cli',
    cli: 'gemini',
    buildArgs(persona, userMsg) {
      const merged = persona ? `${persona}\n\n---\n\n${userMsg}` : userMsg;
      return ['-p', merged];
    },
    parseStdout(stdout) { return stdout.trim(); },
    envHints: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  },
  {
    name: 'qwen-code',
    cli: 'qwen',
    buildArgs(_persona, userMsg) { return ['-p', userMsg]; },
    parseStdout(stdout) { return stdout.trim(); },
    envHints: [],
  },
  {
    name: 'opencode',
    cli: 'opencode',
    buildArgs(persona, userMsg) {
      const merged = persona ? `${persona}\n\n---\n\n${userMsg}` : userMsg;
      return ['run', merged];
    },
    parseStdout(stdout) { return stdout.trim(); },
    envHints: [],
  },
];

function detectHost(opts) {
  opts = opts || {};
  const preferred = opts.preferred || process.env.NIRVANA_AGENT_RUNTIME;
  if (preferred) {
    const r = RUNTIMES.find((x) => x.name === preferred);
    if (r && whichSync(r.cli)) return r;
  }
  for (const r of RUNTIMES) {
    if (whichSync(r.cli)) return r;
  }
  return null;
}

function callHostAgent(persona, userMessage, opts) {
  opts = opts || {};
  const host = detectHost();
  if (!host) {
    return { error: 'no host agent CLI found on PATH (tried: ' + RUNTIMES.map((r) => r.cli).join(', ') + ')' };
  }
  const args = host.buildArgs(persona || '', userMessage);
  const r = spawnSync(host.cli, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs || 120000,
    maxBuffer: 8 * 1024 * 1024,
    env: Object.assign({}, process.env),
  });
  if (r.status !== 0) {
    return {
      error: (r.stderr || '').slice(0, 500) || `${host.cli} exited ${r.status}`,
      host: host.name,
      exit_code: r.status == null ? -1 : r.status,
    };
  }
  return {
    text: host.parseStdout(r.stdout),
    host: host.name,
    exit_code: 0,
  };
}

function callHostAgentAsync(persona, userMessage, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const host = detectHost();
    if (!host) {
      resolve({ error: 'no host agent CLI found on PATH (tried: ' + RUNTIMES.map((r) => r.cli).join(', ') + ')' });
      return;
    }
    const args = host.buildArgs(persona || '', userMessage);
    const child = spawn(host.cli, args, {
      env: Object.assign({}, process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timeout = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_e) {}
    }, opts.timeoutMs || 120000);
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        resolve({
          error: stderr.slice(0, 500) || `${host.cli} exited ${code}`,
          host: host.name,
          exit_code: code == null ? -1 : code,
        });
        return;
      }
      resolve({
        text: host.parseStdout(stdout),
        host: host.name,
        exit_code: 0,
      });
    });
    child.on('error', (e) => {
      clearTimeout(timeout);
      resolve({ error: e.message, host: host.name, exit_code: -1 });
    });
  });
}

module.exports = { detectHost, callHostAgent, callHostAgentAsync };

if (require.main === module) {
  const host = detectHost();
  if (!host) { console.log('no-host-detected'); process.exit(0); }
  console.log(JSON.stringify({ host: host.name, cli: host.cli }, null, 2));
}
