"use client";

import { EntityIcon } from "@/components/glance/entity-icon";
import { entityDotClass } from "@/components/glance/primitives";
import { useI18n } from "@/lib/i18n/provider";
import { fmtClock, fmtInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { EntityDTO } from "@/lib/types";

interface EntityColumnProps {
  entities: EntityDTO[];
  onSelect: (slug: string) => void;
}

/** RF-5 · Coluna "Agent Entities" — cards verticais com runs hoje + last seen. */
export function EntityColumn({ entities, onSelect }: EntityColumnProps) {
  const { t } = useI18n();
  const cards = entities.filter((e) => e.kind !== "WORKFLOW");

  return (
    <section
      aria-label={t("entities.title")}
      className="flex flex-col rounded-lg border border-border bg-card shadow-hairline"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h2 className="label-caps text-foreground/80">{t("entities.title")}</h2>
        <span className="label-caps text-muted-foreground">{cards.length}</span>
      </header>

      <div className="scroll-slim max-h-[560px] space-y-3 overflow-y-auto p-4">
        {cards.length === 0
          ? Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-[72px] animate-pulse rounded-lg border border-border bg-secondary/40" />
            ))
          : cards.map((e) => <EntityCard key={e.slug} entity={e} onSelect={onSelect} />)}
      </div>
    </section>
  );
}

export function EntityCard({ entity, onSelect }: { entity: EntityDTO; onSelect: (slug: string) => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={() => onSelect(entity.slug)}
      aria-label={t("entities.openAria", { name: entity.name })}
      className="group flex w-full items-center gap-3.5 rounded-lg border border-border bg-card p-4 text-left transition-shadow hover:shadow-hairline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-foreground/80 transition-colors group-hover:text-foreground">
        <EntityIcon name={entity.icon} className="size-[18px]" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{entity.name}</span>
        <span className="label-caps mt-1.5 flex items-center gap-1.5 text-muted-foreground">
          <span className={cn("inline-block size-1.5 shrink-0 rounded-full", entityDotClass(entity.status))} aria-hidden />
          {entity.status}
        </span>
      </span>

      <span className="shrink-0 text-right">
        <span className="num-display block text-[26px] text-foreground md:text-[28px]">
          {fmtInt(entity.runsToday)}
        </span>
        <span className="mt-0.5 block font-mono text-[11px] tabular-nums text-muted-foreground">
          {t("entities.lastSeen")} {fmtClock(entity.lastSeenAt)}
        </span>
      </span>
    </button>
  );
}
