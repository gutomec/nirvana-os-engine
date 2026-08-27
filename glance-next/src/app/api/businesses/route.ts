import { fetchEngineBusinesses } from "@/lib/engine-client";
import { db } from "@/lib/db";
import type { BusinessDTO } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/businesses — registry real do engine com fallback simulado. */
export async function GET() {
  const upstream = await fetchEngineBusinesses();
  if (upstream) {
    return Response.json({ businesses: upstream.businesses }, { headers: { "Cache-Control": "no-store" } });
  }

  const rows = await db.business.findMany({ orderBy: { id: "asc" } });
  const businesses: BusinessDTO[] = rows.map((b) => ({
    slug: b.slug,
    name: b.name,
    active: b.active,
    runsToday: b.runsToday,
    lastSeenAt: b.lastSeenAt.toISOString(),
  }));
  return Response.json({ businesses }, { headers: { "Cache-Control": "no-store" } });
}
