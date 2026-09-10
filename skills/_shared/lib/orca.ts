// orca.ts — the typed face of the Orca host integration, plus everything that
// actually calls the `orca` CLI. Detection lives in orca.js (CJS, so the
// canonical audit emitter can read it); this file adds the settings-aware gate
// and the fail-soft spawn helpers every seam uses.
//
// The contract, stated once (ADR-009):
//   - Detection is the only gate. Outside an Orca terminal (or with `host.orca`
//     off) no function here spawns anything: `orcaHostActive()` is false and
//     every helper returns without touching the machine.
//   - Every call is fail-soft. A missing binary, a closed app, an unknown
//     command or a timeout is a `{ ok: false }` answer or a silent no-op, never
//     an exception that reaches a run. Status updates are fire-and-forget.
//   - Orca is a projection and a transport, never a source of truth. The ledger,
//     the audit and the outputs tree keep deciding what happened; Orca shows it.
import { spawn, spawnSync } from "node:child_process";
import * as os from "node:os";
import { resolveSetting } from "./settings.ts";
import * as core from "./orca.js";

export interface OrcaContext {
  worktreeId: string | null;
  terminalHandle: string | null;
  paneKey: string | null;
  tabId: string | null;
  appVersion: string | null;
  userDataPath: string | null;
}

export type OrcaHostMode = "auto" | "on" | "off";

export const PANE_ENV_KEYS: readonly string[] = core.PANE_ENV_KEYS;
export const insideOrcaTerminal: (env?: NodeJS.ProcessEnv) => boolean = core.insideOrcaTerminal;
export const detectOrca: (env?: NodeJS.ProcessEnv) => OrcaContext | null = core.detectOrca;
export const orcaAuditContext: (env?: NodeJS.ProcessEnv) => Record<string, string> | null = core.orcaAuditContext;
export const resolveOrcaExecutable: (env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform) => string = core.resolveOrcaExecutable;
export const stripOrcaPaneEnv: <T extends NodeJS.ProcessEnv>(env: T) => T = core.stripOrcaPaneEnv;
export const orcaWorkspaceSelector: (projectRoot?: string | null, env?: NodeJS.ProcessEnv) => string = core.orcaWorkspaceSelector;

/** The `host.orca` setting resolved through the settings core (env, project
 *  file, global file, engine default), then applied to the environment: `off`
 *  never, `on` always, `auto` only inside an Orca terminal. */
export function orcaHostActive(env: NodeJS.ProcessEnv = process.env): boolean {
  let mode: OrcaHostMode = "auto";
  try { mode = resolveSetting("host.orca").value as OrcaHostMode; }
  catch { return core.orcaHostActiveEnv(env); }
  if (mode === "off") return false;
  if (mode === "on") return true;
  return core.insideOrcaTerminal(env);
}

/** Headless dispatches become Orca worker terminals only when the host is
 *  active AND `host.orca_workers` is on (its default). */
export function orcaWorkersActive(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!orcaHostActive(env)) return false;
  try { return resolveSetting("host.orca_workers").value === true; }
  catch { return true; }
}

export interface OrcaCall<T = any> {
  ok: boolean;
  /** The `result` object of a `--json` answer (Orca wraps every reply in `{ id, ok, result | error }`). */
  result: T | null;
  error: { code?: string; message?: string; data?: unknown } | null;
  /** Raw stdout, for a caller that wants more than `result`. */
  raw: string;
  exitCode: number | null;
}

/** Quote one argument for the Windows command interpreter — the same rule the
 *  runtime driver applies on its own shell path. Only used when the Orca CLI
 *  on Windows is a `.cmd` shim, which has to go through cmd.exe. */
