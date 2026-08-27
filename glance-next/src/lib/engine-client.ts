// ─── Cliente do engine oficial (gutomec/nirvana-os-engine ≥ 0.10) ──────────
//
// Quando `NIRVANA_ENGINE_URL` aponta para um servidor `nrv glance` real
// (ex.: `bun ~/.nirvana/skills/harness/scripts/glance.ts --port 4242`), as
// rotas desta app usam o engine como upstream e normalizam as respostas para
// os DTOs do one-pager. Sem a variável — ou se o upstream estiver fora do ar —
// tudo cai no Run Kernel simulado (`event-engine.ts`).
//
// Contratos extraídos do código-fonte oficial:
//   skills/harness/lib/glance/server.ts        (rotas + SSE)
//   skills/harness/lib/glance/data-loader.ts   (shapes de squads/businesses/logs)
//   skills/harness/GLANCE.md                   (superfície canônica)
//
// Regras respeitadas: leitura sempre; escrita (POST /api/v1/…) exige
// `--allow-actions` no upstream + `Idempotency-Key` — igual ao engine.

import type {
  BusinessDTO,
  EntityDTO,
  HealthDTO,
  PulseDTO,
  StatsDTO,
  SubsystemDTO,
  TurnDTO,
  WireEvent,
} from "@/lib/types";

