"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  ChevronRight,
  Languages,
  LayoutGrid,
  List,
  Lock,
  Menu,
  Moon,
  Settings,
  Sun,
  Users,
} from "lucide-react";
import { useTheme } from "next-themes";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useI18n } from "@/lib/i18n/provider";
import { LOCALES, type Dictionary, type Locale } from "@/lib/i18n/dictionaries";
import { cn } from "@/lib/utils";

export type RailId = "overview" | "entities" | "timeline" | "projects" | "settings" | "permissions";

export const RAIL_ITEMS: Array<{ id: RailId; labelKey: keyof Dictionary; icon: typeof LayoutGrid }> = [
  { id: "overview", labelKey: "rail.overview", icon: LayoutGrid },
  { id: "entities", labelKey: "rail.entities", icon: Users },
  { id: "timeline", labelKey: "rail.timeline", icon: List },
  { id: "projects", labelKey: "rail.projects", icon: Box },
  { id: "settings", labelKey: "rail.settings", icon: Settings },
  { id: "permissions", labelKey: "rail.permissions", icon: Lock },
];

const LOCALE_LABEL: Record<Locale, string> = { en: "EN", "pt-BR": "PT" };

/** Linha de idioma: segmented EN | PT (compacto no flyout, touch no Sheet). */
function LocaleRow({ compact = false }: { compact?: boolean }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <div>
      <p className="label-caps flex items-center gap-1.5 px-1 text-muted-foreground">
        <Languages className="size-3" aria-hidden />
        {t("rail.language")}
      </p>
      <div className="mt-1.5 flex rounded-md border border-border bg-background p-0.5">
        {LOCALES.map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => setLocale(l)}
            aria-pressed={locale === l}
            className={cn(
              "flex-1 rounded-[5px] font-medium transition-colors",
              compact ? "h-7 text-[11px]" : "h-10 text-xs",
              locale === l ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {LOCALE_LABEL[l]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Linha de tema: segmented clean-light | apple-dark (compacto no flyout, touch no Sheet). */
function ThemeRow({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === "apple-dark";
  return (
    <div>
      <p className="label-caps flex items-center gap-1.5 px-1 text-muted-foreground">
        <Sun className="size-3 dark:hidden" aria-hidden />
        <Moon className="hidden size-3 dark:block" aria-hidden />
        {t("rail.theme")}
      </p>
      <div className="mt-1.5 flex rounded-md border border-border bg-background p-0.5">
        <button
          type="button"
          onClick={() => setTheme("clean-light")}
          aria-pressed={!isDark}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded-[5px] font-medium transition-colors",
            compact ? "h-7 text-[11px]" : "h-10 text-xs",
            !isDark ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          <Sun className="size-3" aria-hidden /> Light
        </button>
        <button
          type="button"
          onClick={() => setTheme("apple-dark")}
          aria-pressed={isDark}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded-[5px] font-medium transition-colors",
            compact ? "h-7 text-[11px]" : "h-10 text-xs",
            isDark ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          <Moon className="size-3" aria-hidden /> Dark
        </button>
      </div>
    </div>
  );
}

/**
 * Rail "sumido" (RF-3 + menu lateral suspenso discreto):
 * - Desktop (md+): por padrão o rail fica totalmente recolhido fora da tela —
 *   sobra apenas uma micro-afordância na borda esquerda (fio vertical com 3
 *   pontos). Revela em hover na borda (com micro-delay de intenção), foco via
 *   teclado, clique na affordance (fixa/pin) ou no chevron. Retrai ao sair,
 *   a menos que esteja fixado. O flyout de 208px continua deslizando à direita.
 * - Mobile (<md): botão flutuante redondo acima do AskBar abre um Sheet à esquerda.
 * Mesma linguagem visual: hairline, sem gradiente, 200ms, motion-reduce respeitado.
 */
export function IconRail({
  active,
  onSelect,
  onRevealedChange,
  badges,
}: {
  active: RailId;
  onSelect: (id: RailId) => void;
  onRevealedChange?: (revealed: boolean) => void;
  /** Atividade viva: dot no ícone (timeline = pulso verde, settings = gated âmbar). */
  badges?: Partial<Record<RailId, boolean>>;
}) {
  const { t } = useI18n();
  const [hoverOpen, setHoverOpen] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const enterTimer = useRef<number | null>(null);
  const leaveTimer = useRef<number | null>(null);

  const open = hoverOpen || pinnedOpen || focusOpen;

  // Avisa o shell para deslizar o conteúdo junto (padding-left 200ms).
  useEffect(() => {
    onRevealedChange?.(open);
  }, [open, onRevealedChange]);

  useEffect(() => {
    return () => {
      if (enterTimer.current) window.clearTimeout(enterTimer.current);
      if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
    };
  }, []);

  const closeAll = useCallback(() => {
    setHoverOpen(false);
    setPinnedOpen(false);
    setFocusOpen(false);
  }, []);

  // Hover com micro-delay de intenção (evita abertura em roçadas acidentais).
  const handleEnter = useCallback(() => {
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
    if (enterTimer.current) window.clearTimeout(enterTimer.current);
    enterTimer.current = window.setTimeout(() => setHoverOpen(true), 110);
  }, []);

  // Pequena graça na saída: atravessar para o flyout/conteúdo não fecha com flicker.
  const handleLeave = useCallback(() => {
    if (enterTimer.current) window.clearTimeout(enterTimer.current);
    leaveTimer.current = window.setTimeout(() => setHoverOpen(false), 90);
  }, []);

  const choose = (id: RailId) => {
    onSelect(id);
    closeAll();
    setSheetOpen(false);
  };

  return (
    <>
      {/* ── Desktop (md+): trilho sumido + affordance de borda + flyout ── */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-50 transition-[width] duration-200 ease-out motion-reduce:transition-none",
          open ? "w-14 md:w-16" : "w-2"
        )}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        onFocus={() => setFocusOpen(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            closeAll();
            if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          }
        }}
      >
        {/* Micro-afordância: fio com 3 pontos, some quando aberto */}
        <button
          type="button"
          onClick={() => setPinnedOpen((v) => !v)}
          aria-label={t("rail.openMenu")}
          title={t("rail.openMenu")}
          className={cn(
            "absolute left-0 top-1/2 z-10 hidden h-20 w-3 -translate-y-1/2 items-center rounded-r-md",
            "transition-opacity duration-200 motion-reduce:transition-none",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:flex",
            open && "pointer-events-none opacity-0"
          )}
        >
          <span
            aria-hidden
            className="mx-auto flex h-14 w-[2px] flex-col items-center justify-center gap-[5px] rounded-full bg-border"
          >
            <span className="size-[3px] rounded-full bg-muted-foreground/45" />
            <span className="size-[3px] rounded-full bg-muted-foreground/45" />
            <span className="size-[3px] rounded-full bg-muted-foreground/45" />
          </span>
        </button>

        <nav
          aria-label={t("rail.menu")}
          className={cn(
            "absolute inset-y-0 left-0 flex h-full w-14 flex-col items-center gap-1 border-r border-border bg-card py-3 transition-transform duration-200 ease-out motion-reduce:transition-none md:w-16",
            open ? "translate-x-0" : "-translate-x-full"
          )}
        >
          {RAIL_ITEMS.map(({ id, labelKey, icon: Icon }) => {
            const isActive = active === id;
            const badge = badges?.[id];
            return (
              <button
                key={id}
                type="button"
                onClick={() => choose(id)}
                aria-label={t(labelKey)}
                aria-current={isActive ? "true" : undefined}
                className={cn(
                  "relative flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  isActive && "bg-secondary text-foreground"
                )}
              >
                <Icon className="size-[18px]" aria-hidden />
                {badge && (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute right-1.5 top-1.5 size-1.5 rounded-full",
                      id === "timeline" ? "bg-success dot-pulse" : "bg-warning"
                    )}
                  />
                )}
              </button>
            );
          })}
          <div className="mt-auto pt-1">
            <button
              type="button"
              onClick={() => setPinnedOpen((v) => !v)}
              aria-pressed={pinnedOpen}
              aria-label={pinnedOpen ? t("rail.unpinMenu") : t("rail.pinMenu")}
              className="hidden size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:flex"
            >
              <ChevronRight
                className={cn("size-4 transition-transform duration-200", open && "rotate-180")}
                aria-hidden
              />
            </button>
          </div>
        </nav>

        {/* Flyout: painel suspenso com navegação + idioma/tema */}
        <div
          role="menu"
          aria-label={t("rail.menu")}
          className={cn(
            "absolute left-full top-3 z-50 hidden w-52 rounded-lg border border-border bg-card p-2 shadow-hairline transition-all duration-200 ease-out md:block",
            open
              ? "pointer-events-auto translate-x-0 opacity-100"
              : "pointer-events-none -translate-x-1.5 opacity-0"
          )}
        >
          {RAIL_ITEMS.map(({ id, labelKey, icon: Icon }) => {
            const isActive = active === id;
            return (
              <button
                key={id}
                type="button"
                role="menuitem"
                onClick={() => choose(id)}
                aria-current={isActive ? "true" : undefined}
                className={cn(
                  "flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
                  isActive && "bg-secondary text-foreground"
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                {t(labelKey)}
              </button>
            );
          })}
          <div className="mt-2 space-y-2.5 border-t border-border pt-2.5">
            <LocaleRow compact />
            <ThemeRow compact />
          </div>
        </div>
      </div>

      {/* ── Mobile (<md): botão flutuante discreto acima do AskBar ── */}
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        aria-label={t("rail.openMenu")}
        className="fixed bottom-[calc(6.75rem+env(safe-area-inset-bottom))] left-2 z-50 flex size-10 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-hairline transition-colors hover:bg-secondary md:hidden"
      >
        <Menu className="size-[18px]" aria-hidden />
      </button>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="left" className="w-72 gap-0">
          <SheetHeader className="sr-only">
            <SheetTitle>{t("rail.menu")}</SheetTitle>
            <SheetDescription>{t("rail.menu")}</SheetDescription>
          </SheetHeader>
          <nav aria-label={t("rail.menu")} className="flex flex-col gap-1 p-3">
            {RAIL_ITEMS.map(({ id, labelKey, icon: Icon }) => {
              const isActive = active === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => choose(id)}
                  aria-current={isActive ? "true" : undefined}
                  className={cn(
                    "flex h-11 items-center gap-3 rounded-lg px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
                    isActive && "bg-secondary text-foreground"
                  )}
                >
                  <Icon className="size-[18px] shrink-0" aria-hidden />
                  {t(labelKey)}
                </button>
              );
            })}
          </nav>
          <div className="mt-auto space-y-3 border-t border-border p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <LocaleRow />
            <ThemeRow />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
