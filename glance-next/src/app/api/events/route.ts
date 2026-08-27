import { fetchEngineLogs, fetchEnginePulse, isEngineMode } from "@/lib/engine-client";
import { getEngine } from "@/lib/event-engine";
import type { BusMessage } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

/**
 * Stream SSE canônico do Run Kernel.
 * - eventos nomeados: `timeline` (id = seq), `timeline-update`, `pulse`
 * - resume por `Last-Event-ID` (header padrão do EventSource) sem duplicar
 *
 * Modo engine: consome o `audit.jsonl` real do upstream (mesma cadência de
 * 3s do `/api/logs/stream` oficial) e reemite no formato do one-pager,
 * com pulse a cada 10s derivado de endpoints reais.
 */
export async function GET(req: Request) {
  const lastEventId =
    req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("lastEventId");
  const lastSeq = lastEventId ? Number(lastEventId) || 0 : 0;

  if (isEngineMode()) {
    const first = await fetchEngineLogs(200);
    if (first) return engineStream(req, lastSeq);
    // upstream indisponível agora → cai no simulado
  }
  return simulatedStream(req, lastSeq);
}

// ─── Upstream real (nrv glance) ──────────────────────────────────────────────

function engineStream(req: Request, lastSeq: number): Response {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let pulseTimer: ReturnType<typeof setInterval> | null = null;
  let lastEmittedId = lastSeq;
  const seen = new Set<string>();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const sendMsg = (msg: BusMessage) => {
        if (msg.type === "timeline") {
          send(`id: ${msg.payload.id}\nevent: timeline\ndata: ${JSON.stringify(msg.payload)}\n\n`);
        } else if (msg.type === "timeline-update") {
          send(`event: timeline-update\ndata: ${JSON.stringify(msg.payload)}\n\n`);
        } else {
          send(`event: pulse\ndata: ${JSON.stringify(msg.payload)}\n\n`);
        }
      };

      send("retry: 3000\n\n");

      const pollOnce = async () => {
        const batch = await fetchEngineLogs(200);
        if (!batch) return;
        for (const ev of batch.events) {
          const key = `${ev.id}:${ev.title}`;
          if (ev.id <= lastEmittedId || seen.has(key)) continue;
          seen.add(key);
          lastEmittedId = Math.max(lastEmittedId, ev.id);
          sendMsg({ type: "timeline", payload: ev });
        }
      };

      send(`: engine mode ${new Date().toISOString()}\n\n`);
      await pollOnce();

      poll = setInterval(() => void pollOnce(), 4000);
      pulseTimer = setInterval(async () => {
        const pulse = await fetchEnginePulse();
        if (pulse) sendMsg({ type: "pulse", payload: pulse });
      }, 10_000);
      heartbeat = setInterval(() => send(`: hb ${Date.now()}\n\n`), 15_000);

      req.signal.addEventListener("abort", () => {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (poll) clearInterval(poll);
        if (pulseTimer) clearInterval(pulseTimer);
        try {
          controller.close();
        } catch {
          /* já fechado */
        }
      });
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      if (poll) clearInterval(poll);
      if (pulseTimer) clearInterval(pulseTimer);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

// ─── Kernel simulado (comportamento original) ────────────────────────────────

async function simulatedStream(req: Request, lastSeq: number): Promise<Response> {
  const engine = getEngine();
  await engine.ready;

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      send("retry: 3000\n\n");

      if (lastSeq > 0) {
        for (const ev of engine.eventsAfter(lastSeq)) {
          send(`id: ${ev.id}\nevent: timeline\ndata: ${JSON.stringify(ev)}\n\n`);
        }
      }

      const listener = (msg: BusMessage) => {
        if (msg.type === "timeline") {
          send(`id: ${msg.payload.id}\nevent: timeline\ndata: ${JSON.stringify(msg.payload)}\n\n`);
        } else if (msg.type === "timeline-update") {
          send(`event: timeline-update\ndata: ${JSON.stringify(msg.payload)}\n\n`);
        } else {
          send(`event: pulse\ndata: ${JSON.stringify(msg.payload)}\n\n`);
        }
      };
      engine.subscribe(listener);
      unsubscribe = () => engine.unsubscribe(listener);

      heartbeat = setInterval(() => send(`: hb ${Date.now()}\n\n`), 15_000);

      req.signal.addEventListener("abort", () => {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          /* já fechado */
        }
      });
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
