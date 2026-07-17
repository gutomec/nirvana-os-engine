# Pixelle-Video Troubleshooting — squad reference

Common issues squads will hit when dispatching to Pixelle. Surface these to the user verbatim if `client.js` returns a matching error.

| Symptom | Diagnosis | Fix |
|---|---|---|
| `client.js ping → ECONNREFUSED` | Pixelle não está rodando | `start.bat` (Win) ou `uv run streamlit run web/app.py` (Mac/Linux) |
| `pixelle sync failed: 500 ... comfyui_unreachable` | ComfyUI offline | Reiniciar ComfyUI: `python main.py` em `~/comfyui` |
| `pixelle async failed: 503 queue_full` | RunningHub no concurrent_limit | Aguardar ou subir `concurrent_limit` em `~/.pixelle-video.yaml` |
| `task ... failed: voice_workflow_not_found` | TTS workflow não está instalado no ComfyUI | Instalar o workflow (F5-TTS / Chatterbox / Index-TTS no ComfyUI custom_nodes) |
| `validateRefAudio → file_too_small` | Áudio < 50KB | Pedir re-record com 30s+; ver voice-clone-pipeline.md |
| `validateRefAudio → unsupported_format` | Não é mp3/wav/flac/m4a/ogg | Converter via `ffmpeg -i input.aac output.wav` |
| Vídeo final tem voz robótica | Ref audio curto demais ou ruidoso | Re-record em ambiente silencioso ≥30s |
| Lip-sync travado/desconectado | Workflow errado para o modelo | Sonic precisa SVD; InfiniteTalk precisa WAN 2.1 + MultiTalk |
| OOM no ComfyUI | <12GB VRAM no WAN 2.1 | Quantizar (FP8/INT4) ou usar RunningHub 24/48GB |
| `ffmpeg: command not found` | ffmpeg não instalado | `brew install ffmpeg` / `apt install ffmpeg` |
| LLM `Invalid API key` | Base URL errada (ex: usar OpenAI URL com Qwen key) | Conferir preset em `~/.pixelle-video.yaml` |
| Roteiro vem em inglês mesmo pedindo PT-BR | LLM não recebeu instrução | Squad deve adicionar "Responda em PT-BR" no `text` ou `prompt_prefix` |
| Gemini retorna `quota_exceeded` | Plano free do Gemini bateu limite | Trocar para Qwen ou Ollama; ou pagar tier 1 do Gemini |
| Voz de talent soa diferente do esperado | Modelo errado pra língua do talent | Ver `tts-models-2026.yaml` selection_rules |

## Quick diagnostic commands

```bash
# Geral
node ${CLAUDE_SKILLS_DIR}/_shared/lib/pixelle/client.js ping
node ${CLAUDE_SKILLS_DIR}/_shared/lib/pixelle/client.js config
node ${CLAUDE_SKILLS_DIR}/_shared/lib/pixelle/client.js voices

# ComfyUI
curl http://127.0.0.1:8188/system_stats

# Gemini
curl -H "Authorization: Bearer $GEMINI_API_KEY" \
  "https://generativelanguage.googleapis.com/v1beta/openai/models" | head

# Ollama
curl http://localhost:11434/api/tags
```

Full reference: `(base de conhecimento interna)` §13.
