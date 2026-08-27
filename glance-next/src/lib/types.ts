// ─── Contratos de dados Nirvana Glance ────────────────────────────────────

export type EventStatus = "SUCCESS" | "INFO" | "WARNING" | "FAILED";
export type EventKind = "RUN" | "GATE" | "SYSTEM" | "ENTITY";

/** Evento canônico do Run Kernel trafegado via SSE / REST */
export interface WireEvent {
  id: number; // seq — usado como SSE Last-Event-ID
  ts: string; // ISO
  kind: EventKind;
  status: EventStatus;
  title: string;
  detail: string | null;
  entitySlug: string | null;
  durationMs: number | null;
  cancelled: boolean;
}

/**
 * Entidades do one-pager. Em modo `engine` (upstream `nrv glance`), squads e
 * businesses chegam do registry real e os contadores voláteis podem ser null
 * (o engine não expõe runs/dia por entidade — a UI mostra "—").
 */
export interface EntityDTO {
  slug: string;
  name: string;
  kind: "AGENT" | "TOOL" | "WORKFLOW" | "SQUAD" | "BUSINESS";
  icon: string;
  status: "OPERATIONAL" | "IDLE" | "DEGRADED" | "OFFLINE";
  runsToday: number | null;
  successRate: number | null;
  lastSeenAt: string | null;
  /** Metadados reais do registry do engine (modo engine). */
  engineMeta?: {
    version?: string;
    protocol?: string;
    domains?: string[];
    source?: string;
    businessType?: string;
    employeeCount?: number;
    capabilitiesCount?: number;
  };
}

export interface BusinessDTO {
  slug: string;
  name: string;
  active: boolean;
  runsToday: number | null;
  lastSeenAt: string | null;
  engineMeta?: EntityDTO["engineMeta"];
}

export interface SubsystemDTO {
  name: string;
  status: "OK" | "IDLE" | "OFF" | "CHECKED";
  value: string;
  lastCheckAt: string;
}

/** Campos null = dado indisponível no engine real; a UI renderiza "—". */
export interface StatsDTO {
  agents: number;
  eventsToday: number | null;
  successRate: number | null; // %
  avgResponseMs: number | null;
  uptimePct: number | null; // %
  uptimeLabel: string; // "30 days"
}

export interface HealthDTO {
  status: "OPERATIONAL" | "DEGRADED";
  scope: "project" | "global";
  allowActions: boolean;
  version: string;
  budgetPct: number;
  time: string;
  /** De onde veio o dado: engine real (`nrv glance`) ou kernel simulado. */
  source: "engine" | "simulated";
  /** uptime_ms cru do engine (modo engine). */
  engineUptimeMs?: number;
}

export interface PulseDTO {
  stats: StatsDTO;
  subsystems: SubsystemDTO[];
  entities: EntityDTO[];
  health: HealthDTO;
}

export interface EntityDetailDTO extends EntityDTO {
  events: WireEvent[];
}

export type TurnState =
  | "RUNNING"
  | "COMPLETED"
  | "ROLLED_BACK"
  | "FAILED"
  | "NO_MATCH";

export interface TurnDTO {
  id: number;
  message: string;
  target: string | null;
  state: TurnState;
  detail: string | null;
  budgetPct: number;
  createdAt: string;
  resolveAt: string;
  durationMs: number | null;
}

export interface ProjectStepDTO {
  name: string;
  status: "SUCCESS" | "INFO" | "WARNING" | "FAILED";
}

export interface ProjectDTO {
  slug: string;
  name: string;
  lastRun: string; // ISO
  lastDurationLabel: string;
  lastStatus: EventStatus;
  entitySlug: string;
  steps: ProjectStepDTO[];
}

export interface SettingsDTO {
  scope: "project" | "global";
  allowActions: boolean;
  version: string;
  budgetPct: number;
  idempotency: boolean;
  headlessPerms: string[];
}

// ─── Maestro v2 · Agentic Forms ───────────────────────────────────────────
// O maestro responde com formulários gerados em tempo real (o operador clica/
// seleciona em vez de digitar). Protocolo próprio do kernel simulado — no modo
// engine (upstream real) a conversa permanece textual e `reply` vem null.

export type MaestroActionType = "open_entity" | "open_timeline" | "open_projects";

/** Ação de UI que o maestro sugere executar no Glance após a resposta. */
export interface MaestroAction {
  type: MaestroActionType;
  slug?: string;
}

export interface FormOption {
  value: string;
  label: string;
  hint?: string;
  dot?: "success" | "warning" | "danger" | "muted";
}

export type FormField =
  | { id: string; type: "choice"; label: string; options: FormOption[]; style?: "chips" | "list" }
  | { id: string; type: "multi"; label: string; options: FormOption[]; max?: number }
  | {
      id: string;
      type: "confirm";
      label: string;
      okLabel: string;
      cancelLabel: string;
      tone?: "default" | "danger";
    }
  | {
      id: string;
      type: "text";
      label: string;
      placeholder?: string;
      submitLabel?: string;
      maxLen?: number;
    };

/** Formulário gerado pelo agente; `id` é o token de continuação do fluxo. */
export interface TurnForm {
  id: string;
  title?: string | null;
  fields: FormField[];
}

export type FormAnswers = Record<string, string | string[]>;

/** Resposta rica do maestro (vai no `meta` do turno, devolvida por /api/v1). */
export interface MaestroReply {
  text: string;
  form?: TurnForm | null;
  actions?: MaestroAction[] | null;
}

/** Mensagens do barramento SSE */
export type BusMessage =
  | { type: "timeline"; payload: WireEvent }
  | { type: "timeline-update"; payload: WireEvent }
  | { type: "pulse"; payload: PulseDTO };

/** Labels vivem no dicionário i18n (`src/lib/i18n/dictionaries.ts`). */
export const FILTER_OPTIONS = ["ALL", "RUN", "GATE", "SYSTEM", "ENTITY"] as const;

export type TimelineFilter = (typeof FILTER_OPTIONS)[number];
