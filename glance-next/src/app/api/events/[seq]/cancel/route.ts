import { engineCancelRun, isEngineMode } from "@/lib/engine-client";
import { getEngine } from "@/lib/event-engine";

export const dynamic = "force-dynamic";

/**
 * POST /api/events/[seq]/cancel — cancela um run.
 * Gated: exige allowActions (= `--allow-actions`), caso contrário 403.
 * Modo engine: repassa para `POST /api/v1/conversations/:cnv/turns/:trn/:cancel`.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ seq: string }> }) {
  const { seq } = await params;
  const seqNum = Number(seq);
  if (!seqNum) {
    return Response.json({ error: "bad_request", hint: "seq inválido." }, { status: 400 });
  }

  if (isEngineMode()) {
    const upstream = await engineCancelRun(seqNum);
    if (upstream) {
      if (upstream.ok) return Response.json({ ok: true });
      const status = upstream.code === "ACTIONS_GATED" ? 403 : upstream.code === "NOT_FOUND" ? 404 : 409;
      return Response.json(upstream, { status });
    }
  }

  const engine = getEngine();
  await engine.ready;
  const result = await engine.cancelEvent(seqNum);
  if (!result.ok) {
    const status = result.code === "ACTIONS_GATED" ? 403 : result.code === "NOT_FOUND" ? 404 : 409;
    return Response.json(result, { status });
  }
  return Response.json(result);
}
