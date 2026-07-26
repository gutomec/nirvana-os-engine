/**
 * parallel-dispatcher.ts — runs a planned DAG with bounded concurrency.
 *
 * For each layer (output of dag-planner.planDag), runs all nodes in parallel
 * up to `maxConcurrent`. Errors from one node do NOT cancel siblings
 * (Promise.allSettled). The caller decides what to do with partial results.
 *
 * Phase 5 da nirvana-evolution.
 */

import type { PlanResult } from "./dag-planner.ts";

export interface NodeRun {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  duration_ms: number;
  cost_usd?: number;
}

export interface ExecuteOpts {
  maxConcurrent: number;
  stopOnLayerError?: boolean;   // if true, halts further layers when any node in current layer fails
  layerTimeoutMs?: number;
}

export const DEFAULT_OPTS: ExecuteOpts = {
  maxConcurrent: 5,
  stopOnLayerError: false,
};

export type RunFn = (nodeId: string) => Promise<{ result?: unknown; cost_usd?: number }>;

interface Semaphore {
  acquire(): Promise<() => void>;
}

function createSemaphore(n: number): Semaphore {
  const queue: ((release: () => void) => void)[] = [];
  let available = n;
  const release = () => {
    available++;
    if (queue.length > 0 && available > 0) {
      available--;
      const next = queue.shift()!;
      next(release);
    }
  };
  return {
    acquire(): Promise<() => void> {
      return new Promise<() => void>((resolve) => {
        if (available > 0) {
          available--;
          resolve(release);
        } else {
          queue.push(resolve);
        }
      });
    },
  };
}

export async function executePlan(
  plan: PlanResult,
  run: RunFn,
  opts: Partial<ExecuteOpts> = {},
): Promise<{ runs: NodeRun[]; total_duration_ms: number; aborted_after_layer: number | null }> {
  const cfg = { ...DEFAULT_OPTS, ...opts };
  const semaphore = createSemaphore(Math.max(1, cfg.maxConcurrent));
  const runs: NodeRun[] = [];
  const tStart = Date.now();
  let abortedAfter: number | null = null;

  for (let layerIdx = 0; layerIdx < plan.layers.length; layerIdx++) {
    const layer = plan.layers[layerIdx];
    const promises = layer.map((id) =>
      (async () => {
        const release = await semaphore.acquire();
        const t0 = Date.now();
        try {
          let result;
          if (cfg.layerTimeoutMs && cfg.layerTimeoutMs > 0) {
            const timer = new Promise<never>((_, rej) =>
              setTimeout(() => rej(new Error(`layer_timeout_${cfg.layerTimeoutMs}ms`)), cfg.layerTimeoutMs),
            );
            result = await Promise.race([run(id), timer]);
          } else {
            result = await run(id);
          }
          return { id, ok: true, result: result.result, duration_ms: Date.now() - t0, cost_usd: result.cost_usd } as NodeRun;
        } catch (e) {
          return { id, ok: false, error: (e as Error).message, duration_ms: Date.now() - t0 } as NodeRun;
        } finally {
          release();
        }
      })(),
    );
    const layerResults = await Promise.all(promises);
    runs.push(...layerResults);
    if (cfg.stopOnLayerError && layerResults.some((r) => !r.ok)) {
      abortedAfter = layerIdx;
      break;
    }
  }

  return {
    runs,
    total_duration_ms: Date.now() - tStart,
    aborted_after_layer: abortedAfter,
  };
}
