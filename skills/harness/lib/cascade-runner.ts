// cascade-runner.ts — runs a headless dispatch with multi-runtime fallback.
//
// Wraps runHeadless(): if the chosen runtime returns quota_exhausted, marks it
// in the cooldown registry, builds a handoff prompt, and retries on the next
// runtime in the LLM_CASCADE. Emits runtime_handoff audit events.
//
// What it is NOT: a router for API keys (use LiteLLM/OpenRouter for that).
// This is for OAuth-backed CLI subscriptions (Claude Pro/Max, ChatGPT Plus,
// Gemini Advanced) where the user "pays" with their plan and we want to
// stretch dispatches across multiple plans the user already has.

import * as fs from "node:fs";
import * as path from "node:path";
import { runHeadless, runtimeAvailable, type Runtime, type RunHeadlessOpts, type RunHeadlessResult } from "./host-agent-driver.ts";
import { classify } from "./quota-detector.ts";
import { markCooldown, isInCooldown, getCooldown } from "./cooldown-registry.ts";
import { loadCascade, nextAfter, explain as explainCascade, entryKey, resolveCascadeRoot, type CascadeEntry } from "./cascade.ts";
import { buildHandoffPrompt } from "./handoff-prompt.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { estimateCostUsd } from "./cost-estimator.ts";
import { addSpend, isBudgetExhausted, getSpend } from "./spend-tracker.ts";

function emitAudit(payload: Record<string, any>, projectRoot: string): void {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(harnessLogsDir({ cwd: projectRoot }), today);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n");
  } catch { /* non-fatal */ }
}

export interface CascadeRunArgs extends RunHeadlessOpts {
  /** The user's brief — needed to rebuild the handoff prompt for the next runtime. */
  brief: string;
  /** Where state + outputs live. */
  projectRoot: string;
  outputsRoot: string;
  /** Optional human label of the current task (e.g. "step 3/5 (ds-landing-designer)"). */
  taskHint?: string;
  /** Optional project_id for the audit chain. */
  projectId?: string | null;
  /** Hard cap on number of handoffs before giving up (default: cascade length). */
  maxHandoffs?: number;
}

export interface CascadeRunResult extends RunHeadlessResult {
  /** Runtimes attempted, in order. First entry was the original choice. */
  handoffs: Array<{ from: Runtime; to: Runtime; reason: string }>;
  /** Final runtime that produced the result (may differ from the requested one). */
  finalRuntime: Runtime;
}

/** Run a dispatch with cross-runtime cascade. If LLM_CASCADE is unset in the
 *  project .env, behaves as a pass-through to runHeadless (no rotation). */
