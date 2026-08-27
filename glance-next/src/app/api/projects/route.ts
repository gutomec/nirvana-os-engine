import { getEngine } from "@/lib/event-engine";

export const dynamic = "force-dynamic";

export async function GET() {
  const engine = getEngine();
  await engine.ready;
  const projects = await engine.getProjects();
  return Response.json({ projects }, { headers: { "Cache-Control": "no-store" } });
}
