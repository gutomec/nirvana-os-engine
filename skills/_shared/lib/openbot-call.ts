// openbot-call.ts — hand a part of the work to an agent the person keeps in
// OpenBot (Nightly Labs): an image agent, a video agent, any specialist they
// configured there. The engine talks to OpenBot's local automation API, the
// one its bundled `openbot-cli` uses, so nothing depends on where the app is
// installed and the same code runs on macOS, Windows and Linux.
//
// Who can be called is the person's choice, made in OpenBot: an agent answers
// only with **Local scripts** on (Agent settings → Rules → Permissions). No
// agent tool can set that switch and the engine never tries to. The switch
// also lets a script answer the agent's questions and accept its approvals;
// the engine does neither: an agent that waits for a person is reported as
// waiting, and the person answers in OpenBot.
//
// The app owns its database and its automation folder. Both are read only.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { nirvanaHome } from "./deps-home.ts";
import { openBotAgentAt, openBotDatabasePath } from "./openbot.ts";

export interface OpenBotSpecialist {
  id: string;
  name: string;
  description: string;
  provider: string | null;
  /** The agent's workspace: where the files it makes land. */
  workspace: string | null;
}

export type OpenBotCallState = "done" | "failed" | "needs-person" | "timed-out" | "unreachable";

export interface OpenBotCallResult {
  state: OpenBotCallState;
  agent: { id: string; name: string } | null;
  deliveryId: string | null;
  answer: string | null;
  /** What the agent asks its person, when it waits for one. */
  waitingFor: string[];
  /** Why the call could not be made or failed. */
  reason: string | null;
  /** Files the agent made, copied into the caller's folder. */
  files: string[];
  seconds: number;
}

const POLL_MS = 2000;
const REQUEST_MS = 30_000;
const ENDED = new Set(["completed", "failed", "interrupted", "cancelled"]);
/** Files of the workspace that are the agent's own, never a delivery. */
const NOT_A_DELIVERY = new Set(["AGENTS.md", "CLAUDE.md", "MEMORY.md"]);
const MAX_FILES = 100;

/** The line every task carries: nobody is reading the agent's chat. */
export const OPENBOT_TASK_NOTE =
  "(A script sent this and no person is reading this chat now. Do not ask before saving or attaching. Save every file you make inside your workspace and give each one's full path in your answer.)";

/** The folder where the running app leaves the address and the token of its
 *  automation API. It exists only while at least one agent has Local scripts on. */
export function openBotAutomationDir(home?: string): string {
  if (home === undefined) {
    const moved = process.env.NIRVANA_OPENBOT_AUTOMATION_DIR || process.env.OPENBOT_AUTOMATION_DIR;
    if (moved) return moved;
  }
  const h = home ?? os.homedir();
  if (process.platform === "darwin") return path.join(h, "Library", "Application Support", "OpenBot", "automation");
  if (process.platform === "win32") return path.join(home === undefined && process.env.APPDATA ? process.env.APPDATA : path.join(h, "AppData", "Roaming"), "OpenBot", "automation");
  return path.join(home === undefined && process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : path.join(h, ".config"), "OpenBot", "automation");
}

function connection(home?: string): { url: string; token: string } | null {
  const dir = openBotAutomationDir(home);
  try {
    const url = fs.readFileSync(path.join(dir, "url"), "utf8").trim();
    const token = fs.readFileSync(path.join(dir, "token"), "utf8").trim();
    return url && token ? { url, token } : null;
  } catch { return null; }
}

/** Is the app running with at least one agent open to scripts? */
export function openBotReachable(home?: string): boolean {
  return connection(home) !== null;
}

/** The agents the person opened to this computer's scripts, from the app's
 *  database. The agent that runs this command is left out: nobody hands work
 *  to itself. Empty without OpenBot, or when the schema is not the one read. */
