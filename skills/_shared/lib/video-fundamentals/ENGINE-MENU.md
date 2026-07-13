# Menu de engines de vídeo (compartilhado)

Qual engine escolher para cada trabalho. Squads referenciam este arquivo em vez de manter árvores de
decisão copiadas. A execução mora em cada squad/registry; aqui está a *seleção*.

## A pergunta que decide

| Preciso de… | Engine preferido | Auth |
|---|---|---|
| **Personagem/produto consistente entre tomadas** (Soul ID) | **Higgsfield** (`text2image_soul_v2` + Seedance) | `higgsfield auth login` |
| **Jornada encadeada** (frame final → inicial, "tomada única") | **Higgsfield Seedance 2.0** (`start_image`/`end_image`); alt: Luma Ray, Kling, Wan FLF2V | `higgsfield` / `FAL_KEY` |
| **Anúncio UGC / product ad falado** | **Higgsfield Marketing Studio** (`marketing_studio_video`); alt: HeyGen (voz PT mais limpa) | `higgsfield` / `HEYGEN_API_KEY` |
| **Diálogo em inglês, broadcast, aderência ao prompt** | **Veo 3.1** (`veo-3.1-generate-preview`) | `GOOGLE_API_KEY` |
| **Expressividade emocional, cena cinematográfica** | Sora 2 (ou Veo 3.1) | ChatGPT / `GOOGLE_API_KEY` |
| **Controle de câmera / 3D / referências** | Runway Gen-4 | `RUNWAY_API_KEY` |
| **Iteração barata, física de movimento** | Kling 2.6 (via fal) | `FAL_KEY` |
| **Órbita de produto, I2V a partir de still** | Luma Ray / Kling | `FAL_KEY` |
| **Fala com lip-sync nativo no próprio clipe** (áudio incluído no preço) | **Grok Imagine** (`grok-imagine-video`; fala entre aspas no prompt) | `grok login` / `XAI_API_KEY` |
| **Extend/edit nativo de vídeo** (continuar do último frame; editar elemento mantendo o take) | **Grok Imagine** (`/videos/extensions`, `/videos/edits`) | `XAI_API_KEY` (créditos) |
| **Lip-sync / dublagem broadcast** | Sync.so | `SYNC_API_KEY` |
| **Loop perfeito / cinemagraph** | Veo 3.1 (first=last frame) | `GOOGLE_API_KEY` |
| **Local, sem custo por clipe (GPU própria)** | Wan 2.2 / HunyuanVideo / LTX (ComfyUI) | — |
| **Upscale 4K/8K** | Topaz (Higgsfield) / SUPIR | `higgsfield` / — |

## Higgsfield — o que ele adiciona ao menu (novo)

O Higgsfield é o único engine do menu que entrega, no mesmo lugar:

- **Soul ID** — identidade de personagem/produto travada entre gerações (consistência que Veo/Fal não
  garantem na geração; ver `FUNDAMENTALS.md` §1).
- **Seedance 2.0** com `start_image`/`end_image` — o keyframe-chaining nativo para jornadas contínuas
  (`FUNDAMENTALS.md` §2).
- **Marketing Studio** — UGC/product ad falado direto (`marketing_studio_video`), inclusive Click-to-Ad
  por URL do produto.
- CLI shell-out simples (sem GPU local). Detalhe completo: `higgsfield-cli.md`.

Escolha Higgsfield quando o trabalho pede **consistência forte**, **jornada encadeada** ou **UGC ad**.
Para diálogo em inglês broadcast ou loops nativos, Veo segue melhor. Não force um engine só; o menu é
para casar tarefa → engine.

## Grok Imagine — o que ele adiciona ao menu (novo)

O Grok Imagine (xAI) é o único engine do menu com **áudio nativo sempre incluído no preço**: diálogo
com lip-sync, SFX e ambiente saem dentro do próprio clipe (a fala vai entre aspas no prompt) — sem
etapa separada de lipsync nem cobrança extra de áudio.

- **Extend nativo** (`/videos/extensions`) — continua um take do último frame (2-10s por segmento,
  encadeável), sem o extract-frame manual do chaining clássico (`FUNDAMENTALS.md` §2).
- **Edit generativo de vídeo** (`/videos/edits`) — muda elemento/estilo mantendo duração/AR/resolução.
- **Dois trilhos**: Grok Build CLI headless (`grok -p`, assinatura SuperGrok — funciona sem créditos
  de API) e API Imagine (`XAI_API_KEY` + créditos: 1-15s, 720p/1080p, ref2v, n≤10).
- Custo baixo: $0.02-0.05/imagem; $0.05-0.08/s de vídeo com áudio.
- Limites honestos: sem Soul ID/seed (consistência = disciplina de referência via identity kit), sem
  upscale nativo, moderação própria. Execução completa: squad `grok-studio-nirvana`
  (`references/grok-build-cli.md` e `references/grok-imagine-api.md`).

Escolha Grok quando o trabalho pede **fala natural no clipe**, **take contínuo estendido** ou
**custo baixo com áudio incluído**. Para identidade travada por treino (Soul ID), Higgsfield segue único.

## Detecção de disponibilidade (rode ANTES de escolher)

O menu só vale entre engines **vivos** neste ambiente. Antes de escolher, probe (1 comando por engine,
segundos, zero custo) e risque do menu o que não responder:

| Engine | Probe | Vivo quando |
|---|---|---|
| **Grok Imagine** | `grok --version` e, se houver squad instalado, `bun ~/squads/grok-studio-nirvana/scripts/grok-media.ts doctor` | binário ok + trilho A (assinatura logada via `grok login`) OU trilho B (`XAI_API_KEY` com créditos) — o doctor diz qual |
| Higgsfield | `higgsfield account` | conta autenticada com créditos |
| Veo 3.1 | `test -n "$GOOGLE_API_KEY"` | key presente |
| Fal/Kling | `test -n "$FAL_KEY"` | key presente |
| Runway | `test -n "$RUNWAY_API_KEY"` | key presente |
| HeyGen | `test -n "$HEYGEN_API_KEY"` | key presente |

Regra de preferência quando **mais de um** está vivo: case a tarefa pela tabela principal acima.
Empate em tarefa genérica de vídeo: **Grok CLI logado (assinatura) ganha o default** — não consome
créditos de API de terceiros, tem áudio+fala nativos e o custo marginal já está pago na assinatura;
Higgsfield assume quando a tarefa exige Soul ID/Marketing Studio; Veo quando exige diálogo EN
broadcast/loop nativo. Registre no handoff qual probe passou e por que o engine foi escolhido.

## Regra de fallback (honesta)

Registre a cadeia de fallback quando o engine primário falhar (ex.: `veo-3.1 → veo-3.0 → fal/kling →
runway`). Fallback é mecânico (só em erro de provider), não substitui a *escolha* semântica acima.

## Ver também

- `higgsfield-cli.md` — superfície CLI completa do Higgsfield.
- Grok Imagine: superfícies verificadas em `~/squads/grok-studio-nirvana/references/` (CLI e API).
- `FUNDAMENTALS.md` — hero-image, chaining, takes (valem para qualquer engine).
- `AUDIO-POLICY.md` / `CREDIT-DISCIPLINE.md` — áudio e custo por engine.
- Inventário detalhado por engine (specs/custo/auth): `~/squads/nirvana-video-creator/data/tool-registry.yaml`.
