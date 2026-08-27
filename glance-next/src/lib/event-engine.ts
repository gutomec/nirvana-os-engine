import { db } from "@/lib/db";
import type { Locale } from "@/lib/i18n/dictionaries";
import {
  answerFlow,
  hasFlowToken,
  matchFlowIntent,
  startFlow,
  type FlowDeps,
  type FlowId,
} from "@/lib/maestro-flows";
import type {
  BusMessage,
  EntityDTO,
  FormAnswers,
  HealthDTO,
  MaestroReply,
  ProjectDTO,
  PulseDTO,
  SettingsDTO,
  StatsDTO,
  SubsystemDTO,
  TurnDTO,
  WireEvent,
} from "@/lib/types";

// ─── Seeds canônicos (imagem de referência + rótulos Nirvana) ─────────────

const SEED_ENTITIES = [
  { slug: "data-hunter", name: "DataHunter", kind: "AGENT", icon: "Search", runsToday: 1248, successRate: 99.6 },
  { slug: "insight-synth", name: "InsightSynth", kind: "AGENT", icon: "BarChart3", runsToday: 842, successRate: 99.9 },
  { slug: "web-scout", name: "WebScout", kind: "AGENT", icon: "Globe", runsToday: 532, successRate: 99.2 },
  { slug: "email-watcher", name: "EmailWatcher", kind: "AGENT", icon: "Mail", runsToday: 124, successRate: 100 },
  { slug: "stripe-reader", name: "StripeReader", kind: "TOOL", icon: "CreditCard", runsToday: 312, successRate: 99.8 },
  { slug: "serpapi", name: "SerpAPI", kind: "TOOL", icon: "KeyRound", runsToday: 76, successRate: 98.7 },
  { slug: "daily-digest", name: "Daily Digest", kind: "WORKFLOW", icon: "Workflow", runsToday: 18, successRate: 100 },
];

const SEED_BUSINESSES = [
  { slug: "acme-retail", name: "Acme Retail", runsToday: 214 },
  { slug: "northwind-logistics", name: "Northwind Logistics", runsToday: 168 },
  { slug: "lumen-media", name: "Lumen Media", runsToday: 97 },
  { slug: "vector-health", name: "Vector Health", runsToday: 76 },
  { slug: "forge-capital", name: "Forge Capital", runsToday: 52 },
  { slug: "atlas-education", name: "Atlas Education", runsToday: 31 },
];

const SEED_SUBSYSTEMS: Array<{ name: string; status: string; value: string; sortOrder: number }> = [
  { name: "ROUTER", status: "OK", value: "1,024 routed", sortOrder: 1 },
  { name: "SUPERVISOR", status: "OK", value: "312 checks", sortOrder: 2 },
  { name: "QUALITY GATE", status: "OK", value: "248 pass", sortOrder: 3 },
  { name: "GAUNTLET", status: "IDLE", value: "on demand", sortOrder: 4 },
  { name: "RUN KERNEL", status: "OK", value: "248 runs", sortOrder: 5 },
  { name: "EMBEDDINGS", status: "OFF", value: "local off", sortOrder: 6 },
  { name: "SETTINGS", status: "OK", value: "v0.9.0", sortOrder: 7 },
  { name: "UPDATES", status: "CHECKED", value: "channel: stable", sortOrder: 8 },
];

const DEFAULT_SETTINGS: Record<string, string> = {
  scope: "project",
  allowActions: "false",
  version: "0.9.0",
  budgetPct: "94",
  idempotency: "true",
  headlessPerms: JSON.stringify(["read:logs", "read:metrics", "read:health"]),
  metricsSeed: JSON.stringify({ eventsToday: 236, runBase: 5000, passBase: 4990, avgBaseMs: 842, avgWeight: 500 }),
  inceptionAt: "", // preenchido no seed: now - 30d
  downtimeSec: "260",
  projects: "", // preenchido no seed
};

type Listener = (msg: BusMessage) => void;

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min: number, max: number) => Math.floor(min + Math.random() * (max - min + 1));
const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[randInt(0, 15)]).join("");

// ─── Engine ───────────────────────────────────────────────────────────────

class GlanceEngine {
  ready: Promise<void>;
  private listeners = new Set<Listener>();
  private buffer: WireEvent[] = [];
  private seq = 0;
  private genTimer: ReturnType<typeof setTimeout> | null = null;
  private pulseTimer: ReturnType<typeof setInterval> | null = null;
  private idempotency = new Map<string, number>();
  private finalizing = new Set<number>();
  private disposed = false;

