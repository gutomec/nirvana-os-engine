/**
 * host-agent-driver.ts — runtime-agnostic dispatcher for agentic calls.
 *
 * The skill itself is invoked from whichever agent runtime the user runs:
 *   Claude Code, Codex, Gemini CLI, Cursor, Antigravity, etc.
 *
 * When the audit consensus loop or verifier needs LLM judgement, it must
 * dispatch through the host runtime — not hard-code a vendor. We never:
 *   - specify a model (the host already chose one)
 *   - specify an agent slug (the host already routes its own agents)
 *   - use ANTHROPIC_API_KEY or any provider-specific key directly
 *
 * Detection strategy: probe `command -v <cli>` in priority order. The first
 * CLI present on PATH wins. The user's host runtime is whichever one is
 * driving the session.
 *
 * Returned: { text, host, error? }
 */

import { spawn, spawnSync } from "node:child_process";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveSystemModel } from "./system-model.ts";

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));

interface RuntimeAdapter {
  name: string;
  cli: string;
  buildArgs(persona: string, userMsg: string): string[];
  parseStdout(stdout: string): string;
  /** Optional: extract token usage + USD cost from raw stdout. Returns null
   *  when the runtime doesn't report usage (codex, gemini today). */
  parseUsage?(stdout: string): {
    usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
    total_cost_usd: number | null;
    model: string | null;
    duration_ms: number | null;
    session_id: string | null;
  } | null;
  envHints: string[];  // env vars that signal this runtime is the host
}

function whichSync(cli: string): string | null {
  const r = spawnSync(process.platform === "win32" ? "where" : "command", ["-v", cli], { encoding: "utf8" });
  // bash builtin `command` is shell-only; fallback to PATH scan
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split("\n")[0];
  // Manual PATH scan
  const PATH = (process.env.PATH || "").split(path.delimiter);
  for (const dir of PATH) {
    const full = path.join(dir, cli);
    try { if (fs.statSync(full).isFile()) return full; } catch {}
    try { if (fs.statSync(full + ".exe").isFile()) return full + ".exe"; } catch {}
  }
  return null;
}

const RUNTIMES: RuntimeAdapter[] = [
  {
    name: "claude-code",
    cli: "claude",
    buildArgs(persona, userMsg) {
      // Model do sistema (o que a sessão do usuário roda) propagado ao filho —
      // sem isto, judge/gate/verify caíam no default do CLI (sonnet) em vez de
      // herdar fable/opus. null → sem --model (mantém o default).
      const args = ["-p", "--no-session-persistence", "--output-format", "json"];
      const model = resolveSystemModel("claude-code");
      if (model) args.push("--model", model);
      if (persona) args.push("--append-system-prompt", persona.slice(0, 8000));
      args.push(userMsg);
      return args;
    },
    parseStdout(stdout) {
      try { const o = JSON.parse(stdout); return (o.result || o.text || o.content || "").trim(); }
      catch { return stdout.trim(); }
    },
    parseUsage(stdout) {
      // Claude Code --output-format json includes:
      //   { usage: { input_tokens, output_tokens, cache_creation_input_tokens,
      //              cache_read_input_tokens }, total_cost_usd, model }
      try {
        const o = JSON.parse(stdout);
        if (!o || typeof o !== "object") return null;
        const u = o.usage || {};
        const tokens = {
          input_tokens: Number(u.input_tokens || 0),
          output_tokens: Number(u.output_tokens || 0),
          cache_creation_input_tokens: Number(u.cache_creation_input_tokens || 0),
          cache_read_input_tokens: Number(u.cache_read_input_tokens || 0),
        };
        const total = tokens.input_tokens + tokens.output_tokens
                    + tokens.cache_creation_input_tokens + tokens.cache_read_input_tokens;
        if (total === 0) return null;
        return {
          usage: tokens,
          total_cost_usd: typeof o.total_cost_usd === "number" ? o.total_cost_usd : null,
          model: o.model || o.session_model || null,
          duration_ms: typeof o.duration_ms === "number" ? o.duration_ms : null,
          session_id: o.session_id || null,
        };
      } catch { return null; }
    },
    envHints: ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"],
  },
  {
    name: "codex",
    cli: "codex",
    buildArgs(persona, userMsg) {
      // Codex headless: `codex exec` runs a prompt non-interactively.
      // Most portable form — concatenate persona + user as one prompt.
      const merged = persona ? `${persona}\n\n---\n\n${userMsg}` : userMsg;
      return ["exec", merged];
    },
    parseStdout(stdout) { return stdout.trim(); },
    envHints: ["CODEX_HOME"],
  },
  {
    // Antigravity CLI (`agy`) — replaces gemini-cli for the consumer tier after
    // 2026-06-18. Same Google backend, different binary + flags (confirmed via
    // `agy --help`): -p/--print runs a single prompt non-interactively; there is
    // NO --output-format (plain text out); --dangerously-skip-permissions for
    // autonomous runs (without it agy halts waiting for approval).
    name: "antigravity-cli",
    cli: "agy",
    buildArgs(persona, userMsg) {
      const merged = persona ? `${persona}\n\n---\n\n${userMsg}` : userMsg;
      return ["-p", merged, "--dangerously-skip-permissions"];
    },
    parseStdout(stdout) { return stdout.trim(); },
    envHints: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  },
  {
    name: "gemini-cli",
    cli: "gemini",
    buildArgs(persona, userMsg) {
      const merged = persona ? `${persona}\n\n---\n\n${userMsg}` : userMsg;
      return ["-p", merged];
    },
    parseStdout(stdout) { return stdout.trim(); },
    envHints: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  },
  {
    name: "qwen-code",
    cli: "qwen",
    buildArgs(_persona, userMsg) { return ["-p", userMsg]; },
    parseStdout(stdout) { return stdout.trim(); },
    envHints: [],
  },
  {
    name: "opencode",
    cli: "opencode",
    buildArgs(persona, userMsg) {
      const merged = persona ? `${persona}\n\n---\n\n${userMsg}` : userMsg;
      return ["run", merged];
    },
    parseStdout(stdout) { return stdout.trim(); },
    envHints: [],
  },
];

