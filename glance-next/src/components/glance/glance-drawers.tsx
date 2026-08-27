"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { EntityIcon } from "@/components/glance/entity-icon";
import { MiniEventRow } from "@/components/glance/event-timeline";
import { entityDotClass, StatusBadge } from "@/components/glance/primitives";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/lib/i18n/provider";
import { fmtClock, fmtInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { BusinessDTO, EntityDetailDTO, ProjectDTO, SettingsDTO } from "@/lib/types";

export type DrawerState =
  | { type: "entity"; slug: string }
  | { type: "gallery" }
  | { type: "projects" }
  | { type: "settings" }
  | { type: "permissions" }
  | null;

interface GlanceDrawersProps {
  drawer: DrawerState;
  onClose: () => void;
  onOpenEntity: (slug: string) => void;
  settings: SettingsDTO | null;
  onToggleAllowActions: (v: boolean) => Promise<void>;
  onScopeChange: (scope: "project" | "global") => Promise<void>;
}

export function GlanceDrawers({
  drawer,
  onClose,
  onOpenEntity,
  settings,
  onToggleAllowActions,
  onScopeChange,
}: GlanceDrawersProps) {
  const { t } = useI18n();
  const open = drawer != null;
  const title =
    drawer?.type === "entity"
      ? t("drawer.entity.title")
      : drawer?.type === "gallery"
        ? t("drawer.gallery.title")
        : drawer?.type === "projects"
          ? t("drawer.projects.title")
          : drawer?.type === "settings"
            ? t("drawer.settings.title")
            : t("drawer.permissions.title");

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto scroll-slim sm:max-w-md">
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle className="label-caps text-foreground/80">{title}</SheetTitle>
          <SheetDescription className="sr-only">{title} · Nirvana Glance</SheetDescription>
        </SheetHeader>

        <div className="flex-1 px-5 py-4">
          {drawer?.type === "entity" && <EntityDrawerContent key={drawer.slug} slug={drawer.slug} />}
          {drawer?.type === "gallery" && <GalleryDrawerContent onOpenEntity={onOpenEntity} />}
          {drawer?.type === "projects" && <ProjectsDrawerContent />}
          {(drawer?.type === "settings" || drawer?.type === "permissions") && (
            <ConfigDrawerContent
              mode={drawer.type}
              settings={settings}
              onToggleAllowActions={onToggleAllowActions}
              onScopeChange={onScopeChange}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Drawer: entidade ─────────────────────────────────────────────────────

function EntityDrawerContent({ slug }: { slug: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<EntityDetailDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/squads/${slug}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).hint ?? "not_found");
        return r.json();
      })
      .then((json: EntityDetailDTO) => !cancelled && setData(json))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!data) {
    return (
      <div className="space-y-3">
        <div className="h-20 animate-pulse rounded-lg bg-secondary/50" />
        <div className="h-32 animate-pulse rounded-lg bg-secondary/50" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3.5">
        <span className="flex size-12 items-center justify-center rounded-lg border border-border bg-background">
          <EntityIcon name={data.icon} className="size-5 text-foreground/80" />
        </span>
        <div>
          <p className="text-base font-medium text-foreground">{data.name}</p>
          <p className="label-caps mt-1 flex items-center gap-1.5 text-muted-foreground">
            <span className={cn("inline-block size-1.5 rounded-full", entityDotClass(data.status))} aria-hidden />
            {data.status} · {data.kind.toLowerCase()}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border">
        <Stat label={t("entity.runsToday")} value={fmtInt(data.runsToday)} />
        <Stat label={t("entity.successRate")} value={data.successRate != null ? `${data.successRate.toFixed(1)}%` : "—"} />
        <Stat label={t("entity.lastSeen")} value={fmtClock(data.lastSeenAt)} mono />
        <Stat label={t("entity.recentEvents")} value={String(data.events.length)} />
      </div>

      <div>
        <p className="label-caps mb-2 text-muted-foreground">{t("entity.recentEvents")}</p>
        {data.events.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("entity.noEvents")}</p>
        ) : (
          <ul className="divide-y divide-border/70 rounded-lg border border-border px-3">
            {data.events.map((ev) => (
              <MiniEventRow key={ev.id} ev={ev} />
            ))}
          </ul>
        )}
      </div>

      <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
        cancel: gated por --allow-actions · idempotency: on · ledger: append-only
      </p>
    </div>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bg-card p-3.5">
      <p className="label-caps text-muted-foreground">{label}</p>
      <p className={cn("num-display mt-1.5 text-[22px] text-foreground", mono && "font-mono text-lg font-normal")}>
        {value}
      </p>
    </div>
  );
}