  constructor() {
    this.ready = this.boot();
  }

  dispose() {
    this.disposed = true;
    if (this.genTimer) clearTimeout(this.genTimer);
    if (this.pulseTimer) clearInterval(this.pulseTimer);
    this.listeners.clear();
  }

  private async boot() {
    await ensureSeed();
    const rows = await db.event.findMany({ orderBy: { seq: "desc" }, take: 400 });
    this.buffer = rows.reverse().map(toWire);
    this.seq = rows.length ? rows[rows.length - 1].seq : 0;
    // Finaliza turnos que ficaram pendentes de uma sessão anterior
    await this.finalizeDueTurns().catch(() => {});
    this.scheduleNext(randInt(2500, 6000));
    this.pulseTimer = setInterval(() => {
      this.finalizeDueTurns().catch(() => {});
      this.broadcastPulse();
    }, 10_000);
  }

  // ── Barramento ──
  subscribe(fn: Listener) {
    this.listeners.add(fn);
  }
  unsubscribe(fn: Listener) {
    this.listeners.delete(fn);
  }
  private publish(msg: BusMessage) {
    for (const fn of this.listeners) {
      try {
        fn(msg);
      } catch {
        /* listener morto — SSE fechado */
      }
    }
  }

  eventsAfter(lastSeq: number): WireEvent[] {
    return this.buffer.filter((e) => e.id > lastSeq);
  }

  async broadcastPulse() {
    try {
      const pulse = await this.getPulse();
      this.publish({ type: "pulse", payload: pulse });
    } catch {
      /* noop */
    }
  }

  // ── Eventos ──
  private async addEvent(input: {
    kind: WireEvent["kind"];
    status: WireEvent["status"];
    title: string;
    detail?: string | null;
    entitySlug?: string | null;
    durationMs?: number | null;
    actor?: string;
  }): Promise<WireEvent> {
    this.seq += 1;
    const row = await db.event.create({
      data: {
        seq: this.seq,
        kind: input.kind,
        status: input.status,
        title: input.title,
        detail: input.detail ?? null,
        entitySlug: input.entitySlug ?? null,
        durationMs: input.durationMs ?? null,
        actor: input.actor ?? "kernel",
      },
    });
    const wire = toWire(row);
    this.buffer.push(wire);
    if (this.buffer.length > 400) this.buffer.shift();
    this.publish({ type: "timeline", payload: wire });
    return wire;
  }

  private async bumpEntity(slug: string) {
    try {
      await db.entity.update({
        where: { slug },
        data: { runsToday: { increment: 1 }, lastSeenAt: new Date() },
      });
    } catch {
      /* entidade pode não existir */
    }
  }

  private scheduleNext(delay: number) {
    if (this.disposed) return;
    this.genTimer = setTimeout(async () => {
      await this.generateEvent().catch(() => {});
      this.scheduleNext(randInt(2800, 7500));
    }, delay);
  }

