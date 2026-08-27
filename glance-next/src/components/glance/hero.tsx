"use client";

import { AnimatedNumber } from "@/components/glance/primitives";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { PulseDTO } from "@/lib/types";

/** RF-1 · Hero tipográfico + stat row de 5 métricas. */
export function Hero({ pulse }: { pulse: PulseDTO | null }) {
  const { t } = useI18n();
  const s = pulse?.stats;
  const stats: Array<{ label: string; value: number | null; format: (n: number) => string; sub: string }> = [
    { label: t("hero.stat.agents"), value: s?.agents ?? null, format: (n) => Math.round(n).toString(), sub: t("hero.stat.agentsSub") },
    { label: t("hero.stat.eventsToday"), value: s?.eventsToday ?? null, format: (n) => Math.round(n).toLocaleString("en-US"), sub: t("hero.stat.eventsSub") },
    { label: t("hero.stat.successRate"), value: s?.successRate ?? null, format: (n) => `${n.toFixed(1)}%`, sub: t("hero.stat.successSub") },
    { label: t("hero.stat.avgResponse"), value: s?.avgResponseMs ?? null, format: (n) => `${Math.round(n)}ms`, sub: t("hero.stat.successSub") },
    { label: t("hero.stat.uptime"), value: s?.uptimePct ?? null, format: (n) => `${n.toFixed(2)}%`, sub: t("hero.uptimeLabel") },
  ];

  return (
    <section
      aria-label={t("hero.overview")}
      className="rounded-lg border border-border bg-card p-6 shadow-hairline md:p-10"
    >
      <p className="label-caps text-muted-foreground">{t("hero.overview")}</p>

      <h1 className="mt-5 font-light leading-[1.05] tracking-tight text-foreground text-[42px] md:text-6xl lg:text-[64px]">
        {t("hero.title1")}
        <br />
        {t("hero.title2")}
      </h1>

      <p className="mt-4 text-base text-muted-foreground">{t("hero.subtitle")}</p>

      <div
        className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-3 lg:grid-cols-5"
        role="list"
        aria-label={t("hero.statsAria")}
      >
        {stats.map((stat, i) => (
          <div
            key={stat.label}
            role="listitem"
            className={cn("bg-card p-4 md:p-5", i === 4 && "col-span-2 sm:col-span-2 lg:col-span-1")}
          >
            <p className="label-caps text-muted-foreground">{stat.label}</p>
            {s && stat.value != null ? (
              <AnimatedNumber
                value={stat.value}
                format={stat.format}
                className="mt-2.5 block text-[30px] text-foreground md:text-[34px]"
              />
            ) : (
              <p className="num-display mt-2.5 text-[30px] text-ink-3 md:text-[34px]" aria-hidden>
                {s ? "—" : ""}
              </p>
            )}
            <p className="mt-1.5 text-xs text-muted-foreground">{stat.sub}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