function quoteForCmd(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"^&|<>()]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

function spawnShape(exe: string, args: string[]): { command: string; args: string[]; shell: boolean } {
  if (process.platform !== "win32") return { command: exe, args, shell: false };
  // An installed CLI on Windows is normally a `.cmd` shim; spawning the bare
  // name without a shell fails with ENOENT. The command line stays small (ids,
  // paths, a short spec), so the interpreter route is safe here.
  return { command: quoteForCmd(exe), args: args.map(quoteForCmd), shell: true };
}

/** One `orca … --json` call, parsed. Never throws: a missing binary, a closed
 *  app, a timeout or a non-JSON answer is `{ ok: false }` with the error text. */
export function orcaJson<T = any>(args: string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): OrcaCall<T> {
  const env = opts.env ?? process.env;
  const exe = core.resolveOrcaExecutable(env);
  const shape = spawnShape(exe, [...args, "--json"]);
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync(shape.command, shape.args, {
      encoding: "utf8", env, timeout: opts.timeoutMs ?? 15_000, maxBuffer: 16 * 1024 * 1024,
      ...(shape.shell ? { shell: true } : {}), windowsHide: true,
    });
  } catch (e) {
    return { ok: false, result: null, error: { code: "spawn_failed", message: (e as Error)?.message ?? String(e) }, raw: "", exitCode: null };
  }
  const raw = String(r.stdout ?? "");
  if (r.error) {
    return { ok: false, result: null, error: { code: (r.error as NodeJS.ErrnoException).code ?? "spawn_failed", message: r.error.message }, raw, exitCode: r.status };
  }
  const doc = lastJsonDocument(raw);
  if (!doc) {
    const stderr = String(r.stderr ?? "").trim();
    return { ok: false, result: null, error: { code: "no_json", message: stderr || raw.trim() || `${exe} exited ${r.status}` }, raw, exitCode: r.status };
  }
  if (doc.ok === true) return { ok: true, result: (doc.result ?? null) as T, error: null, raw, exitCode: r.status };
  return { ok: false, result: null, error: doc.error ?? { code: "orca_error", message: `${exe} answered ok:false` }, raw, exitCode: r.status };
}

/** `--json` answers are one JSON document on stdout; `check --wait` keeps its
 *  keepalive lines on stderr. A stray line before the document (a shim's
 *  banner) must not hide the answer, so the parse starts at the last `{`
 *  that opens a full document. */
function lastJsonDocument(text: string): any | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  for (let i = trimmed.indexOf("{"); i !== -1; i = trimmed.indexOf("{", i + 1)) {
    try { return JSON.parse(trimmed.slice(i)); } catch { /* keep looking */ }
  }
  return null;
}

/** Fire an `orca …` command and forget it: detached, output discarded, wrapped
 *  in try/catch — the same posture os-notify.ts takes, for the same reason.
 *  A status mirror that can block a run is worse than no mirror. */
export function orcaFire(args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const exe = core.resolveOrcaExecutable(env);
  const shape = spawnShape(exe, [...args, "--json"]);
  try {
    const child = spawn(shape.command, shape.args, { stdio: "ignore", detached: true, env, windowsHide: true, ...(shape.shell ? { shell: true } : {}) });
    child.on("error", () => { /* binary absent — never fatal */ });
    child.unref();
  } catch { /* best-effort */ }
}

// ── the workspace card ────────────────────────────────────────────────────

/** Orca's board columns, as the CLI names them. */
export type OrcaWorkspaceStatus = "todo" | "in-progress" | "in-review" | "completed";

/** Ledger state → board column. Active states are work in progress; the gate
 *  and every stopped-but-not-delivered state ask for a look; delivered is done. */
export function orcaStatusForRunState(state: string): OrcaWorkspaceStatus | null {
  switch (state) {
    case "dispatched": case "running": case "verifying": return "in-progress";
    case "gated": case "withheld": case "stalled": case "failed": case "abandoned": return "in-review";
    case "delivered": return "completed";
    default: return null;
  }
}

/** The one-line comment the card shows for a run. English, like every string
 *  the engine writes for itself; the deliverable's language is the brief's. */
export function orcaRunComment(row: { target_kind?: string | null; target_slug?: string | null; state: string; last_error?: string | null; project_id?: string | null }): string {
  const target = `${row.target_kind ?? "run"}/${row.target_slug ?? row.project_id ?? "?"}`;
  const tail = row.last_error && ["stalled", "failed", "withheld", "abandoned"].includes(row.state) ? ` · ${String(row.last_error).replace(/\s+/g, " ").slice(0, 100)}` : "";
  return `nirvana · ${target} · ${row.state}${tail}`.slice(0, 200);
}

/** Update the workspace card (comment and/or status). A no-op unless the host
 *  is active. Synchronous on purpose, with a short timeout: two detached
 *  updates a few milliseconds apart (`gated` then `delivered`) raced, and the
 *  card kept whichever landed last — measured on a live run, where it stayed
 *  on `gated / in-review` after the run had delivered. In order, every time,
 *  costs the caller one local RPC. */
