"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AskBar } from "@/components/glance/ask-bar";
import { CommandPalette } from "@/components/glance/command-palette";
import { EntityColumn } from "@/components/glance/entity-column";
import { EventTimeline } from "@/components/glance/event-timeline";
import { GlanceDrawers, type DrawerState } from "@/components/glance/glance-drawers";
import { Hero } from "@/components/glance/hero";
import { IconRail, type RailId } from "@/components/glance/icon-rail";
import { Tier3Row } from "@/components/glance/tier3-row";
import { TopBar } from "@/components/glance/top-bar";
import { useGlance } from "@/hooks/use-glance";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { SettingsDTO } from "@/lib/types";

const DRAWER_TO_RAIL: Record<NonNullable<DrawerState>["type"], RailId> = {
  entity: "entities",
  gallery: "entities",
  projects: "projects",
  settings: "settings",
  permissions: "permissions",
};

/** Layout canônico "Clean Operations" (PRD v2.0 §1). */
export default function GlanceApp() {
  const { t } = useI18n();
  const { pulse, events, entities: entitySnapshot, businesses, connected, cancelRun } = useGlance();
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [settings, setSettings] = useState<SettingsDTO | null>(null);
  const [railRevealed, setRailRevealed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [timelineInView, setTimelineInView] = useState(false);


  // Entidades ao vivo chegam no pulse (SSE 10s); snapshot só cobre o 1º render.
  const entities = pulse?.entities?.length ? pulse.entities : entitySnapshot;

  // Settings derivados: campos ao vivo sobrepõem o snapshot local (sem effect de sync).
  const effectiveSettings: SettingsDTO | null = settings
    ? {
        ...settings,
        scope: pulse?.health.scope ?? settings.scope,
        allowActions: pulse?.health.allowActions ?? settings.allowActions,
        budgetPct: pulse?.health.budgetPct ?? settings.budgetPct,
      }
    : null;

  // Scrollspy: com nenhum drawer aberto, o rail acompanha a rolagem (overview ⇄ timeline).
  useEffect(() => {
    const el = document.getElementById("event-timeline");
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setTimelineInView(entry.isIntersecting),
      { rootMargin: "0px 0px -55% 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Badge de atividade no rail (sem estado): pulso quando há evento muito
  // recente (<30s) e o operador não está olhando a timeline.
  const latestEventTs = events[0]?.ts ? Date.parse(events[0].ts) : 0;
  const recentActivity = Date.now() - latestEventTs < 30_000;
  const timelineBadge = !timelineInView && !drawer && recentActivity;

  const railActive: RailId = drawer
    ? DRAWER_TO_RAIL[drawer.type]
    : timelineInView
      ? "timeline"
      : "overview";

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: SettingsDTO) => setSettings(j))
      .catch(() => {});
  }, []);

  const patchSettings = useCallback(async (body: Record<string, unknown>) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) setSettings((await res.json()) as SettingsDTO);
    } catch {
      toast.error(t("toast.settingsFail"));
    }
  }, [t]);

  const handleCancelRun = useCallback(
    async (id: number) => {
      const res = await cancelRun(id);
      if (!res.ok) {
        toast.error(res.hint ?? t("toast.cancelBlocked"));
      } else {
        toast.success(t("toast.cancelOk"));
      }
      return res;
    },
    [cancelRun, t]
  );

  const onRailSelect = useCallback((id: RailId) => {
    switch (id) {
      case "overview":
        setDrawer(null);
        window.scrollTo({ top: 0, behavior: "smooth" });
        break;
      case "timeline":
        setDrawer(null);
        document.getElementById("event-timeline")?.scrollIntoView({ behavior: "smooth", block: "start" });
        break;
      case "entities":
        setDrawer({ type: "gallery" });
        break;
      case "projects":
        setDrawer({ type: "projects" });
        break;
      case "settings":
        setDrawer({ type: "settings" });
        break;
      case "permissions":
        setDrawer({ type: "permissions" });
        break;
    }
  }, []);

  const openEntity = useCallback((slug: string) => setDrawer({ type: "entity", slug }), []);

  const handleRailRevealed = useCallback((v: boolean) => setRailRevealed(v), []);

  const handlePaletteNavigate = useCallback(
    (id: RailId) => {
      setPaletteOpen(false);
      onRailSelect(id);
    },
    [onRailSelect]
  );

  return (
    <div className="min-h-screen bg-background">
      <IconRail
        active={railActive}
        onSelect={onRailSelect}
        onRevealedChange={handleRailRevealed}
        badges={{
          timeline: timelineBadge,
          settings: effectiveSettings ? !effectiveSettings.allowActions : false,
        }}
      />

      {/* Conteúdo desliza em sincronia com o rail sumido (200ms) */}
      <div
        className={cn(
          "flex min-h-screen flex-col transition-[padding-left] duration-200 ease-out motion-reduce:transition-none",
          railRevealed ? "pl-14 md:pl-16" : "pl-0"
        )}
      >
        <TopBar
          health={pulse?.health ?? null}
          connected={connected}
          onCycleScope={() => {
            const next = pulse?.health.scope === "global" ? "project" : "global";
            void patchSettings({ scope: next });
            toast.info(t("toast.scopeChanged", { scope: next }));
          }}
          onOpenPalette={() => setPaletteOpen(true)}
        />

        <main className="mx-auto w-full max-w-6xl flex-1 space-y-4 px-4 pb-40 pt-6 md:px-6">
          <Hero pulse={pulse} />

          <div className="grid items-start gap-4 lg:grid-cols-[1.5fr_1fr]">
            <EventTimeline
              events={events}
              allowActions={effectiveSettings?.allowActions ?? false}
              onCancelRun={handleCancelRun}
            />
            <EntityColumn entities={entities} onSelect={openEntity} />
          </div>

          <Tier3Row subsystems={pulse?.subsystems ?? []} />
        </main>
      </div>

      <AskBar
        entities={entities}
        businesses={businesses}
        railOpen={railRevealed}
        onOpenEntity={openEntity}
        onOpenProjects={() => onRailSelect("projects")}
      />

      <GlanceDrawers
        drawer={drawer}
        onClose={() => setDrawer(null)}
        onOpenEntity={openEntity}
        settings={effectiveSettings}
        onToggleAllowActions={(v) => patchSettings({ allowActions: v })}
        onScopeChange={(scope) => {
          void patchSettings({ scope });
          toast.info(t("toast.scopeChanged", { scope }));
          return Promise.resolve();
        }}
      />

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onNavigate={handlePaletteNavigate} />
    </div>
  );
}
