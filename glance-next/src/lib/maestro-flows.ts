// ─── Maestro v2 · Fluxos guiados com formulários gerados em tempo real ────
//
// O operador clica/seleciona em vez de digitar: cada resposta do maestro pode
// trazer um `TurnForm` cujo `id` é um token de continuação guardado aqui (em
// memória, TTL de 15min — igual ao resto do kernel simulado). Todo dado exibido
// é lido AO VIVO do kernel (entities/events/subsystems/settings) — nada inventado.
//
// Conteúdo bilíngue: o locale vem do cliente no POST /api/v1 (o engine oficial
// usa PT-BR como locale default; aqui seguimos o idioma do operador).
// No modo engine (upstream real) estes fluxos não rodam — a conversa lá é
// textual e `reply` chega null. Delimitação honesta.

import { db } from "@/lib/db";
import type { Locale } from "@/lib/i18n/dictionaries";
import type {
  FormAnswers,
  FormOption,
  MaestroAction,
  MaestroReply,
  TurnForm,
  WireEvent,
} from "@/lib/types";

export type FlowId = "diagnose" | "route" | "gate" | "status";

export interface FlowDeps {
  locale: Locale;
  allowActions: boolean;
  budgetPct: number;
  /** Emite um evento real no kernel (timeline + SSE). Implementado pelo engine. */
  emit: (input: {
    kind: WireEvent["kind"];
    status: WireEvent["status"];
    title: string;
    detail?: string | null;
    entitySlug?: string | null;
  }) => Promise<WireEvent>;
}

interface FlowStateEntry {
  flow: FlowId;
  step: "diagnose.target" | "diagnose.confirm" | "route.task" | "route.confirm" | "route.dispatch" | "gate.pick" | "gate.confirm" | "status.pick" | "status.open";
  ctx: Record<string, string>;
  expect?: { field: string; type: "choice" | "multi"; allowed: string[] };
  createdAt: number;
}

// Estado de fluxos em memória global (sobrevive a HMR como o engine).
const g = globalThis as unknown as { __maestroFlows?: Map<string, FlowStateEntry> };
g.__maestroFlows ??= new Map<string, FlowStateEntry>();
const flows = g.__maestroFlows;

const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 300;

