import type { EventStatus } from "@/lib/types";

/** 16:42:31 (UTC) · null = indisponível (modo engine) → "—" */
export function fmtClock(d: Date | string | null | undefined): string {
  if (d == null) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}`;
}

/** 16:42:28.531 (UTC, com milissegundos) */
export function fmtMs(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  return `${fmtClock(dt)}.${String(dt.getUTCMilliseconds()).padStart(3, "0")}`;
}

/** 1,248 · null = indisponível (modo engine) → "—" */
export function fmtInt(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString("en-US");
}

/** duração legível: 842ms · 18.4s */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Classes do dot de status conforme RF-4 (● ○ ◐ ◉) */
export function dotClass(status: EventStatus): string {
  switch (status) {
    case "SUCCESS":
      return "bg-success";
    case "INFO":
      return "border-2 border-ink-3 bg-transparent";
    case "WARNING":
      return "bg-warning dot-pulse";
    case "FAILED":
      return "bg-danger ring-2 ring-danger/25";
  }
}

/** Classes do badge outline conforme RF-4 */
export function badgeClass(status: EventStatus): string {
  switch (status) {
    case "SUCCESS":
      return "text-success border-success/35 bg-success/5";
    case "INFO":
      return "text-ink-3 border-border bg-transparent";
    case "WARNING":
      return "text-warning border-warning/40 bg-warning/5";
    case "FAILED":
      return "text-danger border-danger/40 bg-danger/5";
  }
}
