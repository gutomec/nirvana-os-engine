# _shared/lib/video-fundamentals

Fonte única dos fundamentos de geração de vídeo para TODOS os squads de vídeo do Nirvana-OS. Squads
**referenciam** estes arquivos (via `tasks/video-compose.md` ou os agentes de geração); não os copiam.
Execução do Higgsfield fica centralizada no squad `higgsfield-studio-nirvana`.

## Conteúdo

| Arquivo | O quê |
|---|---|
| `FUNDAMENTALS.md` | hero-image anchor, encadeamento de clipes, takes, bíblia de mundo, anti-cara-de-IA |
| `AUDIO-POLICY.md` | sem áudio (hero/loop) vs com áudio + legenda (publicar) |
| `CREDIT-DISCIPLINE.md` | defaults std/1080p/~8s, compress-for-web, 4K só showpiece, cost-check |
| `ENGINE-MENU.md` | qual engine escolher — inclui **Higgsfield** (Soul ID, Seedance, Marketing Studio) |
| `higgsfield-cli.md` | superfície CLI completa do Higgsfield (auth, custo, upload, generate, gotchas) |
| `CAPABILITY.yaml` | a capability canônica `media.video.compose` (consolida os ids antigos) |
| `inject-capability.js` | injeta a capability + `tasks/video-compose.md` em cada squad de vídeo (idempotente) |

O ponteiro do Veo (`../veo/agent-veo-orchestrator.md`) é a persona que os `agents/VEO_VIDEO.md`
carregam — dobra o ENGINE-MENU (com Higgsfield) e a AUDIO-POLICY.

> **Conteúdo pago (não no engine livre):** o método de roteiro/fonética PT-BR (`roteiro-method/`) e o
> kit ffmpeg de pós (`post-kit/`) são conteúdo dos **packs de vídeo (pagos)** — vivem na squad
> `higgsfield-studio-nirvana` (`references/roteiro-method/`, `scripts/post-kit/`). O engine livre traz
> só os fundamentos genéricos acima; os packs de vídeo trazem o método de produção.

## Rollout

```bash
node inject-capability.js --dry-run     # relatório
node inject-capability.js               # injeta nos squads de vídeo
node inject-capability.js --slug <slug> # um squad só
```

Origem dos fundamentos genéricos: hero-image, chaining e disciplina de crédito. O método de
roteiro/fonética/pós é conteúdo dos packs de vídeo pagos (ver nota acima).
