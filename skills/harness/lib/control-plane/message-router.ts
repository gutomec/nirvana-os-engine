// message-router.ts — the agentic router composed for the Glance: `agenticRoute` from
// lib/agentic-router.ts, the one router of the engine, run in a Worker because the
// headless CLI call it makes is a blocking `spawnSync`. In a Worker that call blocks
// its own thread; the Bun.serve event loop keeps answering HTTP and SSE while a
// Message is being routed, as it does while a child executes. Nothing here ranks.
import type { AgenticRouteDecision } from "../agentic-router.ts";
import type { Runtime } from "../host-agent-driver.ts";
import { MESSAGE_ROUTE_TIMEOUT_MS, type MessageRouter } from "./agent-x-canary-queue.ts";
import { detectExecutionRuntime } from "./execution-runner.ts";

export interface AgenticMessageRouterOptions {
  /** Pins the router's runtime; otherwise the runtime the execution runner would use, resolved per call. */
  runtime?: Runtime;
  /** Passed to agenticRoute, which ends the CLI call at the ceiling; default MESSAGE_ROUTE_TIMEOUT_MS. */
  timeoutMs?: number;
}

export function createAgenticMessageRouter(options: AgenticMessageRouterOptions = {}): MessageRouter {
  const workerUrl = new URL("./message-route-worker.ts", import.meta.url).href;
  return {
    route(input) {
      return new Promise<AgenticRouteDecision>((resolve, reject) => {
        const worker = new Worker(workerUrl);
        worker.onmessage = event => { worker.terminate(); resolve(event.data as AgenticRouteDecision); };
        worker.onerror = event => { worker.terminate(); reject(new Error((event.message || "message route worker failed").split("\n")[0])); };
        worker.postMessage({ brief: input.brief, cwd: input.projectRoot, projectId: input.projectId,
          runtime: options.runtime ?? detectExecutionRuntime().runtime, timeoutMs: options.timeoutMs ?? MESSAGE_ROUTE_TIMEOUT_MS });
      });
    },
  };
}
