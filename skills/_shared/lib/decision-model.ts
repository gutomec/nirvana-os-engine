// decision-model.ts: one client for the decision models (System One models).
//
// A decision model does not write text. It reads a state and answers closed
// questions with calibrated probabilities in 150-250 ms, for cents per thousand
// calls. Four backends speak almost the same contract, and this file is the
// only place that knows their differences:
//
//   typesafe     TypeSafe Jev        POST https://api.typesafe.ai/v1/systemone    TYPESAFE_API_KEY
//   gemini       Gemini Decision 1   POST .../v1beta/decisions                     GEMINI_API_KEY | GOOGLE_API_KEY
//   openai       OpenAI Decisions    POST https://api.openai.com/v1/decisions      OPENAI_API_KEY
//   local        JEV-27B (AutoTrust) POST <decision.local_url>/v1/decide          none (the user's own server)
//   subscription a text model through the runtime CLI the user is logged in to, asked for
//                the same JSON. Uncalibrated (confidence null): the last resort.
//
// None of the three hosted APIs accepts a ChatGPT or Gemini subscription login
// (checked 2026-11-11): they take API keys only. That is why `subscription`
// exists, and why a key is preferred whenever one is present.
//
// The engine never downloads, installs or starts JEV-27B. `local` only talks to
// a server the user started, and `localCapacity()` only reads the hardware to
// say whether starting one is sensible. See ../DECISION_MODELS.md.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveSetting } from "./settings.ts";

export type DecisionProvider = "local" | "typesafe" | "gemini" | "openai" | "subscription";
export const DECISION_PROVIDERS: DecisionProvider[] = ["local", "typesafe", "gemini", "openai", "subscription"];

export const DECISION_MODELS: Record<Exclude<DecisionProvider, "subscription">, string> = {
  typesafe: "jev-latest",
  gemini: "gemini-decision-1",
  openai: "gpt-6-luna",
  local: "autotrust/JEV-27B",
};

/** A string setting, or "" when the settings layer cannot be read. */
export function settingText(key: string): string {
  try { return String(resolveSetting(key as never).value ?? "").trim(); } catch { return ""; }
}

const KEY_ENV: Record<"typesafe" | "gemini" | "openai", string[]> = {
  typesafe: ["TYPESAFE_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openai: ["OPENAI_API_KEY"],
};

export type DecisionQuestion =
  | { type: "yes_no"; instructions: string }
  | { type: "choice"; instructions: string; options: Record<string, string> }
  | { type: "score"; instructions: string; levels: string[] };

export type DecisionAnswer =
  | { type: "yes_no"; probability: number; confidence: number | null }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number | null }
  | { type: "score"; score: number; probabilities: number[]; confidence: number | null };

export interface DecisionRequest {
  /** What every question is about: text, or JSON that is sent as text. */
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, DecisionQuestion>;
}

export interface DecisionResult {
  provider: DecisionProvider;
  model: string;
  answers: Record<string, DecisionAnswer>;
  latency_ms: number;
}