export function runWithCascade(args: CascadeRunArgs): CascadeRunResult {
  // Normalize projectRoot UP-FRONT. Callers (dispatch.ts) sometimes pass a
  // deep subdir like <root>/.nirvana/outputs/<id>/businesses/<slug>. We need
  // the TRUE root (where .env, .nirvana/state/, .nirvana/logs/ live) so the
  // .env is read, spend tracker writes to the right file, and cooldowns are
  // shared across team-steps of the same project.
  const realRoot = resolveCascadeRoot(args.projectRoot);
  if (realRoot !== args.projectRoot) {
    args = { ...args, projectRoot: realRoot };
  }
  const cascade = loadCascade(args.projectRoot);
  const handoffs: CascadeRunResult["handoffs"] = [];

  // No cascade configured → behave like plain runHeadless.
  if (!cascade.length) {
    const r = runHeadless(args);
    return { ...r, handoffs: [], finalRuntime: args.runtime };
  }

  // Pick the starting entry. Preference order:
  //   1. The cascade entry whose runtime matches the caller's request AND is
  //      currently usable (runtime not in cooldown, per-entry budget not spent).
  //   2. The first cascade entry that is usable.
  //   3. Pass-through to runHeadless (everything blocked — let the user see).
  const usable = (e: CascadeEntry) =>
    !isInCooldown(args.projectRoot, e.runtime) &&
    !isBudgetExhausted(args.projectRoot, entryKey(e), e.budgetUsd);
  let currentEntry: CascadeEntry | undefined = cascade.find(e => e.runtime === args.runtime && usable(e))
                                            ?? cascade.find(usable);
  if (!currentEntry) {
    emitAudit({
      event: "cascade_no_entry_available", project_id: args.projectId ?? null,
      cascade_explained: explainCascade(args.projectRoot, cascade),
    }, args.projectRoot);
    return { ...runHeadless(args), handoffs, finalRuntime: args.runtime };
  }
  if (currentEntry.runtime !== args.runtime) {
    // Diagnose WHY the requested runtime was skipped — budget? cooldown? not in cascade?
    // Makes audit logs informative when debugging multi-step team runs.
    let reason = `requested ${args.runtime} unavailable at start`;
    const wantedEntries = cascade.filter(e => e.runtime === args.runtime);
    if (wantedEntries.length) {
      const reasons: string[] = [];
      for (const e of wantedEntries) {
        if (isInCooldown(args.projectRoot, e.runtime)) reasons.push(`${entryKey(e)}: cooldown`);
        else if (isBudgetExhausted(args.projectRoot, entryKey(e), e.budgetUsd)) reasons.push(`${entryKey(e)}: budget exhausted ($${getSpend(args.projectRoot, entryKey(e)).toFixed(4)} of $${e.budgetUsd})`);
      }
      if (reasons.length) reason = `${args.runtime} unavailable — ${reasons.join("; ")}`;
    } else {
      reason = `${args.runtime} not in LLM_CASCADE`;
    }
    handoffs.push({ from: args.runtime, to: currentEntry.runtime, reason });
    emitAudit({
      event: "runtime_handoff", project_id: args.projectId ?? null,
      from: args.runtime, to: currentEntry.runtime, model: currentEntry.model,
      provider: currentEntry.providerHint, reason,
      cascade_explained: explainCascade(args.projectRoot, cascade),
    }, args.projectRoot);
  }
  let chosen: Runtime = currentEntry.runtime;
  let chosenModel: string | null = currentEntry.model ?? args.model ?? null;
  let chosenProvider: string | null = currentEntry.providerHint ?? args.providerHint ?? null;

  const maxHandoffs = args.maxHandoffs ?? cascade.length;
  let attempt = 0;
  let currentPrompt = args.prompt;
  let currentOpts: RunHeadlessOpts = {
    ...args, runtime: chosen,
    model: chosenModel ?? undefined,
    providerHint: chosenProvider ?? undefined,
  };

  while (attempt <= maxHandoffs) {
    attempt++;

    if (!runtimeAvailable(chosen)) {
      // CLI binary missing — treat as install failure, cooldown briefly, move on.
      markCooldown(args.projectRoot, chosen, 24 * 3600, `CLI binary for ${chosen} not on PATH`, "unknown");
      emitAudit({ event: "runtime_unavailable", project_id: args.projectId ?? null, runtime: chosen }, args.projectRoot);
      const nxt = nextAfter(args.projectRoot, cascade, chosen, entryKey(currentEntry!));
      if (!nxt) break;
      handoffs.push({ from: chosen, to: nxt.runtime, reason: `${chosen} CLI not installed` });
      currentEntry = nxt;
      chosen = nxt.runtime;
      chosenModel = nxt.model;
      chosenProvider = nxt.providerHint;
      currentOpts = {
        ...currentOpts, runtime: chosen,
        model: chosenModel ?? undefined,
        providerHint: chosenProvider ?? undefined,
      };
      continue;
    }

    const r = runHeadless(currentOpts);
    const verdict = classify(chosen, r);

    if (verdict.kind === "ok") {
      // Estimate spend and accumulate. Null cost = unknown → no enforcement.
      const cost = estimateCostUsd(chosen, chosenModel, r);
      if (cost != null) {
        const key = entryKey(currentEntry!);
        addSpend(args.projectRoot, key, cost);
        const totalSpend = getSpend(args.projectRoot, key);
        emitAudit({
          event: "dispatch_cost_recorded", project_id: args.projectId ?? null,
          entry_key: key, cost_usd: cost, total_spend_usd: totalSpend,
          budget_usd: currentEntry!.budgetUsd, source: chosen === "claude-code" && typeof r.costUsd === "number" ? "cli_native" : "estimate",
        }, args.projectRoot);
      }
      return { ...r, handoffs, finalRuntime: chosen };
    }

    if (verdict.kind === "auth_failed" || verdict.kind === "error") {
      // Don't rotate on auth or generic errors — surface to the caller.
      emitAudit({
        event: verdict.kind === "auth_failed" ? "runtime_auth_failed" : "runtime_error",
        project_id: args.projectId ?? null, runtime: chosen, hint: verdict.hint,
      }, args.projectRoot);
      return { ...r, handoffs, finalRuntime: chosen };
    }

    if (verdict.kind === "transient") {
      // Brief 429: small sleep then retry the same runtime. Bounded by retryAfter.
      const sleepMs = Math.max(1000, (verdict.retryAfterSec ?? 5) * 1000);
      emitAudit({
        event: "runtime_transient_retry", project_id: args.projectId ?? null,
        runtime: chosen, sleep_ms: sleepMs, hint: verdict.hint,
      }, args.projectRoot);
      const t = Date.now() + sleepMs;
      while (Date.now() < t) { /* busy wait kept honest because runHeadless is sync */ }
      continue;
    }

    // quota_exhausted → cooldown + handoff
    markCooldown(args.projectRoot, chosen, verdict.ttlSec, verdict.hint, verdict.window);
    emitAudit({
      event: "runtime_quota_exhausted", project_id: args.projectId ?? null,
      runtime: chosen, ttl_sec: verdict.ttlSec, window: verdict.window, hint: verdict.hint,
    }, args.projectRoot);

    const next = nextAfter(args.projectRoot, cascade, chosen, entryKey(currentEntry!));
    if (!next) {
      emitAudit({
        event: "cascade_exhausted", project_id: args.projectId ?? null,
        cascade_explained: explainCascade(args.projectRoot, cascade),
      }, args.projectRoot);
      return { ...r, handoffs, finalRuntime: chosen };
    }

    // Build a fresh prompt for the new runtime — it doesn't see the old session.
    currentPrompt = buildHandoffPrompt({
      fromRuntime: chosen,
      toRuntime: next.runtime,
      reason: verdict.hint,
      brief: args.brief,
      projectDir: args.cwd,
      outputsRoot: args.outputsRoot,
      taskHint: args.taskHint,
    });
    handoffs.push({ from: chosen, to: next.runtime, reason: verdict.hint });
    emitAudit({
      event: "runtime_handoff", project_id: args.projectId ?? null,
      from: chosen, to: next.runtime, model: next.model, provider: next.providerHint, reason: verdict.hint,
    }, args.projectRoot);
    currentEntry = next;
    chosen = next.runtime;
    chosenModel = next.model;
    chosenProvider = next.providerHint;
    currentOpts = {
      ...currentOpts, runtime: chosen, prompt: currentPrompt,
      model: chosenModel ?? undefined,
      providerHint: chosenProvider ?? undefined,
    };
  }

  // Exceeded handoff budget — return the last result.
  return {
    ok: false, runtime: chosen, sessionId: null, result: "",
    costUsd: null, exitCode: 1, stderr: "", durationMs: 0,
    error: `cascade exhausted after ${attempt} attempts`,
    handoffs, finalRuntime: chosen,
  };
}
