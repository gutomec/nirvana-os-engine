# Política de áudio (compartilhado)

A decisão com/sem áudio depende do DESTINO do clipe. Nenhum squad tinha essa distinção; agora ela é
explícita e roteável. Regra de uma linha: **hero/background loop = sem áudio; publicar = com áudio.**

## Sem áudio — hero e background loops

Gere **sem áudio** quando o clipe vai ser:

- um **hero** varrido pelo scroll (frame-sequence / scroll-scrub): o som é irrelevante, o clipe vira
  frames;
- um **background loop** atrás de texto/UI (site, story, tela de espera);
- material que vai receber **trilha/voz na pós** (o áudio gerado só atrapalharia a mixagem).

Como setar:

- Higgsfield: `--generate_audio false`.
- Veo/Remotion: `BGM volume 0.0` (ou não anexar faixa).
- Regra de crédito: sem áudio é o **default** do mundo de sites/loops (ver `CREDIT-DISCIPLINE.md`).

## Com áudio — publicar (Instagram, YouTube, TikTok, Reels)

Gere **com áudio** quando o clipe é o entregável final publicado:

- **anúncio falado** (UGC/porta-voz), depoimento, VSL;
- **Reel/Short/TikTok** que será postado como está;
- qualquer peça em que a fala/trilha É o conteúdo.

Como setar:

- Higgsfield: `--generate_audio true` (dispara TTS — prepare a fala foneticamente, ver
  método de roteiro/fonética PT-BR — pack de vídeo pago).
- Veo: áudio nativo (diálogo + SFX); `BGM volume` ~0.3.

### Legenda obrigatória ao publicar

**85% do vídeo social é assistido sem som.** Todo clipe publicado com áudio vai **legendado**
(burned-in), safe-zone no terço superior/central, 9:16. A ausência de legenda reprova no QA de
publicação (QA de áudio do kit de pós — pack de vídeo pago — + checklist do squad). O `--generate_audio` gera a fala; a legenda
entra na pós.

## Resumo roteável

| Destino | Áudio | Flag Higgsfield | Legenda |
|---|---|---|---|
| Hero scroll-scrub / frame-sequence | não | `--generate_audio false` | n/a |
| Background loop (atrás de UI/texto) | não | `--generate_audio false` | n/a |
| Vai receber trilha/voz na pós | não | `--generate_audio false` | na pós |
| Anúncio falado / VSL / depoimento | sim | `--generate_audio true` | sim (burned-in) |
| Reel / Short / TikTok publicado | sim | `--generate_audio true` | sim (burned-in) |