export interface DecisionError {
  error: string;
  /** Each provider tried, with why it failed. */
  tried: Array<{ provider: DecisionProvider; error: string }>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface DecideOptions {
  /** A provider to use alone; omitted = the `decision.provider` setting (auto = the order below). */
  provider?: DecisionProvider | "auto";
  /** Exclude the subscription fallback (callers that must not start a CLI). */
  apiOnly?: boolean;
  env?: Record<string, string | undefined>;
  localUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /** The subscription backend: sends a prompt to the logged-in runtime CLI, returns its text. */
  callHost?: (prompt: string) => Promise<string>;
}

const QUESTION_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/** Throws on a request no backend would accept, before any network call. */
export function validateRequest(req: DecisionRequest): void {
  const names = Object.keys(req.questions ?? {});
  if (!names.length) throw new Error("at least one question is required");
  if (names.length > 255) throw new Error("at most 255 questions per request (the tightest backend limit)");
  for (const name of names) {
    if (!QUESTION_KEY.test(name)) throw new Error(`question name "${name}" must match [A-Za-z0-9_-], 1 to 64 characters`);
    const q = req.questions[name];
    if (!q?.instructions?.trim()) throw new Error(`question "${name}" has no instructions`);
    if (q.type === "choice") {
      const n = Object.keys(q.options ?? {}).length;
      if (n < 2 || n > 255) throw new Error(`question "${name}" needs 2 to 255 options`);
    } else if (q.type === "score") {
      if (!Array.isArray(q.levels) || q.levels.length < 2 || q.levels.length > 10) throw new Error(`question "${name}" needs 2 to 10 levels`);
    } else if (q.type !== "yes_no") {
      throw new Error(`question "${name}" has unknown type "${(q as { type: string }).type}" (yes_no | choice | score)`);
    }
  }
}

// ── keys and settings ───────────────────────────────────────────────────────

/** The env and the engine's .env chain, read for the decision keys only. */
export function decisionEnv(base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const wanted = Object.values(KEY_ENV).flat();
  const out: Record<string, string | undefined> = { ...base };
  const home = base.NIRVANA_HOME || os.homedir();
  const files = [path.join(process.cwd(), ".env"), path.join(home, ".nirvana", ".env"), path.join(os.homedir(), ".claude", ".env"), path.join(os.homedir(), ".env")];
  for (const file of files) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || !wanted.includes(m[1]) || out[m[1]]) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (v) out[m[1]] = v;
    }
  }
  return out;
}

function keyFor(provider: "typesafe" | "gemini" | "openai", env: Record<string, string | undefined>): string | null {
  for (const name of KEY_ENV[provider]) if (env[name]?.trim()) return env[name]!.trim();
  return null;
}

/** Which providers can be called right now, in the order auto tries them. */
export function availableProviders(opts: { env?: Record<string, string | undefined>; localUrl?: string; hostAvailable?: boolean } = {}): DecisionProvider[] {
  const env = opts.env ?? decisionEnv();
  const out: DecisionProvider[] = [];
  if ((opts.localUrl ?? settingText("decision.local_url")).trim()) out.push("local");
  for (const p of ["typesafe", "gemini", "openai"] as const) if (keyFor(p, env)) out.push(p);
  if (opts.hostAvailable ?? true) out.push("subscription");
  return out;
}

// ── the backends ────────────────────────────────────────────────────────────

const stateText = (s: DecisionRequest["state"]): string => (typeof s === "string" ? s : JSON.stringify(s));
const clamp01 = (n: unknown): number => Math.min(1, Math.max(0, Number(n)));
const num = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);

/** Probabilities in any of the shapes the backends use, as a map keyed by option. */
function probMap(raw: unknown, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (Array.isArray(raw)) {
    raw.forEach((v, i) => {
      if (typeof v === "number") { if (keys[i] !== undefined) out[keys[i]] = v; }
      else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        const k = String(o.value ?? o.choice ?? o.label ?? o.level ?? keys[i]);
        const p = num(o.probability ?? o.p);
        if (p !== null) out[k] = p;
      }
    });
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) if (num(v) !== null) out[k] = v as number;
  }
  return out;
}

function normalizeAnswer(q: DecisionQuestion, a: Record<string, unknown>): DecisionAnswer {
  const confidence = num(a.confidence);
  if (q.type === "yes_no") {
    const p = num(a.noul ?? a.probability);
    if (p === null) throw new Error("yes_no answer without a probability");
    return { type: "yes_no", probability: clamp01(p), confidence };
  }
  if (q.type === "choice") {
    const keys = Object.keys(q.options);
    const probabilities = probMap(a.probabilities, keys);
    const choice = typeof a.choice === "string" ? a.choice
      : Object.entries(probabilities).sort((x, y) => y[1] - x[1])[0]?.[0];
    if (!choice) throw new Error("choice answer without a choice");
    return { type: "choice", choice, probabilities, confidence };
  }
  const levels = q.levels.map((_, i) => String(i));
  const pm = probMap(a.probabilities, levels);
  const probabilities = levels.map((l) => pm[l] ?? 0);
  const score = num(a.score);
  if (score === null) throw new Error("score answer without a score");
  return { type: "score", score, probabilities, confidence };
}

async function post(fetchImpl: FetchLike, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<any> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "nirvana-os", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { throw new Error(`not JSON: ${text.slice(0, 200)}`); }
}

