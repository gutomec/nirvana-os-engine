// runs.ts — a run is `nrv dispatch --auto --exec` in a child process.
//
// The API is a CONTROL PLANE: it never executes a brief in-process. Spawning
// the same binary the CLI uses buys crash isolation, one execution path
// forever, and the run ledger + supervisor as the safety net (an orphaned
// child is swept and salvaged exactly like a CLI run).
//
// The envelope wraps what the engine already produces — exit codes map 1:1
// to delivery states, `_SUMMARY.md` and `_QA-RESERVATIONS.md` become fields.

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import * as ledger from "../run-ledger.ts";
import type { SessionRecord } from "./sessions.ts";
import { listArtifacts } from "./artifacts.ts";
import { childEnvFor } from "../../../_shared/lib/child-env.ts";
import { defaultDotenvFiles, knownSecrets, redactText } from "../../../_shared/lib/secret-scan.ts";

/** The secrets a response from this server must never carry: credential-like
 *  variables of the server and the dotenv files of the session and the home. */
/** Did the runtime error after producing files? The dispatcher records it in
 *  the run own audit; absence of the file simply means no. */
function runtimeErrored(outputsRoot: string): boolean {
  for (const f of [path.join(outputsRoot, "audit.jsonl"), path.join(outputsRoot, "..", "audit.jsonl")]) {
    try {
      if (fs.readFileSync(f, "utf8").includes("x_runtime_errored_with_artifacts")) return true;
    } catch { /* no audit here */ }
  }
  return false;
}

export function serveKnownSecrets(sessionDir: string): Array<[string, string]> {
  return knownSecrets({ env: process.env, dotenvFiles: defaultDotenvFiles({ cwd: sessionDir, projectRoot: sessionDir }) });
}

/** Text with known secret values and credential-shaped content masked. */
export function redactForClient(text: string | null, sessionDir: string): { text: string | null; redactions: number } {
  if (text == null) return { text, redactions: 0 };
  return redactText(text, serveKnownSecrets(sessionDir));
}

/**
 * Where a run's artifacts live, for `nrv serve`.
 *
 * One function so the writer and both readers cannot drift apart again. It is
 * the same shape `outputsDir()` returns for a project — `<root>/outputs/<run>`
 * — which is what OUTPUTS_CONTRACT calls canonical and what every other layer
 * of the engine computes on its own. An empty `traceId` returns the base.
 */
export function runOutputsRoot(sessionDir: string, traceId: string): string {
  return traceId ? path.join(sessionDir, "outputs", traceId) : path.join(sessionDir, "outputs");
}

export type RunEnvelopeState = "queued" | "running" | "delivered" | "withheld" | "indeterminate" | "failed" | "cancelled";

export interface RunEnvelope {
  trace_id: string;
  session_id: string;
  state: RunEnvelopeState;
  /** Gate verdict as the delivery pipeline reported it. */
  gate: "pass" | "fail-accepted" | "fail" | "indeterminate" | null;
  brief_excerpt: string;
  created_at: string;
  finished_at: string | null;
  exit_code: number | null;
  artifacts: { path: string; bytes: number; content_type: string }[];
  /** Contents of outputs/_SUMMARY.md when the target wrote one. */
  summary: string | null;
  /** Contents of _QA-RESERVATIONS.md — honesty as a field, not a footnote. */
  reservations: string | null;
  /**
   * True when the runtime reported an error and the work was judged anyway.
   *
   * Not a failure state: the artifacts existed, the verifier ran and the gate
   * approved them, which is the engine doing the right thing rather than
   * throwing away finished work. But a client reading `delivered` with exit 0
   * had no way to know the runtime had died, while the ledger, the audit and
   * the CLI all did. A fact the engine holds and the answer omits is the kind
   * of silence this envelope exists to prevent.
   */
  runtime_errored: boolean;
  error: string | null;
}

