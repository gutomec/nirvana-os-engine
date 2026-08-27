import { fetchEngineBusinesses, fetchEngineLogs, fetchEngineSquads, isEngineMode } from "@/lib/engine-client";
import { db } from "@/lib/db";
import { getEngine } from "@/lib/event-engine";
import type { EntityDetailDTO } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/squads/[slug] — detalhe da entidade para o drawer.
 * Modo engine: resolve no registry real (squads ou businesses) e anexa os
 * eventos recentes do audit.jsonl que citarem o slug; sem upstream, o
 * registro simulado.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  if (isEngineMode()) {
    const [squads, businesses, logs] = await Promise.all([
      fetchEngineSquads(),
      fetchEngineBusinesses(),
      fetchEngineLogs(200),
    ]);
    const match = squads?.find((s) => s.slug === slug) ?? businesses?.entities.find((b) => b.slug === slug);
    if (match) {
      const dto: EntityDetailDTO = {
        ...match,
        events: (logs?.events ?? []).filter((ev) => ev.entitySlug === slug).slice(0, 12),
      };
      return Response.json(dto, { headers: { "Cache-Control": "no-store" } });
    }
    // nem squad nem business no upstream → cai no fallback (404 honesto)
  }

  const engine = getEngine();
  await engine.ready;

  const e = await db.entity.findUnique({ where: { slug } });
  if (!e) {
    return Response.json({ error: "not_found", hint: `Entidade "${slug}" não encontrada.` }, { status: 404 });
  }
  const events = await db.event.findMany({
    where: { entitySlug: slug },
    orderBy: { seq: "desc" },
    take: 12,
  });

  const dto: EntityDetailDTO = {
    slug: e.slug,
    name: e.name,
    kind: e.kind as EntityDetailDTO["kind"],
    icon: e.icon,
    status: e.status as EntityDetailDTO["status"],
    runsToday: e.runsToday,
    successRate: e.successRate,
    lastSeenAt: e.lastSeenAt.toISOString(),
    events: events.map((row) => ({
      id: row.seq,
      ts: row.ts.toISOString(),
      kind: row.kind as (typeof dto.events)[number]["kind"],
      status: row.status as (typeof dto.events)[number]["status"],
      title: row.title,
      detail: row.detail,
      entitySlug: row.entitySlug,
      durationMs: row.durationMs,
      cancelled: row.cancelled,
    })),
  };
  return Response.json(dto, { headers: { "Cache-Control": "no-store" } });
}