export interface HostCall {
  text: string;
  host: string;
  exit_code: number;
}
export interface HostError {
  error: string;
  host?: string;
  exit_code?: number;
  /** Set when the watchdog detected a stall. ms elapsed without bytes. */
  stalled_after_ms?: number;
  /** Total stdout+stderr bytes seen before stall classification. */
  bytes_received_before_stall?: number;
}

/**
 * detectHost — returns the first runtime whose CLI is on PATH.
 * If `forceRuntime` is set (NIRVANA_AGENT_RUNTIME env), that one is preferred
 * (must still be installed). Caller may also pass `preferred` slug.
 */
export function detectHost(opts: { preferred?: string } = {}): RuntimeAdapter | null {
  const preferred = opts.preferred || process.env.NIRVANA_AGENT_RUNTIME;
  if (preferred) {
    const r = RUNTIMES.find(x => x.name === preferred);
    if (r && whichSync(r.cli)) return r;
  }
  for (const r of RUNTIMES) {
    if (whichSync(r.cli)) return r;
  }
  return null;
}

/**
 * callHostAgent — dispatches a single LLM call through the host runtime.
 * Persona is the role's persona text (loaded from the agent .md). User
 * message is the actual task prompt.
 */
export function callHostAgent(persona: string, userMessage: string, opts: CallOpts = {}): HostCall | HostError {
  const host = opts.__testRuntime ?? detectHost();
  if (!host) {
    return { error: "no host agent CLI found on PATH (tried: " + RUNTIMES.map(r => r.cli).join(", ") + ")" };
  }
  const args = host.buildArgs(persona || "", userMessage);
  const r = spawnSync(host.cli, args, {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env },
  });
  if (r.status !== 0) {
    return {
      error: (r.stderr || "").slice(0, 500) || `${host.cli} exited ${r.status}`,
      host: host.name,
      exit_code: r.status ?? -1,
    };
  }
  try { emitCostAudit(host, r.stdout, opts); } catch { /* non-fatal */ }
  return {
    text: host.parseStdout(r.stdout),
    host: host.name,
    exit_code: 0,
  };
}

/**
 * Async variant — dispatches via child_process.spawn so multiple calls can
 * run in parallel from the same process. Returns the same shape as
 * callHostAgent but as a Promise.
 *
 * Stall watchdog (opt-in): when `heartbeatMs > 0`, the driver tracks the
 * timestamp of the most recent stdout/stderr chunk. If no bytes arrive within
 * `heartbeatMs` (default 60_000), the driver classifies the call as stalled.
 * Behavior depends on `heartbeatMode`:
 *   - 'kill' (default): SIGTERM the child immediately, escalate to SIGKILL
 *     after 5s, resolve with `{ error: 'stall', stalled_after_ms, ... }`.
 *   - 'warn': resolve with stall signal but let the child keep running until
 *     timeout. Useful in tests or when caller wants to log without aborting.
 *
 * The driver does not retry — that is the caller's job (see
 * `_shared/lib/host-agent-retry.js`). Audit events are emitted by callers,
 * not here, to keep the driver host-agnostic and free of cross-skill imports.
 */
export type HeartbeatMode = "kill" | "warn";
export interface CallOpts {
  timeoutMs?: number;
  heartbeatMs?: number;            // 0 disables; default 60_000
  minBytesPerHeartbeat?: number;   // bytes counted toward "alive"; default 1
  heartbeatMode?: HeartbeatMode;   // default 'kill'
  /** Identifies the caller for cost telemetry attribution (e.g. "quality-judge",
   *  "squad-audit-consensus:critic", "stage-2-amplifier"). Surfaced in the
   *  cost_emission audit event so dashboards can break down by source. */
  caller_id?: string;
  /** Project to attribute the cost to. Defaults to NIRVANA_PROJECT_ID env. */
  project_id?: string;
  /** Set to false to suppress cost_emission emission for this call. Default true. */
  emitCost?: boolean;
  /**
   * TEST-ONLY: bypass detectHost and use this adapter directly. Must conform to
   * the RuntimeAdapter shape ({ name, cli, buildArgs, parseStdout }). Do not
   * use in production code paths.
   */
  __testRuntime?: any;
}