interface RunMemo {
  trace_id: string;
  session: SessionRecord;
  key_id: string;
  brief: string;
  outputs_root: string;
  created_at: string;
  finished_at: string | null;
  exit_code: number | null;
  error: string | null;
  child_pid: number | null;
  state: RunEnvelopeState;
}

const runs = new Map<string, RunMemo>();

/**
 * A run's identity lives NEXT TO ITS ARTIFACTS (`.run.json` inside the
 * outputs root), not only in this process's memory. Restarting the server
 * must not orphan work whose files are already on disk — the E2E caught
 * exactly that: the artifacts were delivered, the envelope answered
 * "run_not_found" after a restart. Disk is the truth; the map is cache.
 */
function memoFile(outputsRoot: string): string {
  return path.join(outputsRoot, ".run.json");
}

function persist(m: RunMemo): void {
  try {
    fs.mkdirSync(m.outputs_root, { recursive: true });
    fs.writeFileSync(memoFile(m.outputs_root), JSON.stringify({
      trace_id: m.trace_id, session: m.session, key_id: m.key_id, brief: m.brief,
      outputs_root: m.outputs_root, created_at: m.created_at, finished_at: m.finished_at,
      exit_code: m.exit_code, error: m.error, state: m.state,
    }, null, 2));
  } catch { /* a run whose outputs dir vanished is already lost; do not crash the server */ }
}

/** Rehydrates a run from disk when this process never saw it. */
function rehydrate(traceId: string, sessionsRoot: string): RunMemo | null {
  let sessions: string[];
  try { sessions = fs.readdirSync(sessionsRoot); } catch { return null; }
  for (const sid of sessions) {
    // Canonical first, then the legacy root: a server upgraded mid-flight
    // must still find the runs it wrote yesterday.
    const f = [runOutputsRoot(path.join(sessionsRoot, sid), traceId),
           path.join(sessionsRoot, sid, ".nirvana", "outputs", traceId)]
      .map((d) => path.join(d, ".run.json")).find((p) => fs.existsSync(p))
      ?? path.join(runOutputsRoot(path.join(sessionsRoot, sid), traceId), ".run.json");
    try {
      const raw = JSON.parse(fs.readFileSync(f, "utf8")) as RunMemo;
      // A run that was mid-flight when the server died is not "running" any
      // more — no child of ours survives. Report it honestly.
      const m: RunMemo = { ...raw, child_pid: null, state: raw.state === "running" || raw.state === "queued" ? "failed" : raw.state };
      if (m.state === "failed" && !m.error) m.error = "server restarted while the run was in flight";
      runs.set(traceId, m);
      return m;
    } catch { /* not this session */ }
  }
  return null;
}

export function newTraceId(): string {
  return "run_" + randomBytes(8).toString("hex");
}

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(process.env.HOME || "", ".nirvana", "skills"))
    ? path.join(process.env.HOME || "", ".nirvana", "skills")
    : path.resolve(import.meta.dir, "..", "..", ".."));

/** Test seam: a fixture script standing in for the real dispatch. */
function dispatchCmd(): { bin: string; script: string } {
  const override = process.env.NIRVANA_SERVE_DISPATCH_BIN;
  if (override) return { bin: process.env.NIRVANA_SERVE_BUN || "bun", script: override };
  return { bin: process.env.NIRVANA_SERVE_BUN || "bun", script: path.join(SKILLS_ROOT, "harness", "scripts", "dispatch.ts") };
}

export function register(memo: Omit<RunMemo, "state" | "finished_at" | "exit_code" | "error" | "child_pid">): RunMemo {
  const m: RunMemo = { ...memo, state: "queued", finished_at: null, exit_code: null, error: null, child_pid: null };
  runs.set(m.trace_id, m);
  persist(m);
  return m;
}

export function get(traceId: string, sessionsRoot?: string): RunMemo | null {
  const hit = runs.get(traceId);
  if (hit) return hit;
  return sessionsRoot ? rehydrate(traceId, sessionsRoot) : null;
}

