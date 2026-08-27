import { getEngine } from "@/lib/event-engine";

export const dynamic = "force-dynamic";

export async function GET() {
  const engine = getEngine();
  await engine.ready;
  const settings = await engine.getSettings();
  return Response.json(settings, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: Request) {
  const engine = getEngine();
  await engine.ready;

  let body: { scope?: string; allowActions?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad_request", hint: "JSON inválido." }, { status: 400 });
  }

  if (body.scope !== undefined) {
    if (body.scope !== "project" && body.scope !== "global") {
      return Response.json({ error: "bad_scope", hint: 'Scope deve ser "project" ou "global".' }, { status: 400 });
    }
    await engine.updateSetting("scope", body.scope);
  }
  if (body.allowActions !== undefined) {
    await engine.updateSetting("allowActions", String(Boolean(body.allowActions)));
  }

  const settings = await engine.getSettings();
  return Response.json(settings);
}
