# Pixelle-Video Setup Wizard — agentic onboarding

## When this fires

Any video-capable squad about to dispatch a video MUST first verify Pixelle is reachable + configured. If `client.ping()` fails or no `~/.pixelle-video.yaml` exists yet, the squad invokes this wizard. The wizard is **conversational** — the squad spawns a `general-purpose` Agent with the persona + the user's last message and walks the user through setup.

The wizard NEVER fakes success. If the user can't complete a step, the squad reports back and refuses to dispatch.

## Pre-flight check

```bash
node ${CLAUDE_SKILLS_DIR}/_shared/lib/pixelle/client.js ping
```

- Exit 0 → Pixelle is up. Skip wizard.
- Exit 1 → Wizard required.

## Wizard prompt (the squad sends this to the user)

> Olá, vou te ajudar a configurar o Pixelle-Video — é o motor que vou usar pra gerar seus vídeos. Roda 100% local ou em cloud, custo zero ou alguns centavos por vídeo dependendo da escolha. Vou te perguntar 4 coisas:
>
> **1. Você já instalou o Pixelle-Video?**
> - Se sim: me diga se está rodando agora (`http://localhost:8000/docs` abre?).
> - Se não: te mando o passo-a-passo.
>
> **2. Que LLM você quer usar pro roteiro?**
> - Vi que você já tem `GEMINI_API_KEY` configurada no `.env` — recomendo Gemini 2.5 Pro (default).
> - Outras opções: OpenAI GPT-4o, Qwen, DeepSeek, Ollama (100% local, grátis).
>
> **3. Que modo de imagem/vídeo?**
> - **Local (ComfyUI)**: NVIDIA 6GB+ VRAM, grátis, mais lento.
> - **Cloud (RunningHub)**: sem hardware, ~$0.05–0.50/vídeo, precisa API key.
>
> **4. Voz dos vídeos?**
> - **Edge-TTS** (default): grátis, voz neutra PT-BR ou EN. Bom pra começar.
> - **Voz clonada (sua ou de talent)**: precisa de 30–60s de áudio. Eu te guio. Modelo: F5-TTS-pt-br (PT-BR) ou Chatterbox (EN/multilíngue).
> - **ElevenLabs** (premium): se você já paga, eu uso a sua voice clone de lá.
>
> Me responde nesta ordem ou em texto livre — eu pego.

## Step-by-step the wizard runs

### Step 1 — Pixelle install check

```bash
node ${CLAUDE_SKILLS_DIR}/_shared/lib/pixelle/client.js ping
```

If `{ ok: false, error: "ECONNREFUSED" }`:

> Pixelle não está rodando ainda. Tem 2 caminhos:
>
> **Caminho fácil (Windows):**
> 1. Baixe o all-in-one zip em https://github.com/AIDC-AI/Pixelle-Video/releases
> 2. Extraia e rode `start.bat`
> 3. Aguarde até ver `http://localhost:8501` aberto no navegador
> 4. Volte aqui e me diga "pronto"
>
> **Caminho macOS/Linux:**
> ```bash
> brew install ffmpeg              # macOS
> # ou: sudo apt install ffmpeg    # Ubuntu/Debian
> curl -LsSf https://astral.sh/uv/install.sh | sh
> git clone https://github.com/AIDC-AI/Pixelle-Video.git ~/pixelle-video
> cd ~/pixelle-video
> uv sync
> uv run streamlit run web/app.py    # Streamlit em :8501
> # em outro terminal, rode a API:
> uv run uvicorn pixelle_video.api:app --port 8000
> ```
>
> Quando rodar, me diga "pronto" e sigo.

### Step 2 — LLM config

Read `~/.env` for `GEMINI_API_KEY`. If found:

> Encontrei sua `GEMINI_API_KEY`. Vou usar **Gemini 2.5 Pro** como roteirista (qualidade alta, custo baixo). Confirma?

If user picks Ollama:

> Confirme que Ollama tá rodando: `curl http://localhost:11434/api/tags`. Já tem `llama3.2` ou `qwen2.5` baixado?
> Se não: `ollama pull llama3.2`

