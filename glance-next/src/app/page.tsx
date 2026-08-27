import GlanceApp from "@/components/glance/glance-app";
import ClassicView from "@/components/glance/classic-view";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const view = Array.isArray(sp.view) ? sp.view[0] : sp.view;

  // Modo clássico preservado (RF-11): /?view=classic
  if (view === "classic") {
    return <ClassicView />;
  }
  return <GlanceApp />;
}
