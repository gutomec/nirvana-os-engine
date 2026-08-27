"use client";

import { useEffect } from "react";
import {
  Archive,
  Languages,
  Moon,
  Sun,
} from "lucide-react";
import { useTheme } from "next-themes";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { useI18n } from "@/lib/i18n/provider";
import { RAIL_ITEMS, type RailId } from "@/components/glance/icon-rail";

/**
 * Command palette (⌘K / Ctrl+K) — item pendente do M2 do PRD v2.0.
 * Navegação pelas 6 seções do rail + preferências (idioma/tema) + visão clássica.
 * Zero novos endpoints: apenas ações de UI já existentes, centralizadas.
 */
export function CommandPalette({
  open,
  onOpenChange,
  onNavigate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (id: RailId) => void;
}) {
  const { t, locale, setLocale } = useI18n();
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === "apple-dark";

  // Atalho global ⌘K / Ctrl+K (re-registra por abertura — fechamento por Esc é do Dialog).
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [open, onOpenChange]);

  const run = (action: () => void) => () => {
    onOpenChange(false);
    action();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("palette.title")}
      description={t("palette.subtitle")}
      showCloseButton={false}
    >
      <CommandInput placeholder={t("palette.placeholder")} />
      <CommandList>
        <CommandEmpty>{t("palette.empty")}</CommandEmpty>

        <CommandGroup heading={t("palette.groupNav")}>
          {RAIL_ITEMS.map(({ id, labelKey, icon: Icon }) => (
            <CommandItem
              key={id}
              value={`navigate ${id}`}
              onSelect={run(() => onNavigate(id))}
            >
              <Icon aria-hidden />
              {t(labelKey)}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading={t("palette.groupPrefs")}>
          <CommandItem
            value="theme light"
            disabled={!isDark}
            onSelect={run(() => setTheme("clean-light"))}
          >
            <Sun aria-hidden />
            {t("palette.themeLight")}
          </CommandItem>
          <CommandItem
            value="theme dark"
            disabled={isDark}
            onSelect={run(() => setTheme("apple-dark"))}
          >
            <Moon aria-hidden />
            {t("palette.themeDark")}
          </CommandItem>
          <CommandItem
            value="language english"
            disabled={locale === "en"}
            onSelect={run(() => setLocale("en"))}
          >
            <Languages aria-hidden />
            {t("palette.langEn")}
          </CommandItem>
          <CommandItem
            value="language portugues"
            disabled={locale === "pt-BR"}
            onSelect={run(() => setLocale("pt-BR"))}
          >
            <Languages aria-hidden />
            {t("palette.langPt")}
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading={t("palette.groupViews")}>
          <CommandItem
            value="classic view"
            onSelect={run(() => window.location.assign("/?view=classic"))}
          >
            <Archive aria-hidden />
            {t("palette.classic")}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
