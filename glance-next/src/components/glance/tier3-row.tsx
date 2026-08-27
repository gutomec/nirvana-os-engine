"use client";

import { subsystemDotClass } from "@/components/glance/primitives";
import { useI18n } from "@/lib/i18n/provider";
import { fmtClock } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SubsystemDTO } from "@/lib/types";

/** RF-7 · Tier 3 — saúde dos subsistemas do engine (decisão Q2: recomendado). */
export function Tier3Row({ subsystems }: { subsystems: SubsystemDTO[] }) {
  const { t } = useI18n();
  return (
    <section
      aria-label={t("tier3.title")}
      className="overflow-hidden rounded-lg border border-border bg-card shadow-hairline"
    >
      <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4 xl:grid-cols-8">
        {subsystems.length === 0
          ? Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="min-h-[124px] animate-pulse bg-card" />
            ))
          : subsystems.map((s) => (
              <div key={s.name} className="min-h-[124px] bg-card p-4">
                <p className="label-caps truncate text-muted-foreground" title={s.name}>
                  {s.name}
                </p>
                <p className="mt-2.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-foreground/80">
                  <span
                    className={cn("inline-block size-2 shrink-0 rounded-full", subsystemDotClass(s.status))}
                    aria-hidden
                  />
                  {s.status}
                </p>
                <p className="mt-2 truncate font-mono text-xs text-foreground/85" title={s.value}>
                  {s.value}
                </p>
                <p className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">
                  {fmtClock(s.lastCheckAt)}
                </p>
              </div>
            ))}
      </div>
    </section>
  );
}
