export interface BusinessCanaryPolicyInput {
  businessSlug: string;
  wantExec: boolean;
  teamMode: boolean;
  requestedMode: "standard" | "gauntlet" | "auto";
  resolvedMode: "standard" | "gauntlet";
  intensity: "light" | "balanced" | "exhaustive";
  allowlist?: string;
  killSwitch?: string;
}

export interface BusinessCanaryDecision {
  enabled: boolean;
  reason: "selected" | "kill_switch" | "not_explicit" | "not_light" | "scaffold_only" | "team_mode" | "not_allowlisted";
}

export function decideBusinessCanary(input: BusinessCanaryPolicyInput): BusinessCanaryDecision {
  if (["1", "true", "on"].includes((input.killSwitch ?? "").trim().toLowerCase())) return { enabled: false, reason: "kill_switch" };
  if (!input.wantExec) return { enabled: false, reason: "scaffold_only" };
  if (input.teamMode) return { enabled: false, reason: "team_mode" };
  if (input.requestedMode !== "gauntlet" || input.resolvedMode !== "gauntlet") return { enabled: false, reason: "not_explicit" };
  if (input.intensity !== "light") return { enabled: false, reason: "not_light" };
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
    if (!productionStarted) {
      input.emit("x_business_gauntlet_rollback", { reason: "pre_production_error", production_started: false,
        error: String((error as Error).message) });
      return input.runLegacy();
    }
    input.emit("x_business_gauntlet_terminal", { production_started: true, error: String((error as Error).message) });
    throw error;
  }
}
