import { fetchEngineHealth } from "@/lib/engine-client";
import { getEngine } from "@/lib/event-engine";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — espelha o contrato do engine oficial
 * (`{ ok, version, uptime_ms, allow_actions, scope }`), normalizado para o
 * one-pager. Com `NIRVANA_ENGINE_URL` setado usa o upstream real; caso
 * contrário, o kernel simulado.
 */
export async function GET() {
  const upstream = await fetchEngineHealth();
  if (upstream) {
    return Response.json(upstream, { headers: { "Cache-Control": "no-store" } });
  }
  const engine = getEngine();
  await engine.ready;
  const health = await engine.getHealth();
  return Response.json(health, { headers: { "Cache-Control": "no-store" } });
}
