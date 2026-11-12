// decision-runtime.ts: a decision model picks the runtime when nothing else did.
//
// The default is always the session host: the user working in Claude Code gets
// Claude Code. This runs only when the user asked the engine to choose the
// runtime (`nrv dispatch --runtime auto`) and no brief mention or USE_* rule
// named one, and only with a hosted or local decision model: asking a CLI which
// CLI to use would spend a subscription to save one. The pick must clear
// decision.min_confidence; otherwise the host stands.

import type { Runtime } from "../../_shared/lib/host-agent-driver.ts";
import { decide, isDecisionError, settingText, type DecisionResult } from "../../_shared/lib/decision-model.ts";

/** What each runtime is, for the decision model. Vendor and model family first,
 *  then what that family is known to handle well. Kept factual and short. */
export const RUNTIME_PROFILES: Partial<Record<Runtime, string>> = {
  "claude-code": "Anthropic Claude through Claude Code: long multi-step coding, refactors, careful long-form writing.",
  codex: "OpenAI GPT through the Codex CLI: code changes and terminal-heavy engineering tasks.",
  "antigravity-cli": "Google Gemini through Antigravity: very large context, images, video and PDFs as input, research with Google Search.",
  "kimi-cli": "Moonshot Kimi through the Kimi CLI: long-context reading and coding.",
  "grok-cli": "xAI Grok through the Grok CLI: current events and posts on X.",
  pi: "Pi coding agent, model chosen by the user's own configuration.",
  "qwen-code": "Alibaba Qwen through Qwen Code: coding.",
  opencode: "OpenCode, model chosen by the user's own configuration.",
};

export interface RuntimePick {
  runtime: Runtime;
  confidence: number;
  provider: string;
  probabilities: Record<string, number>;
}

/** The runtime a decision model picks for the brief, or null (off, no
 *  provider, one candidate, an error, or a pick below the confidence floor). */
export async function chooseRuntimeByDecision(opts: {
  brief: string;
  candidates: Runtime[];
  host: Runtime;
  decideFn?: typeof decide;
}): Promise<RuntimePick | null> {
  const candidates = [...new Set(opts.candidates)];
  if (candidates.length < 2 || !opts.brief.trim()) return null;
  const options: Record<string, string> = {};
  for (const rt of candidates) {
    options[rt] = (RUNTIME_PROFILES[rt] ?? rt) + (rt === opts.host ? " This is the session the user is working in." : "");
  }
  const r = await (opts.decideFn ?? decide)({
    state: opts.brief.slice(0, 12_000),
    questions: {
      runtime: {
        type: "choice",
        instructions: "Which agent runtime should carry out this task? Keep the session the user is working in unless another runtime clearly fits the task better.",
        options,
      },
    },
  }, { apiOnly: true });
  if (isDecisionError(r)) return null;
  const a = (r as DecisionResult).answers.runtime;
  if (a?.type !== "choice" || !candidates.includes(a.choice as Runtime)) return null;
  const confidence = a.confidence ?? 0;
  const floor = Number(settingText("decision.min_confidence") || 0.7);
  if (confidence < floor) return null;
  return { runtime: a.choice as Runtime, confidence, provider: r.provider, probabilities: a.probabilities };
}
