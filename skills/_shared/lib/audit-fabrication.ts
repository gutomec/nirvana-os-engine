/**
 * audit-fabrication.ts — heuristic detector for fabricated audit events.
 *
 * Some agents (notably Gemini-CLI without hooks) write audit events directly
 * via fs.appendFile, bypassing the audit.emit validator. They invent event
 * names, fabricate timestamps in artificial increments, and pretend tools were
 * dispatched without leaving evidence.
 *
 * This lib runs heuristics over a run's events and assigns a suspicion score.
 * Score >= 3 → flag the run as `_suspicious: true` with the evidence list,
 * so Glance can warn the user "this run looks fabricated, don't trust it".
 *
 * Heuristics:
 *   +3   any event name not in ALLOWED_EVENTS (real_mining_completed, etc.)
 *   +2   5+ events with timestamps in exact 5/10/15-minute increments
 *   +2   3+ consecutive events with `host: null`
 *   +1   delivered=true but ZERO `tool_invoked` / `artifact_touched` / `bash_completed` before it
 *   +2   ZERO events from any known hook host (gemini-cli-hook / claude-code-hook / fs-watch)
 */

// Mirror of audit.js ALLOWED_EVENTS (kept in sync manually — these are events
// the canonical audit.emit() will accept). Anything NOT here is suspicious.
const ALLOWED_EVENTS = new Set<string>([
  // Standard harness events
  "brief_received", "brief_amplified", "routing_decision", "invocation_start", "invocation_end",
  "cost_emission", "handoff", "ticket_opened", "ticket_resolved",
  "escalation_trigger_fired", "human_notification_required", "human_response_received",
  "resume", "approval_checkpoint", "approval_granted", "approval_rejected",
  "budget_violation", "memory_write", "isolation_violation", "validation_failed",
  "humanization_applied", "humanization_skipped", "loop_detected", "context_budget_warning",
  "stall_detected", "stall_retry", "gate_failed",
  // Agentic-mode events the new SKILL.md emits
  "target_plan_committed", "dispatch_business", "dispatch_squad",
  "research_completed", "briefing_completed", "no_match",
  "local_execution_started", "local_execution_completed",
  "delivered", "gate_passed",
  // Hook-emitted events (audit-emit-from-hook.ts + gemini-session-start.ts)
  "tool_invoked", "artifact_touched", "bash_completed",
  "session_started",
  // fs-watch daemon events (watch-fs.ts)
  "watch_started", "watch_stopped",
]);

const KNOWN_HOOK_HOSTS = new Set<string>(["claude-code-hook", "gemini-cli-hook", "codex-hook", "fs-watch"]);

export interface FabricationVerdict {
  suspicious: boolean;
  score: number;
  evidence: string[];
}

export function detectFabrication(events: any[]): FabricationVerdict {
  if (!Array.isArray(events) || events.length === 0) {
    return { suspicious: false, score: 0, evidence: [] };
  }
  const evidence: string[] = [];
  let score = 0;

  // 1. Events out of ALLOWED_EVENTS
  const unknownEvents: string[] = [];
  for (const ev of events) {
    if (ev?.event && !ALLOWED_EVENTS.has(ev.event)) {
      if (!unknownEvents.includes(ev.event)) unknownEvents.push(ev.event);
    }
  }
  if (unknownEvents.length > 0) {
    score += 3;
    evidence.push(`${unknownEvents.length} event name(s) outside the canonical enum: ${unknownEvents.slice(0, 5).join(", ")}${unknownEvents.length > 5 ? "..." : ""}`);
  }

  // 2. Timestamps in artificial increments (5/10/15 min, with multiple events)
  const timestamps = events.map((e: any) => e.ts).filter(Boolean).sort();
  if (timestamps.length >= 4) {
    const minutesEpoch = timestamps.map(t => Math.floor(new Date(t).getTime() / 60_000));
    const allOnRoundMinute = minutesEpoch.every((m, i, arr) => i === 0 || (arr[i] - arr[0]) % 5 === 0);
    const uniqueDeltas = new Set<number>();
    for (let i = 1; i < minutesEpoch.length; i++) {
      uniqueDeltas.add(minutesEpoch[i] - minutesEpoch[i - 1]);
    }
    // If all deltas are multiples of 5 minutes AND there are ≥3 different deltas all in {5,10,15,30,60}
    const suspectIncrements = new Set([5, 10, 15, 30, 60]);
    const allSuspect = Array.from(uniqueDeltas).every(d => d === 0 || suspectIncrements.has(d));
    if (allOnRoundMinute && allSuspect && uniqueDeltas.size >= 2) {
      score += 2;
      evidence.push(`Timestamps fall on artificial 5/10/15-min increments (${timestamps.length} events, deltas: ${[...uniqueDeltas].join(",")} min)`);
    }
  }

  // 3. Consecutive null host
  let nullHostStreak = 0;
  let maxNullStreak = 0;
  for (const ev of events) {
    if (ev?.host === null || ev?.host === undefined || ev?.host === "") {
      nullHostStreak++;
      maxNullStreak = Math.max(maxNullStreak, nullHostStreak);
    } else {
      nullHostStreak = 0;
    }
  }
  if (maxNullStreak >= 3) {
    score += 2;
    evidence.push(`${maxNullStreak} consecutive events with no host attribution`);
  }

  // 4. delivered without any tool evidence
  const hasDelivered = events.some((e: any) => e.event === "delivered");
  const hasToolEvidence = events.some((e: any) => ["tool_invoked", "artifact_touched", "bash_completed", "dispatch_business", "dispatch_squad"].includes(e.event));
  if (hasDelivered && !hasToolEvidence) {
    score += 1;
    evidence.push(`'delivered' event without any tool_invoked / artifact_touched evidence (claims delivery, no proof of work)`);
  }

  // 5. Zero hook events in a multi-event run
  if (events.length >= 4) {
    const hostsSeen = new Set(events.map((e: any) => e.host).filter(Boolean));
    const anyHookHost = [...hostsSeen].some(h => KNOWN_HOOK_HOSTS.has(h));
    if (!anyHookHost) {
      score += 2;
      evidence.push(`No events from any verified hook source (${[...hostsSeen].join(", ") || "no hosts"}) — agent may be writing directly to audit.jsonl`);
    }
  }

  return { suspicious: score >= 3, score, evidence };
}
