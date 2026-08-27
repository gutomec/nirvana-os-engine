"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowUp,
  Check,
  Gauge,
  Loader2,
  RotateCcw,
  Route,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type {
  BusinessDTO,
  EntityDTO,
  FormAnswers,
  FormField,
  FormOption,
  MaestroAction,
  MaestroReply,
  TurnDTO,
  TurnForm,
  TurnState,
} from "@/lib/types";

interface TargetChip {
  type: "squad" | "business";
  slug: string;
  label: string;
}

interface AskBarProps {
  entities: EntityDTO[];
  businesses: BusinessDTO[];
  /** Rail sumido: desloca a barra quando o menu está revelado. */
  railOpen: boolean;
  onOpenEntity?: (slug: string) => void;
  onOpenProjects?: () => void;
}

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
  form?: TurnForm | null;
  formAnswered?: boolean;
  answerEcho?: string | null;
  turnId?: number | null;
  state?: TurnState | null;
  durationMs?: number | null;
  budgetPct?: number | null;
  actions?: MaestroAction[] | null;
}

type TurnPhase =
  | { kind: "idle" }
  | { kind: "running"; turn: TurnDTO }
  | { kind: "done"; turn: TurnDTO };

const FLOW_CHIPS = [
  { intent: "diagnose", labelKey: "ask.flow.diagnose", icon: Activity },
  { intent: "route", labelKey: "ask.flow.route", icon: Route },
  { intent: "gate", labelKey: "ask.flow.gate", icon: ShieldCheck },
  { intent: "status", labelKey: "ask.flow.status", icon: Gauge },
] as const;

const DOT_CLASS: Record<NonNullable<FormOption["dot"]>, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  muted: "bg-muted-foreground/60",
};

const OPT_DOT = ({ dot }: { dot?: FormOption["dot"] }) =>
  dot ? <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", DOT_CLASS[dot])} /> : null;

// ─── Formulário gerado pelo maestro (Agentic Forms) ───────────────────────

function FormCard({
  form,
  onAnswer,
}: {
  form: TurnForm;
  onAnswer: (fieldId: string, value: string | string[], echo: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="mt-2 space-y-2.5 rounded-lg border border-border bg-background p-3">
      {form.title && <p className="label-caps text-muted-foreground">{form.title}</p>}
      {form.fields.map((field) => (
        <FormFieldView key={field.id} field={field} onAnswer={onAnswer} />
      ))}
      {/* fallback silencioso para tipos desconhecidos */}
      <span className="sr-only">{t("ask.form.inputAria")}</span>
    </div>
  );
}

function FormFieldView({
  field,
  onAnswer,
}: {
  field: FormField;
  onAnswer: (fieldId: string, value: string | string[], echo: string) => void;
}) {
  const { t } = useI18n();
  const [multiSel, setMultiSel] = useState<string[]>([]);
  const [textVal, setTextVal] = useState("");

  if (field.type === "choice") {
    if (field.style === "list") {
      return (
        <div>
          <p className="text-[13px] text-foreground">{field.label}</p>
          <div className="mt-1.5 flex flex-col gap-1">
            {field.options.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => onAnswer(field.id, o.value, o.label)}
                className="flex h-10 w-full items-center gap-2 rounded-md border border-border bg-card px-3 text-left text-[13px] text-foreground transition-colors hover:bg-secondary"
              >
                <OPT_DOT dot={o.dot} />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.hint && <span className="font-mono text-[11px] text-muted-foreground">{o.hint}</span>}
              </button>
            ))}
          </div>
        </div>
      );
    }
    return (
      <div>
        <p className="text-[13px] text-foreground">{field.label}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {field.options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => onAnswer(field.id, o.value, o.label)}
              title={o.hint}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-[13px] text-foreground transition-colors hover:bg-secondary"
            >
              <OPT_DOT dot={o.dot} />
              {o.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (field.type === "multi") {
    const toggle = (v: string) =>
      setMultiSel((prev) =>
        prev.includes(v) ? prev.filter((x) => x !== v) : field.max && prev.length >= field.max ? prev : [...prev, v]
      );
    return (
      <div>
        <p className="text-[13px] text-foreground">{field.label}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {field.options.map((o) => (
            <button
              key={o.value}
              type="button"
              aria-pressed={multiSel.includes(o.value)}
              onClick={() => toggle(o.value)}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors",
                multiSel.includes(o.value)
                  ? "border-transparent bg-secondary text-foreground"
                  : "border-border bg-card text-foreground hover:bg-secondary"
              )}
            >
              <OPT_DOT dot={o.dot} />
              {o.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={multiSel.length === 0}
          onClick={() => {
            const labels = field.options
              .filter((o) => multiSel.includes(o.value))
              .map((o) => o.label)
              .join(", ");
            onAnswer(field.id, multiSel, labels);
          }}
          className="mt-2 inline-flex h-9 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {t("ask.form.multiSubmit")}
        </button>
      </div>
    );
  }

  if (field.type === "confirm") {
    return (
      <div>
        <p className="text-[13px] text-foreground">{field.label}</p>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => onAnswer(field.id, "ok", field.okLabel)}
            className={cn(
              "inline-flex h-9 items-center rounded-md px-3.5 text-[13px] font-medium transition-opacity hover:opacity-90",
              field.tone === "danger" ? "bg-danger text-white" : "bg-primary text-primary-foreground"
            )}
          >
            {field.okLabel}
          </button>
          <button
            type="button"
            onClick={() => onAnswer(field.id, "cancel", field.cancelLabel)}
            className="inline-flex h-9 items-center rounded-md border border-border px-3.5 text-[13px] text-foreground transition-colors hover:bg-secondary"
          >
            {field.cancelLabel}
          </button>
        </div>
      </div>
    );
  }

  // text
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const v = textVal.trim();
        if (!v) return;
        onAnswer(field.id, v, `“${v}”`);
      }}
      className="flex items-center gap-2"
    >
      <label className="sr-only" htmlFor={`ff-${field.id}`}>
        {field.label}
      </label>
      <input
        id={`ff-${field.id}`}
        value={textVal}
        onChange={(e) => setTextVal(field.maxLen ? e.target.value.slice(0, field.maxLen) : e.target.value)}
        placeholder={field.placeholder}
        autoComplete="off"
        className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
      />
      <button
        type="submit"
        disabled={!textVal.trim()}
        className="inline-flex h-10 shrink-0 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {field.submitLabel ?? t("ask.send")}
      </button>
    </form>
  );
}

