/**
 * agent-state.ts — derive live agent execution state from raw audit events.
 *
 * Powers the "Agents" tab swimlane view + PixiJS animated workspace.
 *
 * Input: a chronological array of audit events from ~/.harness-logs/<date>/audit.jsonl
 * Output: AgentState[] grouped by trace_id with derived status.
 *
 * Status semantics (precedence top-down):
 *   completed      → trace emitted `delivered`
 *   failed         → trace emitted `gate_failed`
 *   no_match       → trace emitted `no_match`
 *   stale          → no event in `STALE_THRESHOLD_MS`
 *   tool_in_flight → last action event was `tool_invoked` and no matching post-event after
 *   waiting        → has `brief_received` but no dispatch yet
 *   running        → recent ACTION event (tool_invoked / artifact_touched / bash_completed
 *                    / dispatch_squad / routing_decision / brief_received) within `RUNNING_RECENT_MS`
 *   idle           → alive (events < STALE_THRESHOLD) but only `cost_emission` (chat-only / inference)
 *
 * Configuration via env vars (no hardcoded magic):
 *   NIRVANA_GLANCE_STALE_MS          (default 600_000  = 10m)
 *   NIRVANA_GLANCE_RUNNING_MS        (default 120_000  = 2m)
 *   NIRVANA_GLANCE_TOOL_FLIGHT_MS    (default 90_000   = 90s)
 *   NIRVANA_GLANCE_RECENT_EVENTS     (default 30)
 *
 * Pricing comes from `cost-aggregator.js::getPricing()` (already env-overridable
 * via NIRVANA_PRICING_USD).
 */

import { tokensFromPayload, usdFor, getPricing } from "./cost-aggregator.js";

// ── Action events: any of these signals "agent is doing real work" ──
const ACTION_EVENTS = new Set<string>([
  "tool_invoked",
  "artifact_touched",
  "bash_completed",
  "dispatch_squad",
  "routing_decision",
  "brief_received",
  "brief_amplified",
  "gate_passed",
  "gate_failed",
  "delivered",
  "humanize_completed",
  "target_plan_committed",
  "local_execution_started",
  "local_execution_completed",
  "session_started",
]);

const PASSIVE_EVENTS = new Set<string>(["cost_emission", "context_budget_warning"]);

export type AgentStatus =
  | "tool_in_flight"
  | "running"
  | "idle"
  | "waiting"
  | "stale"
  | "completed"
  | "failed"
  | "no_match";

export interface AgentState {
  trace_id: string;
  label: string;                  // host + cwd basename (or session slice fallback)
  host: string;                    // e.g., "claude-code", "antigravity-cli", "gemini-cli", "fs-watch"
  caller_id: string | null;        // e.g., "claude-code-transcript" → backfill, not realtime
  is_backfill: boolean;            // true if all events come from transcript importer
  cwd: string | null;
  project_id: string | null;
  brief_excerpt: string | null;    // first 80 chars of brief_received text
  fallback_summary: string;        // human-readable last activity hint
  started_at: string;              // first event ts (ISO)
  last_event_ts: string;           // last event ts (ISO)
  last_event_type: string;         // last event name
  last_action_ts: string | null;   // ts of last ACTION_EVENT (null if none)
  last_action_type: string | null;
  current_tool: string | null;     // name/file_path if tool_in_flight
  status: AgentStatus;
  status_since_ms: number;         // duration in ms since entered current status
  events_count: number;
  action_events_count: number;
  tokens_session: { input: number; output: number; cache_read: number; cache_creation: number; total: number };
  cost_session_usd: number;
  files_touched_count: number;
  artifacts_created: number;
  bash_executions: number;
  gate_status: "passed" | "failed" | "pending" | null;
  recent_events: Array<{ ts: string; event: string; meta?: any }>;
  // ── Phase D: dispatch quality state ──
  declared_mind_clones: string[];                  // slugs from target_plan_committed events
  injected_mind_clones: Array<{                    // matching mind_clone_injected events
    slug: string;
    category?: string;
    path?: string;
    bytes: number;
    sha256: string;
  }>;
  missing_mind_clones: string[];                   // declared but not injected
  dispatch_audit: { verdict: "pass" | "needs_revision" | "block"; findings_count: number } | null;
  is_suspicious_dispatch: boolean;                  // missing injections OR audit verdict not pass OR dispatch_blocked seen
}

