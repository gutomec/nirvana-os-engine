"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import type { BusinessDTO, EntityDTO, PulseDTO, WireEvent } from "@/lib/types";

const MAX_EVENTS = 150;

/**
 * Fonte única de dados do Glance:
 * - snapshot inicial: /api/pulse + /api/logs + /api/squads + /api/businesses
 * - realtime: SSE /api/events (timeline, timeline-update, pulse)
 * - resume por Last-Event-ID é nativo do EventSource; dedupe por id.
 */
export function useGlance() {
  const { t } = useI18n();
  const [pulse, setPulse] = useState<PulseDTO | null>(null);
  const [events, setEvents] = useState<WireEvent[]>([]);
  const [entities, setEntities] = useState<EntityDTO[]>([]);
  const [businesses, setBusinesses] = useState<BusinessDTO[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seenIds = useRef<Set<number>>(new Set);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;

    (async () => {
      try {
        const [p, l, s, b] = await Promise.all([
          fetch("/api/pulse", { cache: "no-store" }).then((r) => r.json()) as Promise<PulseDTO>,
          fetch("/api/logs?limit=60", { cache: "no-store" }).then((r) => r.json()) as Promise<{ events: WireEvent[] }>,
          fetch("/api/squads", { cache: "no-store" }).then((r) => r.json()) as Promise<{ squads: EntityDTO[] }>,
          fetch("/api/businesses", { cache: "no-store" }).then((r) => r.json()) as Promise<{ businesses: BusinessDTO[] }>,
        ]);
        if (cancelled) return;
        setPulse(p);
        setEntities(s.squads);
        setBusinesses(b.businesses);
        const initial = l.events.slice(0, MAX_EVENTS);
        initial.forEach((e) => seenIds.current.add(e.id));
        setEvents(initial);

        es = new EventSource("/api/events");
        es.onopen = () => setConnected(true);
        es.onerror = () => setConnected(false);
        es.addEventListener("timeline", (e) => {
          const ev = JSON.parse((e as MessageEvent).data) as WireEvent;
          if (seenIds.current.has(ev.id)) return;
          seenIds.current.add(ev.id);
          setEvents((prev) => [ev, ...prev].slice(0, MAX_EVENTS));
        });
        es.addEventListener("timeline-update", (e) => {
          const ev = JSON.parse((e as MessageEvent).data) as WireEvent;
          seenIds.current.add(ev.id);
          setEvents((prev) => prev.map((x) => (x.id === ev.id ? ev : x)));
        });
        es.addEventListener("pulse", (e) => {
          setPulse(JSON.parse((e as MessageEvent).data) as PulseDTO);
        });
      } catch {
        if (!cancelled) setError(t("error.snapshot"));
      }
    })();

    return () => {
      cancelled = true;
      es?.close();
    };
  }, []);

  // Contadores ao vivo das entidades chegam dentro do `pulse` (SSE 10s),
  // então o snapshot /api/squads serve apenas como primeiro render.

  const cancelRun = useCallback(async (id: number) => {
    try {
      const res = await fetch(`/api/events/${id}/cancel`, { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; hint?: string };
      if (res.ok) {
        setEvents((prev) =>
          prev.map((x) => {
            if (x.id !== id || x.cancelled) return x; // SSE timeline-update é a fonte da verdade
            return {
              ...x,
              status: "FAILED",
              cancelled: true,
              detail: x.detail ? `${x.detail} — cancelado pelo operador` : "cancelado pelo operador",
            };
          })
        );
      }
      return { ok: res.ok, ...json };
    } catch {
      return { ok: false, hint: t("error.cancelNetwork") };
    }
  }, [t]);

  return { pulse, events, entities, businesses, connected, error, cancelRun };
}