  private async generateEvent() {
    const roll = Math.random();
    const agents = ["data-hunter", "insight-synth", "web-scout", "email-watcher"];

    if (roll < 0.42) {
      // RUN de agente (SUCCESS)
      const slug = pick(agents);
      const name = SEED_ENTITIES.find((e) => e.slug === slug)!.name;
      const durationMs = randInt(320, 2400);
      const tpl = {
        "data-hunter": () => ({
          title: `Agent "DataHunter" executed search`,
          detail: `Query: ${pick(["revenue by region – Q1 2025", "active users by cohort", "churn risk — enterprise tier", "ticket volume by channel"])}`,
        }),
        "insight-synth": () => ({
          title: `Agent "InsightSynth" generated report`,
          detail: `Report ID: rep_${hex(8)}`,
        }),
        "web-scout": () => ({
          title: `Agent "WebScout" completed run`,
          detail: `Pages scanned: ${randInt(6, 48)}`,
        }),
        "email-watcher": () => ({
          title: `Agent "EmailWatcher" new email processed`,
          detail: `From: ${pick(["partner@acme.com", "billing@northwind.io", "ops@lumen.media", "no-reply@stripe.com"])}`,
        }),
      }[slug]!();
      await this.bumpEntity(slug);
      await this.addEvent({ kind: "RUN", status: "SUCCESS", entitySlug: slug, durationMs, ...tpl });
    } else if (roll < 0.52) {
      // Tool / credencial (INFO)
      const tool = pick([
        { slug: "stripe-reader", name: "StripeReader", title: `Tool "StripeReader" retrieved data`, detail: `Source: Stripe / ${pick(["Balance Summary", "Invoices — March", "Payouts"])}` },
        { slug: "serpapi", name: "SerpAPI", title: `Credential "SerpAPI" validated`, detail: `Status: OK` },
        { slug: "web-scout", name: "WebScout", title: `Tool "WebScout" fetched SERP`, detail: `Endpoint: search·page ${randInt(1, 5)}` },
      ]);
      await this.bumpEntity(tool.slug);
      await this.addEvent({ kind: "RUN", status: "INFO", entitySlug: tool.slug, durationMs: randInt(90, 600), title: tool.title, detail: tool.detail });
    } else if (roll < 0.66) {
      // Quality gate / ledger
      const gateRoll = Math.random();
      if (gateRoll < 0.85) {
        await this.addEvent({
          kind: "GATE",
          status: "SUCCESS",
          title: `Quality gate PASS — run #${randInt(1000, 9999)}`,
          detail: `score: 0.9${randInt(10, 99)} · threshold: 0.90`,
          durationMs: randInt(40, 260),
        });
      } else if (gateRoll < 0.95) {
        await this.addEvent({
          kind: "GATE",
          status: "WARNING",
          title: `Ledger: retido (orçamento do squad)`,
          detail: `Aguardando liberação — teto diário em ${randInt(80, 97)}%`,
        });
      } else {
        await this.addEvent({
          kind: "GATE",
          status: "FAILED",
          title: `Quality gate FAIL — run #${randInt(1000, 9999)}`,
          detail: `reason: output drifted from brief`,
          durationMs: randInt(40, 260),
        });
      }
    } else if (roll < 0.84) {
      // Sistema
      const sysRoll = Math.random();
      if (sysRoll < 0.4) {
        await this.addEvent({ kind: "SYSTEM", status: "INFO", title: "System heartbeat", detail: "All systems operational" });
      } else if (sysRoll < 0.6) {
        await this.addEvent({ kind: "SYSTEM", status: "WARNING", title: "Rate limit threshold approaching", detail: `Service: OpenAI / GPT-4o-mini · ${randInt(72, 96)}% do teto` });
      } else if (sysRoll < 0.8) {
        await this.addEvent({ kind: "SYSTEM", status: "INFO", title: "canary.recovery_ok", detail: `watchdog: instância restabelecida em ${randInt(12, 90)}s` });
      } else {
        await this.addEvent({ kind: "SYSTEM", status: "INFO", title: "Updates: channel check", detail: "channel: stable — nenhum update pendente" });
      }
    } else {
      // Entidades / Nirvana labels
      const entRoll = Math.random();
      if (entRoll < 0.5) {
        await this.addEvent({ kind: "ENTITY", status: "INFO", title: "Prova de vida: hook 12:09", detail: `squads: ${randInt(5, 6)}/6 responderam` });
      } else {
        const biz = pick(SEED_BUSINESSES);
        await this.addEvent({ kind: "ENTITY", status: "INFO", title: "Mind-clone sincronizado", detail: `clone: ${biz.slug}/ops — drift 0.0${randInt(0, 9)}%` });
      }
    }
    await db.subsystem.updateMany({
      where: { name: { in: ["RUN KERNEL", "ROUTER"] } },
      data: { lastCheckAt: new Date() },
    });
  }

  // ── Cancel (gated por --allow-actions) ──
  async cancelEvent(seq: number, actor = "operator@local") {
    const allowActions = (await getSetting("allowActions")) === "true";
    if (!allowActions) {
      return { ok: false as const, code: "ACTIONS_GATED" as const, hint: "Ações bloqueadas — rode com --allow-actions ou habilite em Permissões." };
    }
    const existing = await db.event.findUnique({ where: { seq } });
    if (!existing) return { ok: false as const, code: "NOT_FOUND" as const, hint: "Evento não encontrado." };
    if (existing.cancelled || existing.status === "FAILED") {
      return { ok: false as const, code: "NOT_CANCELLABLE" as const, hint: "Run já finalizado." };
    }
    const updated = await db.event.update({
      where: { seq },
      data: {
        status: "FAILED",
        cancelled: true,
        detail: `${existing.detail ? `${existing.detail} — ` : ""}cancelado pelo operador`,
        actor,
      },
    });
    const wire = toWire(updated);
    const idx = this.buffer.findIndex((e) => e.id === seq);
    if (idx >= 0) this.buffer[idx] = wire;
    this.publish({ type: "timeline-update", payload: wire });
    await this.addEvent({
      kind: "SYSTEM",
      status: "FAILED",
      title: `Run #${seq} cancelado pelo operador`,
      detail: `actor: ${actor} · --allow-actions: on`,
    });
    return { ok: true as const, event: wire };
  }

