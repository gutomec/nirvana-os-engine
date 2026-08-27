import { fetchEngineSquads } from "@/lib/engine-client";
import { db } from "@/lib/db";
import type { EntityDTO } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/squads — em modo engine devolve o registry real
 * (`{ slug, source, version, protocol, capabilities, domains }` normalizado);
 * sem upstream, o registro simulado.
 */
export async function GET() {
  const upstream = await fetchEngineSquads();
  if (upstream) {
    return Response.json({ squads: upstream }, { headers: { "Cache-Control": "no-store" } });
  }

  const rows = await db.entity.findMany({ orderBy: { id: "asc" } });
  const squads: EntityDTO[] = rows.map((e) => ({
    slug: e.slug,
    name: e.name,
    kind: e.kind as EntityDTO["kind"],
    icon: e.icon,
    status: e.status as EntityDTO["status"],
    runsToday: e.runsToday,
    successRate: e.successRate,
    lastSeenAt: e.lastSeenAt.toISOString(),
  }));
  return Response.json({ squads }, { headers: { "Cache-Control": "no-store" } });
}