function prune() {
  const now = Date.now();
  for (const [k, v] of flows) if (now - v.createdAt > TTL_MS) flows.delete(k);
  while (flows.size > MAX_ENTRIES) {
    const oldest = [...flows.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (!oldest) break;
    flows.delete(oldest[0]);
  }
}

function token(): string {
  return `fl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function register(entry: Omit<FlowStateEntry, "createdAt">): string {
  prune();
  const id = token();
  flows.set(id, { ...entry, createdAt: Date.now() });
  return id;
}

/** Lookup para validação síncrona no POST (token desconhecido/expirado → no_match). */
export function hasFlowToken(id: string): boolean {
  prune();
  return flows.has(id);
}

// ─── Textos bilíngues (conteúdo do agente = dados do kernel simulado) ─────

type L = Locale;
const pickL = <T,>(locale: L, en: T, pt: T): T => (locale === "pt-BR" ? pt : en);

const fmtTime = (d: Date) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Texto honesto quando a ação exige --allow-actions e está gated. */
function gatedText(deps: FlowDeps): string {
  return pickL(
    deps.locale,
    "Blocked: actions are gated (--allow-actions off) — nothing was dispatched. Enable writes in Permissions if you intend to act.",
    "Bloqueado: ações estão gated (--allow-actions off) — nada foi despachado. Habilite a escrita em Permissões se a intenção for agir."
  );
}

async function entityOptions(kinds: string[]): Promise<FormOption[]> {
  const rows = await db.entity.findMany({
    where: { kind: { in: kinds } },
    orderBy: { runsToday: "desc" },
  });
  return rows.map((e) => ({
    value: e.slug,
    label: e.name,
    hint: `${e.runsToday} runs`,
    dot: e.status === "OPERATIONAL" ? "success" : e.status === "DEGRADED" ? "warning" : "muted",
  }));
}

// ─── Início de fluxo (chip/click ou palavra-chave no texto livre) ─────────

export async function startFlow(flow: FlowId, deps: FlowDeps): Promise<MaestroReply> {
  switch (flow) {
    case "status": {
      const [entities, subsystems] = await Promise.all([
        db.entity.findMany({ orderBy: { runsToday: "desc" } }),
        db.subsystem.findMany({ orderBy: { sortOrder: "asc" } }),
      ]);
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      const eventsToday = await db.event.count({ where: { ts: { gte: since } } });
      const op = entities.filter((e) => e.status === "OPERATIONAL").length;
      const okSubs = subsystems.filter((s) => s.status === "OK").length;
      const top = entities.filter((e) => e.kind === "AGENT").slice(0, 4);
      const formId = register({
        flow,
        step: "status.pick",
        ctx: {},
        expect: { field: "entity", type: "choice", allowed: top.map((e) => e.slug) },
      });
      const text = pickL(
        deps.locale,
        `Kernel snapshot — ${op}/${entities.length} agents operational · ${eventsToday} events today · subsystems ${okSubs}/${subsystems.length} OK · budget ${deps.budgetPct}%.`,
        `Retrato do kernel — ${op}/${entities.length} agentes operacionais · ${eventsToday} eventos hoje · subsistemas ${okSubs}/${subsystems.length} OK · orçamento ${deps.budgetPct}%.`
      );
      const form: TurnForm = {
        id: formId,
        title: pickL(deps.locale, "Live from the Run Kernel", "Ao vivo do Run Kernel"),
        fields: [
          {
            id: "entity",
            type: "choice",
            style: "list",
            label: pickL(deps.locale, "Which agent should we zoom into?", "Em qual agente quer se aprofundar?"),
            options: top.map((e) => ({
              value: e.slug,
              label: e.name,
              hint: `${e.runsToday} runs · ${e.successRate}%`,
              dot: "success" as const,
            })),
          },
        ],
      };
      return { text, form, actions: null };
    }

    case "diagnose": {
      const options = [
        {
          value: "all",
          label: pickL(deps.locale, "All agents", "Todos os agentes"),
          hint: pickL(deps.locale, "fleet-wide", "toda a frota"),
          dot: "muted" as const,
        },
        ...(await entityOptions(["AGENT", "TOOL"])),
      ];
      const formId = register({
        flow,
        step: "diagnose.target",
        ctx: {},
        expect: { field: "target", type: "choice", allowed: options.map((o) => o.value) },
      });
      return {
        text: pickL(
          deps.locale,
          "Diagnosis — pick a target. I'll cross-check runs, gates and subsystems live from the kernel.",
          "Diagnóstico — escolha o alvo. Vou cruzar runs, gates e subsistemas ao vivo do kernel."
        ),
        form: {
          id: formId,
          fields: [
            {
              id: "target",
              type: "choice",
              style: "chips",
              label: pickL(deps.locale, "Diagnosis target", "Alvo do diagnóstico"),
              options,
            },
          ],
        },
        actions: null,
      };
    }

    case "route": {
      const options = await entityOptions(["AGENT"]);
      const formId = register({
        flow,
        step: "route.task",
        ctx: {},
        expect: { field: "squad", type: "choice", allowed: options.map((o) => o.value) },
      });
      return {
        text: pickL(
          deps.locale,
          "Route a task — which squad should take it? The dispatch is gated by --allow-actions, as in the official engine.",
          "Rotear tarefa — qual squad assume? O despacho é gated por --allow-actions, como no engine oficial."
        ),
        form: {
          id: formId,
          fields: [
            {
              id: "squad",
              type: "choice",
              style: "chips",
              label: pickL(deps.locale, "Target squad", "Squad de destino"),
              options,
            },
          ],
        },
        actions: null,
      };
    }

    case "gate": {
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      const pending = await db.event.findMany({
        where: { kind: "GATE", status: { in: ["WARNING", "FAILED"] }, ts: { gte: since } },
        orderBy: { ts: "desc" },
        take: 5,
      });
      if (pending.length === 0) {
        const last = await db.event.findFirst({ where: { kind: "GATE" }, orderBy: { ts: "desc" } });
        return {
          text: pickL(
            deps.locale,
            `No gates pending today.${last ? ` Last review: “${trunc(last.title, 60)}” at ${fmtTime(last.ts)}.` : ""}`,
            `Nenhum gate pendente hoje.${last ? ` Última revisão: “${trunc(last.title, 60)}” às ${fmtTime(last.ts)}.` : ""}`
          ),
          form: null,
          actions: null,
        };
      }
      const formId = register({
        flow,
        step: "gate.pick",
        ctx: {},
        expect: { field: "gate", type: "choice", allowed: pending.map((p) => String(p.id)) },
      });
      return {
        text: pickL(
          deps.locale,
          `${pending.length} gate${pending.length > 1 ? "s" : ""} with pending review today — pick one to reprocess.`,
          `${pending.length} gate${pending.length > 1 ? "s" : ""} com pendência hoje — escolha um para reprocessar.`
        ),
        form: {
          id: formId,
          fields: [
            {
              id: "gate",
              type: "choice",
              style: "list",
              label: pickL(deps.locale, "Pending gates", "Gates pendentes"),
              options: pending.map((p) => ({
                value: String(p.id),
                label: trunc(p.title, 52),
                hint: fmtTime(p.ts),
                dot: p.status === "FAILED" ? ("danger" as const) : ("warning" as const),
              })),
            },
          ],
        },
        actions: null,
      };
    }
  }
}

// ─── Resposta de formulário (continuação do fluxo) ─────────────────────────

export async function answerFlow(
  formId: string,
  answers: FormAnswers,
  deps: FlowDeps
): Promise<MaestroReply | null> {
  prune();
  const state = flows.get(formId);
  if (!state) return null;
  flows.delete(formId); // um token, um uso

  const first = (v: string | string[] | undefined): string =>
    Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");

  switch (state.step) {
    // ── Status → escolher agente ──
    case "status.pick": {
      const slug = first(answers.entity);
      if (!state.expect?.allowed.includes(slug)) return null;
      const e = await db.entity.findUnique({ where: { slug } });
      if (!e) return null;
      const recent = await db.event.findMany({
        where: { entitySlug: slug },
        orderBy: { ts: "desc" },
        take: 3,
      });
      const recentTxt = recent.length
        ? recent.map((r) => `“${trunc(r.title, 40)}”`).join(pickL(deps.locale, "; ", "; "))
        : pickL(deps.locale, "no recent events", "sem eventos recentes");
      const formId2 = register({
        flow: state.flow,
        step: "status.open",
        ctx: { slug, name: e.name },
        expect: { field: "open", type: "choice", allowed: ["ok", "cancel"] },
      });
      return {
        text: pickL(
          deps.locale,
          `${e.name} — ${e.runsToday} runs today · success ${e.successRate}% · status ${e.status}. Recent: ${recentTxt}.`,
          `${e.name} — ${e.runsToday} runs hoje · sucesso ${e.successRate}% · status ${e.status}. Recentes: ${recentTxt}.`
        ),
        form: {
          id: formId2,
          fields: [
            {
              id: "open",
              type: "confirm",
              label: pickL(deps.locale, `Open ${e.name}'s full card?`, `Abrir o card completo de ${e.name}?`),
              okLabel: pickL(deps.locale, "Open card", "Abrir card"),
              cancelLabel: pickL(deps.locale, "Stay here", "Ficar por aqui"),
            },
          ],
        },
        actions: null,
      };
    }

    case "status.open": {
      if (first(answers.open) === "ok") {
        const actions: MaestroAction[] = [{ type: "open_entity", slug: state.ctx.slug }];
        return {
          text: pickL(deps.locale, `Opening ${state.ctx.name}'s card — the drawer is agent-driven UI.`, `Abrindo o card de ${state.ctx.name} — o drawer é UI dirigida pelo agente.`),
          form: null,
          actions,
        };
      }
      return {
        text: pickL(deps.locale, "Fine — the summary stays here in the thread.", "Fechado — o resumo fica aqui no thread."),
        form: null,
        actions: null,
      };
    }

    // ── Diagnóstico → alvo ──
    case "diagnose.target": {
      const target = first(answers.target);
      if (!state.expect?.allowed.includes(target)) return null;
      const since = new Date(Date.now() - 60 * 60 * 1000);
      const where = {
        ts: { gte: since },
        ...(target === "all" ? {} : { entitySlug: target }),
      };
      const [fails, warns, gateFails, lastEvent, subsystems] = await Promise.all([
        db.event.count({ where: { ...where, status: "FAILED" } }),
        db.event.count({ where: { ...where, status: "WARNING" } }),
        db.event.count({ where: { kind: "GATE", status: "FAILED", ts: { gte: since } } }),
        db.event.findFirst({ where, orderBy: { ts: "desc" } }),
        db.subsystem.findMany({ orderBy: { sortOrder: "asc" } }),
      ]);
      const okN = subsystems.filter((s) => s.status === "OK").length;
      const off = subsystems.filter((s) => s.status !== "OK").map((s) => s.name);
      const label =
        target === "all"
          ? pickL(deps.locale, "all agents", "todos os agentes")
          : (await db.entity.findUnique({ where: { slug: target } }))?.name ?? target;
      const lastTxt = lastEvent ? trunc(lastEvent.title, 52) : pickL(deps.locale, "none", "nenhum");
      const offTxt = off.length ? ` (${off.join(", ")})` : "";
      const formId2 = register({
        flow: state.flow,
        step: "diagnose.confirm",
        ctx: { target, label },
        expect: { field: "act", type: "choice", allowed: ["ok", "cancel"] },
      });
      return {
        text: pickL(
          deps.locale,
          `Diagnosis · ${label} — last 60 min: ${fails} failures · ${warns} warnings · ${gateFails} gate blocks. Last event: “${lastTxt}”. Subsystems: ${okN}/${subsystems.length} OK${offTxt}.`,
          `Diagnóstico · ${label} — últimos 60 min: ${fails} falhas · ${warns} avisos · ${gateFails} bloqueios de gate. Último evento: “${lastTxt}”. Subsistemas: ${okN}/${subsystems.length} OK${offTxt}.`
        ),
        form: {
          id: formId2,
          fields: [
            {
              id: "act",
              type: "confirm",
              label: pickL(deps.locale, `Dispatch a guided remediation for ${label}?`, `Despachar corretiva guiada para ${label}?`),
              okLabel: pickL(deps.locale, "Run corrective", "Executar corretiva"),
              cancelLabel: pickL(deps.locale, "Report only", "Só relatório"),
            },
          ],
        },
        actions: null,
      };
    }

    case "diagnose.confirm": {
      const { target, label } = state.ctx;
      if (first(answers.act) === "ok") {
        if (!deps.allowActions) return { text: gatedText(deps), form: null, actions: null };
        const wire = await deps.emit({
          kind: "RUN",
          status: "SUCCESS",
          title: pickL(deps.locale, `Guided remediation dispatched — ${label}`, `Corretiva guiada despachada — ${label}`),
          detail: pickL(deps.locale, "via maestro v2 · corrective run", "via maestro v2 · run corretivo"),
          entitySlug: target === "all" ? null : target,
        });
        if (target !== "all") {
          await db.entity.update({
            where: { slug: target },
            data: { lastSeenAt: new Date(), runsToday: { increment: 1 } },
          });
        }
        return {
          text: pickL(
            deps.locale,
            `Corrective run #${wire.id} dispatched to ${label} — watch it land in the timeline.`,
            `Run corretivo #${wire.id} despachado para ${label} — acompanhe na timeline.`
          ),
          form: null,
          actions: [{ type: "open_timeline" }],
        };
      }
      await deps.emit({
        kind: "RUN",
        status: "INFO",
        title: pickL(deps.locale, `Diagnosis report filed — ${label}`, `Relatório de diagnóstico registrado — ${label}`),
        detail: pickL(deps.locale, "ledger append-only · no dispatch", "ledger append-only · sem despacho"),
        entitySlug: target === "all" ? null : target,
      });
      return {
        text: pickL(deps.locale, "Report filed to the ledger. No dispatch.", "Relatório registrado no ledger. Nada despachado."),
        form: null,
        actions: null,
      };
    }

    // ── Rota → squad → tarefa ──
    case "route.task": {
      const slug = first(answers.squad);
      if (!state.expect?.allowed.includes(slug)) return null;
      const e = await db.entity.findUnique({ where: { slug } });
      if (!e) return null;
      const formId2 = register({
        flow: state.flow,
        step: "route.confirm",
        ctx: { slug, name: e.name },
        expect: { field: "task", type: "multi", allowed: [] },
      });
      return {
        text: pickL(deps.locale, `${e.name} selected (${e.runsToday} runs today). Now — what's the task?`, `${e.name} selecionado (${e.runsToday} runs hoje). Agora — qual é a tarefa?`),
        form: {
          id: formId2,
          fields: [
            {
              id: "task",
              type: "text",
              label: pickL(deps.locale, `Describe the task for ${e.name}`, `Descreva a tarefa para ${e.name}`),
              placeholder: pickL(
                deps.locale,
                "e.g. collect March invoices from Stripe",
                "ex.: coletar faturas de março no Stripe"
              ),
              submitLabel: pickL(deps.locale, "Review dispatch", "Revisar despacho"),
              maxLen: 160,
            },
          ],
        },
        actions: null,
      };
    }

    case "route.confirm": {
      const { slug, name } = state.ctx;
      const task = first(answers.task).trim().slice(0, 160);
      if (!task) return null;
      const formId3 = register({
        flow: state.flow,
        step: "route.dispatch",
        ctx: { slug, name, task },
        expect: { field: "go", type: "choice", allowed: ["ok", "cancel"] },
      });
      return {
        text: pickL(deps.locale, `Task captured: “${trunc(task, 80)}”`, `Tarefa capturada: “${trunc(task, 80)}”`),
        form: {
          id: formId3,
          fields: [
            {
              id: "go",
              type: "confirm",
              label: pickL(deps.locale, `Dispatch to ${name}?`, `Despachar para ${name}?`),
              okLabel: pickL(deps.locale, "Dispatch now", "Despachar agora"),
              cancelLabel: pickL(deps.locale, "Cancel", "Cancelar"),
            },
          ],
        },
        actions: null,
      };
    }

    case "route.dispatch":
      return answerDispatch(state.ctx, first(answers.go), deps);

    // ── Gate → escolher → confirmar ──
    case "gate.pick": {
      const idNum = Number(first(answers.gate));
      if (!state.expect?.allowed.includes(String(idNum)) || !Number.isFinite(idNum)) return null;
      const ev = await db.event.findUnique({ where: { id: idNum } });
      if (!ev) return null;
      const formId2 = register({
        flow: state.flow,
        step: "gate.confirm",
        ctx: { eventId: String(ev.id), title: ev.title },
        expect: { field: "go", type: "choice", allowed: ["ok", "cancel"] },
      });
      return {
        text: pickL(
          deps.locale,
          `Gate “${trunc(ev.title, 60)}” (${fmtTime(ev.ts)}) — reprocessing appends a GATE event to the ledger.`,
          `Gate “${trunc(ev.title, 60)}” (${fmtTime(ev.ts)}) — reprocessar registra um evento GATE no ledger.`
        ),
        form: {
          id: formId2,
          fields: [
            {
              id: "go",
              type: "confirm",
              label: pickL(deps.locale, "Reprocess this gate?", "Reprocessar este gate?"),
              okLabel: pickL(deps.locale, "Reprocess gate", "Reprocessar gate"),
              cancelLabel: pickL(deps.locale, "Leave as is", "Deixar como está"),
            },
          ],
        },
        actions: null,
      };
    }

    case "gate.confirm": {
      if (first(answers.go) === "ok") {
        if (!deps.allowActions) return { text: gatedText(deps), form: null, actions: null };
        const wire = await deps.emit({
          kind: "GATE",
          status: "SUCCESS",
          title: pickL(deps.locale, `Gate reprocessed — ${trunc(state.ctx.title, 44)}`, `Gate reprocessado — ${trunc(state.ctx.title, 44)}`),
          detail: pickL(deps.locale, "reprocess · via maestro v2", "reprocess · via maestro v2"),
        });
        return {
          text: pickL(
            deps.locale,
            `Gate reprocessed — PASS appended (#${wire.id}). The pending gate can stay for the record.`,
            `Gate reprocessado — PASS registrado (#${wire.id}). A pendência original segue no histórico.`
          ),
          form: null,
          actions: [{ type: "open_timeline" }],
        };
      }
      return {
        text: pickL(
          deps.locale,
          "Left as is — the pending gate stays visible in the timeline for review.",
          "Deixado como está — a pendência segue visível na timeline para revisão."
        ),
        form: null,
        actions: null,
      };
    }
  }

  return null;
}