### Step 3 — Image/video backend

> Você tem GPU NVIDIA com 6GB+ VRAM?
> - SIM → vou usar ComfyUI local. Te ajudo a instalar se não tiver.
> - NÃO → recomendo RunningHub. Crie conta em https://www.runninghub.ai/ e cole sua API key aqui.

If ComfyUI not installed:

> ```bash
> git clone https://github.com/comfyanonymous/ComfyUI.git ~/comfyui
> cd ~/comfyui
> pip install -r requirements.txt
> python main.py        # roda em :8188
> ```
> Modelos que você precisa baixar (mínimo viável):
> - FLUX.dev ou SDXL pra geração de imagem (HuggingFace)
> - F5-TTS ou Chatterbox ou Index-TTS pra voz (links em `~/.claude/skills/_shared/lib/pixelle/tts-models-2026.yaml`)
>
> Me avisa quando ComfyUI estiver respondendo em http://127.0.0.1:8188.

### Step 4 — Voice setup

> Pra voz tem 4 opções:
>
> 1. **Edge-TTS** — grátis, voz padrão PT-BR (Francisca/Antonio) ou EN (Aria/Guy). Pula esta etapa.
> 2. **Sua voz clonada** — preciso de 30–60s de áudio seu. Te guio na captura.
> 3. **Voz de outra pessoa** (talent, sua mãe, voiceover artist) — mesmo flow, com 30–60s de áudio.
> 4. **ElevenLabs** — se você já paga e tem voice clone lá, exporta um sample MP3 de 30s e usa como referência.
>
> Qual prefere?

If 2/3/4 chosen → run **voice-clone-pipeline.md** Path A or B.

### Step 5 — Save config

After all answers, the wizard writes `~/.pixelle-video.yaml`:

```yaml
api_base: http://localhost:8000
llm_provider: gemini
llm_model: gemini-2.5-pro
llm_base_url: https://generativelanguage.googleapis.com/v1beta/openai/
comfy_url: http://127.0.0.1:8188
runninghub_key: null      # or the key the user pasted
tts_workflow: f5-tts-pt-br
ref_audio_default: ~/.pixelle-voices/guto.wav
voices_dir: ~/.pixelle-voices
bgm_volume: 0.3
frame_preset: instagram-reel
```

Then:

```bash
node ${CLAUDE_SKILLS_DIR}/_shared/lib/pixelle/client.js ping     # validates
node ${CLAUDE_SKILLS_DIR}/_shared/lib/pixelle/client.js config   # shows resolved config
node ${CLAUDE_SKILLS_DIR}/_shared/lib/pixelle/client.js voices   # lists captured voices
```

Squad reports to user:

> ✅ Pixelle configurado.
> - API: http://localhost:8000 (sync + async OK)
> - LLM: Gemini 2.5 Pro
> - Imagem/vídeo: ComfyUI local em :8188
> - TTS: F5-TTS (PT-BR) com sua voz salva em ~/.pixelle-voices/guto.wav
> - Frame preset default: instagram-reel (1080x1920)
>
> Tudo gravado em ~/.pixelle-video.yaml. Posso prosseguir com a geração agora.

## Failure modes

- **User can't install Pixelle** → squad refuses to dispatch, suggests using a hosted alternative or postponing.
- **ComfyUI offline mid-run** → client.js retries 3× then fails. Squad reports + asks user to restart ComfyUI.
- **Voice file too short** → wizard asks for re-record per voice-clone-pipeline.md.
- **GEMINI_API_KEY invalid** → wizard suggests OpenAI / Qwen / Ollama as alternatives.

## Anti-patterns

- ❌ Squad assumes Pixelle is up and dispatches blindly — must `ping()` first.
- ❌ Squad fabricates `video_url` when API call fails — always surface real errors.
- ❌ Skipping the voice-clone-pipeline when the user said "minha voz" — capture properly or explicitly fall back to Edge-TTS with user consent.
- ❌ Hardcoding paths like `~/squads-v5/...` — use `${CLAUDE_SKILLS_DIR}` and `~/.pixelle-video.yaml`.
