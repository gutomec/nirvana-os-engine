import { describe, expect, test } from "bun:test";
import { decideBusinessCanary, runBusinessCanaryWithRollback } from "../lib/gauntlet/business-canary.ts";
import { RunAlreadyTerminalError } from "../lib/run-kernel/index.ts";

const selected = { businessSlug: "allowed-business", wantExec: true, teamMode: false, requestedMode: "gauntlet" as const,
  resolvedMode: "gauntlet" as const, allowlist: "other, allowed-business" };

describe("Business canary policy", () => {
  test("requires every activation condition", () => {
    expect(decideBusinessCanary(selected)).toEqual({ enabled: true, reason: "selected" });
    expect(decideBusinessCanary({ ...selected, killSwitch: "1" }).reason).toBe("kill_switch");
    expect(decideBusinessCanary({ ...selected, wantExec: false }).reason).toBe("scaffold_only");
    expect(decideBusinessCanary({ ...selected, teamMode: true }).reason).toBe("team_mode");
    expect(decideBusinessCanary({ ...selected, requestedMode: "auto" }).reason).toBe("not_explicit");
    expect(decideBusinessCanary({ ...selected, resolvedMode: "standard" }).reason).toBe("not_explicit");
    expect(decideBusinessCanary({ ...selected, allowlist: "" }).reason).toBe("not_allowlisted");
    expect(decideBusinessCanary({ ...selected, allowlist: "allowed-business-extra" }).reason).toBe("not_allowlisted");
  });

  test("rolls back before production without duplicating a producer", () => {
    let legacy = 0, production = 0;
    const events: string[] = [];
    const attempt = { markProductionStarted() { production += 1; }, run: () => ({ state: "rolled_back" }), shouldRollback: () => true };
    const result = runBusinessCanaryWithRollback({ attempt, runLegacy: () => { legacy += 1; return { state: "legacy" }; }, emit: event => events.push(event) });
    expect(result.state).toBe("legacy"); expect(legacy).toBe(1); expect(production).toBe(0);
    expect(events).toEqual(["x_business_gauntlet_rollback"]);
  });

  test("never falls back after production starts", () => {
    let legacy = 0, production = 0;
    const events: string[] = [];
    const attempt = { markProductionStarted() { production += 1; }, run() { this.markProductionStarted(); return { state: "failed" }; }, shouldRollback: () => true };
    const result = runBusinessCanaryWithRollback({ attempt, runLegacy: () => { legacy += 1; return { state: "legacy" }; }, emit: event => events.push(event) });
    expect(result.state).toBe("failed"); expect(production).toBe(1); expect(legacy).toBe(0);
    expect(events).toEqual(["x_business_gauntlet_terminal"]);
  });

  test("propagates post-production errors without legacy execution", () => {
    let legacy = 0;
    const attempt = { markProductionStarted() {}, run() { this.markProductionStarted(); throw new Error("producer failed"); }, shouldRollback: () => false };
    expect(() => runBusinessCanaryWithRollback({ attempt, runLegacy: () => { legacy += 1; return null as never; }, emit: () => {} })).toThrow("producer failed");
    expect(legacy).toBe(0);
  });

  test("a Run that already ended under the canary's id is refused, never rolled back into the legacy producer", () => {
    let legacy = 0;
    const events: string[] = [];
    const attempt = { markProductionStarted() {}, run(): never { throw new RunAlreadyTerminalError("run_p", "completed"); }, shouldRollback: () => true };
    expect(() => runBusinessCanaryWithRollback({ attempt, runLegacy: () => { legacy += 1; return null as never; }, emit: event => events.push(event) }))
      .toThrow("run 'run_p' is already terminal (completed); pass a fresh --run-id");
    expect(legacy).toBe(0);
    expect(events).toEqual([]);
  });
});