/** Despacho final do fluxo de rota (compartilhado pelos dois caminhos de step). */
async function answerDispatch(
  ctx: Record<string, string>,
  go: string,
  deps: FlowDeps
): Promise<MaestroReply> {
  if (go === "ok") {
    if (!deps.allowActions) return { text: gatedText(deps), form: null, actions: null };
    const wire = await deps.emit({
      kind: "RUN",
      status: "SUCCESS",
      title: pickL(deps.locale, `Run dispatched by maestro — ${trunc(ctx.task, 40)}`, `Run despachado pelo maestro — ${trunc(ctx.task, 40)}`),
      detail: `target: squad:${ctx.slug} · via agentic forms`,
      entitySlug: ctx.slug,
    });
    await db.entity.update({
      where: { slug: ctx.slug },
      data: { lastSeenAt: new Date(), runsToday: { increment: 1 } },
    });
    return {
      text: pickL(
        deps.locale,
        `Run #${wire.id} live on ${ctx.name} — follow it in the timeline.`,
        `Run #${wire.id} ao vivo em ${ctx.name} — acompanhe na timeline.`
      ),
      form: null,
      actions: [{ type: "open_timeline" }],
    };
  }
  return {
    text: pickL(deps.locale, "Dispatch cancelled — nothing was recorded.", "Despacho cancelado — nada foi registrado."),
    form: null,
    actions: null,
  };
}

/** Palavras-chave de texto livre que iniciam fluxos (PT/EN). */
export function matchFlowIntent(message: string): FlowId | null {
  const m = message.toLowerCase();
  if (/(diagno|diagn|diagnóst)/.test(m)) return "diagnose";
  if (/(route|rota|despach|tarefa|task|dispatch)/.test(m)) return "route";
  if (/(gate|porta|aprova|revis)/.test(m)) return "gate";
  if (/(status|saúde|saude|health|resumo|snapshot)/.test(m)) return "status";
  return null;
}
