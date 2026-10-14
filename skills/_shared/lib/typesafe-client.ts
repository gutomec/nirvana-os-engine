// typesafe-client.ts — TypeSafe's Jev classifier, on plain fetch, opt-in by key.
//
// Jev answers classification questions (a Choice among labelled options, with a
// probability per option) over a text. The engine asks it who should execute a
// request (harness/lib/jev-router.ts) and which voice fits a run
// (harness/lib/jev-voice.ts). It is an external classifier, not a generative
// model: the router LLM and every worker keep the runtime's own default model.
//
// Off unless the user configured a key. Without TYPESAFE_API_KEY nothing here
// sends a byte, and `routing.jev: off` switches it off even with the key. With
// the key, the request text leaves the machine for TypeSafe: that is said in
// docs/architecture/configuration.md.
//
// The key is looked up in the real environment, then the project's .env, then
// ~/.env. It leaves this module only as the Authorization header: never
// printed, logged, written to an audit event or to a result, and scrubbed from
// any error text a failed call carries back.
//
// Never throws. A timeout, a refused connection, a 4xx/5xx or a body that is
// not JSON all come back as `{ ok: false, error }`, and the caller takes the
// path it would take without the key.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveSetting } from "./settings.ts";
import { resolveProjectRoot } from "./project-root.js";

/** The API's model identifier. It names the classifier the endpoint serves, not a generative model the engine picks. */
export const JEV_MODEL = "jev-1.13.0";
export const DEFAULT_TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** Published price: US$ 0.042 per million input tokens; output is free. */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;
/** Measured median 0.64 s, p95 0.70 s on 48 requests (2026-10-13): three seconds is a dead service, not a slow one. */
export const JEV_TIMEOUT_MS = 3_000;
const KEY_VAR = "TYPESAFE_API_KEY";

export type Criterion = string | null | { what?: string; not_for?: string; examples?: string[] };
export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, Criterion> }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } };

export interface ChoiceAnswer { choice: string; confidence: number; probabilities?: Record<string, number> }

export interface JevResult {
  ok: boolean;
  latency_ms: number;
  answers: Record<string, any>;
  input_tokens: number;
  cost_usd: number;
  /** HTTP attempts made: 0 when nothing was sent. */
  attempts: number;
  status?: number;
  error?: string;
}

export interface KeyLookup {
  env?: Record<string, string | undefined>;
  /** Where the project .env is looked for; default process.cwd(). */
  cwd?: string;
  /** The home whose .env is read last; default os.homedir(). */
  home?: string;
}

