// server.ts — the HTTP control plane. Bun.serve, zero new dependencies,
// same posture as glance's server: local by default, explicit to expose.
//
// This file routes and validates. It never runs a brief: every dispatch is
// a child process (runs.ts), every state answer comes from what the engine
// already wrote (ledger, audit log, outputs tree). The API is the FOURTH
// PROJECTION of the protocol — graph, glance, CLI, and now HTTP.

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { authenticate, consumeRun, setWebhook, type ApiKeyRecord } from "./auth.ts";
import { createSession, getSession, listSessions, expireSession, sessionsRoot } from "./sessions.ts";
import * as runsLib from "./runs.ts";
import { RunQueue } from "./queue.ts";
import { listArtifacts, resolveArtifact, contentTypeFor } from "./artifacts.ts";
import { todayAuditFile } from "../../../_shared/lib/log-paths.ts";
import { listRuntimes } from "../../../_shared/lib/host-agent-driver.ts";

export interface ServeOpts {
  port: number;
  host: string;
  maxConcurrent: number;
  /** Allowed CORS origins; empty = no CORS headers at all. */
  corsOrigins?: string[];
}

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });

const ENGINE_VERSION = (() => {
  for (const p of [
    path.resolve(import.meta.dir, "..", "..", "..", "VERSION"),
    path.join(process.env.HOME || "", ".nirvana", "skills", "VERSION"),
  ]) {
    try { return fs.readFileSync(p, "utf8").trim(); } catch { /* next */ }
  }
  return "unknown";
})();

export function startServer(opts: ServeOpts) {
  const queue = new RunQueue({ maxConcurrent: opts.maxConcurrent });
  const adopted = runsLib.adoptOrphans();

  const cors = (req: Request): Record<string, string> => {
    const origin = req.headers.get("origin");
    if (!origin || !opts.corsOrigins?.includes(origin)) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    };
  };

  const server = Bun.serve({
    port: opts.port,
    hostname: opts.host,
    idleTimeout: 240,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname.replace(/\/+$/, "") || "/";
      const h = cors(req);

      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });

      // Health is the ONLY unauthenticated route: an operator behind a proxy
      // needs a liveness probe that carries no secret and no session data.
      if (p === "/v1/health") {
        const runtimes = listRuntimes().map((r) => r.name);
        return json({ ok: true, engine: ENGINE_VERSION, runtimes, queue: queue.stats, adopted_runs: adopted }, 200, h);
      }

      const key = authenticate(req);
      if (!key) return json({ error: "unauthorized", hint: "Authorization: Bearer <key from `nrv serve keygen`>" }, 401, h);

      // ── sessions ────────────────────────────────────────────────────────
      if (p === "/v1/sessions" && req.method === "POST") {
        const s = createSession(key.id);
        return json({ session_id: s.id, dir: s.dir, created_at: s.created_at }, 201, h);
      }
      if (p === "/v1/sessions" && req.method === "GET") {
        return json({ sessions: listSessions(key.id).map((s) => ({ session_id: s.id, created_at: s.created_at })) }, 200, h);
      }

      const mSession = /^\/v1\/sessions\/([^/]+)$/.exec(p);
      if (mSession && req.method === "DELETE") {
        return expireSession(mSession[1], key.id)
          ? json({ expired: true }, 200, h)
          : json({ error: "session_not_found" }, 404, h);
      }

      // ── briefs ──────────────────────────────────────────────────────────
      const mBriefs = /^\/v1\/sessions\/([^/]+)\/briefs$/.exec(p);
      if (mBriefs && req.method === "POST") {
        const session = getSession(mBriefs[1], key.id);
        if (!session) return json({ error: "session_not_found" }, 404, h);
        let body: { brief?: string } = {};
        try { body = await req.json() as { brief?: string }; } catch { /* validated below */ }
        const brief = (body.brief || "").trim();
        if (!brief) return json({ error: "brief_required" }, 400, h);
        // Money and limits are attributes of the KEY. A client-supplied
        // budget/limit is ignored on purpose (never trust the caller with
        // its own ceiling).
        const quota = consumeRun(key.id);
        if (!quota.ok) return json({ error: "daily_quota_exceeded", used: quota.used, limit: quota.limit }, 429, h);

        const traceId = runsLib.newTraceId();
        const memo = runsLib.register({
          trace_id: traceId,
          session,
          key_id: key.id,
          brief,
          outputs_root: path.join(session.dir, ".nirvana", "outputs", traceId),
          created_at: new Date().toISOString(),
        });
        queue.submit({ memo, budgetUsd: key.budget_usd, webhook: key.webhook });
        return json({ trace_id: traceId, session_id: session.id, state: "queued" }, 202, h);
      }

      // ── runs ────────────────────────────────────────────────────────────
      const mRun = /^\/v1\/sessions\/([^/]+)\/runs\/([^/]+)$/.exec(p);
      if (mRun && req.method === "GET") {
        const memo = runsLib.get(mRun[2], sessionsRoot());
        if (!memo || memo.session.id !== mRun[1] || memo.key_id !== key.id) return json({ error: "run_not_found" }, 404, h);
        return json(runsLib.envelope(memo), 200, h);
      }

      const mEvents = /^\/v1\/sessions\/([^/]+)\/runs\/([^/]+)\/events$/.exec(p);
      if (mEvents && req.method === "GET") {
        const memo = runsLib.get(mEvents[2], sessionsRoot());
        if (!memo || memo.session.id !== mEvents[1] || memo.key_id !== key.id) return json({ error: "run_not_found" }, 404, h);
        return sseAuditStream(memo, h);
      }

      const mArts = /^\/v1\/sessions\/([^/]+)\/runs\/([^/]+)\/artifacts$/.exec(p);
      if (mArts && req.method === "GET") {
        const memo = runsLib.get(mArts[2], sessionsRoot());
        if (!memo || memo.session.id !== mArts[1] || memo.key_id !== key.id) return json({ error: "run_not_found" }, 404, h);
        return json({ artifacts: listArtifacts(memo.outputs_root) }, 200, h);
      }

      const mArt = /^\/v1\/sessions\/([^/]+)\/runs\/([^/]+)\/artifacts\/(.+)$/.exec(p);
      if (mArt && req.method === "GET") {
        const memo = runsLib.get(mArt[2], sessionsRoot());
        if (!memo || memo.session.id !== mArt[1] || memo.key_id !== key.id) return json({ error: "run_not_found" }, 404, h);
        const abs = resolveArtifact(memo.outputs_root, decodeURIComponent(mArt[3]));
        if (!abs) return json({ error: "artifact_not_found" }, 404, h);
        return new Response(Bun.file(abs), {
          headers: { "Content-Type": contentTypeFor(abs), "Content-Disposition": `attachment; filename="${path.basename(abs)}"`, ...h },
        });
      }

      // ── webhook registration (per key) ──────────────────────────────────
      if (p === "/v1/webhooks" && req.method === "POST") {
        let body: { url?: string } = {};
        try { body = await req.json() as { url?: string }; } catch { /* validated below */ }
        const target = (body.url || "").trim();
        if (!/^https?:\/\//i.test(target)) return json({ error: "url_required" }, 400, h);
        const secret = randomBytes(24).toString("base64url");
        setWebhook(key.id, target, secret);
        return json({ url: target, secret, signature_header: "X-Nirvana-Signature" }, 201, h);
      }

      return json({ error: "not_found" }, 404, h);
    },
  });

  return server;
}

