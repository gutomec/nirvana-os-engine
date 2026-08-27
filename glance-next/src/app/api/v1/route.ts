import { enginePollTurn, engineSubmitTurn, isEngineMode } from "@/lib/engine-client";
import { getEngine } from "@/lib/event-engine";
import type { FlowId } from "@/lib/maestro-flows";
import type { FormAnswers } from "@/lib/types";

export const dynamic = "force-dynamic";

const FLOW_IDS: FlowId[] = ["diagnose", "route", "gate", "status"];

function badRequest(hint: string, status = 400) {
  return Response.json({ error: "bad_request", hint }, { status });
}

function sanitizeAnswers(raw: unknown): FormAnswers | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: FormAnswers = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length > 64) return null;
    if (typeof v === "string") {
      if (v.length > 200) return null;
      out[k] = v;
    } else if (Array.isArray(v) && v.every((x) => typeof x === "string") && v.length <= 12) {
      out[k] = v as string[];
    } else {
      return null;
    }
  }
  return out;
}

/**
 * POST /api/v1 — dispara um turno do maestro (Ask bar v2).
 * Corpo: { message, target?, intent?, form?: { id, answers }, locale? }
 * - `intent` inicia um fluxo guiado (chips ou palavra-chave já resolvida no engine).
 * - `form` responde um formulário gerado pelo maestro (Agentic Forms).
 * Modo engine: repassa para o upstream com `Idempotency-Key` (conversa textual,
 * `reply` null — os fluxos guiados são do kernel simulado). Sem upstream, o
 * kernel simulado com formulários em tempo real.
 */
export async function POST(req: Request) {
  let body: {
    message?: string;
    target?: string | null;
    intent?: string | null;
    form?: { id?: string; answers?: unknown };
    locale?: string;
  };
  try {
    body = await req.json();
  } catch {
    return badRequest("JSON inválido.");
  }

  const message = (body.message ?? "").trim();
  if (!message) return badRequest("Mensagem vazia.");
  if (message.length > 500) return badRequest("Mensagem longa demais (máx. 500).");
  const target = body.target?.trim() || null;
  if (target && !/^(squad|business):[\w-]+$/.test(target)) {
    return badRequest('Target deve ser "squad:<slug>" ou "business:<slug>".');
  }
  const locale = body.locale === "pt-BR" ? "pt-BR" : "en";
  const intent =
    typeof body.intent === "string" && (FLOW_IDS as string[]).includes(body.intent)
      ? (body.intent as FlowId)
      : null;
  const form =
    body.form && typeof body.form.id === "string" && body.form.id.length <= 64
      ? (() => {
          const answers = sanitizeAnswers(body.form?.answers);
          return answers ? { id: body.form!.id as string, answers } : null;
        })()
      : null;

  if (isEngineMode()) {
    const idemKey = req.headers.get("idempotency-key") ?? crypto.randomUUID();
    const upstream = await engineSubmitTurn(target ? `${message} (${target})` : message, idemKey);
    if (upstream) {
      return Response.json(
        { turn: upstream.turn, reply: null },
        { status: upstream.turn.state === "NO_MATCH" ? 422 : 202 }
      );
    }
    // upstream indisponível → cai no simulado abaixo
  }

  const engine = getEngine();
  await engine.ready;
  const idemKey = req.headers.get("idempotency-key");
  const { turn, reply } = await engine.createTurn(message, target, idemKey, { locale, intent, form });
  return Response.json({ turn, reply: reply ?? null }, { status: turn.state === "NO_MATCH" ? 422 : 202 });
}

/** GET /api/v1?turnId= — consulta estado do turno + resposta rica (polling). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const turnId = Number(url.searchParams.get("turnId"));
  if (!turnId) return badRequest("turnId obrigatório.");

  if (isEngineMode()) {
    const upstream = await enginePollTurn(turnId);
    if (upstream) {
      return Response.json(
        { turn: upstream, reply: null },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
  }

  const engine = getEngine();
  const found = await engine.getTurnWithReply(turnId);
  if (!found) {
    return Response.json({ error: "not_found", hint: "Turno não encontrado." }, { status: 404 });
  }
  return Response.json(found, { headers: { "Cache-Control": "no-store" } });
}