function readNumberEnv(name: string, fallback: number): number {
  const v = process.env?.[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function thresholds() {
  return {
    STALE_MS: readNumberEnv("NIRVANA_GLANCE_STALE_MS", 10 * 60 * 1000),
    RUNNING_MS: readNumberEnv("NIRVANA_GLANCE_RUNNING_MS", 2 * 60 * 1000),
    TOOL_FLIGHT_MS: readNumberEnv("NIRVANA_GLANCE_TOOL_FLIGHT_MS", 90 * 1000),
    RECENT_EVENTS: readNumberEnv("NIRVANA_GLANCE_RECENT_EVENTS", 30),
  };
}

function basenameOfCwd(cwd: string | null): string {
  if (!cwd) return "";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function projectBasename(projectId: string | null): string {
  if (!projectId) return "";
  return projectId.split("/").filter(Boolean).slice(-1)[0] || "";
}

function buildLabel(host: string, cwd: string | null, projectId: string | null, traceId: string): string {
  const tail = basenameOfCwd(cwd) || projectBasename(projectId);
  if (tail) return `${host} · ${tail}`;
  // Last resort: trace slice so multi-session traces don't all read "claude-code @ unknown"
  return `${host} · #${traceId.slice(0, 8)}`;
}

function buildFallbackSummary(opts: {
  brief: string | null;
  lastAction: { ts: string; event: string; meta?: any } | null;
  status: AgentStatus;
  isBackfill: boolean;
}): string {
  if (opts.brief) return opts.brief;
  if (opts.isBackfill) return "transcript backfill (no live activity)";
  if (opts.lastAction) {
    const m = opts.lastAction.meta || {};
    if (opts.lastAction.event === "tool_invoked") {
      return m.action ? `tool: ${m.action}${m.file ? " " + m.file.split("/").pop() : ""}` : "tool invoked";
    }
    if (opts.lastAction.event === "artifact_touched") {
      return m.file ? `${m.action || "edit"}: ${m.file.split("/").pop()}` : "artifact touched";
    }
    if (opts.lastAction.event === "bash_completed") {
      return m.command ? `bash: ${m.command.slice(0, 40)}` : "bash completed";
    }
    if (opts.lastAction.event === "dispatch_squad") return "dispatched squad";
    if (opts.lastAction.event === "routing_decision") return "routing decision";
    return opts.lastAction.event.replace(/_/g, " ");
  }
  if (opts.status === "idle") return "inference only (no tools)";
  return "(no brief captured)";
}

/**
 * Derive AgentState[] from a flat event stream. Events should span the
 * recent window (typically last ~500 events from tailJsonlEvents).
 */
export function deriveAgentStates(events: Array<any>): AgentState[] {
  if (!events?.length) return [];
  const T = thresholds();
  const pricing = getPricing();

  // Sort chronologically (oldest first). Same-ms Pre/Post pairs can be
  // appended in either order because the hooks fire async — use a stable
  // tiebreaker that respects logical sequence: pre-stage (tool_invoked,
  // brief_received…) before post-stage (artifact_touched, bash_completed,
  // delivered…); finally fall back to `_ord` (file position).
  const stageRank = (e: any): number => {
    if (e.stage === "pre") return 0;
    if (e.stage === "post") return 2;
    if (e.event === "tool_invoked" || e.event === "brief_received") return 0;
    if (e.event === "artifact_touched" || e.event === "bash_completed") return 2;
    return 1;
  };
  const sorted = [...events].sort((a, b) => {
    const c = (a.ts || "").localeCompare(b.ts || "");
    if (c !== 0) return c;
    const sr = stageRank(a) - stageRank(b);
    if (sr !== 0) return sr;
    if (a._ord != null && b._ord != null) return a._ord - b._ord;
    return 0;
  });

  // Group by trace_id
  const byTrace = new Map<string, any[]>();
  for (const ev of sorted) {
    const tid = ev.trace_id || "no-trace";
    if (!byTrace.has(tid)) byTrace.set(tid, []);
    byTrace.get(tid)!.push(ev);
  }

  const nowMs = Date.now();
  const states: AgentState[] = [];

  for (const [tid, evs] of byTrace.entries()) {
    if (evs.length === 0) continue;

    const first = evs[0];
    const last = evs[evs.length - 1];

    const tokens = { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 };
    let cost = 0;
    const filesTouched = new Set<string>();
    let artifactsCreated = 0;
    let bashExecs = 0;
    let host = first.host || "unknown";
    let cwd: string | null = null;
    let projectId: string | null = null;
    let brief: string | null = null;
    let gate: "passed" | "failed" | "pending" | null = null;
    let actionCount = 0;
    let lastAction: { ts: string; event: string; meta?: any } | null = null;
    let toolInvokedAtIdx = -1;            // index of last unmatched tool_invoked
    const callerIds = new Set<string>();
    // ── Phase D: dispatch quality tracking ──
    const declaredMindClones = new Set<string>();
    const injectedMindClones: Array<{ slug: string; category?: string; path?: string; bytes: number; sha256: string }> = [];
    let dispatchAuditResult: { verdict: "pass" | "needs_revision" | "block"; findings_count: number } | null = null;
    let dispatchBlockedSeen = false;

    evs.forEach((ev, i) => {
      if (ev.host && (host === "unknown" || host === "claude-code") && ev.host !== host) {
        // prefer more specific host (e.g., claude-code-hook over claude-code)
        if (ev.host.endsWith("-hook")) host = ev.host;
      }
      if (!cwd && ev.cwd) cwd = ev.cwd;
      if (!projectId && ev.project_id) projectId = ev.project_id;
      if (ev.caller_id) callerIds.add(ev.caller_id);

      if (ev.event === "brief_received" && !brief) {
        brief = (ev.brief || ev.user_input || ev.payload?.brief || "").toString().slice(0, 80) || null;
      }

      if (ev.event === "cost_emission") {
        if (typeof ev.total_cost_usd === "number") cost += ev.total_cost_usd;
        else if (typeof ev.payload?.total_cost_usd === "number") cost += ev.payload.total_cost_usd;
        const t = tokensFromPayload(ev.usage ? ev : ev.payload);
        tokens.input += t.input;
        tokens.output += t.output;
        tokens.cache_read += t.cache_read;
        tokens.cache_creation += t.cache_creation;
      }

      if (ev.event === "tool_invoked") {
        toolInvokedAtIdx = i;
      } else if (ev.event === "artifact_touched" || ev.event === "bash_completed") {
        // a tool_invoked has been answered by a post-event; clear the pending marker
        toolInvokedAtIdx = -1;
        if (ev.event === "artifact_touched") {
          if (ev.action === "create") artifactsCreated++;
          if (ev.file_path) filesTouched.add(ev.file_path);
        } else {
          bashExecs++;
        }
      }

      if (ev.event === "gate_passed") gate = "passed";
      if (ev.event === "gate_failed") gate = "failed";

      // Phase D — dispatch quality events
      if (ev.event === "target_plan_committed") {
        const list: any[] =
          ev.mind_clones || ev.payload?.mind_clones ||
          ev.target_plan?.mind_clones || ev.payload?.target_plan?.mind_clones || [];
        for (const m of list) {
          const slug = typeof m === "string" ? m : (m.slug || m.id || "");
          if (slug) declaredMindClones.add(slug);
        }
      }
      if (ev.event === "mind_clone_injected") {
        const slug = ev.slug || ev.payload?.slug;
        const bytes = Number(ev.bytes ?? ev.payload?.bytes ?? 0);
        const sha = ev.sha256 || ev.payload?.sha256 || "";
        const category = ev.category || ev.payload?.category;
        const filePath = ev.path || ev.payload?.path;
        if (slug && bytes > 0) {
          injectedMindClones.push({ slug, category, path: filePath, bytes, sha256: sha });
        }
      }
      if (ev.event === "dispatch_audit") {
        const verdict = (ev.verdict || ev.payload?.verdict) as any;
        const findings = ev.findings || ev.payload?.findings || [];
        if (verdict === "pass" || verdict === "needs_revision" || verdict === "block") {
          dispatchAuditResult = { verdict, findings_count: Array.isArray(findings) ? findings.length : 0 };
        }
      }
      if (ev.event === "dispatch_blocked") dispatchBlockedSeen = true;

      if (ACTION_EVENTS.has(ev.event)) {
        actionCount++;
        const meta =
          ev.event === "artifact_touched" || ev.event === "tool_invoked"
            ? { action: ev.action, file: ev.file_path }
          : ev.event === "bash_completed"
            ? { success: ev.success, command: (ev.command || "").slice(0, 60) }
          : ev.event === "delivered"
            ? { artifact: ev.artifact_path }
          : ev.event === "dispatch_squad"
            ? { squad: ev.squad_slug || ev.target?.squad }
          : ev.event === "routing_decision"
            ? { signal: ev.signal, target: ev.target_id || ev.target?.squad || ev.target?.business }
          : undefined;
        lastAction = { ts: ev.ts, event: ev.event, meta };
      }
    });

    tokens.total = tokens.input + tokens.output + tokens.cache_read + tokens.cache_creation;

    // Compute USD if not summed from events (i.e., legacy events without total_cost_usd)
    if (cost === 0 && tokens.total > 0) cost = usdFor(tokens, pricing);

    // Backfill = trace has ZERO realtime action events. The transcript importer
    // emits only cost_emission with caller_id "claude-code-transcript"; any
    // tool_invoked / artifact_touched / bash_completed proves a live hook fired.
    const isBackfill = actionCount === 0
      && callerIds.size > 0
      && [...callerIds].every(c => c === "claude-code-transcript");

    // ── Status derivation ──
    const lastMs = new Date(last.ts).getTime();
    const lastAge = nowMs - lastMs;
    const lastActionAge = lastAction ? nowMs - new Date(lastAction.ts).getTime() : Infinity;
    let status: AgentStatus;
    let statusSinceMs = lastAge;
    let currentTool: string | null = null;

    // 1. Terminal states (regardless of age)
    if (evs.some(e => e.event === "delivered")) {
      status = "completed";
      const dt = evs.filter(e => e.event === "delivered").pop()!;
      statusSinceMs = nowMs - new Date(dt.ts).getTime();
    } else if (evs.some(e => e.event === "gate_failed") && !evs.some(e => e.event === "gate_passed" && new Date(e.ts) > new Date(evs.filter(x => x.event === "gate_failed").pop()!.ts))) {
      status = "failed";
      const ft = evs.filter(e => e.event === "gate_failed").pop()!;
      statusSinceMs = nowMs - new Date(ft.ts).getTime();
    } else if (evs.some(e => e.event === "no_match")) {
      status = "no_match";
      const nt = evs.filter(e => e.event === "no_match").pop()!;
      statusSinceMs = nowMs - new Date(nt.ts).getTime();
    }
    // 2. Stale: no event for STALE_MS
    else if (lastAge > T.STALE_MS) {
      status = "stale";
    }
    // 3. tool_in_flight: pending tool_invoked without matching post
    else if (toolInvokedAtIdx >= 0 && (nowMs - new Date(evs[toolInvokedAtIdx].ts).getTime()) < T.TOOL_FLIGHT_MS) {
      status = "tool_in_flight";
      const tev = evs[toolInvokedAtIdx];
      currentTool = tev.action || tev.tool_name || (tev.file_path ? tev.file_path.split("/").pop() : null) || "?";
      statusSinceMs = nowMs - new Date(tev.ts).getTime();
    }
    // 4. waiting: brief received but no dispatch yet
    else if (last.event === "brief_received" && !evs.some(e => e.event === "dispatch_squad" || e.event === "routing_decision")) {
      status = "waiting";
    }
    // 5. running: recent ACTION event
    else if (lastAction && lastActionAge < T.RUNNING_MS) {
      status = "running";
      statusSinceMs = lastActionAge;
    }
    // 6. idle: alive but only passive events recently
    else {
      status = "idle";
      statusSinceMs = lastActionAge === Infinity ? lastAge : lastActionAge;
    }

    // ── Build recent_events tail (with per-event delta tokens, not cumulative) ──
    const recentSlice = evs.slice(-T.RECENT_EVENTS);
    const recent = recentSlice.map(e => {
      let meta: any | undefined;
      if (e.event === "artifact_touched" || e.event === "tool_invoked") {
        meta = { action: e.action, file: e.file_path };
      } else if (e.event === "bash_completed") {
        meta = { success: e.success, command: (e.command || "").slice(0, 60) };
      } else if (e.event === "cost_emission") {
        const t = tokensFromPayload(e.usage ? e : e.payload);
        meta = { tokens: t.total, model: e.model };
      } else if (e.event === "delivered") {
        meta = { artifact: e.artifact_path };
      } else if (e.event === "gate_passed" || e.event === "gate_failed") {
        meta = { rubrics: e.rubrics };
      }
      return { ts: e.ts, event: e.event, meta };
    });

    states.push({
      trace_id: tid,
      label: buildLabel(host, cwd, projectId, tid),
      host,
      caller_id: callerIds.size === 1 ? [...callerIds][0] : (callerIds.size > 1 ? "mixed" : null),
      is_backfill: isBackfill,
      cwd,
      project_id: projectId,
      brief_excerpt: brief,
      fallback_summary: buildFallbackSummary({ brief, lastAction, status, isBackfill }),
      started_at: first.ts,
      last_event_ts: last.ts,
      last_event_type: last.event,
      last_action_ts: lastAction?.ts || null,
      last_action_type: lastAction?.event || null,
      current_tool: currentTool,
      status,
      status_since_ms: Math.max(0, statusSinceMs),
      events_count: evs.length,
      action_events_count: actionCount,
      tokens_session: tokens,
      cost_session_usd: cost,
      files_touched_count: filesTouched.size,
      artifacts_created: artifactsCreated,
      bash_executions: bashExecs,
      gate_status: gate,
      recent_events: recent,
      // Phase D fields
      declared_mind_clones: [...declaredMindClones].sort(),
      injected_mind_clones: injectedMindClones,
      missing_mind_clones: (() => {
        // Compare by last segment so "alex-hormozi" matches "_root/alex-hormozi"
        const lastSeg = (s: string) => s.split("/").pop() || s;
        const injectedLast = new Set(injectedMindClones.map(i => lastSeg(i.slug)));
        return [...declaredMindClones].map(lastSeg).filter(s => !injectedLast.has(s)).sort();
      })(),
      dispatch_audit: dispatchAuditResult,
      is_suspicious_dispatch:
        dispatchBlockedSeen ||
        (dispatchAuditResult !== null && dispatchAuditResult.verdict !== "pass") ||
        (declaredMindClones.size > 0 && (() => {
          const lastSeg = (s: string) => s.split("/").pop() || s;
          const injectedLast = new Set(injectedMindClones.map(i => lastSeg(i.slug)));
          return [...declaredMindClones].some(s => !injectedLast.has(lastSeg(s)));
        })()),
    });
  }

  // Sort: active (tool_in_flight, running) first, then waiting, idle, stale, terminal
  const order: Record<AgentStatus, number> = {
    tool_in_flight: 0, running: 1, waiting: 2, idle: 3, stale: 4,
    completed: 5, failed: 5, no_match: 5,
  };
  states.sort((a, b) => {
    const oa = order[a.status] ?? 9;
    const ob = order[b.status] ?? 9;
    if (oa !== ob) return oa - ob;
    return b.last_event_ts.localeCompare(a.last_event_ts);
  });

  return states;
}

export function summarizeStates(states: AgentState[]): Record<AgentStatus, number> & { total: number } {
  const out: any = {
    tool_in_flight: 0, running: 0, idle: 0, waiting: 0, stale: 0,
    completed: 0, failed: 0, no_match: 0, total: 0,
  };
  for (const s of states) {
    out[s.status] = (out[s.status] || 0) + 1;
    out.total++;
  }
  return out;
}