  // ── Turnos do maestro (Ask bar → /api/v1) ──
  /**
   * v2: `opts` carrega o contexto do Agentic Forms — `intent` (chips/palavra-
   * chave) ou `form` (resposta de um formulário gerado pelo maestro). Fluxos
   * são determinísticos (sem rolled_back aleatório) e a resposta rica fica no
   * `meta` do turno, devolvida por /api/v1 como `reply`.
   */
  async createTurn(
    message: string,
    target: string | null,
    idemKey?: string | null,
    opts?: { locale?: Locale; intent?: FlowId | null; form?: { id: string; answers: FormAnswers } | null }
  ): Promise<{ turn: TurnDTO; reply: MaestroReply | null }> {
    if (idemKey && this.idempotency.has(idemKey)) {
      const turnId = this.idempotency.get(idemKey)!;
      const found = await db.turn.findUnique({ where: { id: turnId } });
      if (found) return { turn: toTurnDTO(found), reply: parseMeta(found.meta)?.reply ?? null };
    }

    const locale: Locale = opts?.locale ?? "en";
    let intent = opts?.intent ?? null;
    const form = opts?.form ?? null;
    // Texto livre pode iniciar um fluxo por palavra-chave (PT/EN).
    if (!intent && !form) intent = matchFlowIntent(message);
    const flowMode = Boolean(intent || form);
    const meta: TurnMetaJSON = {
      locale,
      intent,
      formToken: form?.id ?? null,
      answers: form?.answers ?? null,
      reply: null,
    };

    let state: TurnDTO["state"] = "RUNNING";
    let detail: string | null = null;
    let reply: MaestroReply | null = null;
    let resolveDelay = flowMode ? (form ? randInt(900, 1700) : randInt(650, 1200)) : randInt(1400, 3000);

    // Validação de target: no_match é síncrono
    if (target) {
      const [type, slug] = target.split(":");
      const found =
        type === "squad"
          ? await db.entity.findUnique({ where: { slug } })
          : await db.business.findUnique({ where: { slug } });
      if (!found) {
        state = "NO_MATCH";
        detail = `no_dispatchable_target — ${type} "${slug}" não encontrado no escopo`;
        resolveDelay = 0;
      }
    }

    // Token de formulário precisa existir (um uso, TTL 15min)
    if (state === "RUNNING" && form && !hasFlowToken(form.id)) {
      state = "NO_MATCH";
      detail = "flow_expired — token de fluxo desconhecido ou expirado";
      reply = {
        text:
          locale === "pt-BR"
            ? "Este fluxo expirou (15 min) ou já foi respondido. Inicie novamente pelos chips."
            : "This flow expired (15 min) or was already answered. Start it again from the chips.",
      };
      resolveDelay = 0;
    }

    const budgetPct = await getSetting("budgetPct").then(Number);
    if (state === "RUNNING") {
      if (budgetPct <= 1) {
        state = "FAILED";
        detail = "budget_exhausted — orçamento do turno esgotado";
        reply = {
          text:
            locale === "pt-BR"
              ? "Turno falhou: orçamento esgotado (budget_exhausted). Nada foi despachado."
              : "Turn failed: budget exhausted (budget_exhausted). Nothing was dispatched.",
        };
        resolveDelay = 0;
      } else if (!flowMode && Math.random() < 0.12) {
        state = "ROLLED_BACK";
        detail = "rolled_back: no_dispatchable_target — nada foi despachado";
        resolveDelay = randInt(900, 1600);
      }
    }

    const resolveAt = new Date(Date.now() + resolveDelay);
    const row = await db.turn.create({
      data: {
        message,
        target,
        state,
        detail,
        budgetPct: state === "RUNNING" ? Math.max(1, budgetPct - randInt(1, 3)) : budgetPct,
        resolveAt,
        meta: JSON.stringify(meta),
      },
    });
    if (idemKey) this.idempotency.set(idemKey, row.id);
    if (state !== "RUNNING") await this.finalizeTurn(row.id, state, detail, budgetPct, reply);
    const final = await db.turn.findUnique({ where: { id: row.id } });
    return { turn: toTurnDTO(final!), reply: reply ?? parseMeta(final!.meta)?.reply ?? null };
  }