/**
 * SSE over the session's audit log — the progress feed costs nothing to
 * build because the engine already appends every dispatch, gate and
 * revision there. Same shape glance uses (server.ts:656).
 */
function sseAuditStream(memo: ReturnType<typeof runsLib.get> & {}, extraHeaders: Record<string, string>): Response {
  const file = todayAuditFile({ projectRoot: memo.session.dir });
  let offset = 0;
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const pump = () => {
        try {
          const st = fs.statSync(file);
          if (st.size > offset) {
            const fd = fs.openSync(file, "r");
            const buf = Buffer.alloc(st.size - offset);
            fs.readSync(fd, buf, 0, buf.length, offset);
            fs.closeSync(fd);
            offset = st.size;
            for (const line of buf.toString("utf8").split("\n")) {
              if (!line.trim()) continue;
              try { send(JSON.parse(line)); } catch { /* partial line */ }
            }
          }
        } catch { /* log not created yet */ }
      };
      pump();
      // Poll fast: a short run can finish between two slow ticks, and the
      // client would then get the terminal event without the audit lines
      // that preceded it (CI caught exactly this — a fixture run finishing
      // inside the first second). One final pump AFTER the run is terminal
      // also matters: the child writes its last audit lines as it exits.
      let sawTerminal = false;
      const timer = setInterval(() => {
        pump();
        const m = runsLib.get(memo.trace_id);
        const terminal = m && m.state !== "queued" && m.state !== "running";
        if (!terminal) return;
        if (!sawTerminal) {
          // one more cycle: give the exiting child's last writes time to land
          sawTerminal = true;
          return;
        }
        pump();
        send({ event: "run.finished", state: m!.state, exit_code: m!.exit_code });
        clearInterval(timer);
        controller.close();
      }, 150);
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", ...extraHeaders },
  });
}