/** TypeSafe and Gemini share the map-of-questions shape with `noul`. */
function criteriaQuestions(req: DecisionRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, q] of Object.entries(req.questions)) {
    if (q.type === "yes_no") out[name] = { type: "noul", instructions: q.instructions };
    else if (q.type === "choice") out[name] = { type: "choice", instructions: q.instructions, criteria: q.options };
    else out[name] = { type: "score", instructions: q.instructions, criteria: q.levels };
  }
  return out;
}

function mapAnswers(req: DecisionRequest, raw: unknown): Record<string, DecisionAnswer> {
  const byName: Record<string, Record<string, unknown>> = {};
  if (Array.isArray(raw)) for (const a of raw) { if (a && typeof a === "object" && typeof (a as any).name === "string") byName[(a as any).name] = a as Record<string, unknown>; }
  else if (raw && typeof raw === "object") Object.assign(byName, raw);
  const out: Record<string, DecisionAnswer> = {};
  for (const [name, q] of Object.entries(req.questions)) {
    const a = byName[name];
    if (!a) throw new Error(`no answer for "${name}"`);
    if ((a as any).type === "refusal") throw new Error(`the model refused "${name}"`);
    out[name] = normalizeAnswer(q, a);
  }
  return out;
}

async function callTypesafe(req: DecisionRequest, key: string, f: FetchLike, t: number) {
  const body = { model: DECISION_MODELS.typesafe, state: req.state, questions: criteriaQuestions(req) };
  const res = await post(f, "https://api.typesafe.ai/v1/systemone", { authorization: `Bearer ${key}` }, body, t);
  return { model: String(res.model ?? DECISION_MODELS.typesafe), answers: mapAnswers(req, res.answers) };
}

async function callGemini(req: DecisionRequest, key: string, f: FetchLike, t: number) {
  const body = { model: DECISION_MODELS.gemini, input: stateText(req.state), questions: criteriaQuestions(req) };
  const res = await post(f, "https://generativelanguage.googleapis.com/v1beta/decisions", { "x-goog-api-key": key }, body, t);
  return { model: DECISION_MODELS.gemini, answers: mapAnswers(req, res.answers) };
}

async function callOpenai(req: DecisionRequest, key: string, f: FetchLike, t: number) {
  // OpenAI names the yes/no type `predicate` and takes options and levels as
  // lists of objects ({value, description} and {label, description}).
  const questions = Object.entries(req.questions).map(([name, q]) => {
    if (q.type === "yes_no") return { type: "predicate", name, instructions: q.instructions };
    if (q.type === "choice") {
      return { type: "choice", name, instructions: q.instructions, choices: Object.entries(q.options).map(([value, description]) => (description ? { value, description } : { value })) };
    }
    return { type: "score", name, instructions: q.instructions, levels: q.levels.map((description, i) => ({ label: String(i), description })) };
  });
  const body = { model: DECISION_MODELS.openai, input: stateText(req.state), questions };
  const res = await post(f, "https://api.openai.com/v1/decisions", { authorization: `Bearer ${key}` }, body, t);
  return { model: String(res.model ?? DECISION_MODELS.openai), answers: mapAnswers(req, res.answers) };
}