export function all(): RunMemo[] {
  return [...runs.values()];
}

/**
 * Starts the child. Resolves when it exits — the caller (queue) decides how
 * to await. The brief travels as a FILE, never as an argv string: a brief
 * with quotes, newlines or a shell metacharacter must not depend on
 * escaping (and argv has a length ceiling).
 */
/**
 * Live children of THIS server process, by trace.
 *
 * Cancelling by pid is not safe: a pid that answers is not proof it is ours.
 * The process that used to live there can have exited, and the OS is free to
 * hand the same number to anything spawned since — the supervisor carries the
 * same warning and the same guard. Holding the handle removes the question.
 */
const live = new Map<string, { kill(signal?: NodeJS.Signals): boolean }>();

/**
 * Stops a run that is still going.
 *
 * A run had no way to end but its own: an expensive one could only be stopped
 * by opening an SSH session and killing it by hand, which is not something a
 * client of an HTTP API can do and not something an owner should have to.
 *
 * SIGTERM, not SIGKILL, so the runtime closes its own children and flushes what
 * it wrote — the artifacts already on disk are not the enemy. The state is
 * `cancelled`, its own terminal state rather than `failed`: a run the owner
 * stopped is not a run that broke, and telling those apart is the whole reason
 * an envelope carries a state.
 *
 * A run started by a PREVIOUS server process has no handle here. It is marked
 * cancelled and `signalled` comes back false, so the caller is told plainly
 * that the process was not reached rather than being left to assume it was.
 */
export function cancel(memo: RunMemo, reason = "cancelled by the owner"): { memo: RunMemo; signalled: boolean } {
  if (memo.state !== "queued" && memo.state !== "running") return { memo, signalled: false };
  let signalled = false;
  const child = live.get(memo.trace_id);
  if (child) {
    try { signalled = child.kill("SIGTERM"); } catch { signalled = false; }
  }
  memo.state = "cancelled";
  memo.error = signalled ? reason : `${reason} (the run process was not reachable from this server)`;
  memo.finished_at = new Date().toISOString();
  persist(memo);
  return { memo, signalled };
}