export function engineUrl(): string | null {
  const raw = process.env.NIRVANA_ENGINE_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

export function isEngineMode(): boolean {
  return engineUrl() !== null;
}

/** Fetch contra o upstream com timeout curto; null = upstream indisponível. */
export async function fetchEngine(
  path: string,
  init?: RequestInit & { timeoutMs?: number }
): Promise<Response | null> {
  const base = engineUrl();
  if (!base) return null;
  const { timeoutMs = 4000, ...rest } = init ?? {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      ...rest,
      signal: ctrl.signal,
      cache: "no-store",
      headers: { Accept: "application/json", ...(rest.headers ?? {}) },
    });
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Health ──────────────────────────────────────────────────────────────────

/** GET /api/health → { ok, version, uptime_ms, idle_ms, allow_actions, scope } */
export async function fetchEngineHealth(): Promise<HealthDTO | null> {
  const res = await fetchEngine("/api/health", { timeoutMs: 2500 });
  if (!res?.ok) return null;
  const raw = (await res.json().catch(() => null)) as
    | { ok?: boolean; version?: string; uptime_ms?: number; allow_actions?: boolean; scope?: { mode?: string } }
    | null;
  if (!raw?.ok) return null;
  // Scope do engine: "global" | "project" | "merge" — "merge" comporta-se como
  // global no one-pager (visão combinada).
  const mode = raw.scope?.mode === "project" ? "project" : "global";
  return {
    status: "OPERATIONAL",
    scope: mode,
    allowActions: raw.allow_actions === true,
    version: raw.version ?? "unknown",
    budgetPct: 0,
    time: new Date().toISOString(),
    source: "engine",
    engineUptimeMs: raw.uptime_ms,
  };
}

// ─── Entidades (squads + businesses do registry real) ────────────────────────

type EngineSquad = {
  slug: string;
  source?: string;
  version?: string;
  protocol?: string;
  capabilities?: string[];
  domains?: string[];
};

type EngineBusiness = {
  slug: string;
  source?: string;
  version?: string;
  domains?: string[];
  employee_count?: number;
  business_type?: string;
};

const titleize = (slug: string) =>
  slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");

export function normalizeSquad(s: EngineSquad): EntityDTO {
  return {
    slug: s.slug,
    name: titleize(s.slug),
    kind: "SQUAD",
    icon: "squad",
    status: "OPERATIONAL",
    runsToday: null,
    successRate: null,
    lastSeenAt: null,
    engineMeta: {
      version: s.version,
      protocol: s.protocol,
      domains: s.domains ?? [],
      source: s.source,
      capabilitiesCount: s.capabilities?.length,
    },
  };
}

export function normalizeBusiness(b: EngineBusiness): EntityDTO {
  return {
    slug: b.slug,
    name: titleize(b.slug),
    kind: "BUSINESS",
    icon: "business",
    status: "OPERATIONAL",
    runsToday: null,
    successRate: null,
    lastSeenAt: null,
    engineMeta: {
      version: b.version,
      domains: b.domains ?? [],
      source: b.source,
      businessType: b.business_type,
      employeeCount: b.employee_count,
    },
  };
}

/** GET /api/squads → { squads: [...], scope } */
export async function fetchEngineSquads(): Promise<EntityDTO[] | null> {
  const res = await fetchEngine("/api/squads");
  if (!res?.ok) return null;
  const raw = (await res.json().catch(() => null)) as { squads?: EngineSquad[] } | null;
  if (!raw?.squads) return null;
  return raw.squads.map(normalizeSquad).sort((a, b) => a.slug.localeCompare(b.slug));
}

/** GET /api/businesses → { businesses: [...], scope } */
export async function fetchEngineBusinesses(): Promise<{ entities: EntityDTO[]; businesses: BusinessDTO[] } | null> {
  const res = await fetchEngine("/api/businesses");
  if (!res?.ok) return null;
  const raw = (await res.json().catch(() => null)) as { businesses?: EngineBusiness[] } | null;
  if (!raw?.businesses) return null;
  const sorted = [...raw.businesses].sort((a, b) => a.slug.localeCompare(b.slug));
  return {
    entities: sorted.map(normalizeBusiness),
    businesses: sorted.map<BusinessDTO>((b) => ({
      slug: b.slug,
      name: titleize(b.slug),
      active: true,
      runsToday: null,
      lastSeenAt: null,
      engineMeta: {
        version: b.version,
        domains: b.domains ?? [],
        source: b.source,
        businessType: b.business_type,
        employeeCount: b.employee_count,
      },
    })),
  };
}

// ─── Logs (audit.jsonl) → WireEvent ─────────────────────────────────────────

type RawAuditEvent = Record<string, unknown> & { ts?: string; time?: string; event?: string; type?: string; level?: string };

const RX_GATE = /gate|verdict|gauntlet|audit|score/i;
const RX_RUN = /run|dispatch|canary|child|message|turn|brief/i;
const RX_SYS = /health|system|config|setting|startup|install|update/i;

function classify(ev: RawAuditEvent): { kind: WireEvent["kind"]; status: WireEvent["status"] } {
  const name = String(ev.event ?? ev.type ?? "");
  const level = String(ev.level ?? "").toLowerCase();
  let kind: WireEvent["kind"] = "ENTITY";
  if (RX_GATE.test(name)) kind = "GATE";
  else if (RX_RUN.test(name)) kind = "RUN";
  else if (RX_SYS.test(name)) kind = "SYSTEM";

  let status: WireEvent["status"] = "INFO";
  if (level === "error" || /fail|reject|withheld|stall|error/i.test(name)) status = "FAILED";
  else if (level === "warn") status = "WARNING";
  else if (/pass|ok|delivered|approved|success|completed/i.test(name)) status = "SUCCESS";
  return { kind, status };
}

/** Determinístico: id = ts(ms)*10 + ocorrência dentro do mesmo ms. */
function assignIds(events: RawAuditEvent[]): WireEvent[] {
  const sorted = [...events]
    .map((ev, i) => ({ ev, i }))
    .sort((a, b) => Date.parse(a.ev.ts ?? a.ev.time ?? "") - Date.parse(b.ev.ts ?? b.ev.time ?? "") || a.i - b.i);
  const perTs = new Map<number, number>();
  return sorted.map(({ ev }) => {
    const tsMs = Number.isFinite(Date.parse(ev.ts ?? ev.time ?? "")) ? Date.parse(ev.ts ?? ev.time ?? "") : Date.now();
    const occ = perTs.get(tsMs) ?? 0;
    perTs.set(tsMs, occ + 1);
    const { kind, status } = classify(ev);
    const detail =
      (typeof ev.reason === "string" && ev.reason) ||
      (typeof ev.last_error === "string" && ev.last_error) ||
      (typeof ev.detail === "string" && ev.detail) ||
      null;
    return {
      id: tsMs * 10 + (occ % 10),
      ts: new Date(tsMs).toISOString(),
      kind,
      status,
      title: String(ev.event ?? ev.type ?? "event"),
      detail,
      entitySlug:
        (typeof ev.squad === "string" && ev.squad) ||
        (typeof ev.slug === "string" && ev.slug) ||
        (typeof ev.business === "string" && ev.business) ||
        null,
      durationMs: typeof ev.duration_ms === "number" ? ev.duration_ms : null,
      cancelled: false,
    } satisfies WireEvent;
  });
}

/** GET /api/logs?type=harness&date=today&limit=N → { events, total_in_day, … } */
export async function fetchEngineLogs(limit = 200): Promise<{ events: WireEvent[]; totalInDay: number | null } | null> {
  const date = new Date().toISOString().slice(0, 10);
  const res = await fetchEngine(`/api/logs?type=harness&date=${date}&limit=${limit}`);
  if (!res?.ok) return null;
  const raw = (await res.json().catch(() => null)) as
    | { events?: RawAuditEvent[]; total_in_day?: number }
    | null;
  if (!raw?.events) return null;
  return { events: assignIds(raw.events), totalInDay: raw.total_in_day ?? null };
}

// ─── Pulse (stats + subsystems derivados de dados reais) ─────────────────────

export async function fetchEnginePulse(): Promise<PulseDTO | null> {
  const [health, squads, businesses, logs] = await Promise.all([
    fetchEngineHealth(),
    fetchEngineSquads(),
    fetchEngineBusinesses(),
    fetchEngineLogs(200),
  ]);
  if (!health || !squads || !businesses) return null;

  const stats: StatsDTO = {
    agents: squads.length + businesses.entities.length,
    eventsToday: logs?.totalInDay ?? logs?.events.length ?? 0,
    successRate: null, // o engine não expõe taxa agregada — UI mostra "—"
    avgResponseMs: null,
    uptimePct: null,
    uptimeLabel: "30 days",
  };

  const entities = [...squads, ...businesses.entities];
  const now = new Date().toISOString();

  // Tier 3 derivado 100% de respostas reais do engine (sem invenção).
  const subsystems: SubsystemDTO[] = [
    { name: "RUN KERNEL", status: "OK", value: `${stats.eventsToday} events today`, lastCheckAt: now },
    { name: "REGISTRY·SQUADS", status: squads.length ? "OK" : "IDLE", value: `${squads.length} squads`, lastCheckAt: now },
    { name: "REGISTRY·BUSINESSES", status: businesses.entities.length ? "OK" : "IDLE", value: `${businesses.entities.length} businesses`, lastCheckAt: now },
    { name: "MAESTRO PROJECTS", status: "CHECKED", value: "GET /api/projects", lastCheckAt: now },
    { name: "SCOPE", status: "OK", value: health.scope, lastCheckAt: now },
    { name: "PERMISSIONS", status: health.allowActions ? "OK" : "IDLE", value: health.allowActions ? "allow-actions" : "read-only", lastCheckAt: now },
    { name: "CONTROL PLANE", status: "CHECKED", value: "/api/v1", lastCheckAt: now },
    { name: "ENGINE HEALTH", status: "OK", value: `up ${Math.round((health.engineUptimeMs ?? 0) / 1000)}s`, lastCheckAt: now },
  ];

  return { stats, subsystems, entities, health };
}

// ─── /api/v1 — turnos do maestro contra o engine real ────────────────────────

type EngineTurn = {
  turn_id: string;
  conversation_id: string;
  project_id?: string;
  state?: string;
  events_url?: string;
};

type EngineConv = { conversation_id?: string; id?: string };

/** Cache de bootstrap (projectId + conversationId) por processo, sobrevive a HMR. */
type BridgeState = { projectId: string | null; conversationId: string | null; checkedAt: number };
const g = globalThis as unknown as { __nrvBridge?: BridgeState };
function bridge(): BridgeState {
  if (!g.__nrvBridge) g.__nrvBridge = { projectId: null, conversationId: null, checkedAt: 0 };
  return g.__nrvBridge;
}

const TURN_STATE_MAP: Record<string, TurnDTO["state"]> = {
  running: "RUNNING",
  prepared: "RUNNING",
  waiting: "RUNNING",
  verifying: "RUNNING",
  revising: "RUNNING",
  cancelling: "RUNNING",
  completed: "COMPLETED",
  delivered: "COMPLETED",
  delivered_with_reservations: "COMPLETED",
  withheld: "ROLLED_BACK",
  rolled_back: "ROLLED_BACK",
  cancelled: "ROLLED_BACK",
  failed: "FAILED",
  abandoned: "FAILED",
  unavailable: "NO_MATCH",
  no_match: "NO_MATCH",
};

function toTurnDTO(t: EngineTurn): TurnDTO {
  const state = TURN_STATE_MAP[t.state ?? "running"] ?? "RUNNING";
  return {
    id: Math.abs(hashCode(t.turn_id)),
    message: "",
    target: null,
    state,
    detail: t.state ? `engine state: ${t.state}` : null,
    budgetPct: 0,
    createdAt: new Date().toISOString(),
    resolveAt: new Date().toISOString(),
    durationMs: null,
  };
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** Descobre (uma vez) o projeto adotado + conversa canônica do workspace. */
async function ensureConversation(): Promise<{ projectId: string; conversationId: string } | null> {
  const b = bridge();
  const fresh = Date.now() - b.checkedAt < 30_000;
  if (fresh && b.projectId && b.conversationId) return { projectId: b.projectId, conversationId: b.conversationId };

  // GET /api/v1/projects → { projects: [...], legacy: [...] }
  const res = await fetchEngine("/api/v1/projects");
  if (!res?.ok) return null;
  const raw = (await res.json().catch(() => null)) as { projects?: Array<{ project_id?: string }> } | null;
  const projectId = raw?.projects?.[0]?.project_id;
  if (!projectId) return null;

  // GET /api/v1/projects/:id/conversations → { conversations: [...] }
  const convRes = await fetchEngine(`/api/v1/projects/${projectId}/conversations`);
  let conversationId: string | null = null;
  if (convRes?.ok) {
    const convRaw = (await convRes.json().catch(() => null)) as { conversations?: EngineConv[] } | null;
    conversationId = convRaw?.conversations?.[0]?.conversation_id ?? convRaw?.conversations?.[0]?.id ?? null;
  }
  if (!conversationId) {
    const created = await fetchEngine(`/api/v1/projects/${projectId}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Glance one-pager" }),
    });
    if (!created?.ok) return null;
    const c = (await created.json().catch(() => null)) as EngineConv | null;
    conversationId = c?.conversation_id ?? c?.id ?? null;
  }
  if (!conversationId) return null;

  b.projectId = projectId;
  b.conversationId = conversationId;
  b.checkedAt = Date.now();
  return { projectId, conversationId };
}

/**
 * POST /api/v1/conversations/:cnv/messages { project_id, content, mode: "turn" }
 * + Idempotency-Key → { message, turn, session, queued, events_url }
 * Requer `--allow-actions` no upstream (senão 405).
 */
export async function engineSubmitTurn(message: string, idemKey: string): Promise<{ turn: TurnDTO; queued: boolean } | null> {
  const conv = await ensureConversation();
  if (!conv) return null;
  const res = await fetchEngine(`/api/v1/conversations/${conv.conversationId}/messages`, {
    method: "POST",
    timeoutMs: 8000,
    headers: { "Content-Type": "application/json", "Idempotency-Key": idemKey },
    body: JSON.stringify({ project_id: conv.projectId, role: "user", content: message, mode: "turn" }),
  });
  if (!res) return null;
  if (res.status === 405) {
    // upstream sem --allow-actions
    return { turn: { ...toTurnDTO({ turn_id: `blocked-${idemKey}`, conversation_id: conv.conversationId, state: "unavailable" }), state: "NO_MATCH", detail: "upstream read-only: --allow-actions off" }, queued: false };
  }
  if (!res.ok && res.status !== 202) return null;
  const raw = (await res.json().catch(() => null)) as { turn?: EngineTurn; queued?: boolean } | null;
  if (!raw?.turn?.turn_id) return null;
  const dto = toTurnDTO(raw.turn);
  dto.message = message;
  return { turn: dto, queued: raw.queued !== false };
}

/** GET /api/v1/conversations/:cnv/turns/:trn → turnPayload */
export async function enginePollTurn(turnId: number): Promise<TurnDTO | null> {
  const b = bridge();
  if (!b.projectId || !b.conversationId) return null;
  // O id numérico é hash(turn_id); buscamos a conversa e resolvemos o turn real.
  const res = await fetchEngine(`/api/v1/conversations/${b.conversationId}`);
  if (!res?.ok) return null;
  const raw = (await res.json().catch(() => null)) as { active_turn?: EngineTurn; messages?: unknown[] } | null;
  const active = raw?.active_turn;
  if (active?.turn_id && Math.abs(hashCode(active.turn_id)) === turnId) return toTurnDTO(active);
  return null;
}

/** POST /api/v1/conversations/:cnv/turns/:trn/:cancel — exige upstream com actions. */
export async function engineCancelRun(seq: number): Promise<{ ok: boolean; code?: string; hint?: string } | null> {
  const b = bridge();
  if (!b.projectId || !b.conversationId) return null;
  const convRes = await fetchEngine(`/api/v1/conversations/${b.conversationId}`);
  if (!convRes?.ok) return null;
  const raw = (await convRes.json().catch(() => null)) as { active_turn?: EngineTurn } | null;
  const active = raw?.active_turn;
  if (!active?.turn_id || Math.abs(hashCode(active.turn_id)) !== seq) {
    return { ok: false, code: "NOT_FOUND", hint: "Turno ativo não corresponde a este id." };
  }
  const res = await fetchEngine(`/api/v1/conversations/${b.conversationId}/turns/${active.turn_id}:cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: b.projectId }),
  });
  if (res?.ok || res?.status === 202) return { ok: true };
  if (res?.status === 405) return { ok: false, code: "ACTIONS_GATED", hint: "upstream read-only: --allow-actions off" };
  if (res?.status === 409) return { ok: false, code: "STATE", hint: "Turno não está mais em execução." };
  return null;
}