/** JEV-27B's serve_decide.py: one question per call, options as a list, score fixed at 0-5. */
async function callLocal(req: DecisionRequest, baseUrl: string, f: FetchLike, t: number) {
  const url = baseUrl.replace(/\/+$/, "") + "/v1/decide";
  const answers: Record<string, DecisionAnswer> = {};
  for (const [name, q] of Object.entries(req.questions)) {
    if (q.type === "yes_no") {
      const r = await post(f, url, {}, { kind: "noul", state: stateText(req.state), question: q.instructions }, t);
      const p = probMap(r.probabilities, ["false", "true"]);
      answers[name] = { type: "yes_no", probability: clamp01(p.true ?? 0), confidence: Math.max(p.true ?? 0, p.false ?? 0) };
    } else if (q.type === "choice") {
      const keys = Object.keys(q.options);
      const desc = Object.entries(q.options).filter(([, d]) => d).map(([k, d]) => `- ${k}: ${d}`).join("\n");
      const r = await post(f, url, {}, { kind: "choice", state: stateText(req.state), question: desc ? `${q.instructions}\n${desc}` : q.instructions, options: keys }, t);
      const probabilities = probMap(r.probabilities, keys);
      const choice = typeof r.choice === "string" ? r.choice : keys[r.choice_index ?? 0];
      answers[name] = { type: "choice", choice, probabilities, confidence: Math.max(0, ...Object.values(probabilities)) };
    } else {
      // The local score scale is 0-5; levels map onto it and the result maps back.
      const scale = q.levels.map((l, i) => `${i}: ${l}`).join("\n");
      const r = await post(f, url, {}, { kind: "score", state: stateText(req.state), question: `${q.instructions}\nAnswer on this scale, using only the numbers listed:\n${scale}` }, t);
      const p = probMap(r.probabilities, ["0", "1", "2", "3", "4", "5"]);
      const probabilities = q.levels.map((_, i) => p[String(i)] ?? 0);
      const total = probabilities.reduce((s, v) => s + v, 0) || 1;
      const norm = probabilities.map((v) => v / total);
      answers[name] = { type: "score", score: norm.reduce((s, v, i) => s + v * i, 0), probabilities: norm, confidence: Math.max(...norm) };
    }
  }
  return { model: DECISION_MODELS.local, answers };
}

/** The prompt the subscription fallback sends. Exported for the tests. */
export function subscriptionPrompt(req: DecisionRequest): string {
  const qs = Object.entries(req.questions).map(([name, q]) => {
    if (q.type === "yes_no") return `- ${name} (yes_no): ${q.instructions}\n  answer: {"probability": <0..1 that it is true>}`;
    if (q.type === "choice") return `- ${name} (choice): ${q.instructions}\n  options: ${JSON.stringify(q.options)}\n  answer: {"choice": "<one option key>", "probabilities": {<key>: <0..1>, ...}}`;
    return `- ${name} (score): ${q.instructions}\n  levels (index from 0): ${JSON.stringify(q.levels)}\n  answer: {"score": <level index, may be fractional>, "probabilities": [<0..1 per level>]}`;
  }).join("\n");
  return [
    "You are a decision function. Do not use tools, do not explain, do not write prose.",
    "Read the STATE, answer every question, and print ONE JSON object keyed by question name. Nothing else.",
    "", "STATE:", stateText(req.state), "", "QUESTIONS:", qs,
  ].join("\n");
}

async function callSubscription(req: DecisionRequest, callHost: (p: string) => Promise<string>) {
  const text = await callHost(subscriptionPrompt(req));
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("the runtime answered without JSON");
  const parsed = JSON.parse(m[0]) as Record<string, Record<string, unknown>>;
  const answers = mapAnswers(req, parsed);
  // A text model's self-reported numbers are not calibrated: never claim a confidence.
  for (const a of Object.values(answers)) a.confidence = null;
  return { model: "runtime-cli", answers };
}

async function defaultCallHost(prompt: string): Promise<string> {
  const { callHostAgentAsync } = await import("./host-agent-driver.ts");
  const r = await callHostAgentAsync("", prompt, { timeoutMs: 120_000 });
  if ("error" in r) throw new Error(r.error);
  return r.text;
}

/** Answers the questions with the first provider that works. Never throws. */
export async function decide(req: DecisionRequest, opts: DecideOptions = {}): Promise<DecisionResult | DecisionError> {
  try { validateRequest(req); } catch (e) { return { error: (e as Error).message, tried: [] }; }
  const env = opts.env ?? decisionEnv();
  const pref = opts.provider ?? (settingText("decision.provider") || "auto") as DecisionProvider | "auto" | "off";
  if (pref === "off") return { error: "decision models are off (decision.provider=off)", tried: [] };
  const localUrl = opts.localUrl ?? settingText("decision.local_url");
  let order = availableProviders({ env, localUrl, hostAvailable: !opts.apiOnly });
  if (pref !== "auto") order = order.includes(pref) ? [pref] : [];
  if (!order.length) {
    return { error: pref === "auto" ? "no decision provider: set TYPESAFE_API_KEY, GEMINI_API_KEY or OPENAI_API_KEY, or decision.local_url" : `decision provider "${pref}" is not configured`, tried: [] };
  }
  const f = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const t = opts.timeoutMs ?? 20_000;
  const tried: DecisionError["tried"] = [];
  for (const provider of order) {
    const started = Date.now();
    try {
      const r = provider === "typesafe" ? await callTypesafe(req, keyFor("typesafe", env)!, f, t)
        : provider === "gemini" ? await callGemini(req, keyFor("gemini", env)!, f, t)
        : provider === "openai" ? await callOpenai(req, keyFor("openai", env)!, f, t)
        : provider === "local" ? await callLocal(req, localUrl!, f, t)
        : await callSubscription(req, opts.callHost ?? defaultCallHost);
      return { provider, model: r.model, answers: r.answers, latency_ms: Date.now() - started };
    } catch (e) {
      tried.push({ provider, error: (e as Error).message.slice(0, 300) });
    }
  }
  return { error: "every decision provider failed", tried };
}

