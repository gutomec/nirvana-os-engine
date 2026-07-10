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

## Regra de fallback (honesta)

Registre a cadeia de fallback quando o engine primário falhar (ex.: `veo-3.1 → veo-3.0 → fal/kling →
runway`). Fallback é mecânico (só em erro de provider), não substitui a *escolha* semântica acima.

## Ver também

- `higgsfield-cli.md` — superfície CLI completa do Higgsfield.
- `FUNDAMENTALS.md` — hero-image, chaining, takes (valem para qualquer engine).
- `AUDIO-POLICY.md` / `CREDIT-DISCIPLINE.md` — áudio e custo por engine.
- Inventário detalhado por engine (specs/custo/auth): `~/squads/nirvana-video-creator/data/tool-registry.yaml`.
