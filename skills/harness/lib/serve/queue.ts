// queue.ts — one run at a time per session, N sessions in parallel.
//
// Serializing per session is the protocol's own mental model (a session is a
// project; a project advances one brief at a time), and the global cap is
// the machine constraint expressed as a product parameter — the owner's
// machine dies under uncontrolled parallelism, and a server must never
// reproduce that on a buyer's VPS.

import * as runsLib from "./runs.ts";
import { deliveryId, referenceBody } from "./webhooks.ts";
import { enqueue as enqueueDelivery } from "./webhook-outbox.ts";

interface Pending {
  memo: ReturnType<typeof runsLib.register>;
  budgetUsd?: number;
  webhook?: { url: string; secret: string };
}

export interface QueueOpts { maxConcurrent: number }

export class RunQueue {
  private waiting: Pending[] = [];
  private activeBySession = new Set<string>();
  private active = 0;

  constructor(private opts: QueueOpts) {}

  get stats() {
    return { active: this.active, waiting: this.waiting.length, max_concurrent: this.opts.maxConcurrent };
  }

  submit(p: Pending): void {
    this.waiting.push(p);
    this.pump();
  }

  private pump(): void {
    for (let i = 0; i < this.waiting.length; i++) {
      if (this.active >= this.opts.maxConcurrent) return;
      const p = this.waiting[i];
      if (this.activeBySession.has(p.memo.session.id)) continue; // this session is busy
      this.waiting.splice(i, 1);
      i--;
      this.run(p);
    }
  }

  private run(p: Pending): void {
    this.active++;
    this.activeBySession.add(p.memo.session.id);
    runsLib.start(p.memo, { budgetUsd: p.budgetUsd })
      .catch((e) => {
        p.memo.state = "failed";
        p.memo.error = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        this.active--;
        this.activeBySession.delete(p.memo.session.id);
        if (p.webhook) {
          const env = runsLib.envelope(p.memo);
          const body = JSON.stringify(referenceBody(env));
          enqueueDelivery(p.memo.outputs_root, {
            id: deliveryId(env),
            trace_id: p.memo.trace_id,
            session_dir: p.memo.session.dir,
            url: p.webhook.url,
            secret: p.webhook.secret,
            body,
          });
        }
        this.pump();
      });
  }
}
