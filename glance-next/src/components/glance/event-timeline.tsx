"use client";

import { useMemo, useState } from "react";
import { Loader2, X } from "lucide-react";
import { StatusBadge, StatusDot } from "@/components/glance/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtDuration, fmtMs } from "@/lib/format";
import { cn } from "@/lib/utils";
import { FILTER_OPTIONS, type TimelineFilter, type WireEvent } from "@/lib/types";
import { useI18n } from "@/lib/i18n/provider";
import type { Dictionary } from "@/lib/i18n/dictionaries";

interface EventTimelineProps {
  events: WireEvent[];
  allowActions: boolean;
  onCancelRun: (id: number) => Promise<{ ok: boolean; hint?: string }>;
}

/** RF-4 · Timeline canônica: filtro, timestamp ms, dots, badges outline, cancel gated. */
export function EventTimeline({ events, allowActions, onCancelRun }: EventTimelineProps) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<TimelineFilter>("ALL");

  const filtered = useMemo(
    () => (filter === "ALL" ? events : events.filter((e) => e.kind === filter)),
    [events, filter]
  );

  return (
    <section
      id="event-timeline"
      aria-label={t("timeline.title")}
      className="flex flex-col rounded-lg border border-border bg-card shadow-hairline"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h2 className="label-caps text-foreground/80">{t("timeline.title")}</h2>
        <Select value={filter} onValueChange={(v) => setFilter(v as TimelineFilter)}>
          <SelectTrigger
            size="sm"
            aria-label={t("timeline.filterAria")}
            className="w-[150px] rounded-md text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {FILTER_OPTIONS.map((opt) => (
              <SelectItem key={opt} value={opt} className="text-xs">
                {t(`filter.${opt}` as keyof Dictionary)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </header>

      <div
        role="log"
        aria-live="polite"
        aria-label={t("timeline.logAria")}
        className="scroll-slim max-h-[560px] overflow-y-auto px-5"
      >
        {filtered.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t("timeline.empty")}</p>
        ) : (
          <ol className="divide-y divide-border/70">
            {filtered.map((ev) => (
              <TimelineRow key={ev.id} ev={ev} allowActions={allowActions} onCancelRun={onCancelRun} />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function TimelineRow({
  ev,
  allowActions,
  onCancelRun,
}: {
  ev: WireEvent;
  allowActions: boolean;
  onCancelRun: (id: number) => Promise<{ ok: boolean; hint?: string }>;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const cancelable =
    allowActions &&
    ev.kind === "RUN" &&
    !ev.cancelled &&
    ev.status !== "FAILED" &&
    Date.now() - new Date(ev.ts).getTime() < 180_000;

  const handleCancel = async () => {
    setPending(true);
    await onCancelRun(ev.id);
    setPending(false);
  };

  return (
    <li className="ev-enter group grid grid-cols-[84px_16px_1fr_auto] items-start gap-x-3 py-3.5 sm:grid-cols-[96px_16px_1fr_auto]">
      <time
        dateTime={ev.ts}
        className="pt-px font-mono text-xs tabular-nums text-muted-foreground"
      >
        {fmtMs(ev.ts)}
      </time>

      {/* coluna do dot com linha-guia vertical contínua */}
      <div className="relative flex min-h-[38px] justify-center self-stretch">
        <span
          aria-hidden
          className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/70"
        />
        <StatusDot status={ev.status} className="relative z-10 mt-1.5 ring-2 ring-card" />
      </div>

      <div className="min-w-0 py-0.5">
        <p className="truncate text-[13.5px] font-medium text-foreground" title={ev.title}>
          {ev.title}
        </p>
        {ev.detail && (
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={ev.detail}>
            {ev.detail}
          </p>
        )}
      </div>

      <div className="flex items-center gap-1.5 pt-0.5">
        {cancelable && (
          <button
            type="button"
            onClick={handleCancel}
            disabled={pending}
            aria-label={t("timeline.cancel")}
            title={t("timeline.cancel")}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-40"
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" aria-hidden />}
          </button>
        )}
        <StatusBadge status={ev.status} />
      </div>
    </li>
  );
}

/** Linha compacta reutilizada nos drawers (entidade). */
export function MiniEventRow({ ev }: { ev: WireEvent }) {
  return (
    <li className="grid grid-cols-[84px_1fr_auto] items-start gap-x-3 py-2.5">
      <time className="pt-px font-mono text-[11px] tabular-nums text-muted-foreground">
        {fmtMs(ev.ts)}
      </time>
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-foreground">{ev.title}</p>
        {ev.detail && (
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {ev.durationMs ? `${ev.detail} · ${fmtDuration(ev.durationMs)}` : ev.detail}
          </p>
        )}
      </div>
      <StatusBadge status={ev.status} />
    </li>
  );
}
