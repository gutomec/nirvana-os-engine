import { fetchEngineLogs } from "@/lib/engine-client";
import { db } from "@/lib/db";
import type { EventKind, EventStatus, WireEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/logs — em modo engine faz tail do `audit.jsonl` real
 * (`GET /api/logs?type=harness&date=today&limit=N` do upstream) e classifica
 * cada evento nos kinds/status do one-pager; sem upstream, o banco simulado.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);

  const upstream = await fetchEngineLogs(limit);
  if (upstream) {
    return Response.json({ events: upstream.events }, { headers: { "Cache-Control": "no-store" } });
  }

  const kind = url.searchParams.get("kind");
  const entity = url.searchParams.get("entity");
  const status = url.searchParams.get("status");
  const date = url.searchParams.get("date");

  const where: Record<string, unknown> = {};
  if (kind) where.kind = kind;
  if (entity) where.entitySlug = entity;
  if (status) where.status = status;
  if (date === "today") {
    const startToday = new Date();
    startToday.setUTCHours(0, 0, 0, 0);
    where.ts = { gte: startToday };
  }

  const rows = await db.event.findMany({
    where,
    orderBy: { seq: "desc" },
    take: limit,
  });

  const events: WireEvent[] = rows.map((row) => ({
    id: row.seq,
    ts: row.ts.toISOString(),
    kind: row.kind as EventKind,
    status: row.status as EventStatus,
    title: row.title,
    detail: row.detail,
    entitySlug: row.entitySlug,
    durationMs: row.durationMs,
    cancelled: row.cancelled,
  }));

  return Response.json({ events }, { headers: { "Cache-Control": "no-store" } });
}