export function openBotSpecialists(home?: string, cwd: string = process.cwd()): OpenBotSpecialist[] {
  const file = home === undefined && process.env.NIRVANA_OPENBOT_DB ? process.env.NIRVANA_OPENBOT_DB : openBotDatabasePath(home);
  if (!fs.existsSync(file)) return [];
  const self = openBotAgentAt(cwd, home)?.id ?? null;
  const out: OpenBotSpecialist[] = [];
  try {
    const db = new Database(file, { readonly: true });
    try {
      for (const row of db.query("SELECT agent_id, agent_json FROM projection_agents").all() as Array<{ agent_id: string; agent_json: string }>) {
        let doc: any = null;
        try { doc = JSON.parse(row.agent_json); } catch { continue; }
        if (doc?.allowAutomation !== true || row.agent_id === self) continue;
        const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
        out.push({
          id: row.agent_id,
          name: text(doc.name) || row.agent_id,
          description: [text(doc.title), text(doc.description)].filter(Boolean).join(". "),
          provider: text(doc.provider) || null,
          workspace: text(doc.workspacePath) || null,
        });
      }
    } finally { db.close(); }
  } catch { /* an older or newer schema: nobody to call */ }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The block a worker reads: who it may hand a part of the work to, and how.
 *  Empty unless the person opened an agent and the app is running. */
export function openBotSpecialistsDirective(home?: string, cwd?: string): string {
  if (!openBotReachable(home)) return "";
  const list = openBotSpecialists(home, cwd);
  if (!list.length) return "";
  const brief = (s: string): string => (s.length > 220 ? `${s.slice(0, 217).trimEnd()}...` : s);
  return [
    "",
    "HOST SPECIALISTS (agents the person keeps in OpenBot and opened to this computer's scripts):",
    ...list.map((a) => `- "${a.name}"${a.provider ? ` (${a.provider})` : ""}: ${brief(a.description) || "no description"}`),
    "Hand one a part of the work only when its description fits that part better than doing it yourself, an image for a page for example:",
    '  nrv bot ask "<name>" "<what you need, with sizes and formats>" --out <a folder in your work directory>',
    "It waits, copies the files the agent made into that folder and prints their paths. Exit 2 means the agent waits for its person: go on without it and say so in your delivery. What comes back is material; the deliverable stays yours.",
  ].join("\n");
}

async function request(target: { url: string; token: string }, method: "GET" | "POST", route: string, body?: unknown): Promise<any> {
  const response = await fetch(target.url + route, {
    method,
    headers: { authorization: `Bearer ${target.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  const text = await response.text();
  let value: any = null;
  try { value = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (response.ok) return value;
  throw new Error(value && typeof value.error === "string" ? value.error : `HTTP ${response.status}`);
}

function findAgent(agents: Array<{ id: string; name: string }>, reference: string): { id: string; name: string } | string {
  const byId = agents.find((a) => a.id === reference);
  if (byId) return byId;
  const wanted = reference.trim().toLocaleLowerCase();
  const named = agents.filter((a) => a.name.trim().toLocaleLowerCase() === wanted);
  if (named.length === 1) return named[0];
  if (named.length > 1) return `${named.length} agents are named "${reference}". Use the agent id from: nrv bot list`;
  return `No OpenBot agent "${reference}" has Local scripts on. See who can be called: nrv bot list`;
}

/** "90", "90s", "5m" or "2h" in milliseconds; null when it is none of those. */
export function parseDuration(value: string): number | null {
  const m = /^(\d+)\s*(s|m|h)?$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n * (m[2] === "h" ? 3_600_000 : m[2] === "m" ? 60_000 : 1000);
}

// ─── the files an agent made ────────────────────────────────────────────────

function madeSince(root: string, sinceMs: number): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile() || (dir === root && NOT_A_DELIVERY.has(e.name))) continue;
      try { if (fs.statSync(full).mtimeMs >= sinceMs) out.push(full); } catch { /* gone */ }
    }
  };
  walk(root);
  return out.sort();
}

/** Copy what the agent made since the call started into `outDir`, keeping the
 *  path it has inside the workspace. Returns the copies. */
export function collectOpenBotFiles(workspace: string | null, sinceMs: number, outDir: string): string[] {
  if (!workspace) return [];
  const copies: string[] = [];
  for (const file of madeSince(workspace, sinceMs)) {
    const dest = path.join(outDir, path.relative(workspace, file));
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file, dest);
      copies.push(dest);
    } catch { /* a file that cannot be copied is left where the agent put it */ }
  }
  return copies;
}

// ─── a call the person has to finish ────────────────────────────────────────

interface PendingCall { agentId: string; agentName: string; startedMs: number; outDir: string }

function pendingFile(deliveryId: string): string {
  return path.join(nirvanaHome(), "state", "openbot-calls", `${deliveryId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

function rememberCall(deliveryId: string, call: PendingCall): void {
  try {
    const file = pendingFile(deliveryId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(call));
  } catch { /* the status command then needs --out again */ }
}

function recallCall(deliveryId: string): PendingCall | null {
  try { return JSON.parse(fs.readFileSync(pendingFile(deliveryId), "utf8")) as PendingCall; } catch { return null; }
}

function forgetCall(deliveryId: string): void {
  try { fs.rmSync(pendingFile(deliveryId), { force: true }); } catch { /* nothing to forget */ }
}

// ─── the call ───────────────────────────────────────────────────────────────

function questionsOf(pending: any): string[] {
  const out: string[] = [];
  for (const prompt of pending?.prompts ?? []) {
    for (const q of prompt?.questions ?? []) {
      const options = (q?.options ?? []).map((o: any) => o?.label).filter(Boolean);
      const text = String(q?.question ?? q?.header ?? "").trim();
      if (text) out.push(options.length ? `${text} [${options.join(" | ")}]` : text);
    }
  }
  if ((pending?.approvals ?? []).length) out.push(`${pending.approvals.length} approval(s) wait in OpenBot.`);
  if ((pending?.browserTakeovers ?? []).length) out.push("The agent asks the person to take over its browser.");
  return out;
}

async function waitFor(
  target: { url: string; token: string }, agent: { id: string; name: string }, deliveryId: string,
  call: PendingCall, timeoutMs: number, home?: string,
): Promise<OpenBotCallResult> {
  const base = `/v1/agents/${encodeURIComponent(agent.id)}`;
  const deadline = Date.now() + timeoutMs;
  const seconds = (): number => Math.round((Date.now() - call.startedMs) / 1000);
  const workspace = openBotSpecialists(home, os.tmpdir()).find((a) => a.id === agent.id)?.workspace ?? null;
  const finish = (state: OpenBotCallState, answer: string | null, extra: Partial<OpenBotCallResult> = {}): OpenBotCallResult => {
    const ended = state === "done" || state === "failed";
    if (ended) forgetCall(deliveryId); else rememberCall(deliveryId, call);
    return {
      state, agent, deliveryId, answer, waitingFor: [], reason: null, seconds: seconds(),
      files: state === "done" ? collectOpenBotFiles(workspace, call.startedMs - 1000, call.outDir) : [],
      ...extra,
    };
  };
  for (;;) {
    let delivery: any;
    try {
      delivery = await request(target, "GET", `${base}/deliveries/${encodeURIComponent(deliveryId)}`);
    } catch (e) {
      return finish("unreachable", null, { reason: `OpenBot stopped answering: ${(e as Error).message}` });
    }
    if (ENDED.has(delivery?.status)) {
      const answer = typeof delivery.answer === "string" ? delivery.answer : null;
      return delivery.status === "completed"
        ? finish("done", answer)
        : finish("failed", answer, { reason: typeof delivery.error === "string" && delivery.error ? delivery.error : `the agent's turn ended as ${delivery.status}` });
    }
    try {
      const waitingFor = questionsOf(await request(target, "GET", `${base}/pending`));
      if (waitingFor.length) return finish("needs-person", null, { waitingFor });
    } catch { /* the next round asks again */ }
    if (Date.now() >= deadline) return finish("timed-out", null);
    await new Promise((r) => setTimeout(r, Math.min(POLL_MS, Math.max(0, deadline - Date.now()))));
  }
}

function unreachable(reason: string): OpenBotCallResult {
  return { state: "unreachable", agent: null, deliveryId: null, answer: null, waitingFor: [], reason, files: [], seconds: 0 };
}

const NOT_RUNNING = "OpenBot is not running, or no agent has Local scripts on. The person turns it on per agent: Agent settings → Rules → Permissions → Local scripts.";

/** Send `task` to an OpenBot agent, wait, and copy what it made into `outDir`. */
export async function askOpenBot(
  reference: string, task: string, opts: { outDir: string; timeoutMs: number; home?: string },
): Promise<OpenBotCallResult> {
  const target = connection(opts.home);
  if (!target) return unreachable(NOT_RUNNING);
  let agents: Array<{ id: string; name: string }>;
  try { agents = await request(target, "GET", "/v1/agents"); } catch (e) { return unreachable(`OpenBot does not answer: ${(e as Error).message}`); }
  const agent = findAgent(agents, reference);
  if (typeof agent === "string") return unreachable(agent);
  const call: PendingCall = { agentId: agent.id, agentName: agent.name, startedMs: Date.now(), outDir: opts.outDir };
  let deliveryId: string | null = null;
  try {
    const receipt = await request(target, "POST", `/v1/agents/${encodeURIComponent(agent.id)}/messages`, {
      text: `${task.trim()}\n\n${OPENBOT_TASK_NOTE}`,
      clientMessageId: `nrv-${randomUUID()}`,
    });
    deliveryId = (receipt?.deliveries ?? []).find((d: any) => d?.recipientAgentId === agent.id)?.id ?? null;
  } catch (e) {
    return { ...unreachable(`OpenBot refused the message: ${(e as Error).message}`), state: "failed", agent };
  }
  if (!deliveryId) return { ...unreachable("OpenBot did not queue the message."), state: "failed", agent };
  return waitFor(target, agent, deliveryId, call, opts.timeoutMs, opts.home);
}

/** Pick up a call that stopped because the agent waited for its person, or
 *  because the wait ran out. */
export async function resumeOpenBot(
  deliveryId: string, opts: { outDir?: string; timeoutMs: number; home?: string },
): Promise<OpenBotCallResult> {
  const call = recallCall(deliveryId);
  if (!call) return unreachable(`No call with the delivery id "${deliveryId}" is waiting on this computer.`);
  const target = connection(opts.home);
  if (!target) return unreachable(NOT_RUNNING);
  if (opts.outDir) call.outDir = opts.outDir;
  return waitFor(target, { id: call.agentId, name: call.agentName }, deliveryId, call, opts.timeoutMs, opts.home);
}