export function start(memo: RunMemo, opts: { budgetUsd?: number } = {}): Promise<RunMemo> {
  const { bin, script } = dispatchCmd();
  fs.mkdirSync(memo.outputs_root, { recursive: true });
  const briefFile = path.join(memo.outputs_root, ".brief.md");
  fs.writeFileSync(briefFile, memo.brief);

  const args = [
    script, "--auto",
    "--brief-file", briefFile,
    "--exec",
    "--project", memo.trace_id,
    "--outputs-root", memo.outputs_root,
    ...(opts.budgetUsd ? ["--max-budget", String(opts.budgetUsd)] : []),
  ];

  memo.state = "running";
  persist(memo);
  return new Promise((resolve) => {
    // The dispatched agent sees an allowlist of this server's environment, not
    // the whole of it (NIRVANA_SERVE_CHILD_ENV=inherit restores the old shape).
    const parentEnv = childEnvFor(process.env, { mode: process.env.NIRVANA_SERVE_CHILD_ENV === "inherit" ? "inherit" : "declared", runtime: null });
    const child = spawn(bin, args, {
      windowsHide: true,
      cwd: memo.session.dir,
      env: {
        ...parentEnv,
        // Where the intelligence is FOUND (merge: the operator's library,
        // project entries winning on conflict). Where files are WRITTEN is
        // decided separately, below: always inside this session.
        NIRVANA_SCOPE: memo.session.library === "isolated" ? "project" : "merge",
        // Artifacts, logs and run state stay in this session — a mounted
        // volume simply IS this directory on a server.
        NIRVANA_PROJECT_ROOT: memo.session.dir,
        HARNESS_LOGS_DIR: path.join(memo.session.dir, ".nirvana", "logs", "harness"),
        NIRVANA_TRACE_ID: memo.trace_id,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    memo.child_pid = child.pid ?? null;
    live.set(memo.trace_id, child);
    let stderr = "";
    child.stderr?.on("data", (b) => { stderr = (stderr + b.toString()).slice(-4000); });
    child.stdout?.resume();
    child.on("error", (e) => {
      live.delete(memo.trace_id);
      if (memo.state === "cancelled") { resolve(memo); return; }
      memo.state = "failed";
      memo.error = e.message;
      memo.finished_at = new Date().toISOString();
      persist(memo);
      resolve(memo);
    });
    child.on("close", (code) => {
      live.delete(memo.trace_id);
      // A cancelled run keeps its state: the close that follows a SIGTERM is
      // the consequence, not a new verdict.
      if (memo.state === "cancelled") { resolve(memo); return; }
      memo.exit_code = code ?? 1;
      memo.finished_at = new Date().toISOString();
      memo.state = stateFromExit(memo.exit_code);
      if (memo.state === "failed" && stderr.trim()) memo.error = stderr.trim().slice(-500);
      persist(memo);
      resolve(memo);
    });
  });
}

/** The dispatch exit contract, verbatim (dispatch.ts header). */
export function stateFromExit(code: number): RunEnvelopeState {
  switch (code) {
    case 0: return "delivered";
    case 2: return "withheld";
    case 3: return "indeterminate";
    default: return "failed";
  }
}

function gateFromState(state: RunEnvelopeState, outputsRoot: string): RunEnvelope["gate"] {
  if (state === "delivered") {
    return fs.existsSync(path.join(outputsRoot, "_QA-RESERVATIONS.md")) ? "fail-accepted" : "pass";
  }
  if (state === "withheld") return "fail";
  if (state === "indeterminate") return "indeterminate";
  if (state === "cancelled") return null;
  return null;
}

const readIf = (p: string): string | null => {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
};

export function envelope(memo: RunMemo): RunEnvelope {
  const artifacts = memo.state === "queued" || memo.state === "running" ? [] : listArtifacts(memo.outputs_root);
  return {
    trace_id: memo.trace_id,
    session_id: memo.session.id,
    state: memo.state,
    gate: gateFromState(memo.state, memo.outputs_root),
    brief_excerpt: memo.brief.slice(0, 200),
    created_at: memo.created_at,
    finished_at: memo.finished_at,
    exit_code: memo.exit_code,
    // The runtime died and the work was judged anyway. The engine knew:
    // the ledger marks the run failed, the audit records
    // x_runtime_errored_with_artifacts and the CLI prints a warning. The
    // envelope dropped it, so an API client saw `delivered` with exit 0 and
    // no way to tell. The state is right — the gate did pass — and the
    // caveat travels beside it, the way `fail-accepted` already does.
    runtime_errored: runtimeErrored(memo.outputs_root),
    artifacts,
    summary: redactForClient(readIf(path.join(memo.outputs_root, "_SUMMARY.md"))
      ?? readIf(path.join(memo.outputs_root, "outputs", "_SUMMARY.md")), memo.session.dir).text,
    reservations: redactForClient(readIf(path.join(memo.outputs_root, "_QA-RESERVATIONS.md")), memo.session.dir).text,
    error: memo.error,
  };
}

/**
 * On boot, re-anchor runs the ledger still considers active: the in-memory
 * queue is a cache, the ledger is the truth (a serve restart must not
 * orphan work, and the supervisor sweeps whatever really died).
 *
 * Scoped to the project this server is serving — `findNonTerminal` defaults to
 * it. Adopting another project's orphans would put runs this API can neither
 * explain nor finish into its count; the supervisor is what reaches those.
 */
export function adoptOrphans(): number {
  try {
    const h = ledger.openLedger();
    return ledger.findNonTerminal(h).length;
  } catch { return 0; }
}
