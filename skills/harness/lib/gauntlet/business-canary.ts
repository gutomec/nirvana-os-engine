// The canary's producer is the same solo worker as a plain run. Its prompt comes
// from prepareBusinessSolo (business-solo.ts), which also clears the previous
// participation.json, so a candidate never inherits another candidate's credit.
// Crediting what the worker declares is creditSoloRun (business-solo.ts); the
// producer in scripts/dispatch.ts calls it after each candidate.

import { RunAlreadyTerminalError } from "../run-kernel/index.ts";

export interface BusinessCanaryPolicyInput {
  businessSlug: string;
  wantExec: boolean;
  requestedMode: "standard" | "gauntlet" | "auto";
  resolvedMode: "standard" | "gauntlet";
  allowlist?: string;
  killSwitch?: string;
}

export interface BusinessCanaryDecision {
  enabled: boolean;
  reason: "selected" | "kill_switch" | "not_explicit" | "scaffold_only" | "not_allowlisted";
}

export function decideBusinessCanary(input: BusinessCanaryPolicyInput): BusinessCanaryDecision {
  if (["1", "true", "on"].includes((input.killSwitch ?? "").trim().toLowerCase())) return { enabled: false, reason: "kill_switch" };
  if (!input.wantExec) return { enabled: false, reason: "scaffold_only" };
  if (input.requestedMode !== "gauntlet" || input.resolvedMode !== "gauntlet") return { enabled: false, reason: "not_explicit" };
  const allowed = new Set((input.allowlist ?? "").split(",").map(slug => slug.trim()).filter(Boolean));
  if (!allowed.has(input.businessSlug)) return { enabled: false, reason: "not_allowlisted" };
  return { enabled: true, reason: "selected" };
}

export interface BusinessCanaryAttempt<T> {
  markProductionStarted(): void;
  run(): T;
  shouldRollback(result: T): boolean;
}

/** Allows legacy rollback only before the producer starts. Once marked, every
 * failure belongs to the canary and legacy execution is never invoked. */
export function runBusinessCanaryWithRollback<T>(input: {
  attempt: BusinessCanaryAttempt<T>;
  runLegacy(): T;
  emit(event: "x_business_gauntlet_rollback" | "x_business_gauntlet_terminal", payload: Record<string, unknown>): void;
}): T {
  let productionStarted = false;
  const mark = input.attempt.markProductionStarted;
  input.attempt.markProductionStarted = () => { productionStarted = true; mark(); };
  try {
    const result = input.attempt.run();
    if (input.attempt.shouldRollback(result) && !productionStarted) {
      input.emit("x_business_gauntlet_rollback", { reason: "pre_production", production_started: false });
      return input.runLegacy();
    }
    input.emit("x_business_gauntlet_terminal", { production_started: productionStarted });
    return result;
  } catch (error) {
    // A Run that already ended under this id is refused, never rolled back: the legacy producer
    // would run under the same id, which is what the refusal exists to prevent.
    if (error instanceof RunAlreadyTerminalError) throw error;
    if (!productionStarted) {
      input.emit("x_business_gauntlet_rollback", { reason: "pre_production_error", production_started: false,
        error: String((error as Error).message) });
      return input.runLegacy();
    }
    input.emit("x_business_gauntlet_terminal", { production_started: true, error: String((error as Error).message) });
    throw error;
  }
}
