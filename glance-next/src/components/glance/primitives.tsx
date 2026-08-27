"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { badgeClass, dotClass } from "@/lib/format";
import type { EventStatus } from "@/lib/types";

/** Número display com tween de 400ms (RF-1 — contadores tickam). */
export function AnimatedNumber({
  value,
  format,
  className,
}: {
  value: number;
  format?: (n: number) => string;
  className?: string;
}) {
  const [display, setDisplay] = useState(value);
  const prevRef = useRef(value);

  useEffect(() => {
    const from = prevRef.current;
    const to = value;
    prevRef.current = value;
    if (from === to) return;
    const start = performance.now();
    const duration = 400;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (to - from) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  const fmt = format ?? ((n: number) => Math.round(n).toLocaleString("en-US"));
  return (
    <span className={cn("num-display tabular-nums", className)} suppressHydrationWarning>
      {fmt(display)}
    </span>
  );
}

/** Dot de status do RF-4: ● success · ○ info · ◐ warning · ◉ failed */
export function StatusDot({ status, className }: { status: EventStatus; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full", dotClass(status), className)}
    />
  );
}

/** Badge outline do RF-4: SUCCESS / INFO / WARNING / FAILED */
export function StatusBadge({ status, className }: { status: EventStatus; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase leading-none tracking-[0.06em]",
        badgeClass(status),
        className
      )}
    >
      {status}
    </span>
  );
}

/** Dot de status de entidade (OPERATIONAL/IDLE/DEGRADED/OFFLINE) */
export function entityDotClass(status: string): string {
  switch (status) {
    case "OPERATIONAL":
      return "bg-success";
    case "IDLE":
      return "border-2 border-warning bg-transparent";
    case "DEGRADED":
      return "bg-warning dot-pulse";
    default:
      return "border-2 border-ink-3 bg-transparent";
  }
}

/** Dot de subsistema do tier 3 (OK/IDLE/OFF/CHECKED) */
export function subsystemDotClass(status: string): string {
  switch (status) {
    case "OK":
      return "bg-success";
    case "IDLE":
      return "border-2 border-warning bg-transparent";
    case "OFF":
      return "border-2 border-ink-3 bg-transparent";
    case "CHECKED":
      return "border border-success bg-success/25";
    default:
      return "bg-ink-3";
  }
}
