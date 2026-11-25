// hermes-bots.ts — Hermes Agent's Bots (Nous Research, Bot Mode) as a host for
// the library's roles, and as specialists the engine can call.
//
// A Bot is a Hermes profile: a folder under <hermes home>/profiles/<id> with
// its own SOUL.md, config, memory and skills. Bot Mode shows a profile in its
// roster when the profile's `profile.yaml` carries `ui_meta["hermes-bots"]`;
// the roster title and description live there. Everything is a file or a CLI
// command, so unlike OpenBot the engine can create the profile itself, with
// `hermes profile create`. It does that only when asked to (`--create`).
//
// What the engine owns: a marked section in a profile's SOUL.md, and the
// `hermes-bots` title and description of a profile it created. Nothing else in
// the profile, and it never deletes one.
//
// Read at Hermes v0.23.4: hermes_cli/profiles.py (profile.yaml, the id rule),
// tools/bot_mode_probe.py (the roster marker), agent/prompt_builder.py (SOUL.md
// is loaded whole up to at least 20 000 characters).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseDocument } from "yaml";
import { resolveExecutable, whichSync } from "./host-agent-driver.ts";

/** Hermes's own rule for a profile id (hermes_constants.PROFILE_ID_RE). */
export const HERMES_PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface HermesBot {
  /** The profile's folder name: what `hermes -p <id>` takes. */
  id: string;
  dir: string;
  /** The name Bot Mode shows, or the display name, or the id. */
  name: string;
  description: string;
  /** In Bot Mode's roster (`ui_meta["hermes-bots"]` present). */
  inRoster: boolean;
}

export type HermesCallState = "done" | "failed" | "timed-out" | "unreachable";

export interface HermesCallResult {
  state: HermesCallState;
  bot: { id: string; name: string } | null;
  answer: string | null;
  reason: string | null;
  /** Files that appeared in the folder the bot worked in. */
  files: string[];
  seconds: number;
}

/** The root Hermes home, whichever profile the caller runs under. */
export function hermesRoot(): string {
  const named = process.env.NIRVANA_HERMES_HOME || process.env.HERMES_HOME;
  if (named) {
    const home = path.resolve(named);
    // A named profile's home is <root>/profiles/<id>.
    return path.basename(path.dirname(home)) === "profiles" ? path.dirname(path.dirname(home)) : home;
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "hermes");
  }
  return path.join(os.homedir(), ".hermes");
}

/** The `hermes` command, or null when it is not installed. */
export function hermesBinary(): string | null {
  const named = process.env.NIRVANA_HERMES_BIN;
  if (named) return fs.existsSync(named) ? named : null;
  return whichSync("hermes");
}

/** True when this process was started by a Hermes agent's terminal tool. */
export function insideHermes(): boolean {
  return Object.keys(process.env).some((k) => k.startsWith("HERMES_SESSION_"));
}

/** The profile this process runs under, or null outside a named profile. */
export function hermesSelf(): string | null {
  const session = process.env.HERMES_SESSION_PROFILE?.trim();
  if (session && session !== "default") return session;
  const home = process.env.HERMES_HOME ? path.resolve(process.env.HERMES_HOME) : "";
  return home && path.basename(path.dirname(home)) === "profiles" ? path.basename(home) : null;
}

export function hermesProfileDir(id: string): string {
  return path.join(hermesRoot(), "profiles", id);
}

export function hermesSoulFile(dir: string): string {
  return path.join(dir, "SOUL.md");
}

function readMeta(dir: string): { name: string; description: string; inRoster: boolean } {
  let doc: any = {};
  try { doc = parseDocument(fs.readFileSync(path.join(dir, "profile.yaml"), "utf8")).toJS() ?? {}; } catch { /* no metadata yet */ }
  const ui = doc && typeof doc.ui_meta === "object" && doc.ui_meta ? doc.ui_meta : {};
  const bots = ui["hermes-bots"];
  const inRoster = Boolean(bots && typeof bots === "object" && !Array.isArray(bots));
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return {
    name: (inRoster && text(bots.title)) || text(doc?.display_name),
    description: text(doc?.description) || (inRoster ? text(bots.description) : ""),
    inRoster,
  };
}

/** Every named profile of this Hermes install. The default profile is the
 *  person's own agent and is not listed. */
