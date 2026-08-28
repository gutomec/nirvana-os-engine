# Nirvana Glance — Design Reference (M1 "Clean Operations")

![Referência canônica do M1](../assets/glance-onepager-ref.png)

Este diretório documenta o baseline visual do **PRD v2.0 — Nirvana Glance One-Pager**.
A imagem acima é a **referência visual canônica** do milestone M1/M2
(`docs/assets/glance-onepager-ref.png`). Qualquer implementação ou geração
futura deve ser comparada contra ela.

## Prompt canônico (registrado do Anexo do PRD v2.0)

> Minimal clean web dashboard UI, one-page hierarchical bento layout.
> Off-white background (#FAFAF9), single green accent, thin 1px borders,
> generous whitespace, no gradients, no glow. Three aligned tiers on a
> strict grid: top tier one wide hero module with large light typography
> and a thin stat row; middle tier two asymmetric columns — left column a
> clean event timeline with monospace timestamps and tiny status dots,
> right column a stack of medium entity cards; bottom tier a full-width
> row of small uniform cells. Fixed bottom input bar as one rounded text
> field integrated into the grid. Alignment itself implies hierarchy, no
> connecting lines, no arrows, no org chart. Inter typography, small caps
> labels, muted gray secondary text. Linear and Stripe aesthetic, flat
> design, bento grid discipline, subtle shadows only, Figma presentation
> mockup, straight-on full page view, 8k, ultra minimal

## Tokens (PRD §4)

| Token | Valor | Uso |
|---|---|---|
| `--bg` | `#FAFAF9` | fundo geral |
| `--surface` | `#FFFFFF` | cards |
| `--border` | `#E7E5E4` 1px | hairlines |
| `--ink` | `#1C1917` | headline, números |
| `--ink-2` | `#78716C` | subtítulos |
| `--accent` | `#16A34A` | dots, badges SUCCESS, botão ↑ |
| `--warn` | `#D97706` | WARNING |
| `--info` | `#A8A29E` | INFO |
| `--radius` | 8px cards · 999px ask bar | |
| `--font` | Inter (300/400/500) | display + UI |
| `--mono` | JetBrains Mono | timestamps, valores |

Tema `apple-dark` = mesmo layout com tokens escuros (RF-10).
Tema `awwwards` (WebGL/3D) fica para o M3.

## Decisões de produto registradas (perguntas abertas do PRD §7)

- **Q2 (tier 3):** adotada a opção **recomendada — subsistemas do engine**
  (`ROUTER · SUPERVISOR · QUALITY GATE · GAUNTLET · RUN KERNEL · EMBEDDINGS · SETTINGS · UPDATES`),
  eliminando a redundância com a coluna "Agent entities" da imagem.
  Os dados vêm de `/api/pulse` (mesmo SSE da timeline — responde também Q5).
  Reverter para businesses é troca de fonte de dados, não de layout.
- **Q3 (AGENTS 12):** `squads/tools ativos (6) + businesses ativos (6) = 12`.
- **Q4 (avatar com dot):** sim — o dot do avatar "AD" reflete o estado da
  conversa atual (verde idle, âmbar pulsante durante turno, vermelho em falha).
- **Q5 (cadência do tier 3):** mesmo SSE da timeline — eventos `pulse`
  a cada 10s em `GET /api/events` (eventos nomeados: `timeline`,
  `timeline-update`, `pulse`).

## Smoke

```bash
bun scripts/glance-smoke.ts   # 16 checks (critério de aceite #7: 13+ endpoints)
```