// ─── Drawer: gallery (entidades + businesses) ─────────────────────────────

function GalleryDrawerContent({ onOpenEntity }: { onOpenEntity: (slug: string) => void }) {
  const { t } = useI18n();
  const [squads, setSquads] = useState<EntityDetailDTO[] | null>(null);
  const [businesses, setBusinesses] = useState<BusinessDTO[] | null>(null);

  useEffect(() => {
    fetch("/api/squads", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setSquads(j.squads))
      .catch(() => setSquads([]));
    fetch("/api/businesses", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setBusinesses(j.businesses))
      .catch(() => setBusinesses([]));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <p className="label-caps mb-3 text-muted-foreground">{t("drawer.gallery.squads")}</p>
        <div className="grid grid-cols-2 gap-3">
          {(squads ?? []).map((e) => (
            <button
              key={e.slug}
              type="button"
              onClick={() => onOpenEntity(e.slug)}
              className="flex flex-col items-start gap-2 rounded-lg border border-border bg-card p-3.5 text-left transition-shadow hover:shadow-hairline"
            >
              <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-background">
                <EntityIcon name={e.icon} className="size-4 text-foreground/80" />
              </span>
              <span className="text-sm font-medium text-foreground">{e.name}</span>
              <span className="label-caps flex items-center gap-1.5 text-muted-foreground">
                <span className={cn("inline-block size-1.5 rounded-full", entityDotClass(e.status))} aria-hidden />
                {e.status}
              </span>
              <span className="num-display text-xl text-foreground">{fmtInt(e.runsToday)}</span>
            </button>
          ))}
          {!squads && Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-32 animate-pulse rounded-lg bg-secondary/40" />)}
        </div>
      </div>

      <div>
        <p className="label-caps mb-3 text-muted-foreground">{t("drawer.gallery.businesses")}</p>
        <ul className="divide-y divide-border rounded-lg border border-border px-3">
          {(businesses ?? []).map((b) => (
            <li key={b.slug} className="flex items-center gap-3 py-3">
              <span
                className={cn("inline-block size-2 rounded-full", b.active ? "bg-success" : "bg-ink-3")}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{b.name}</p>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {b.slug} · last seen {fmtClock(b.lastSeenAt)}
                </p>
              </div>
              <span className="num-display text-lg text-foreground">{fmtInt(b.runsToday)}</span>
            </li>
          ))}
          {!businesses && Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-12 animate-pulse rounded bg-secondary/40" />)}
        </ul>
      </div>
    </div>
  );
}

// ─── Drawer: projetos / DAG 2D ────────────────────────────────────────────

function ProjectsDrawerContent() {
  const { t } = useI18n();
  const [projects, setProjects] = useState<ProjectDTO[] | null>(null);

  useEffect(() => {
    fetch("/api/projects", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setProjects(j.projects))
      .catch(() => setProjects([]));
  }, []);

  if (!projects) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-40 animate-pulse rounded-lg bg-secondary/40" />)}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {projects.length === 0 && (
        <p className="py-10 text-center text-sm text-muted-foreground">{t("drawer.projects.empty")}</p>
      )}
      {projects.map((p) => (
        <div key={p.slug} className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-foreground">{p.name}</p>
            <StatusBadge status={p.lastStatus} />
          </div>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            {t("drawer.projects.lastRun")} {fmtClock(p.lastRun)} UTC · {t("drawer.projects.duration")} {p.lastDurationLabel} · {p.entitySlug}
          </p>
          <ol className="mt-3 space-y-0">
            {p.steps.map((step, i) => (
              <li key={step.name} className="relative flex items-center gap-3 pb-3 last:pb-0">
                {i < p.steps.length - 1 && (
                  <span aria-hidden className="absolute left-[5px] top-4 h-full w-px bg-border" />
                )}
                <span
                  className={cn(
                    "relative z-10 size-[11px] shrink-0 rounded-full border-2 border-card",
                    step.status === "SUCCESS" && "bg-success",
                    step.status === "INFO" && "bg-ink-3",
                    step.status === "WARNING" && "bg-warning",
                    step.status === "FAILED" && "bg-danger"
                  )}
                  aria-hidden
                />
                <span className="font-mono text-xs text-foreground/85">{step.name}</span>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

// ─── Drawer: settings + permissões (settings core 0.9.0) ─────────────────

function ConfigDrawerContent({
  mode,
  settings,
  onToggleAllowActions,
  onScopeChange,
}: {
  mode: "settings" | "permissions";
  settings: SettingsDTO | null;
  onToggleAllowActions: (v: boolean) => Promise<void>;
  onScopeChange: (scope: "project" | "global") => Promise<void>;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);

  const toggle = async (v: boolean) => {
    setPending(true);
    await onToggleAllowActions(v);
    setPending(false);
    toast.success(v ? t("toast.actionsOn") : t("toast.actionsOff"));
  };

  if (!settings) return <div className="h-64 animate-pulse rounded-lg bg-secondary/40" />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-foreground">{t("drawer.settings.core")}</p>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">nirvana-core · settings 0.9.0</p>
        </div>
        <Badge variant="outline" className="font-mono text-xs">
          v{settings.version}
        </Badge>
      </div>

      {mode === "settings" && (
        <>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-foreground">{t("drawer.settings.scope")}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t("drawer.settings.scopeHint")}</p>
            </div>
            <Select value={settings.scope} onValueChange={(v) => onScopeChange(v as "project" | "global")}>
              <SelectTrigger size="sm" className="w-[120px] text-xs" aria-label={t("drawer.settings.scope")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="project" className="text-xs">project</SelectItem>
                <SelectItem value="global" className="text-xs">global</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-lg border border-border p-4">
            <div className="flex items-center justify-between">
              <p className="label-caps text-muted-foreground">{t("drawer.settings.budget")}</p>
              <p className="font-mono text-xs text-foreground">{settings.budgetPct}%</p>
            </div>
            <Progress value={settings.budgetPct} className="mt-2.5 h-1.5" aria-label={`${t("drawer.settings.budget")}: ${settings.budgetPct}%`} />
          </div>
        </>
      )}

      <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
        <div>
          <p className="text-sm font-medium text-foreground">--allow-actions</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {mode === "permissions"
              ? t("drawer.permissions.actionsHint")
              : t("drawer.settings.actionsGate")}
          </p>
        </div>
        <Switch
          checked={settings.allowActions}
          onCheckedChange={toggle}
          disabled={pending}
          aria-label={t("drawer.settings.allowActions")}
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-foreground">{t("drawer.settings.idempotency")}</p>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">Idempotency-Key em POST /api/v1</p>
        </div>
        <Badge variant="outline" className="text-success border-success/40">
          {settings.idempotency ? "on" : "off"}
        </Badge>
      </div>

      {mode === "permissions" && (
        <div>
          <p className="label-caps mb-2 text-muted-foreground">{t("drawer.permissions.title")}</p>
          <ul className="divide-y divide-border rounded-lg border border-border px-3 text-sm">
            <li className="flex items-center justify-between gap-3 py-2.5">
              <span className="text-foreground/90">{t("drawer.permissions.cancel")}</span>
              <span className="font-mono text-xs text-muted-foreground">{settings.allowActions ? "on" : "gated"}</span>
            </li>
            <li className="flex items-center justify-between gap-3 py-2.5">
              <span className="text-foreground/90">{t("drawer.permissions.scopeChange")}</span>
              <span className="font-mono text-xs text-muted-foreground">on</span>
            </li>
            <li className="flex items-center justify-between gap-3 py-2.5">
              <span className="text-foreground/90">{t("drawer.permissions.settings")}</span>
              <span className="font-mono text-xs text-muted-foreground">on</span>
            </li>
            <li className="flex items-center justify-between gap-3 py-2.5">
              <span className="text-foreground/90">{t("drawer.permissions.readOnly")}</span>
              <span className="font-mono text-xs text-muted-foreground">default</span>
            </li>
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">{t("drawer.permissions.readOnlyHint")}</p>
        </div>
      )}

      <div>
        <p className="label-caps mb-2 text-muted-foreground">{t("drawer.settings.headless")}</p>
        <div className="flex flex-wrap gap-2">
          {settings.headlessPerms.map((p) => (
            <Badge key={p} variant="secondary" className="font-mono text-[11px]">
              {p}
            </Badge>
          ))}
        </div>
      </div>

      <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
        {mode === "permissions"
          ? settings.allowActions
            ? t("drawer.permissions.stateOn")
            : t("drawer.permissions.stateOff")
          : t("drawer.settings.liveHint")}
      </p>
    </div>
  );
}
