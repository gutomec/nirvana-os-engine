# Decision models (System One)

Researched 2026-11-11. Prices and limits move fast; re-check the vendor pages before relying on a number.

A decision model does not write text. It reads a **state** (text, JSON, and for some vendors images, audio, video or PDFs) and answers **closed questions** with calibrated probabilities. The answer comes back in 150 to 900 ms and costs cents per thousand calls, since output tokens are free. Three question types exist everywhere: yes/no, a choice among named options, and a score on an ordered scale. Each answer carries a probability per option and, on most vendors, a separate confidence.

They fit the parts of Nirvana-OS where a text model was spending seconds and tokens to pick from a known list: which finalist executes a brief, which runtime carries it, and whether a delivery passes.

## The systems

| | TypeSafe Jev | Gemini Decision 1 | OpenAI Decisions | AutoTrust JEV-27B |
|---|---|---|---|---|
| Launched | 2026-09-15 | 2026-11-11 | 2026-09-29 (DevDay), GA in October | late September 2026 |
| Model id | `jev-latest` (1.14 on 2026-11-11) | `gemini-decision-1` | `gpt-6-luna` | `autotrust/JEV-27B` |
| Endpoint | `POST https://api.typesafe.ai/v1/systemone` | `POST https://generativelanguage.googleapis.com/v1beta/decisions` | `POST https://api.openai.com/v1/decisions` | `POST <your server>/v1/decide` |
| Auth | `Authorization: Bearer $TYPESAFE_API_KEY` | `x-goog-api-key: $GEMINI_API_KEY` | `Authorization: Bearer $OPENAI_API_KEY` | none (your machine) |
| Input price | US$ 0.042 / 1M tokens | US$ 0.10 / 1M tokens, free tier in AI Studio | US$ 0.10 / 1M tokens | your hardware |
| Questions per call | many, 64k tokens total | 1 to 1,000, 262k tokens | 1 to 400 | 1 |
| Inputs | text, JSON, images (header opt-in) | text, images, audio, video, PDF | text, JSON, images, tool-call history | text |
| Yes/no type name | `noul` | `noul` | `predicate` | `noul` |

**Subscriptions do not reach any of them.** Each hosted API takes an API key only. A ChatGPT or Codex login cannot call `/v1/decisions` (reported by CLIProxyAPI issue 6917; OpenAI documents API keys only), and the Gemini launch post names no consumer-plan access. The engine's `subscription` provider asks a text model through the runtime CLI the user is logged in to for the same JSON. It works with no key, but it takes seconds, spends the subscription's quota and has no calibration, so its confidence is always reported as `null`.

**JEV-27B** is an open-weights (Apache-2.0) distillation of Jev 1.13, built on Qwen3.8-27B. It is not affiliated with TypeSafe. It needs about 54 GB of GPU memory in bf16, about 34 GB as a Q8_0 GGUF and about 23 GB as Q4_K_M, at a 4k context. The model card's server (`serve_decide.py` on vLLM) exposes `/v1/decide`, which the engine speaks; a GGUF build needs llama.cpp with the card's patch. AutoTrust does not document Apple Silicon. Only download it from `huggingface.co/autotrust/JEV-27B` or the GGUF card it links: a GitHub repository offering a "JEV-27B Desktop" Windows zip is not from AutoTrust and must never be suggested.

## Known weaknesses

TypeSafe's own list, inherited by JEV-27B: literal reading of the question, weak arithmetic, counting and date comparison, accuracy that drops with multi-hop indirection, large noisy state acting as a distractor, and answers that adversarial text can move. A schema violation cannot happen; a wrong valid option can. Write questions that the state answers directly, and never ask one that depends on a calculation or a date. In the independent Artificial Analysis Decision Index, Gemini Decision 1 does not lead; vendor benchmarks for all three are self-reported.

## How the engine uses them

| Where | What happens | Provider |
|---|---|---|
| `nrv decide` | Any closed question, from the orchestrator or a script | auto order |
| Routing (Phase 3) | A second opinion over the finalists after Pass 2. Never the pick. | the orchestrator runs `nrv decide` |
| Runtime choice | Only on the last rung: no flag, no brief mention, no `USE_*` rule. Picks among installed runtimes outside cooldown when the confidence clears `decision.min_confidence`. Audited as `x_runtime_decision`. | API or local only |
| Quality gate | When the LLM judge is out of quota, grades the file (meets the brief? quality 0-4). Decides only when both answers agree and the confidence clears the floor; otherwise the file stays unjudged (exit 3). | API or local only |

Provider order under `decision.provider=auto`: `local` (when `decision.local_url` is set), `typesafe`, `gemini`, `openai`, `subscription`. The first that answers wins, and each failure is reported. Keys are read from the environment and the engine's `.env` chain, never printed.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `decision.provider` | `auto` | `auto`, one provider name, or `off` |
| `decision.local_url` | empty | URL of a JEV-27B server the user started |
| `decision.min_confidence` | `0.7` | below it, a decision is only a signal |
| `decision.runtime_choice` | `true` | let a decision model pick the runtime on the last rung |

`nrv decide status` shows what is configured and whether this machine can host JEV-27B. It reads RAM and, through `nvidia-smi`, GPU memory; it never downloads or starts anything.

## Sources

- TypeSafe API reference: https://docs.typesafe.ai/api/system-one
- OpenAI Decisions guide: https://developers.openai.com/api/docs/guides/decisions
- Gemini Decisions API launch: https://blog.google/innovation-and-ai/technology/developers-tools/gemini-decisions-api/
- Gemini Decisions API docs: https://aistudio.google.com/docs/decisions-api
- JEV-27B model card: https://huggingface.co/autotrust/JEV-27B
- JEV-27B GGUF card: https://huggingface.co/Atlas3D/JEV-27B-VL-GGUF
- ChatGPT login and Decisions: https://github.com/router-for-me/CLIProxyAPI/issues/6917
