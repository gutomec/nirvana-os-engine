// webhooks.ts — terminal-state callback, signed.
//
// The receiver must be able to prove the POST came from this server: an
// HMAC-SHA256 of the exact body under the key's secret travels in
// `X-Nirvana-Signature`. Delivery failure NEVER affects the run — the
// artifacts are on disk and the polling routes still answer.

import { createHmac } from "node:crypto";
import type { RunEnvelope } from "./runs.ts";

export function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

export async function notifyTerminal(hook: { url: string; secret: string }, env: RunEnvelope): Promise<boolean> {
  const body = JSON.stringify({ event: "run.finished", run: env });
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(hook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Nirvana-Signature": sign(body, hook.secret),
          "X-Nirvana-Event": "run.finished",
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return true;
    } catch { /* network flake — retry below */ }
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
  }
  return false;
}
