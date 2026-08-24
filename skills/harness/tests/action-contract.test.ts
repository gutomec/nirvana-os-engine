import { describe, expect, test } from "bun:test";
import {
  ActionContractError,
  type ActionContract,
  invokeAction,
  resolveExecution,
} from "../lib/action-contract";

interface CloseInput {
  period: string;
  secret?: string;
}

interface CloseOutput {
  period: string;
  closed: boolean;
}

const closeMonthAction: ActionContract<CloseInput, CloseOutput> = {
  id: "accounting.close-month",
  version: "1.0.0",
  input: (value: unknown): value is CloseInput => {
    return typeof value === "object"
      && value !== null
      && typeof (value as Record<string, unknown>).period === "string";
  },
  output: (value: unknown): value is CloseOutput => {
    return typeof value === "object"
      && value !== null
      && typeof (value as Record<string, unknown>).period === "string"
      && (value as Record<string, unknown>).closed === true;
  },
  run: async (input) => ({ period: input.period, closed: true }),
};

describe("action execution policy", () => {
  test("resolves mode and action identity from the highest-precedence configured layer", () => {
    const cases = [
      {
        explicit: { mode: "action" as const, actionId: "explicit.action" },
        project: { mode: "auto" as const, actionId: "project.action" },
        squad: { mode: "workflow" as const, actionId: "squad.action" },
        want: { mode: "action", actionId: "explicit.action", source: "explicit" },
      },
      {
        explicit: {},
        project: { mode: "auto" as const, actionId: "project.action" },
        squad: { mode: "action" as const, actionId: "squad.action" },
        want: { mode: "auto", actionId: "project.action", source: "project" },
      },
      {
        explicit: {},
        project: {},
        squad: { mode: "action" as const, actionId: "squad.action" },
        want: { mode: "action", actionId: "squad.action", source: "squad" },
      },
      {
        explicit: {},
        project: {},
        squad: {},
        want: { mode: "workflow", source: "default" },
      },
    ];

    for (const { explicit, project, squad, want } of cases) {
      expect(resolveExecution(explicit, project, squad)).toEqual(want);
    }
  });

  test("uses workflow by default even when an action is available", async () => {
    let actionRuns = 0;
    const action = {
      ...closeMonthAction,
      run: async (input: CloseInput) => {
        actionRuns += 1;
        return { period: input.period, closed: true as const };
      },
    };

    const result = await invokeAction({
      action,
      input: { period: "2026-07" },
      workflow: async () => ({ period: "workflow", closed: true }),
    });

    expect(result).toEqual({ period: "workflow", closed: true });
    expect(actionRuns).toBe(0);
  });

  test("records an explicit workflow choice as selected, not fallback", async () => {
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];

    await invokeAction({
      mode: "workflow",
      action: closeMonthAction,
      input: { period: "2026-07" },
      workflow: async () => ({ period: "workflow", closed: true }),
      audit: (event, payload) => events.push({ event, payload }),
    });

    expect(events).toEqual([
      { event: "execution_selected", payload: { mode: "workflow" } },
    ]);
  });

  test("runs an explicit versioned action and audits only its stable identity", async () => {
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];

    const result = await invokeAction({
      mode: "action",
      actionId: "accounting.close-month",
      action: closeMonthAction,
      input: { period: "2026-07", secret: "do-not-audit" },
      audit: (event, payload) => events.push({ event, payload }),
    });

    expect(result).toEqual({ period: "2026-07", closed: true });
    expect(events).toEqual([
      {
        event: "execution_selected",
        payload: {
          mode: "action",
          action_id: "accounting.close-month",
          action_version: "1.0.0",
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("do-not-audit");
  });

  test("rejects invalid action input before the action runs", async () => {
    let actionRuns = 0;
    const action = {
      ...closeMonthAction,
      run: async (input: CloseInput) => {
        actionRuns += 1;
        return { period: input.period, closed: true as const };
      },
    };

    await expect(invokeAction({
      mode: "action",
      action,
      input: { period: 202607 },
    })).rejects.toThrow("invalid input for action 'accounting.close-month'");
    expect(actionRuns).toBe(0);
  });

  test("rejects an invalid action output", async () => {
    const action = {
      ...closeMonthAction,
      run: async () => ({ period: "2026-07", closed: false }),
    } as unknown as ActionContract<CloseInput, CloseOutput>;

    await expect(invokeAction({
      mode: "action",
      action,
      input: { period: "2026-07" },
    })).rejects.toThrow("invalid output for action 'accounting.close-month'");
  });

  test("fails explicitly when action mode has no matching action", async () => {
    let workflowRuns = 0;
    const workflow = async () => {
      workflowRuns += 1;
      return { period: "workflow", closed: true };
    };

    await expect(invokeAction({
      mode: "action",
      input: { period: "2026-07" },
      workflow,
    })).rejects.toBeInstanceOf(ActionContractError);
    await expect(invokeAction({
      mode: "action",
      actionId: "accounting.other",
      action: closeMonthAction,
      input: { period: "2026-07" },
      workflow,
    })).rejects.toThrow("action 'accounting.other' unavailable");
    expect(workflowRuns).toBe(0);
  });

  test("auto falls back when the action is unavailable and records no input", async () => {
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];

    const result = await invokeAction<CloseInput, CloseOutput>({
      mode: "auto",
      action: undefined,
      input: { period: "2026-07", secret: "do-not-audit" },
      workflow: async () => ({ period: "workflow", closed: true }),
      audit: (event, payload) => events.push({ event, payload }),
    });

    expect(result).toEqual({ period: "workflow", closed: true });
    expect(events).toEqual([
      {
        event: "execution_fallback",
        payload: { mode: "auto", fallback: "workflow", reason: "action_unavailable" },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("do-not-audit");
  });

  test("auto treats a mismatched action identity as unavailable", async () => {
    let actionRuns = 0;
    let workflowRuns = 0;
    const action = {
      ...closeMonthAction,
      run: async (input: CloseInput) => {
        actionRuns += 1;
        return { period: input.period, closed: true as const };
      },
    };

    const result = await invokeAction({
      mode: "auto",
      actionId: "accounting.other",
      action,
      input: { period: "2026-07" },
      workflow: async () => {
        workflowRuns += 1;
        return { period: "workflow", closed: true };
      },
    });

    expect(result).toEqual({ period: "workflow", closed: true });
    expect(actionRuns).toBe(0);
    expect(workflowRuns).toBe(1);
  });

  test("auto prefers an available action", async () => {
    let workflowRuns = 0;

    const result = await invokeAction({
      mode: "auto",
      action: closeMonthAction,
      input: { period: "2026-07" },
      workflow: async () => {
        workflowRuns += 1;
        return { period: "workflow", closed: true };
      },
    });

    expect(result).toEqual({ period: "2026-07", closed: true });
    expect(workflowRuns).toBe(0);
  });
});
