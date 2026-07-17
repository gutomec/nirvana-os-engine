/**
 * action-runner.ts — In-memory job manager for Glance actions.
 *
 * Each action spawns a child process (Bun.spawn), captures stdout/stderr
 * line-by-line, and exposes the running output via an async iterator that
 * SSE consumers subscribe to. Jobs are kept in memory for 1 hour after
 * completion (so users can review past output).
 *
 * Concurrency:
 *   - At most 1 mutating action runs at a time (`audit-improve`, `audit-batch`,
 *     `index-squads`, `index-businesses`). Read-only actions (`audit-score`,
 *     `run-smoke`, `run-test`, `activate-dry-run`) can run concurrently.
 *
 * Cancellation:
 *   - `cancelJob(id)` sends SIGTERM, then SIGKILL after 5s.
 *
 * Public API:
 *   ActionRunner.startJob({ action, command, args, mutating }) → Job
 *   ActionRunner.getJob(id) → Job | undefined
 *   ActionRunner.listJobs(opts?) → Job[]
 *   ActionRunner.streamJob(id) → AsyncIterable<{kind, line?, code?}>
 *   ActionRunner.cancelJob(id) → boolean
 */

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Job {
  id: string;
  action: string;
  command: string;
  args: string[];
  cwd?: string;
  status: JobStatus;
  mutating: boolean;
  started_at: number;
  finished_at?: number;
  exit_code?: number | null;
  output: string[];        // line buffer (cap 5000 lines)
  pid?: number;
  scope_mode?: string;
  project_root?: string | null;
}

interface InternalJob extends Job {
  proc?: any;
  subscribers: Set<(ev: { kind: "line" | "done" | "cancelled"; line?: string; code?: number | null }) => void>;
}

const JOBS = new Map<string, InternalJob>();
const MAX_LINES = 5000;
const KEEP_AFTER_DONE_MS = 60 * 60 * 1000;  // 1h
let activeMutator: string | null = null;
let activeChat: string | null = null;   // slot separado da lane de chat

// Periodic GC of finished jobs
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of JOBS) {
    if (j.status !== "running" && j.status !== "queued" && j.finished_at && now - j.finished_at > KEEP_AFTER_DONE_MS) {
      JOBS.delete(id);
    }
  }
}, 5 * 60 * 1000);

function uuid() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

export interface StartOpts {
  action: string;
  command: string;
  args: string[];
  cwd?: string;
  mutating?: boolean;
  env?: Record<string, string>;
  scope_mode?: string;
  project_root?: string | null;
  // Lane de concorrência. "maintenance" (default) = o slot único de mutating
  // (audit-batch/index/…). "chat" = um slot separado, para que um turno de chat
  // (que também escreve arquivos) não colida com a manutenção nem vice-versa.
  lane?: "maintenance" | "chat";
}

export function startJob(opts: StartOpts): { job: Job; reason?: string } | { error: string } {
  const lane = opts.lane || "maintenance";
  if (opts.mutating && lane === "maintenance" && activeMutator) {
    return { error: `Another mutating action is already running (job ${activeMutator}). Cancel it or wait.` };
  }
  if (opts.mutating && lane === "chat" && activeChat) {
    return { error: `Another chat turn is already running (job ${activeChat}). Wait for it to finish.` };
  }
  const id = uuid();
  const job: InternalJob = {
    id,
    action: opts.action,
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    status: "queued",
    mutating: !!opts.mutating,
    started_at: Date.now(),
    output: [],
    subscribers: new Set(),
    scope_mode: opts.scope_mode,
    project_root: opts.project_root,
  };
  (job as any).lane = lane;
  JOBS.set(id, job);
  if (job.mutating) { if (lane === "chat") activeChat = id; else activeMutator = id; }

  // Spawn the child
  try {
    const proc = Bun.spawn([opts.command, ...opts.args], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      stdout: "pipe",
      stderr: "pipe",
    });
    job.proc = proc;
    job.pid = proc.pid;
    job.status = "running";

    const pump = async (stream: ReadableStream<Uint8Array> | undefined, _label: string) => {
      if (!stream) return;
      const reader = stream.getReader();
      const dec = new TextDecoder();
      let pending = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          if (pending.length > 0) emit(job, "line", pending);
          return;
        }
        pending += dec.decode(value, { stream: true });
        let idx;
        while ((idx = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, idx);
          pending = pending.slice(idx + 1);
          emit(job, "line", line);
        }
      }
    };

    Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr")]).catch(() => {});

    proc.exited.then((code) => {
      job.exit_code = code;
      job.status = code === 0 ? "completed" : (job.status === "cancelled" ? "cancelled" : "failed");
      job.finished_at = Date.now();
      if (job.mutating) { if (activeChat === id) activeChat = null; if (activeMutator === id) activeMutator = null; }
      emit(job, "done", undefined, code);
      // Close all subscribers
      for (const cb of job.subscribers) try { cb({ kind: "done", code }); } catch {}
      job.subscribers.clear();
    }).catch((e) => {
      job.status = "failed";
      job.finished_at = Date.now();
      emit(job, "line", `[runner] error: ${e.message}`);
      emit(job, "done", undefined, -1);
    });

    return { job: jobView(job) };
  } catch (e: any) {
    job.status = "failed";
    job.finished_at = Date.now();
    if (activeChat === id) activeChat = null;
    if (activeMutator === id) activeMutator = null;
    return { job: jobView(job), reason: `spawn failed: ${e.message}` };
  }
}

function emit(job: InternalJob, kind: "line" | "done", line?: string, code?: number | null) {
  if (kind === "line" && typeof line === "string") {
    job.output.push(line);
    if (job.output.length > MAX_LINES) job.output.splice(0, job.output.length - MAX_LINES);
    for (const cb of job.subscribers) {
      try { cb({ kind, line }); } catch {}
    }
  }
}

export function jobView(j: InternalJob): Job {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { proc: _proc, subscribers: _subs, ...rest } = j;
  return rest;
}

export function getJob(id: string): Job | undefined {
  const j = JOBS.get(id);
  return j ? jobView(j) : undefined;
}

export function listJobs(): Job[] {
  return [...JOBS.values()].sort((a, b) => b.started_at - a.started_at).map(jobView);
}

export async function* streamJob(id: string): AsyncIterable<{ kind: "snapshot" | "line" | "done"; lines?: string[]; line?: string; code?: number | null; status?: string }> {
  const j = JOBS.get(id);
  if (!j) return;
  // Initial snapshot
  yield { kind: "snapshot", lines: [...j.output], status: j.status };
  if (j.status !== "running" && j.status !== "queued") {
    yield { kind: "done", code: j.exit_code };
    return;
  }
  // Subscribe to live events via a queue
  const queue: any[] = [];
  let resolveNext: ((v: any) => void) | null = null;
  const cb = (ev: any) => {
    if (resolveNext) { resolveNext(ev); resolveNext = null; }
    else queue.push(ev);
  };
  j.subscribers.add(cb);
  try {
    while (true) {
      const ev = queue.length > 0 ? queue.shift() : await new Promise<any>(r => { resolveNext = r; });
      yield ev;
      if (ev.kind === "done") return;
    }
  } finally {
    j.subscribers.delete(cb);
  }
}

export function cancelJob(id: string): boolean {
  const j = JOBS.get(id);
  if (!j || (j.status !== "running" && j.status !== "queued")) return false;
  j.status = "cancelled";
  if (j.proc) {
    try { j.proc.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { j.proc.kill("SIGKILL"); } catch {} }, 5000);
  }
  return true;
}

export function isMutatingActive(): string | null { return activeMutator; }