  async finalizeDueTurns() {
    const due = await db.turn.findMany({ where: { state: "RUNNING", resolveAt: { lte: new Date() } }, take: 10 });
    if (due.length === 0) return;
    const [allowActions] = await Promise.all([getSetting("allowActions").then((v) => v === "true")]);
    for (const t of due) {
      if (this.finalizing.has(t.id)) continue;
      this.finalizing.add(t.id);
      try {
        const meta = parseMeta(t.meta);
        let detail: string;
        let reply: MaestroReply | null = null;
        if (meta && (meta.intent || meta.formToken)) {
          const deps: FlowDeps = {
            locale: meta.locale,
            allowActions,
            budgetPct: t.budgetPct,
            emit: async (input) => {
              const wire = await this.addEvent(input);
              this.broadcastPulse();
              return wire;
            },
          };
          try {
            reply =
              meta.formToken && meta.answers
                ? ((await answerFlow(meta.formToken, meta.answers, deps)) ?? {
                    text:
                      meta.locale === "pt-BR"
                        ? "Resposta fora do esperado para este fluxo — inicie novamente pelos chips."
                        : "Unexpected answer for this flow — start it again from the chips.",
                  })
                : await startFlow(meta.intent!, deps);
          } catch {
            reply = {
              text:
                meta.locale === "pt-BR"
                  ? "Falha ao processar o fluxo no kernel — tente de novo."
                  : "Kernel failed to process this flow — please retry.",
            };
          }
          detail = reply.text;
        } else {
          detail =
            t.detail ??
            pick([
              "Relatório consolidado — 3 fontes consultadas, 12 linhas no ledger.",
              "Resposta sintetizada a partir de 2 squads · confirmação registrada.",
              "Turno concluído — evidências anexadas ao run log.",
            ]);
        }
        await this.finalizeTurn(t.id, "COMPLETED", detail, t.budgetPct, reply);
      } finally {
        this.finalizing.delete(t.id);
      }
    }
  }

  private async finalizeTurn(
    id: number,
    state: string,
    detail: string | null,
    budgetPct: number,
    reply: MaestroReply | null = null
  ) {
    const now = new Date();
    const t = await db.turn.update({
      where: { id },
      data: { state, detail, resolvedAt: now, budgetPct },
    });
    if (reply) {
      const meta = parseMeta(t.meta);
      if (meta) {
        meta.reply = reply;
        await db.turn.update({ where: { id }, data: { meta: JSON.stringify(meta) } });
      }
    }
    const durationMs = Math.max(1, t.resolveAt.getTime() - t.createdAt.getTime());
    await db.turn.update({ where: { id }, data: { durationMs } });
    if (state === "FAILED" && detail?.startsWith("budget_exhausted")) {
      await db.setting.upsert({ where: { key: "budgetPct" }, update: { value: "1" }, create: { key: "budgetPct", value: "1" } });
    } else {
      await db.setting.upsert({ where: { key: "budgetPct" }, update: { value: String(t.budgetPct) }, create: { key: "budgetPct", value: String(t.budgetPct) } });
    }
    // Evento na timeline
    const label = state === "COMPLETED" ? "SUCCESS" : state === "ROLLED_BACK" ? "WARNING" : "FAILED";
    const title =
      state === "COMPLETED"
        ? `Maestro turn concluído — "${t.message.slice(0, 44)}${t.message.length > 44 ? "…" : ""}"`
        : state === "ROLLED_BACK"
          ? `Maestro turn rolled back — "${t.message.slice(0, 36)}${t.message.length > 36 ? "…" : ""}"`
          : `Maestro turn falhou — "${t.message.slice(0, 36)}${t.message.length > 36 ? "…" : ""}"`;
    await this.addEvent({
      kind: "RUN",
      status: label as WireEvent["status"],
      title,
      detail: `${t.target ? `target: ${t.target} · ` : ""}${state.toLowerCase()} · ${(durationMs / 1000).toFixed(1)}s`,
      actor: "glance-ask",
    });
    this.broadcastPulse();
  }