export const isDecisionError = (r: DecisionResult | DecisionError): r is DecisionError => "error" in r;

// ── JEV-27B: can this machine host it? ──────────────────────────────────────

export interface LocalCapacity {
  platform: NodeJS.Platform;
  total_ram_gb: number;
  apple_silicon: boolean;
  gpus: Array<{ name: string; vram_gb: number }>;
  /** The largest build that fits, or none. */
  fits: "bf16" | "q8_0" | "q4_k_m" | "none";
  advice: string;
}

/** Memory each build needs at a 4k context, from the published model cards
 *  (autotrust/JEV-27B, Atlas3D/JEV-27B-VL-GGUF, read 2026-11-11). */
export const JEV27B_NEEDS_GB = { bf16: 54, q8_0: 34, q4_k_m: 23 } as const;

export function localCapacity(probe: {
  platform?: NodeJS.Platform; arch?: string; totalRamBytes?: number;
  nvidiaSmi?: () => string | null;
} = {}): LocalCapacity {
  const platform = probe.platform ?? process.platform;
  const arch = probe.arch ?? process.arch;
  const total_ram_gb = Math.round((probe.totalRamBytes ?? os.totalmem()) / 1024 ** 3);
  const apple_silicon = platform === "darwin" && arch === "arm64";
  const smi = probe.nvidiaSmi ?? (() => {
    const r = spawnSync("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    return r.status === 0 ? r.stdout : null;
  });
  const gpus: LocalCapacity["gpus"] = [];
  if (!apple_silicon) {
    for (const line of (smi() ?? "").split(/\r?\n/)) {
      const m = line.match(/^(.*?),\s*(\d+)\s*$/);
      if (m) gpus.push({ name: m[1].trim(), vram_gb: Math.round(Number(m[2]) / 1024) });
    }
  }
  // Apple Silicon shares memory with the system: leave a third of it to everything else.
  const budget = apple_silicon ? Math.floor(total_ram_gb * 0.66) : Math.max(0, ...gpus.map((g) => g.vram_gb));
  const fits = !apple_silicon && budget >= JEV27B_NEEDS_GB.bf16 ? "bf16"
    : budget >= JEV27B_NEEDS_GB.q8_0 ? "q8_0"
    : budget >= JEV27B_NEEDS_GB.q4_k_m ? "q4_k_m" : "none";
  const advice = fits === "none"
    ? `This machine cannot host JEV-27B (it needs about ${JEV27B_NEEDS_GB.q4_k_m} GB of ${apple_silicon ? "unified memory free" : "GPU memory"}; ${apple_silicon ? `${total_ram_gb} GB total` : gpus.length ? `largest GPU has ${budget} GB` : "no NVIDIA GPU found"}). Use a hosted provider.`
    : fits === "bf16"
      ? "Fits the full bf16 model: serve it with the model card's vLLM quickstart (serve_decide.py) and set decision.local_url."
      : `Fits the ${fits.toUpperCase()} GGUF build. The engine speaks the /v1/decide contract of the model card's serve_decide.py; a GGUF server needs llama.cpp built with the patch from the GGUF card and must expose the same endpoint${apple_silicon ? ". AutoTrust does not document Apple Silicon, so this is unverified" : ""}. Then set decision.local_url.`;
  return { platform, total_ram_gb, apple_silicon, gpus, fits, advice };
}
