// local-llm.ts — minimal LLM helper used by the Studio planner when no
// upstream endpoint is configured. Uses the engine runtime's builtin
// OpenAI-compatible proxy (OPENAI_API_BASE preconfigured).
//
// The proxy only accepts models from its live catalog; the default model is
// the fastest/cheapest one (gpt-5-nano). `max_tokens` is translated to the
// family-correct key when a model is known to need it.

interface LocalOptions { model?: string; temperature?: number; maxTokens?: number }

export async function chatLocal(system: string, user: string, opts: LocalOptions = {}): Promise<string> {
  let { model = "gpt-5-nano", temperature = 0.4, maxTokens = 8000 } = opts;
  // `local` is the planner's sentinel for "default catalog model".
  if (model === "local") model = "gpt-5-nano";
  const base = process.env.OPENAI_API_BASE;
  if (!base) throw new Error("local-llm: OPENAI_API_BASE is not set");
  const key = process.env.OPENAI_API_KEY ?? "";
  const body: Record<string, unknown> = {
    model,
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (model.startsWith("gpt")) body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;
  const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`local-llm: upstream ${res.status} ${await res.text().then((t) => t.slice(0, 300))}`);
  }
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error(`local-llm: empty or missing content (finish=${data.choices?.[0]?.finish_reason ?? "unknown"}, error=${JSON.stringify(data.error).slice(0, 300)})`);
  }
  return content;
}