  async getTurn(id: number): Promise<TurnDTO | null> {
    await this.finalizeDueTurns();
    const t = await db.turn.findUnique({ where: { id } });
    return t ? toTurnDTO(t) : null;
  }

  /** v2: turno + resposta rica (Agentic Forms) em uma leitura. */
  async getTurnWithReply(id: number): Promise<{ turn: TurnDTO; reply: MaestroReply | null } | null> {
    await this.finalizeDueTurns();
    const t = await db.turn.findUnique({ where: { id } });
    if (!t) return null;
    return { turn: toTurnDTO(t), reply: parseMeta(t.meta)?.reply ?? null };
  }

  // ── Leitura: pulse / health / settings ──
  async getHealth(): Promise<HealthDTO> {
    const [scope, allowActions, version, budgetPct] = await Promise.all([
      getSetting("scope"),
      getSetting("allowActions"),
      getSetting("version"),
      getSetting("budgetPct"),
    ]);
    const failedRecent = await db.event.count({
      where: { status: "FAILED", ts: { gte: new Date(Date.now() - 120_000) } },
    });
    return {
      status: failedRecent > 2 ? "DEGRADED" : "OPERATIONAL",
      scope: scope as "project" | "global",
      allowActions: allowActions === "true",
      version,
      budgetPct: Number(budgetPct),
      time: new Date().toISOString(),
      source: "simulated",
    };
  }

  async getPulse(): Promise<PulseDTO> {
    const startToday = new Date();
    startToday.setUTCHours(0, 0, 0, 0);
    const since24h = new Date(Date.now() - 86_400_000);

    const [entities, businesses, eventsTodayCount, ok24h, attempts24h, avgAgg, subsystems, health] =
      await Promise.all([
        db.entity.findMany({ orderBy: { id: "asc" } }),
        db.business.findMany({ orderBy: { id: "asc" } }),
        db.event.count({ where: { ts: { gte: startToday } } }),
        // SUCCESS RATE 24H = gate PASS / total runs (RUN|GATE terminais)
        db.event.count({ where: { kind: { in: ["RUN", "GATE"] }, status: "SUCCESS", ts: { gte: since24h } } }),
        db.event.count({ where: { kind: { in: ["RUN", "GATE"] }, status: { in: ["SUCCESS", "FAILED"] }, ts: { gte: since24h } } }),
        db.event.aggregate({ where: { kind: "RUN", durationMs: { not: null }, ts: { gte: since24h } }, _avg: { durationMs: true } }),
        db.subsystem.findMany({ orderBy: { sortOrder: "asc" } }),
        this.getHealth(),
      ]);

    const seedRaw = (await getSetting("metricsSeed")) || "{}";
    const seed = JSON.parse(seedRaw) as {
      eventsToday: number;
      runBase: number;
      passBase: number;
      avgBaseMs: number;
      avgWeight: number;
    };
    const liveAvg = avgAgg._avg.durationMs ?? seed.avgBaseMs;
    const liveWeight = Math.min(attempts24h, 60);

    const stats: StatsDTO = {
      agents: businesses.filter((b) => b.active).length + entities.filter((e) => e.kind !== "WORKFLOW").length,
      eventsToday: seed.eventsToday + eventsTodayCount,
      successRate:
        Math.round(((seed.passBase + ok24h) / (seed.runBase + Math.max(attempts24h, 1))) * 10000) / 100,
      avgResponseMs: Math.round((seed.avgBaseMs * seed.avgWeight + liveAvg * liveWeight) / (seed.avgWeight + liveWeight)),
      uptimePct: await computeUptimePct(),
      uptimeLabel: "30 days",
    };

    const entityDTOs: EntityDTO[] = entities.map((e) => ({
      slug: e.slug,
      name: e.name,
      kind: e.kind as EntityDTO["kind"],
      icon: e.icon,
      status: e.status as EntityDTO["status"],
      runsToday: e.runsToday,
      successRate: e.successRate,
      lastSeenAt: e.lastSeenAt.toISOString(),
    }));

    const subsystemDTOs: SubsystemDTO[] = subsystems.map((s) => ({
      name: s.name,
      status: s.status as SubsystemDTO["status"],
      value: s.value,
      lastCheckAt: s.lastCheckAt.toISOString(),
    }));

    return { stats, subsystems: subsystemDTOs, entities: entityDTOs, health };
  }

