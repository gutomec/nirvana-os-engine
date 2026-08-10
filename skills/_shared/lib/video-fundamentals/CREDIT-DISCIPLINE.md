# Disciplina de crédito (compartilhado)

Geração de vídeo custa crédito pago; planejamento não. Estes defaults são o ponto ótimo (qualidade
suficiente por menos crédito). Suba o dial só quando o clipe justifica.

## Defaults (o ponto ótimo)

- **Modo std** (não 4K).
- **1080p** (720p quando quiser ainda mais barato; 480p só rascunho).
- **~8s por clipe** (encadeie clipes de ~8s para jornadas — ver `FUNDAMENTALS.md` §2 — em vez de um
  clipe longo e caro).
- **Sem áudio por default** em hero/background/loops (ver `AUDIO-POLICY.md`).
- Aspect: `9:16` social vertical, `16:9` site/paisagem, `1:1` grid.

## 4K só no showpiece

Suba para **4K apenas no render final de vitrine** (o hero que carrega a página, o clipe que vai no
topo do site). Todo o resto fica em std/1080p. 4K em clipe secundário é crédito jogado fora.

## Compress-for-web (não é opcional)

Depois de gerar, **comprima os vídeos para web** — um passo, ~90% de redução de tamanho, e o scroll
fica suave em qualquer laptop. Para sites com scroll-scrub isto é estrutural (Core Web Vitals / LCP),
não uma dica. Uma frase resolve: "compress the videos for web".

```bash
# referência ffmpeg (H.264 web-otimizado; ajuste o CRF por qualidade x tamanho)
ffmpeg -i in.mp4 -vcodec libx264 -crf 26 -preset slow -movflags +faststart -an out-web.mp4
```
(`-an` remove a faixa de áudio — use em hero/loop mudo; tire o `-an` se o áudio faz parte do entregável.)

## Cost-check antes de gerar (sempre)

- Higgsfield: `higgsfield generate cost <model> --prompt "..." --duration 15` antes de `generate create`.
- Veo/Fal: estime `cost_estimate_usd` no handoff antes de disparar o LRO.
- Shape seguro no Higgsfield para evitar falhas que queimam crédito: **1 imagem + 15s** (ver
  `higgsfield-cli.md`).

## Onde o crédito vale a pena

- **2-3 takes só no hero** (ver `FUNDAMENTALS.md` §3); primeiro aceitável nos demais.
- 4K só no hero de vitrine.
- Áudio só no que publica (ver `AUDIO-POLICY.md`).
