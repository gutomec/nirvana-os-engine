import { isEngineMode, fetchEnginePulse } from "@/lib/engine-client";
import { getEngine } from "@/lib/event-engine";

export const dynamic = "force-dynamic";

/**
 * GET /api/pulse — snapshot consolidado (stats + subsystems + entities +
 * health). Em modo engine, todos os valores vêm de endpoints reais do
 * upstream; os indisponíveis viram null e a UI mostra "—".
 */
export async function GET() {
  if (isEngineMode()) {
    const upstream = await fetchEnginePulse();
    if (upstream) {
      return Response.json(upstream, { headers: { "Cache-Control": "no-store" } });
    }
  }
  const engine = getEngine();
  await engine.ready;
  const pulse = await engine.getPulse();
  return Response.json(pulse, { headers: { "Cache-Control": "no-store" } });
}