export function listHermesProfiles(): HermesBot[] {
  const root = path.join(hermesRoot(), "profiles");
  let names: string[] = [];
  try { names = fs.readdirSync(root).sort(); } catch { return []; }
  const out: HermesBot[] = [];
  for (const id of names) {
    if (id === "default" || !HERMES_PROFILE_ID_RE.test(id)) continue;
    const dir = path.join(root, id);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    const meta = readMeta(dir);
    out.push({ id, dir, name: meta.name || id, description: meta.description, inRoster: meta.inRoster });
  }
  return out;
}

/** The Bots a caller can hand work to: in the roster, and not the caller. */
export function hermesBots(): HermesBot[] {
  const self = hermesSelf();
  return listHermesProfiles().filter((b) => b.inRoster && b.id !== self);
}

/** Put a profile in Bot Mode's roster with a title and a description. The
 *  rest of `profile.yaml`, the person's own roster settings included, is kept. */
export function markHermesBot(dir: string, meta: { title: string; description: string }): void {
  const file = path.join(dir, "profile.yaml");
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { /* a profile with no metadata yet */ }
  const doc = parseDocument(raw);
  if (doc.errors.length) throw new Error(`${file} is not valid YAML: ${doc.errors[0].message}`);
  const description = meta.description.replace(/\s+/g, " ").trim();
  if (!doc.contents) doc.contents = doc.createNode({}) as any;
  doc.set("description", description);
  doc.set("description_auto", false);
  const bots = doc.getIn(["ui_meta", "hermes-bots"]) as any;
  const current = bots && typeof bots.toJSON === "function" ? bots.toJSON() : {};
  doc.setIn(["ui_meta", "hermes-bots", "title"], meta.title);
  doc.setIn(["ui_meta", "hermes-bots", "description"], description);
  if (typeof current?.created !== "number") doc.setIn(["ui_meta", "hermes-bots", "created"], Date.now());
  const next = doc.toString({ lineWidth: 0 });
  if (next !== raw) fs.writeFileSync(file, next, "utf8");
}

function hermesArgv(args: string[]): { command: string; args: string[]; shell: boolean } | null {
  const bin = hermesBinary();
  if (!bin) return null;
  const exe = resolveExecutable(process.env.NIRVANA_HERMES_BIN ? bin : "hermes");
  return { command: exe.command, args: exe.args(args), shell: exe.shell };
}

/** A child's environment with no profile of the caller's: `-p` picks it. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k === "HERMES_HOME" || k.startsWith("HERMES_SESSION_")) delete env[k];
  if (process.env.NIRVANA_HERMES_HOME) env.HERMES_HOME = process.env.NIRVANA_HERMES_HOME;
  return env;
}

/** Whether `hermes profile create` gives a fresh profile the person's model and
 *  keys. It does where Bot Mode's own create exists (the `--no-credentials`
 *  opt-out is its sign); an older Hermes makes a fresh profile with no provider
 *  at all (seen on 0.20.5: "No LLM provider configured"). */
function freshProfileInheritsModel(): boolean {
  const call = hermesArgv(["profile", "create", "--help"]);
  if (!call) return false;
  const r = spawnSync(call.command, call.args, { shell: call.shell, windowsHide: true, encoding: "utf8", env: childEnv(), timeout: 60_000 });
  return /--no-credentials/.test(`${r.stdout ?? ""}${r.stderr ?? ""}`);
}

/** `hermes profile create <id>`, with no shell alias: a profile that works with
 *  the person's own model and keys. On a Hermes whose fresh profile has neither,
 *  it is made with `--clone`, and the copy of the person's SOUL.md is emptied so
 *  the new Bot does not start as a second copy of their agent. */
