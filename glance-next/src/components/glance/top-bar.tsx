"use client";

import { useEffect, useState } from "react";
import { Eye, Moon, Search, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useI18n } from "@/lib/i18n/provider";
import { fmtClock } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { HealthDTO } from "@/lib/types";

interface TopBarProps {
  health: HealthDTO | null;
  connected: boolean;
  onCycleScope: () => void;
  onOpenPalette: () => void;
}

export function TopBar({ health, connected, onCycleScope, onOpenPalette }: TopBarProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const { t } = useI18n();
  // inicialização lazy + suppressHydrationWarning no <time>
  const [clock, setClock] = useState<string>(() => fmtClock(new Date()));

  useEffect(() => {
    const id = setInterval(() => setClock(fmtClock(new Date())), 1000);
    return () => clearInterval(id);
  }, []);

  const status = connected ? (health?.status ?? "OPERATIONAL") : "CONNECTING";
  const statusDot =
    !connected ? "bg-ink-3" : status === "OPERATIONAL" ? "bg-success" : "bg-warning";

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
      <div className="flex h-14 items-center gap-3 px-4 md:px-6">
        <div className="flex items-center gap-2.5" aria-label="Nirvana Glance">
          <Eye className="size-[18px] text-foreground" strokeWidth={2} aria-hidden />
          <span className="text-[12px] font-semibold tracking-[0.14em] text-foreground whitespace-nowrap md:text-[13px]">
            NIRVANA GLANCE
          </span>
        </div>

        <div className="ml-auto flex items-center gap-3 md:gap-4">
          {/* Fonte de dados (transparência do modo engine) */}
          {health?.source === "engine" && (
            <span
              title={t("source.hint", { source: t("source.engine") })}
              className="label-caps hidden items-center gap-1.5 rounded-full border border-success/30 bg-success/5 px-2.5 py-1 text-success md:inline-flex"
            >
              <span className="inline-block size-1.5 rounded-full bg-success" aria-hidden />
              {t("source.engine")}
            </span>
          )}

          {/* Scope indicator (RF-2): chip clicável project ⇄ global */}
          <button
            type="button"
            onClick={onCycleScope}
            title={t("topbar.scopeAria")}
            aria-label={t("topbar.scopeAria")}
            className="label-caps hidden rounded-full border border-border px-2.5 py-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground sm:inline-flex"
          >
            scope: {health?.scope ?? "…"}
          </button>

          <div className="flex items-center gap-2" role="status" aria-live="polite" aria-label={t("topbar.statusAria")}>
            <span
              className={cn(
                "inline-block size-2 rounded-full",
                statusDot,
                status === "OPERATIONAL" && connected && "dot-pulse text-success"
              )}
              aria-hidden
            />
            <span className="label-caps text-foreground/75">{status}</span>
          </div>

          <span className="hidden h-4 w-px bg-border md:block" aria-hidden />

          <time
            suppressHydrationWarning
            aria-label={t("topbar.clockAria")}
            className="hidden font-mono text-[13px] tabular-nums text-muted-foreground md:block"
          >
            {clock} UTC
          </time>

          <span className="hidden h-4 w-px bg-border md:block" aria-hidden />

          {/* Command palette (⌘K) — gatilho discreto */}
          <button
            type="button"
            onClick={onOpenPalette}
            aria-label={t("palette.openAria")}
            title={t("palette.openAria")}
            className="hidden h-9 items-center gap-2 rounded-lg border border-border px-2.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:inline-flex"
          >
            <Search className="size-4" aria-hidden />
            <kbd className="font-mono text-[11px] leading-none tracking-wide">⌘K</kbd>
          </button>

          <button
            type="button"
            onClick={() => setTheme(resolvedTheme === "apple-dark" ? "clean-light" : "apple-dark")}
            aria-label={t("topbar.themeAria")}
            className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Sun className="size-[18px] dark:hidden" aria-hidden />
            <Moon className="hidden size-[18px] dark:block" aria-hidden />
          </button>
        </div>
      </div>
    </header>
  );
}