/** Formulário já respondido — eco do que o operador respondeu. */
function AnsweredForm({ echo, label }: { echo?: string | null; label: string }) {
  const { t } = useI18n();
  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2">
      <Check className="size-3.5 shrink-0 text-success" aria-hidden />
      <span className="label-caps shrink-0 text-muted-foreground">{t("ask.form.answered")}</span>
      <span className="min-w-0 truncate text-[13px] text-foreground">{echo ?? label}</span>
    </div>
  );
}

// ─── Ask bar v2 ───────────────────────────────────────────────────────────

/** RF-6 · Ask bar v2: pill canônica + thread de conversa + formulários gerados pelo maestro. */
export function AskBar({ entities, businesses, railOpen, onOpenEntity, onOpenProjects }: AskBarProps) {
  const { t, locale } = useI18n();
  const [value, setValue] = useState("");
  const [target, setTarget] = useState<TargetChip | null>(null);
  const [focused, setFocused] = useState(false);
  const [phase, setPhase] = useState<TurnPhase>({ kind: "idle" });
  const [thread, setThread] = useState<ChatMsg[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [thinking, setThinking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Autocomplete `use squad:`/`use business:` (RF-6) — preservado do M1.
  const suggestions = useMemo(() => {
    const q = value.trim().toLowerCase();
    const all: TargetChip[] = [
      ...entities.map((e) => ({ type: "squad" as const, slug: e.slug, label: e.name })),
      ...businesses.map((b) => ({ type: "business" as const, slug: b.slug, label: b.name })),
    ];
    const m = q.match(/use\s+(squad|business):([\w-]*)$/);
    if (m) return all.filter((s) => s.type === m[1] && s.slug.startsWith(m[2]));
    return all;
  }, [value, entities, businesses]);

  const showAutocomplete =
    focused &&
    phase.kind !== "running" &&
    !thinking &&
    suggestions.length > 0 &&
    (value.trim().length > 0 || (!chatOpen && thread.length === 0));

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setFocused(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    []
  );

  // Auto-scroll do thread para a última mensagem.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.length, thinking]);

  const execActions = useCallback(
    (actions: MaestroAction[] | null | undefined) => {
      if (!actions?.length) return;
      window.setTimeout(() => {
        for (const a of actions) {
          if (a.type === "open_entity" && a.slug) onOpenEntity?.(a.slug);
          else if (a.type === "open_timeline")
            document.getElementById("event-timeline")?.scrollIntoView({ behavior: "smooth", block: "start" });
          else if (a.type === "open_projects") onOpenProjects?.();
        }
      }, 350);
    },
    [onOpenEntity, onOpenProjects]
  );

  const pushAssistant = useCallback(
    (turn: TurnDTO, reply: MaestroReply | null) => {
      setThinking(false);
      setPhase({ kind: "done", turn });
      const msg: ChatMsg = {
        id: `a-${turn.id}`,
        role: "assistant",
        text: reply?.text ?? turn.detail ?? t("ask.turnCompleted"),
        ts: Date.now(),
        form: reply?.form ?? null,
        turnId: turn.id,
        state: turn.state,
        durationMs: turn.durationMs,
        budgetPct: turn.budgetPct,
        actions: reply?.actions ?? null,
      };
      setThread((prev) => [...prev, msg]);
      execActions(msg.actions);
      if (turn.state === "COMPLETED") {
        toast.success(turn.detail ?? t("ask.turnCompleted"));
      } else if (turn.state === "ROLLED_BACK") {
        toast.warning(turn.detail ?? "rolled_back: no_dispatchable_target");
      } else {
        toast.error(turn.detail ?? t("ask.turnFailed"));
      }
    },
    [execActions, t]
  );

  const send = useCallback(
    async (payload: {
      message: string;
      target?: string | null;
      intent?: string;
      form?: { id: string; answers: FormAnswers };
    }) => {
      const text = payload.message.trim();
      if (!text || phase.kind === "running" || thinking) return;

      setThread((prev) => [
        ...prev,
        { id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, role: "user", text, ts: Date.now() },
      ]);
      setThinking(true);
      setChatOpen(true);
      setValue("");
      setTarget(null);
      setFocused(false);

      try {
        const res = await fetch("/api/v1", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ ...payload, message: text, locale }),
        });
        const json = (await res.json()) as { turn?: TurnDTO; reply?: MaestroReply | null; hint?: string };
        if (!json.turn) {
          setThinking(false);
          setThread((prev) => [
            ...prev,
            { id: `a-err-${Date.now()}`, role: "assistant", text: json.hint ?? t("error.turnRequest"), ts: Date.now(), state: "FAILED" },
          ]);
          toast.error(json.hint ?? t("error.turnRequest"));
          return;
        }
        let turn = json.turn;
        setPhase({ kind: turn.state === "RUNNING" ? "running" : "done", turn });

        if (turn.state === "RUNNING") {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = setInterval(async () => {
            const r = await fetch(`/api/v1?turnId=${turn.id}`, { cache: "no-store" });
            const j = (await r.json()) as { turn?: TurnDTO; reply?: MaestroReply | null };
            if (j.turn && j.turn.state !== "RUNNING") {
              if (pollRef.current) clearInterval(pollRef.current);
              pushAssistant(j.turn, j.reply ?? null);
            }
          }, 700);
        } else {
          pushAssistant(turn, json.reply ?? null);
        }
      } catch {
        setThinking(false);
        setThread((prev) => [
          ...prev,
          { id: `a-net-${Date.now()}`, role: "assistant", text: t("error.turnRequest"), ts: Date.now(), state: "FAILED" },
        ]);
        toast.error(t("error.turnRequest"));
      }
    },
    [phase.kind, thinking, locale, pushAssistant, t]
  );

  const answerForm = useCallback(
    (msg: ChatMsg, fieldId: string, fieldValue: string | string[], echo: string) => {
      if (!msg.form || msg.formAnswered) return;
      setThread((prev) =>
        prev.map((m) => (m.id === msg.id ? { ...m, formAnswered: true, answerEcho: echo } : m))
      );
      void send({ message: echo, form: { id: msg.form.id, answers: { [fieldId]: fieldValue } } });
    },
    [send]
  );

  const pickTarget = (chip: TargetChip) => {
    setTarget(chip);
    setValue((v) => v.replace(/\s*use\s+(squad|business):[\w-]*\s*$/i, "").trimEnd());
    inputRef.current?.focus();
  };

  const submitTyped = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      const raw = value.trim();
      if (!raw || phase.kind === "running" || thinking) return;

      let message = raw;
      let resolved: TargetChip | null = target;
      const m = raw.match(/use\s+(squad|business):([\w-]+)\s*$/i);
      if (m) {
        const slug = m[2].toLowerCase();
        const known = entities.find((x) => x.slug === slug) ?? businesses.find((b) => b.slug === slug);
        resolved = { type: m[1].toLowerCase() as "squad" | "business", slug, label: known?.name ?? slug };
        message = raw.replace(/use\s+(squad|business):[\w-]+\s*$/i, "").trim() || raw;
      }
      void send({ message, target: resolved ? `${resolved.type}:${resolved.slug}` : null });
    },
    [value, phase.kind, thinking, target, entities, businesses, send]
  );

  const turn = phase.kind === "idle" ? null : phase.turn;
  const avatarDot =
    phase.kind === "running"
      ? "bg-warning dot-pulse"
      : turn && turn.state !== "COMPLETED"
        ? "bg-danger"
        : "bg-success";

  return (
    <div
      ref={boxRef}
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/90 backdrop-blur",
        railOpen ? "left-14 md:left-16" : "left-0"
      )}
    >
      <div className="mx-auto w-full max-w-6xl px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 md:px-6">
        {/* ── Thread da conversa (Agentic Forms) ── */}
        {chatOpen && !showAutocomplete && (
          <div
            role="log"
            aria-live="polite"
            aria-label={t("ask.threadAria")}
            className="absolute bottom-full left-4 right-4 mb-2 flex max-h-[min(48vh,430px)] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-md md:left-6 md:right-auto md:w-[560px]"
          >
            {/* Chips de fluxos guiados (entrada sem digitação) */}
            <div
              role="toolbar"
              aria-label={t("ask.flowsAria")}
              className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border bg-popover/95 px-2.5 py-2 scroll-slim backdrop-blur"
            >
              {FLOW_CHIPS.map(({ intent, labelKey, icon: Icon }) => (
                <button
                  key={intent}
                  type="button"
                  disabled={thinking || phase.kind === "running"}
                  onClick={() => void send({ message: t(labelKey), intent })}
                  className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
                >
                  <Icon className="size-3" aria-hidden />
                  {t(labelKey)}
                </button>
              ))}
            </div>

            <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 scroll-slim">
              {thread.length === 0 && !thinking && (
                <p className="px-1 py-2 text-[13px] leading-relaxed text-muted-foreground">{t("ask.threadEmpty")}</p>
              )}

              {thread.map((msg) =>
                msg.role === "user" ? (
                  <div key={msg.id} className="ev-enter flex justify-end">
                    <p className="max-w-[85%] rounded-lg rounded-br-sm bg-secondary px-3 py-2 text-sm text-foreground">
                      {msg.text}
                    </p>
                  </div>
                ) : (
                  <div key={msg.id} className="ev-enter max-w-[94%]">
                    <p className="text-sm leading-relaxed text-foreground">{msg.text}</p>
                    {msg.form &&
                      (msg.formAnswered ? (
                        <AnsweredForm echo={msg.answerEcho} label={msg.form.fields[0]?.label ?? ""} />
                      ) : (
                        <FormCard form={msg.form} onAnswer={(fid, v, echo) => answerForm(msg, fid, v, echo)} />
                      ))}
                    {msg.state && (
                      <p
                        className={cn(
                          "mt-1.5 font-mono text-[11px]",
                          msg.state === "COMPLETED"
                            ? "text-muted-foreground"
                            : msg.state === "ROLLED_BACK"
                              ? "text-warning"
                              : "text-danger"
                        )}
                      >
                        {msg.state === "COMPLETED"
                          ? `${t("ask.state.completed")}${msg.durationMs ? ` · ${(msg.durationMs / 1000).toFixed(1)}s` : ""} · ${t("ask.budget")} ${msg.budgetPct ?? "—"}%`
                          : msg.state === "ROLLED_BACK"
                            ? t("ask.state.rolled_back")
                            : t("ask.state.failed")}
                      </p>
                    )}
                  </div>
                )
              )}

              {thinking && (
                <div className="flex items-center gap-2" role="status">
                  <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
                  <span className="font-mono text-[11px] text-muted-foreground">{t("ask.thinking")}</span>
                </div>
              )}
            </div>
          </div>
        )}

        <form onSubmit={submitTyped} className="flex items-center gap-3" aria-label={t("ask.aria")}>
          {/* Avatar da sessão local (Q4: ligado ao estado da conversa; clique abre o thread) */}
          <button
            type="button"
            onClick={() => setChatOpen((v) => !v)}
            aria-label={t("ask.threadAria")}
            aria-expanded={chatOpen}
            className="relative shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <div className="flex size-9 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
              AD
            </div>
            <span
              className={cn(
                "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background",
                avatarDot
              )}
            />
          </button>

          {/* Campo único arredondado com chip de target dentro */}
          <div
            className={cn(
              "flex h-12 min-w-0 flex-1 items-center gap-2 rounded-full border border-input bg-card pl-2 pr-1.5 transition-shadow focus-within:ring-2 focus-within:ring-ring/30",
              phase.kind === "running" && "opacity-90"
            )}
          >
            {target && (
              <span className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium text-foreground/85">
                {t("ask.using")} {target.type}:{target.slug}
                <button
                  type="button"
                  onClick={() => setTarget(null)}
                  aria-label={t("ask.clearTarget")}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            )}
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onFocus={() => setFocused(true)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setFocused(false);
                  (e.target as HTMLInputElement).blur();
                }
              }}
              disabled={phase.kind === "running"}
              placeholder={t("ask.placeholder")}
              aria-label={t("ask.aria")}
              autoComplete="off"
              className="h-full min-w-0 flex-1 bg-transparent px-2 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
            />
            <button
              type="submit"
              disabled={!value.trim() || phase.kind === "running" || thinking}
              aria-label={t("ask.send")}
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {phase.kind === "running" || thinking ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <ArrowUp className="size-4" aria-hidden />
              )}
            </button>
          </div>
        </form>

        {/* Sub-linha de estado inline (RF-6) */}
        <div className="mt-1.5 flex min-h-[18px] items-center gap-1.5 px-1 text-xs" role="status" aria-live="polite">
          {phase.kind === "running" && turn && (
            <>
              <Loader2 className="size-3 animate-spin text-muted-foreground" aria-hidden />
              <span className="font-mono text-muted-foreground">
                {t("ask.state.running")} · {t("ask.target")} {turn.target ?? "auto"} · {t("ask.budget")} {turn.budgetPct}%
              </span>
            </>
          )}
          {phase.kind === "done" && turn?.state === "COMPLETED" && (
            <>
              <Check className="size-3 text-success" aria-hidden />
              <span className="font-mono text-muted-foreground">
                {t("ask.state.completed")}
                {turn.durationMs ? ` · ${(turn.durationMs / 1000).toFixed(1)}s` : ""} · {t("ask.budget")} {turn.budgetPct}% ·{" "}
                <button
                  type="button"
                  className="underline decoration-border underline-offset-2 hover:text-foreground"
                  onClick={() => setPhase({ kind: "idle" })}
                >
                  {t("ask.dismiss")}
                </button>
              </span>
            </>
          )}
          {phase.kind === "done" && turn?.state === "ROLLED_BACK" && (
            <>
              <RotateCcw className="size-3 text-warning" aria-hidden />
              <span className="font-mono text-warning">{turn.detail ?? t("ask.state.rolled_back")}</span>
            </>
          )}
          {(phase.kind === "done" && (turn?.state === "FAILED" || turn?.state === "NO_MATCH")) && (
            <>
              <TriangleAlert className="size-3 text-danger" aria-hidden />
              <span className="font-mono text-danger">{turn.detail ?? t("ask.state.failed")}</span>
            </>
          )}
        </div>

        {/* Painel de autocomplete (prioridade sobre o thread quando digitando) */}
        {showAutocomplete && (
          <div
            role="listbox"
            aria-label={t("ask.suggestionsAria")}
            className="absolute inset-x-4 bottom-full mb-2 max-h-64 overflow-y-auto scroll-slim rounded-lg border border-border bg-popover p-1.5 shadow-md md:left-6 md:right-auto md:w-[420px]"
          >
            <p className="label-caps px-2.5 pb-1 pt-2 text-muted-foreground">{t("ask.hint.squad")}</p>
            {suggestions
              .filter((s) => s.type === "squad")
              .map((s) => (
                <button
                  key={s.slug}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => pickTarget(s)}
                  className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-secondary"
                >
                  <span className="font-mono text-xs text-foreground">use squad: {s.slug}</span>
                  <span className="text-xs text-muted-foreground">{s.label}</span>
                </button>
              ))}
            <p className="label-caps px-2.5 pb-1 pt-2 text-muted-foreground">{t("ask.hint.business")}</p>
            {suggestions
              .filter((s) => s.type === "business")
              .map((s) => (
                <button
                  key={s.slug}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => pickTarget(s)}
                  className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-secondary"
                >
                  <span className="font-mono text-xs text-foreground">use business: {s.slug}</span>
                  <span className="text-xs text-muted-foreground">{s.label}</span>
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