export function createHermesProfile(id: string, description: string): { ok: boolean; message: string; cloned: boolean } {
  if (!HERMES_PROFILE_ID_RE.test(id)) return { ok: false, message: `"${id}" is not a Hermes profile id`, cloned: false };
  const cloned = !freshProfileInheritsModel();
  const call = hermesArgv(["profile", "create", id, ...(cloned ? ["--clone"] : []), "--no-alias", "--description", description.replace(/\s+/g, " ").trim()]);
  if (!call) return { ok: false, message: "the hermes command is not installed", cloned };
  const r = spawnSync(call.command, call.args, { shell: call.shell, windowsHide: true, encoding: "utf8", env: childEnv(), timeout: 180_000 });
  if (r.error) return { ok: false, message: r.error.message, cloned };
  if (r.status !== 0) return { ok: false, message: (r.stderr || r.stdout || "").trim().split(/\r?\n/).slice(-3).join(" ") || `hermes exited ${r.status}`, cloned };
  const dir = hermesProfileDir(id);
  if (!fs.existsSync(dir)) return { ok: false, message: "hermes answered but the profile folder is not there", cloned };
  if (cloned) { try { fs.writeFileSync(hermesSoulFile(dir), "", "utf8"); } catch { /* the copy stays */ } }
  return { ok: true, message: "", cloned };
}

/** What a called Bot is told on top of the task. */
export const HERMES_TASK_NOTE =
  "This task comes from another agent, through a script. Nobody is at the keyboard: do not ask a question, decide and say what you decided. "
  + "Write every file you make inside the folder named below, by its full path, and name each one, with what it is, in your answer.";

function filesSince(dir: string, sinceMs: number): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1); continue; }
      try { if (fs.statSync(p).mtimeMs >= sinceMs) out.push(p); } catch { /* gone */ }
    }
  };
  walk(dir, 0);
  return out.sort();
}

function findBot(reference: string): { bot: HermesBot | null; reason: string | null } {
  const bots = hermesBots();
  const want = reference.replace(/^@/, "").trim().toLowerCase();
  const exact = bots.filter((b) => b.id === want || b.name.toLowerCase() === want);
  if (exact.length === 1) return { bot: exact[0], reason: null };
  if (exact.length > 1) return { bot: null, reason: `more than one Hermes Bot is called "${reference}": name it by its id (${exact.map((b) => b.id).join(", ")})` };
  return { bot: null, reason: bots.length ? `no Hermes Bot is called "${reference}". They are: ${bots.map((b) => `"${b.name}" (${b.id})`).join(", ")}` : "this Hermes has no Bot in its roster" };
}

/** Hand one task to a Hermes Bot and wait for its answer: one turn of
 *  `hermes -p <id> --in <outDir> -z`. */
export async function askHermesBot(reference: string, task: string, opts: { outDir: string; timeoutMs: number }): Promise<HermesCallResult> {
  const started = Date.now();
  const done = (state: HermesCallState, bot: HermesBot | null, extra: Partial<HermesCallResult> = {}): HermesCallResult => ({
    state, bot: bot ? { id: bot.id, name: bot.name } : null, answer: null, reason: null, files: [],
    seconds: Math.round((Date.now() - started) / 1000), ...extra,
  });
  if (!hermesBinary()) return done("unreachable", null, { reason: "the hermes command is not installed on this computer" });
  const { bot, reason } = findBot(reference);
  if (!bot) return done("failed", null, { reason });
  fs.mkdirSync(opts.outDir, { recursive: true });
  // `--in` is what moves the Bot's tools to the folder: without it they run in the profile's own start folder.
  const call = hermesArgv(["-p", bot.id, "--in", opts.outDir, "-z", `${HERMES_TASK_NOTE}\nFolder for your files: ${opts.outDir}\n\n${task.trim()}`])!;
  return await new Promise<HermesCallResult>((resolve) => {
    const child = spawn(call.command, call.args, { shell: call.shell, windowsHide: true, cwd: opts.outDir, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout!.setEncoding("utf8").on("data", (d: string) => { stdout += d; });
    child.stderr!.setEncoding("utf8").on("data", (d: string) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, opts.timeoutMs);
    const files = () => filesSince(opts.outDir, started - 1000);
    child.on("error", (e) => { clearTimeout(timer); resolve(done("failed", bot, { reason: e.message })); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve(done("timed-out", bot, { answer: stdout.trim() || null, files: files(), reason: "the turn was stopped: a Hermes one-shot cannot be picked up later" }));
      if (code !== 0) return resolve(done("failed", bot, { answer: stdout.trim() || null, files: files(), reason: stderr.trim().split(/\r?\n/).slice(-3).join(" ") || `hermes exited ${code}` }));
      resolve(done("done", bot, { answer: stdout.trim(), files: files() }));
    });
  });
}