/** `KEY=value`, `export KEY=value`, quoted or not; null when the file does not set it. */
function keyFromDotenv(file: string): string | null {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const v = m[1].replace(/^(["'])(.*)\1$/, "$2").trim();
    if (v) return v;
  }
  return null;
}

/** The TypeSafe key, from the environment, the project's .env, then ~/.env. Null, never an error, when there is none. */
export function typesafeKey(opts: KeyLookup = {}): string | null {
  const env = opts.env ?? process.env;
  const fromEnv = env[KEY_VAR]?.trim();
  if (fromEnv) return fromEnv;
  let projectRoot: string | null = null;
  try { projectRoot = resolveProjectRoot({ cwd: opts.cwd ?? process.cwd(), env }); } catch { projectRoot = null; }
  if (projectRoot) {
    const k = keyFromDotenv(path.join(projectRoot, ".env"));
    if (k) return k;
  }
  return keyFromDotenv(path.join(opts.home ?? os.homedir(), ".env"));
}

export type JevState = "on" | "no-key" | "setting-off";

/** Why the Jev is or is not in play: the setting first, then the key. */
export function jevState(opts: KeyLookup = {}): JevState {
  let setting = "auto";
  try { setting = String(resolveSetting("routing.jev", { ...(opts.env ? { env: opts.env as any } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}) }).value); } catch { setting = "auto"; }
  if (setting === "off") return "setting-off";
  return typesafeKey(opts) ? "on" : "no-key";
}

/** True when a key exists and `routing.jev` is not off. */
export function jevEnabled(opts: KeyLookup = {}): boolean {
  return jevState(opts) === "on";
}

/** The `nrv doctor` line. */
export function jevDoctorLine(opts: KeyLookup = {}): string {
  const s = jevState(opts);
  return s === "on" ? "jev: on (key found)" : s === "no-key" ? "jev: off (no key)" : "jev: off (routing.jev)";
}

export function typesafeEndpoint(env: Record<string, string | undefined> = process.env): string {
  return env.TYPESAFE_ENDPOINT?.trim() || DEFAULT_TYPESAFE_ENDPOINT;
}

export interface JevCallOpts extends KeyLookup {
  timeoutMs?: number;
  /** Test seam: the fetch to use. Default: Bun's global fetch. */
  fetchImpl?: typeof fetch;
}

const scrub = (text: string, key: string | null) => (key ? text.split(key).join("[redacted]") : text);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One POST with `state`, `model` and the questions; the answers come back under
 * the same keys. The timeout covers the whole call, retry included; the one
 * retry happens only on 429/529 and only while time is left.
 */
export async function jevCall(state: unknown, questions: Record<string, JevQuestion>, opts: JevCallOpts = {}): Promise<JevResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const fail = (error: string, attempts: number, status?: number): JevResult =>
    ({ ok: false, latency_ms: elapsed(), answers: {}, input_tokens: 0, cost_usd: 0, attempts, ...(status !== undefined ? { status } : {}), error });
  let key: string | null = null;
  try {
    key = typesafeKey(opts);
    if (!key) return fail("no TypeSafe key", 0);
    const env = opts.env ?? process.env;
    const doFetch = opts.fetchImpl ?? fetch;
    const timeoutMs = opts.timeoutMs ?? JEV_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const body = JSON.stringify({ state, model: JEV_MODEL, questions });
    let attempts = 0;
    for (;;) {
      attempts++;
      const left = deadline - Date.now();
      if (left <= 0) return fail(`timed out after ${timeoutMs} ms`, attempts - 1);
      let r: Response;
      try {
        r = await doFetch(typesafeEndpoint(env), {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(left),
        });
      } catch (e: any) {
        const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
        return fail(timedOut ? `timed out after ${timeoutMs} ms` : scrub(String(e?.message ?? e), key).slice(0, 300), attempts);
      }
      if (r.ok) {
        let parsed: any;
        try { parsed = await r.json(); } catch { return fail("the response is not JSON", attempts, r.status); }
        if (!parsed || typeof parsed !== "object" || typeof parsed.answers !== "object" || parsed.answers === null) return fail("the response carries no answers", attempts, r.status);
        const tokens = Number(parsed?.usage?.input_tokens ?? 0) || 0;
        return { ok: true, latency_ms: elapsed(), answers: parsed.answers, input_tokens: tokens, cost_usd: tokens * JEV_USD_PER_INPUT_TOKEN, attempts, status: r.status };
      }
      const text = scrub(await r.text().catch(() => ""), key).slice(0, 300);
      if ((r.status === 429 || r.status === 529) && attempts === 1 && deadline - Date.now() > 300) {
        await sleep(Math.min(250, deadline - Date.now() - 50));
        continue;
      }
      return fail(`HTTP ${r.status}${text ? `: ${text}` : ""}`, attempts, r.status);
    }
  } catch (e: any) {
    return fail(scrub(String(e?.message ?? e), key).slice(0, 300), 0);
  }
}

/**
 * The same call from synchronous code (the voice selection runs inside the
 * synchronous prompt build). A child Bun process makes the call and prints the
 * result; the key never crosses argv, the child finds it as this process does.
 */
export function jevCallSync(state: unknown, questions: Record<string, JevQuestion>, opts: KeyLookup & { timeoutMs?: number } = {}): JevResult {
  const started = performance.now();
  const timeoutMs = opts.timeoutMs ?? JEV_TIMEOUT_MS;
  const fail = (error: string): JevResult => ({ ok: false, latency_ms: Math.round(performance.now() - started), answers: {}, input_tokens: 0, cost_usd: 0, attempts: 0, error });
  if (!typesafeKey(opts)) return fail("no TypeSafe key");
  try {
    const script = path.join(import.meta.dir, "..", "scripts", "jev-call.ts");
    const r = spawnSync(process.execPath, [script], {
      input: JSON.stringify({ state, questions, timeoutMs, cwd: opts.cwd ?? process.cwd(), home: opts.home ?? null }),
      encoding: "utf8",
      env: { ...process.env, ...(opts.env ?? {}) } as NodeJS.ProcessEnv,
      // The child's own deadline is timeoutMs; this one only stops a child that hangs past it.
      timeout: timeoutMs + 5_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    const out = (r.stdout || "").trim();
    if (!out) return fail(r.error ? String(r.error.message) : `the Jev call process exited ${r.status ?? "on a signal"}`);
    const parsed = JSON.parse(out) as JevResult;
    return parsed && typeof parsed.ok === "boolean" ? parsed : fail("the Jev call process printed no result");
  } catch (e: any) {
    return fail(String(e?.message ?? e).slice(0, 300));
  }
}

/** A Choice answer under `key`, or null when the response has none. */
export function choiceOf(answers: Record<string, any> | undefined, key: string): ChoiceAnswer | null {
  const a = answers?.[key];
  if (!a || typeof a.choice !== "string") return null;
  const confidence = Number(a.confidence);
  return { choice: a.choice, confidence: Number.isFinite(confidence) ? confidence : 0, ...(a.probabilities && typeof a.probabilities === "object" ? { probabilities: a.probabilities } : {}) };
}
