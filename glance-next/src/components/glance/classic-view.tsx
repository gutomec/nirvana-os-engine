"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { fmtClock, fmtInt, fmtMs } from "@/lib/format";
import type { BusinessDTO, PulseDTO, WireEvent } from "@/lib/types";
import type { EntityDTO } from "@/lib/types";

interface ClassicData {
  pulse: PulseDTO;
  events: WireEvent[];
  squads: EntityDTO[];
  businesses: BusinessDTO[];
}

/** RF-11 · Modo clássico preservado: /?view=classic */
export default function ClassicView() {
  const { t } = useI18n();
  const [data, setData] = useState<ClassicData | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string>("—");

  const load = useCallback(async () => {
    try {
      const [p, l, s, b] = await Promise.all([
        fetch("/api/pulse", { cache: "no-store" }).then((r) => r.json()) as Promise<PulseDTO>,
        fetch("/api/logs?limit=40", { cache: "no-store" }).then((r) => r.json()) as Promise<{ events: WireEvent[] }>,
        fetch("/api/squads", { cache: "no-store" }).then((r) => r.json()) as Promise<{ squads: EntityDTO[] }>,
        fetch("/api/businesses", { cache: "no-store" }).then((r) => r.json()) as Promise<{ businesses: BusinessDTO[] }>,
      ]);
      setData({ pulse: p, events: l.events, squads: s.squads, businesses: b.businesses });
      setUpdatedAt(new Date().toISOString().slice(11, 19));
    } catch {
      /* mantém último snapshot */
    }
  }, []);

  useEffect(() => {
    // primeiro load fora do corpo síncrono do effect; depois, poll de 5s
    const first = setTimeout(() => void load(), 0);
    const id = setInterval(() => void load(), 5000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [load]);

  return (
    <div className="min-h-screen bg-background px-6 py-8 font-sans md:px-10">
      <div className="mx-auto max-w-4xl">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
          <h1 className="text-lg font-semibold tracking-[0.12em] text-foreground">
            NIRVANA GLANCE <span className="font-normal text-muted-foreground">· {t("classic.title")}</span>
          </h1>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span className="font-mono">
              {data ? data.pulse.health.status.toLowerCase() : "…"} · scope: {data?.pulse.health.scope ?? "…"} · allow_actions: {String(data?.pulse.health.allowActions ?? false)}
            </span>
            <button
              type="button"
              onClick={load}
              aria-label={t("classic.refresh")}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-secondary"
            >
              <RefreshCw className="size-3.5" aria-hidden /> {t("classic.refresh")}
            </button>
            <Link href="/" className="text-xs underline decoration-border underline-offset-4 hover:text-foreground">
              {t("classic.modernView")}
            </Link>
          </div>
        </header>

        <section className="mt-6">
          <h2 className="label-caps text-muted-foreground">{t("classic.stats")}</h2>
          <p className="mt-2 font-mono text-sm text-foreground">
            {data
              ? `agents=${data.pulse.stats.agents} · events_today=${fmtInt(data.pulse.stats.eventsToday)} · success_rate=${data.pulse.stats.successRate}% · avg_response=${data.pulse.stats.avgResponseMs}ms · uptime=${data.pulse.stats.uptimePct}%`
              : t("classic.loading")}
          </p>
        </section>

        <section className="mt-8">
          <h2 className="label-caps text-muted-foreground">{t("drawer.gallery.squads")}</h2>
          <table className="mt-2 w-full border border-border text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/40 font-mono text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2 font-medium">{t("classic.name")}</th>
                <th className="px-3 py-2 font-medium">{t("classic.kind")}</th>
                <th className="px-3 py-2 font-medium">{t("classic.status")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("classic.runs")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("classic.lastSeen")} (UTC)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {(data?.squads ?? []).map((e) => (
                <tr key={e.slug}>
                  <td className="px-3 py-2 font-medium text-foreground">{e.name}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{e.kind}</td>
                  <td className="px-3 py-2 font-mono text-xs">{e.status.toLowerCase()}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">{fmtInt(e.runsToday)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">{fmtClock(e.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="mt-8 pb-10">
          <h2 className="label-caps text-muted-foreground">
            {t("classic.events")} ({t("classic.eventsMeta", { at: updatedAt })})
          </h2>
          <ul className="mt-2 space-y-1 font-mono text-xs text-foreground/85">
            {(data?.events ?? []).map((ev) => (
              <li key={ev.id} className="truncate">
                [{fmtMs(ev.ts)}] {ev.status.padEnd(7)} · {ev.kind.padEnd(6)} · {ev.title}
                {ev.detail ? ` — ${ev.detail}` : ""}
              </li>
            ))}
            {!data && <li>{t("classic.loading")}</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
