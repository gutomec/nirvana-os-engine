"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  DICTIONARIES,
  LOCALE_STORAGE_KEY,
  detectLocale,
  interpolate,
  type Dictionary,
  type Locale,
} from "@/lib/i18n/dictionaries";

// ─── Store externo (compatível com SSR, sem setState em effect) ─────────────

let currentLocale: Locale | null = null; // null = ainda não detectado no cliente
const listeners = new Set<() => void>();

function notify() {
  for (const cb of listeners) cb();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Snapshot do cliente: detecta na 1ª leitura (localStorage → navegador). */
function getClientSnapshot(): Locale {
  if (currentLocale === null) currentLocale = detectLocale();
  return currentLocale;
}

/** Snapshot do servidor: inglês (canônico do PRD) — sem mismatch de hidratação. */
function getServerSnapshot(): Locale {
  return "en";
}

function persistLocale(next: Locale) {
  currentLocale = next;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    /* storage indisponível — segue em memória */
  }
  notify();
}

type I18nContextValue = {
  locale: Locale;
  /** Traduz uma chave; params interpolam {placeholders}. */
  t: (key: keyof Dictionary, params?: Record<string, string | number>) => string;
  setLocale: (locale: Locale) => void;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const locale = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);

  useEffect(() => {
    document.documentElement.lang = locale === "pt-BR" ? "pt-BR" : "en";
  }, [locale]);

  const setLocale = useCallback((next: Locale) => persistLocale(next), []);

  const t = useCallback(
    (key: keyof Dictionary, params?: Record<string, string | number>) =>
      interpolate(DICTIONARIES[locale][key] ?? DICTIONARIES.en[key] ?? key, params),
    [locale]
  );

  const value = useMemo(() => ({ locale, t, setLocale }), [locale, t, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n deve ser usado dentro de <I18nProvider>");
  return ctx;
}
