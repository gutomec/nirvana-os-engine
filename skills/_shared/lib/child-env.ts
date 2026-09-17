// child-env.ts — what a dispatched agent is allowed to see of the parent's environment.
//
// Every child the engine spawned inherited the whole process environment. An
// agent with Bash then had `printenv`, and with it every credential of the
// operator that started the server, needed or not. The `declared` mode turns
// that into an allowlist: the base the OS and the tools need, the engine's own
// `NIRVANA_*` / `HARNESS_*` scope, the credentials the runtime being spawned
// authenticates with, and the variables the installed squads DECLARE in
// `dependencies.yaml` (that is what the declaration is for). Anything else is
// absent from the child, and `nrv doctor` / the dispatch preflight already say
// when a declared variable is unset.
//
// `inherit` is the historical behaviour and the local default; `nrv serve`
// runs `declared` unless told otherwise (NIRVANA_SERVE_CHILD_ENV=inherit).
import * as fs from "node:fs";
import * as path from "node:path";

export type ChildEnvMode = "inherit" | "declared";

/** Names every child needs regardless of what it does. */
export const BASE_ENV_NAMES = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TERM", "TZ",
  "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE",
  "BUN_INSTALL", "NODE_OPTIONS", "PYTHONPATH", "VIRTUAL_ENV",
  // Windows
  "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "ProgramFiles", "ProgramData", "windir",
  // Terminal hosts that attribute the child (kept: they carry no secret)
  "TERM_PROGRAM", "ORCA_TERMINAL_HANDLE",
];

/** What each runtime CLI authenticates with when it is not logged in by file.
 *  A file login (`~/.claude`, `~/.codex/auth.json`, `~/.gemini`) needs none of
 *  these, which is the recommended shape on a server. */
export const RUNTIME_AUTH_ENV: Record<string, string[]> = {
  "claude-code": ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "CLAUDECODE"],
  "codex": ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME"],
  "gemini-cli": ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_GENAI_USE_VERTEXAI"],
  "antigravity-cli": ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS"],
  "grok-cli": ["XAI_API_KEY", "GROK_API_KEY"],
  "kimi-cli": ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
  "qwen-code": ["DASHSCOPE_API_KEY", "QWEN_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"],
  "opencode": ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENCODE_CONFIG"],
  "pi": ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "PI_CONFIG_DIR"],
  "openclaw": ["OPENCLAW_HOME", "OPENCLAW_CONFIG", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
};

function envNamesOf(file: string): string[] {
  let deps: any;
  try { deps = Bun.YAML.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
  const vars = deps?.env_vars;
  const out: string[] = [];
  const push = (v: unknown) => { if (typeof v === "string") out.push(v.trim()); else if (v && typeof v === "object" && typeof (v as any).name === "string") out.push((v as any).name.trim()); };
  if (Array.isArray(vars)) for (const v of vars) push(v);
  else if (vars && typeof vars === "object") { for (const v of ((vars as any).required || [])) push(v); for (const v of ((vars as any).optional || [])) push(v); }
  return out.filter(Boolean);
}

/** Every variable the installed squads declare, read from the registry the
 *  engine already keeps (never by walking the library on each spawn). */
export function declaredEnvNames(opts: { registryPath?: string; env?: NodeJS.ProcessEnv } = {}): string[] {
  const env = opts.env ?? process.env;
  const home = env.HOME || env.USERPROFILE || "";
  const candidates = [opts.registryPath, env.NIRVANA_PROJECT_ROOT ? path.join(env.NIRVANA_PROJECT_ROOT, ".nirvana", ".squads-registry.json") : null, path.join(home, ".squads-registry.json"), path.join(home, ".nirvana", ".squads-registry.json")].filter(Boolean) as string[];
  const names = new Set<string>();
  for (const reg of candidates) {
    let data: any;
    try { data = JSON.parse(fs.readFileSync(reg, "utf8")); } catch { continue; }
    for (const e of Object.values(data?.squads ?? {}) as any[]) {
      const dir = typeof e?.manifest_path === "string" ? path.dirname(e.manifest_path) : (typeof e?.dir === "string" ? e.dir : null);
      if (!dir) continue;
      for (const n of envNamesOf(path.join(dir, "dependencies.yaml"))) names.add(n);
    }
  }
  return [...names].sort();
}

/** The environment a child receives. `inherit` returns a copy of `env`;
 *  `declared` returns the allowlist described at the top of this file. */
export function childEnvFor(env: NodeJS.ProcessEnv, opts: { mode: ChildEnvMode; runtime?: string | null; extra?: string[]; declared?: string[] }): NodeJS.ProcessEnv {
  if (opts.mode !== "declared") return { ...env };
  const allow = new Set<string>(BASE_ENV_NAMES);
  const runtimes = opts.runtime ? [opts.runtime] : Object.keys(RUNTIME_AUTH_ENV);
  for (const r of runtimes) for (const n of RUNTIME_AUTH_ENV[r] ?? []) allow.add(n);
  for (const n of opts.declared ?? declaredEnvNames({ env })) allow.add(n);
  for (const n of opts.extra ?? []) allow.add(n);
  for (const n of (env.NIRVANA_CHILD_ENV_EXTRA ?? "").split(",").map((s) => s.trim()).filter(Boolean)) allow.add(n);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (k.startsWith("NIRVANA_") || k.startsWith("HARNESS_") || allow.has(k)) out[k] = v;
  }
  // The child filters its own children the same way.
  out.NIRVANA_CHILD_ENV = "declared";
  return out;
}