  async getSettings(): Promise<SettingsDTO> {
    const [scope, allowActions, version, budgetPct, idempotency, headlessPerms] = await Promise.all([
      getSetting("scope"),
      getSetting("allowActions"),
      getSetting("version"),
      getSetting("budgetPct"),
      getSetting("idempotency"),
      getSetting("headlessPerms"),
    ]);
    return {
      scope: scope as "project" | "global",
      allowActions: allowActions === "true",
      version,
      budgetPct: Number(budgetPct),
      idempotency: idempotency === "true",
      headlessPerms: JSON.parse(headlessPerms ?? "[]") as string[],
    };
  }

  async updateSetting(key: "scope" | "allowActions", value: string) {
    await db.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
    this.broadcastPulse();
  }

  async getProjects(): Promise<ProjectDTO[]> {
    const raw = await getSetting("projects");
    const defs = JSON.parse(raw || "[]") as Array<Omit<ProjectDTO, "lastRun">>;
    const entities = await db.entity.findMany();
    return defs.map((d) => {
      const ent = entities.find((e) => e.slug === d.entitySlug);
      return {
        slug: d.slug,
        name: d.name,
        lastRun: ent ? ent.lastSeenAt.toISOString() : new Date().toISOString(),
        lastDurationLabel: d.lastDurationLabel,
        lastStatus: d.lastStatus,
        entitySlug: d.entitySlug,
        steps: d.steps,
      };
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function toWire(row: {
  seq: number;
  ts: Date;
  kind: string;
  status: string;
  title: string;
  detail: string | null;
  entitySlug: string | null;
  durationMs: number | null;
  cancelled: boolean;
}): WireEvent {
  return {
    id: row.seq,
    ts: row.ts.toISOString(),
    kind: row.kind as WireEvent["kind"],
    status: row.status as WireEvent["status"],
    title: row.title,
    detail: row.detail,
    entitySlug: row.entitySlug,
    durationMs: row.durationMs,
    cancelled: row.cancelled,
  };
}

// ─── Meta do turno (v2 · Agentic Forms) ───────────────────────────────────

interface TurnMetaJSON {
  locale: Locale;
  intent: FlowId | null;
  formToken: string | null;
  answers: FormAnswers | null;
  reply?: MaestroReply | null;
}

function parseMeta(raw: string | null | undefined): TurnMetaJSON | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<TurnMetaJSON>;
    if (typeof v.locale !== "string") return null;
    return {
      locale: (v.locale === "pt-BR" ? "pt-BR" : "en") as Locale,
      intent: (v.intent as FlowId | null) ?? null,
      formToken: v.formToken ?? null,
      answers: v.answers ?? null,
      reply: v.reply ?? null,
    };
  } catch {
    return null;
  }
}

function toTurnDTO(t: {
  id: number;
  message: string;
  target: string | null;
  state: string;
  detail: string | null;
  budgetPct: number;
  createdAt: Date;
  resolveAt: Date;
  durationMs: number | null;
}): TurnDTO {
  return {
    id: t.id,
    message: t.message,
    target: t.target,
    state: t.state as TurnDTO["state"],
    detail: t.detail,
    budgetPct: t.budgetPct,
    createdAt: t.createdAt.toISOString(),
    resolveAt: t.resolveAt.toISOString(),
    durationMs: t.durationMs,
  };
}

async function getSetting(key: string): Promise<string> {
  const row = await db.setting.findUnique({ where: { key } });
  return row?.value ?? "";
}

async function computeUptimePct(): Promise<number> {
  const inception = await getSetting("inceptionAt");
  if (!inception) return 99.99;
  const elapsed = (Date.now() - new Date(inception).getTime()) / 1000;
  const downtime = Number((await getSetting("downtimeSec")) || "260");
  return Math.round(((elapsed - downtime) / elapsed) * 10000) / 100;
}

// ─── Seed inicial ─────────────────────────────────────────────────────────

async function ensureSeed() {
  const entityCount = await db.entity.count();
  if (entityCount === 0) {
    await db.entity.createMany({
      data: SEED_ENTITIES.map((e) => ({
        ...e,
        status: "OPERATIONAL",
        lastSeenAt: new Date(Date.now() - randInt(10, 120) * 1000),
      })),
    });
  }
  if ((await db.business.count()) === 0) {
    await db.business.createMany({
      data: SEED_BUSINESSES.map((b) => ({ ...b, active: true, lastSeenAt: new Date(Date.now() - randInt(30, 300) * 1000) })),
    });
  }
  if ((await db.subsystem.count()) === 0) {
    await db.subsystem.createMany({
      data: SEED_SUBSYSTEMS.map((s) => ({ ...s, lastCheckAt: new Date(Date.now() - randInt(5, 90) * 1000) })),
    });
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if ((await db.setting.findUnique({ where: { key } })) == null) {
      let v = value;
      if (key === "inceptionAt") v = new Date(Date.now() - 30 * 86_400_000).toISOString();
      if (key === "projects")
        v = JSON.stringify([
          {
            slug: "daily-digest",
            name: "Daily Digest",
            entitySlug: "daily-digest",
            lastDurationLabel: "18.4s",
            lastStatus: "SUCCESS",
            steps: [
              { name: "Ingest e-mails (EmailWatcher)", status: "SUCCESS" },
              { name: "Summarize (InsightSynth)", status: "SUCCESS" },
              { name: "Render digest", status: "SUCCESS" },
              { name: "Deliver · SMTP", status: "SUCCESS" },
            ],
          },
          {
            slug: "revenue-weekly",
            name: "Revenue Weekly",
            entitySlug: "data-hunter",
            lastDurationLabel: "42.1s",
            lastStatus: "SUCCESS",
            steps: [
              { name: "Collect (DataHunter + StripeReader)", status: "SUCCESS" },
              { name: "Model revenue", status: "SUCCESS" },
              { name: "Quality gate", status: "SUCCESS" },
            ],
          },
          {
            slug: "canary-watch",
            name: "Canary Watch",
            entitySlug: "web-scout",
            lastDurationLabel: "2.0s",
            lastStatus: "INFO",
            steps: [
              { name: "Probe instâncias", status: "SUCCESS" },
              { name: "canary.recovery_hooks", status: "INFO" },
            ],
          },
        ] satisfies unknown[]);
      await db.setting.create({ data: { key, value: v } });
    }
  }
  if ((await db.event.count()) === 0) {
    const sec = (s: number) => new Date(Date.now() - s * 1000);
    const seedEvents: Array<[number, WireEvent["kind"], WireEvent["status"], string, string | null, string | null, number | null]> = [
      [170, "RUN", "SUCCESS", `Agent "DataHunter" executed search`, "Query: revenue by region – Q1 2025", "data-hunter", 1184],
      [157, "RUN", "INFO", `Tool "StripeReader" retrieved data`, "Source: Stripe / Balance Summary", "stripe-reader", 212],
      [141, "RUN", "SUCCESS", `Agent "InsightSynth" generated report`, "Report ID: rep_8f3c1a2d", "insight-synth", 942],
      [128, "SYSTEM", "WARNING", "Rate limit threshold approaching", "Service: OpenAI / GPT-4o-mini", null, null],
      [112, "RUN", "SUCCESS", `Agent "WebScout" completed run`, "Pages scanned: 24", "web-scout", 1640],
      [96, "ENTITY", "INFO", `Credential "SerpAPI" validated`, "Status: OK", "serpapi", 88],
      [81, "RUN", "SUCCESS", `Agent "EmailWatcher" new email processed`, "From: partner@acme.com", "email-watcher", 430],
      [66, "GATE", "WARNING", "Ledger: retido (orçamento do squad)", "Aguardando liberação — teto diário em 91%", null, null],
      [49, "RUN", "SUCCESS", `Workflow "Daily Digest" completed`, "Duration: 18.4s", "daily-digest", 18400],
      [33, "SYSTEM", "INFO", "canary.recovery_ok", "watchdog: instância restabelecida em 42s", null, null],
      [17, "ENTITY", "INFO", "Prova de vida: hook 12:09", "squads: 6/6 responderam", null, null],
      [2, "SYSTEM", "INFO", "System heartbeat", "All systems operational", null, null],
    ];
    let seq = 0;
    for (const [offset, kind, status, title, detail, entitySlug, durationMs] of seedEvents) {
      seq += 1;
      await db.event.create({
        data: { seq, ts: sec(offset), kind, status, title, detail, entitySlug, durationMs },
      });
    }
  }
}

// ─── Singleton global (sobrevive a HMR) ───────────────────────────────────

export function getEngine(): GlanceEngine {
  const g = globalThis as unknown as { __glanceEngine?: GlanceEngine };
  if (!g.__glanceEngine) {
    g.__glanceEngine = new GlanceEngine();
  }
  return g.__glanceEngine;
}
