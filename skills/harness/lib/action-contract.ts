/** Generic execution boundary for stable squad actions. */
export type ExecutionMode = "action" | "workflow" | "auto";
export type ExecutionSource = "explicit" | "project" | "squad" | "default";

export interface ActionContract<I = unknown, O = unknown> {
  id: string;
  version: string;
  input: (value: unknown) => value is I;
  output: (value: unknown) => value is O;
  run: (input: I) => Promise<O> | O;
}
export interface ExecutionConfig { mode?: ExecutionMode; actionId?: string; }
export interface ResolvedExecution { mode: ExecutionMode; actionId?: string; source: ExecutionSource; }
export interface InvokeOptions<I = unknown, O = unknown> {
  action?: ActionContract<I, O>;
  actionId?: string;
  input: unknown;
  mode?: ExecutionMode;
  workflow?: () => Promise<O> | O;
  audit?: (event: "execution_selected" | "execution_fallback", payload: Record<string, unknown>) => void;
}

export class ActionContractError extends Error {}

export function resolveExecution(explicit: ExecutionConfig = {}, project: ExecutionConfig = {}, squad: ExecutionConfig = {}): ResolvedExecution {
  const selected = explicit.mode !== undefined ? [explicit, "explicit"] : project.mode !== undefined ? [project, "project"] : squad.mode !== undefined ? [squad, "squad"] : [{ mode: "workflow" }, "default"];
  const config = selected[0] as ExecutionConfig;
  const source = selected[1] as ExecutionSource;
  return { mode: config.mode ?? "workflow", ...(config.actionId ? { actionId: config.actionId } : {}), source };
}

export async function invokeAction<I, O>(options: InvokeOptions<I, O>): Promise<O> {
  const mode = options.mode ?? "workflow";
  const action = options.action;
  const emit = options.audit;
  const actionUnavailable = !action
    || (options.actionId !== undefined && options.actionId !== action.id);
  if (mode === "workflow") {
    if (!options.workflow) throw new ActionContractError("workflow unavailable");
    if (emit) emit("execution_selected", { mode: "workflow" });
    return await options.workflow();
  }
  if (mode === "auto" && actionUnavailable) {
    if (!options.workflow) throw new ActionContractError("workflow unavailable");
    if (emit) emit("execution_fallback", {
      mode: "auto",
      fallback: "workflow",
      reason: "action_unavailable",
    });
    return await options.workflow();
  }
  if (!action) throw new ActionContractError("action unavailable");
  if (options.actionId && options.actionId !== action.id) throw new ActionContractError(`action '${options.actionId}' unavailable`);
  if (!action.input(options.input)) throw new ActionContractError(`invalid input for action '${action.id}'`);
  if (emit) emit("execution_selected", { mode: "action", action_id: action.id, action_version: action.version });
  const output = await action.run(options.input);
  if (!action.output(output)) throw new ActionContractError(`invalid output for action '${action.id}'`);
  return output;
}
