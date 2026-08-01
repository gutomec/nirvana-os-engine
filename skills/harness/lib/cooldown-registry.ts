// cooldown-registry.ts — per-project record of which runtimes are temporarily
// unavailable and when they unlock. Sole consumer: the cascade resolver.
//
// File: <projectRoot>/.nirvana/state/runtime-cooldowns.json
// Shape:
//   { "claude-code": { until_iso: "2026-05-23T18:30:00Z", reason: "weekly cap" }, ... }
//
// Why per-project: a Claude 5h window in project A doesn't make claude-code
// unusable in project B if the user happens to have a different account, but
// the common case (one OAuth login) means the cooldown effectively applies
// account-wide. We pin to the project to keep state self-contained — if you
// want global cooldowns, set NIRVANA_COOLDOWN_FILE.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Runtime } from "./host-agent-driver.ts";

interface CooldownEntry {
  until_iso: string;
  reason: string;
  set_at_iso: string;
  window: string;
}
type Registry = Partial<Record<Runtime, CooldownEntry>>;

function fileFor(projectRoot: string): string {
  if (process.env.NIRVANA_COOLDOWN_FILE) return path.resolve(process.env.NIRVANA_COOLDOWN_FILE);
  return path.join(projectRoot, ".nirvana", "state", "runtime-cooldowns.json");
}

function load(projectRoot: string): Registry {
  const f = fileFor(projectRoot);
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, "utf8")) as Registry; }
  catch { return {}; }
}

function save(projectRoot: string, reg: Registry): void {
  const f = fileFor(projectRoot);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(reg, null, 2));
}

export function markCooldown(projectRoot: string, runtime: Runtime, ttlSec: number, reason: string, window: string = "unknown"): void {
  const reg = load(projectRoot);
  const now = new Date();
  reg[runtime] = {
    until_iso: new Date(now.getTime() + ttlSec * 1000).toISOString(),
    reason,
    set_at_iso: now.toISOString(),
    window,
  };
  save(projectRoot, reg);
}

export function clearCooldown(projectRoot: string, runtime: Runtime): void {
  const reg = load(projectRoot);
  if (reg[runtime]) {
    delete reg[runtime];
    save(projectRoot, reg);
  }
}

export function isInCooldown(projectRoot: string, runtime: Runtime, now: Date = new Date()): boolean {
  const reg = load(projectRoot);
  const e = reg[runtime];
  if (!e) return false;
  return new Date(e.until_iso).getTime() > now.getTime();
}

export function getCooldown(projectRoot: string, runtime: Runtime): CooldownEntry | null {
  const reg = load(projectRoot);
  return reg[runtime] ?? null;
}

export function listActive(projectRoot: string, now: Date = new Date()): Array<{ runtime: Runtime } & CooldownEntry> {
  const reg = load(projectRoot);
  return (Object.entries(reg) as [Runtime, CooldownEntry][])
    .filter(([, e]) => new Date(e.until_iso).getTime() > now.getTime())
    .map(([runtime, e]) => ({ runtime, ...e }));
}