export function orcaSetWorkspace(update: { comment?: string; status?: OrcaWorkspaceStatus | null; projectRoot?: string | null }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!orcaHostActive(env)) return false;
  const args = ["worktree", "set", "--worktree", core.orcaWorkspaceSelector(update.projectRoot ?? null, env)];
  if (update.comment) args.push("--comment", update.comment.slice(0, 200));
  if (update.status) args.push("--workspace-status", update.status);
  if (args.length === 4) return false;
  return orcaJson(args, { timeoutMs: 8_000, env }).ok;
}

/** The ledger's projection: a run's state change becomes the card's comment and
 *  column. Called by run-ledger.ts on every transition; nothing else decides. */
export function orcaProjectRun(row: { state: string; target_kind?: string | null; target_slug?: string | null; last_error?: string | null; project_id?: string | null; project_root?: string | null }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!orcaHostActive(env)) return false;
  return orcaSetWorkspace({ comment: orcaRunComment(row), status: orcaStatusForRunState(row.state), projectRoot: row.project_root ?? null }, env);
}

/** A desktop notification's text, mirrored onto the card so the owner who
 *  works in Orca sees it where they are looking. */
export function orcaNotify(title: string, message: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!orcaHostActive(env)) return false;
  const text = `${title}: ${message}`.replace(/\s+/g, " ").trim();
  return orcaSetWorkspace({ comment: text }, env);
}

// ── the app, for the doctor and the browser ───────────────────────────────

export interface OrcaStatus {
  running: boolean;
  appVersion: string | null;
  /** The runtime advertises `orchestration.contract.v1` when the orchestration
   *  layer (Run → Task → Dispatch) is available to CLI callers. */
  orchestration: boolean;
  capabilities: string[];
  error: string | null;
}

export function orcaStatus(timeoutMs = 5_000, env: NodeJS.ProcessEnv = process.env): OrcaStatus {
  const r = orcaJson<any>(["status"], { timeoutMs, env });
  if (!r.ok) return { running: false, appVersion: null, orchestration: false, capabilities: [], error: r.error?.message ?? r.error?.code ?? "unreachable" };
  const runtime = r.result?.runtime ?? {};
  const caps: string[] = Array.isArray(runtime.capabilities) ? runtime.capabilities : [];
  return {
    running: Boolean(r.result?.app?.running ?? runtime.reachable),
    appVersion: runtime.appVersion ?? r.result?.app?.version ?? null,
    orchestration: caps.includes("orchestration.contract.v1"),
    capabilities: caps,
    error: null,
  };
}

export interface OrcaHooksStatus {
  enabled: boolean;
  installed: string[];
  notInstalled: string[];
}

/** Which agents carry Orca's status hooks — the feed the sidebar reads. */
export function orcaHooksStatus(timeoutMs = 5_000, env: NodeJS.ProcessEnv = process.env): OrcaHooksStatus | null {
  const r = orcaJson<any>(["agent", "hooks", "status"], { timeoutMs, env });
  if (!r.ok) return null;
  const statuses: Array<{ agent: string; state: string }> = Array.isArray(r.result?.statuses) ? r.result.statuses : [];
  return {
    enabled: Boolean(r.result?.enabled),
    installed: statuses.filter((s) => s.state === "installed").map((s) => s.agent),
    notInstalled: statuses.filter((s) => s.state !== "installed").map((s) => s.agent),
  };
}

/** Open a URL in Orca's embedded browser, scoped to the enclosing workspace.
 *  Returns false (so the caller opens the system browser) unless the host is
 *  active and the tab was created. */
export function orcaOpenUrl(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!orcaHostActive(env)) return false;
  const r = orcaJson(["tab", "create", "--url", url], { timeoutMs: 8_000, env });
  return r.ok;
}

/** `orca repo add` for a project directory. Returns the display name Orca gave
 *  it, or null with the reason. */
export function orcaRegisterProject(dir: string, env: NodeJS.ProcessEnv = process.env): { ok: boolean; displayName: string | null; reason: string | null } {
  const r = orcaJson<any>(["repo", "add", "--path", dir], { timeoutMs: 15_000, env });
  if (r.ok) return { ok: true, displayName: r.result?.repo?.displayName ?? null, reason: null };
  return { ok: false, displayName: null, reason: r.error?.message ?? r.error?.code ?? "unknown" };
}

/** Environment for a child the engine spawns: the pane identity removed so
 *  Orca keeps attributing this terminal to the process the user started here.
 *  Outside Orca the keys are absent and the copy is the environment itself. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return core.stripOrcaPaneEnv({ ...env });
}

/** `~`-shortened path for messages. */
export function shortHome(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}