/**
 * Fire-and-forget audit emission. Loaded lazily so the driver stays free of
 * cross-skill dependencies at module init.
 */
function emitCostAudit(host: any, stdoutRaw: string, opts: CallOpts) {
  if (opts.emitCost === false) return;
  if (!host?.parseUsage) return;
  const usage = host.parseUsage(stdoutRaw);
  if (!usage) return;
  let audit: any = null;
  try {
    audit = require(path.join(SKILLS_ROOT, "harness", "lib", "audit.js"));
  } catch { return; }
  if (!audit?.emit) return;
  try {
    audit.emit("cost_emission", {
      host: host.name,
      caller_id: opts.caller_id || null,
      model: usage.model,
      usage: usage.usage,
      total_cost_usd: usage.total_cost_usd,
      duration_ms: usage.duration_ms,
      session_id: usage.session_id,
    }, {
      project_id: opts.project_id || process.env.NIRVANA_PROJECT_ID || null,
    });
  } catch { /* non-fatal */ }
}

export function callHostAgentAsync(persona: string, userMessage: string, opts: CallOpts = {}): Promise<HostCall | HostError> {
  return new Promise((resolve) => {
    const host = opts.__testRuntime ?? detectHost();
    if (!host) {
      resolve({ error: "no host agent CLI found on PATH (tried: " + RUNTIMES.map(r => r.cli).join(", ") + ")" });
      return;
    }
    const heartbeatMs = opts.heartbeatMs ?? 60_000;
    const minBytes = opts.minBytesPerHeartbeat ?? 1;
    const mode: HeartbeatMode = opts.heartbeatMode ?? "kill";

    const args = host.buildArgs(persona || "", userMessage);
    const child = spawn(host.cli, args, {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let bytesReceived = 0;
    let bytesSinceLastBeat = 0;
    let lastDataAt = Date.now();
    let stallSignaled = false;
    let stallSettled = false;

    const onChunk = (d: Buffer) => {
      bytesReceived += d.length;
      bytesSinceLastBeat += d.length;
      lastDataAt = Date.now();
    };
    child.stdout?.on("data", (d) => { stdout += d.toString(); onChunk(d); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); onChunk(d); });

    const timeout = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
    }, opts.timeoutMs ?? 120_000);

    let watchdog: ReturnType<typeof setInterval> | null = null;
    let killEscalation: ReturnType<typeof setTimeout> | null = null;
    if (heartbeatMs > 0) {
      const tickMs = Math.max(500, Math.floor(heartbeatMs / 2));
      watchdog = setInterval(() => {
        if (stallSignaled) return;
        const since = Date.now() - lastDataAt;
        const tookEnoughBytes = bytesSinceLastBeat >= minBytes;
        if (tookEnoughBytes) { bytesSinceLastBeat = 0; return; }
        if (since >= heartbeatMs) {
          stallSignaled = true;
          if (mode === "kill") {
            try { child.kill("SIGTERM"); } catch {}
            killEscalation = setTimeout(() => {
              try { child.kill("SIGKILL"); } catch {}
            }, 5000);
            stallSettled = true;
            cleanupTimers();
            resolve({
              error: "stall",
              host: host.name,
              exit_code: -1,
              stalled_after_ms: since,
              bytes_received_before_stall: bytesReceived,
            } as HostError);
          } else {
            // 'warn': signal but don't kill; resolve once child exits normally.
            // Resolve with a separate "warn" payload so caller can log without aborting.
            stallSettled = true;
            cleanupTimers();
            resolve({
              error: "stall_warning",
              host: host.name,
              exit_code: -1,
              stalled_after_ms: since,
              bytes_received_before_stall: bytesReceived,
            } as HostError);
          }
        }
      }, tickMs);
    }

    function cleanupTimers() {
      if (watchdog) clearInterval(watchdog);
      clearTimeout(timeout);
      // killEscalation runs on its own; do not clear here
    }

    child.on("close", (code) => {
      if (stallSettled) return;
      cleanupTimers();
      if (killEscalation) clearTimeout(killEscalation);
      if (code !== 0) {
        resolve({
          error: stderr.slice(0, 500) || `${host.cli} exited ${code}`,
          host: host.name,
          exit_code: code ?? -1,
        });
        return;
      }
      // Auto-emit cost_emission audit event when the host reports usage.
      // Fire-and-forget: never block the resolve() on telemetry.
      try { emitCostAudit(host, stdout, opts); } catch { /* non-fatal */ }
      resolve({
        text: host.parseStdout(stdout),
        host: host.name,
        exit_code: 0,
      });
    });
    child.on("error", (e) => {
      if (stallSettled) return;
      cleanupTimers();
      if (killEscalation) clearTimeout(killEscalation);
      resolve({ error: e.message, host: host.name, exit_code: -1 });
    });
  });
}

if (import.meta.main) {
  const host = detectHost();
  if (!host) { console.log("no-host-detected"); process.exit(0); }
  console.log(JSON.stringify({ host: host.name, cli: host.cli }, null, 2));
}
