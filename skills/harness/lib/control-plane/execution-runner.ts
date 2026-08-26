// execution-runner.ts — runs one Glance Message as a child `dispatch.ts` process.
//
// The in-process canary adapter blocks the Bun.serve event loop for the whole
// Gauntlet, freezing HTTP and SSE for minutes. This runner spawns the existing
// dispatch script instead: the server keeps answering while the child writes the
// canonical timeline into the same `.nirvana/run-kernel.sqlite` (WAL) the server
// reads. Target selection is explicit (--agent-x | --business | --squad) and
// `--run-id` makes the child adopt the Run the control plane already prepared
// instead of creating a second one. Nothing here re-implements dispatch.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { listRuntimes, runtimeAvailable } from "../../../_shared/lib/host-agent-driver.ts";
import type { Runtime } from "../host-agent-driver.ts";
import { canonicalRuntimeName, detectCurrentHost, resolveDefaultRuntime } from "../runtime-rules.ts";
import type { TargetRef } from "../run-kernel/index.ts";

export interface ExecutionStartInput {
  projectRoot: string;
  projectId: string;
  runId: string;
  briefFile: string;
  target: TargetRef;
  intensity: "light";
}

export interface StartedExecution {
  pid: number;
  /** The command line as spawned; the queue records a project-relative summary of it. */
  argv: string[];
  done: Promise<{ exitCode: number | null }>;
  kill(): void;
}

export interface GlanceExecutionRunner {
  /** True when a child would find an executable runtime, by dispatch.ts's own rule. */
  available(): boolean;
  start(input: ExecutionStartInput): StartedExecution;
}

export interface DispatchExecutionRunnerOptions {
  /** Defaults to the repository's dispatch.ts; NIRVANA_DISPATCH_SCRIPT overrides the default. */
  dispatchScriptPath?: string;
  /** Pins the child's runtime (`--runtime`); otherwise the child decides as any dispatch does. */
  runtime?: Runtime;
  /** Extra environment for detection and for the child, on top of the server's. */
  env?: Record<string, string>;
}

const DEFAULT_DISPATCH_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "dispatch.ts");

/** Per-Run working directory of the Glance execution: brief, child log and outputs. */
export function glanceRunDir(projectRoot: string, runId: string): string {
  return path.join(projectRoot, ".nirvana", "glance", "runs", runId);
}

/** The runtime a child dispatch settles on with no flag, brief mention or rule (the same
 * rule dispatch.ts applies), and whether its CLI is on PATH right now. */
export function detectExecutionRuntime(env: NodeJS.ProcessEnv = process.env): { runtime: Runtime; from: "host" | "env" | "path-scan" | "fallback"; available: boolean } {
  const decision = resolveDefaultRuntime({
    detectedHost: detectCurrentHost(env),
    envDefault: (env.NIRVANA_DEFAULT_RUNTIME || "").trim(),
    normalize: canonicalRuntimeName,
    firstAvailable: () => listRuntimes().map(item => item.name).find(name => runtimeAvailable(name)) ?? null,
  });
  return { ...decision, available: runtimeAvailable(decision.runtime) };
}

export function createDispatchExecutionRunner(options: DispatchExecutionRunnerOptions = {}): GlanceExecutionRunner {
  const dispatchScript = path.resolve(options.dispatchScriptPath ?? process.env.NIRVANA_DISPATCH_SCRIPT ?? DEFAULT_DISPATCH_SCRIPT);
  const environment = (): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...options.env })) if (value !== undefined) env[key] = value;
    return env;
  };
  return {
    available() {
      return runtimeAvailable(options.runtime ?? detectExecutionRuntime(environment()).runtime);
    },
    start(input) {
      const runDir = glanceRunDir(input.projectRoot, input.runId);
      fs.mkdirSync(runDir, { recursive: true });
      const argv = ["bun", dispatchScript];
      if (input.target.kind === "business") argv.push("--business", input.target.slug);
      else if (input.target.kind === "squad") argv.push("--squad", input.target.slug);
      else argv.push("--agent-x");
      argv.push("--brief-file", input.briefFile, "--exec", "--project", input.projectId, "--run-id", input.runId,
        "--outputs-root", path.join(runDir, "outputs"));
      // The light Gauntlet is the agent-x canary's contract. Business and squad are not
      // forced into a mode: the child inherits the server's env (NIRVANA_EXECUTION_MODE,
      // allowlists) and decides as any dispatch would.
      if (input.target.kind === "agent-x") argv.push("--execution-mode=gauntlet", `--gauntlet-intensity=${input.intensity}`);
      if (options.runtime) argv.push("--runtime", options.runtime);
      const log = fs.openSync(path.join(runDir, "child.log"), "a");
      const child = Bun.spawn(argv, {
        cwd: input.projectRoot, env: { ...environment(), NIRVANA_PROJECT_ROOT: input.projectRoot },
        stdin: "ignore", stdout: log, stderr: log,
      });
      const done = child.exited.then(() => ({ exitCode: child.exitCode })).finally(() => fs.closeSync(log));
      return { pid: child.pid, argv, done, kill() { try { child.kill(); } catch { /* already gone */ } } };
    },
  };
}
