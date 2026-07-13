# Fundamentos de geração de vídeo (compartilhado)

Os princípios que qualquer squad de vídeo aplica, independente do engine (Higgsfield, Veo, Fal/Kling,
Runway, Luma, Seedance). Estes fundamentos decidem 80% do resultado e a maioria custa zero crédito.
Squads referenciam este arquivo; não o copiam.

## 1. Consistência por hero-image (a âncora)

A regra que mais separa "parece caro" de "parece IA": **gere UMA imagem-âncora primeiro e passe-a como
referência em TODO clipe.** É o que mantém o produto / a pessoa / o lugar idêntico entre as tomadas.

- Higgsfield: `higgsfield upload create ./hero.png` → reuse o `id` em `--image` em cada geração.
- Veo/Fal (I2V): use a mesma imagem inicial como frame de partida.
- **Consistência ganha de qualidade.** Um clipe um pouco mais fraco em que o produto é idêntico entre
  tomadas parece mais caro que quatro clipes lindos de quatro produtos ligeiramente diferentes.
- Para portfólio/porta-voz: a foto da pessoa é a âncora de identidade em toda geração.
- Loja real: as fotos reais do produto são as âncoras — o engine anima o SEU produto, não um inventado.

## 2. Encadeamento de clipes (jornada como tomada única)

Para uma sequência que parece um movimento de câmera contínuo (o "3D scroll", a descida, a corrida):
**use o frame FINAL de cada clipe como frame INICIAL do próximo.** O Seedance 2.0 aceita `start_image`
e `end_image`; encadeando em ordem, N clipes se juntam numa tomada só, sem emenda.

```
clipe 1 (start=hero) ──▶ frame final ──▶ clipe 2 (start=frame final do 1) ──▶ … ──▶ clipe N
```

Gere os clipes **em ordem**. Cada `start_image` = o `end_image` do anterior. É isso que faz a jornada
(oceano, hypercar, penthouse) varrer como uma câmera ininterrupta. Para engines sem start/end frame
explícito, use a mesma imagem + o MESMO bloco de cenário + descrição de personagem idêntica.

## 3. Takes só no hero

O hero é ~80% do "uau". Gaste crédito extra ali:

- **Gere 2-3 takes do clipe HERO** e fique com o melhor (aquele em que a identidade/produto se mantém
  na rotação completa).
- **Nos demais clipes, pegue o primeiro resultado aceitável.** Não desperdice takes fora do hero.
- Para hero-orbit de pessoa: a qualidade da foto de entrada decide tudo.

## 4. Bíblia de mundo + string de cenário VERBATIM

Para qualquer peça com 2+ clipes, monte uma mini-bíblia de mundo e reuse os blocos **idênticos**.
Quatro camadas de consistência, de baixo pra cima: **MUNDO → GEAR/look → PERSONAGEM/voz → NARRATIVA**.
A narrativa nasce dentro do mundo, não o contrário.

Escreva o bloco de cenário em **inglês** (o modelo entende inglês) e cole **VERBATIM** em todo clipe —
parafrasear faz o céu/roupa/luz derivar. Detalhe = especificidade sensorial, não volume de texto
("golden hour light from camera-left, scattered clouds below" vale mais que um parágrafo vago).
Template e método completo em roteiro-method (conteúdo dos packs de vídeo pagos — squad `higgsfield-studio-nirvana`).

## 5. Estilo: como NÃO parecer feito por IA

Fuja do "look IA padrão" (fundo navy + glow azul + cards com borda + tudo centralizado e parado).
Prefira:

- **Uma** cor de destaque (não arco-íris).
- Luz natural com **direção** (golden hour, rim light).
- Textura real (grão de filme, pele natural).
- **Nada parado mais de ~2s** — sempre uma deriva (vento, sway, respiração). Cena calma ≠ cena estática.

Escolha o estilo que a marca comunica: SaaS sóbrio pede `high-key clean, minimal, soft diffused light`;
fitness pede `dynamic, high contrast, handheld, vibrant`. Não copie o estilo de outra marca.

## 6. Gramática de cinema (vago não comanda)

Um movimento de câmera **por clipe**, com verbo concreto — não "cinematic":
`slow push-in`/`dolly in` (crescendo), `orbit` (épico), `tracking shot`, `handheld` (urgência),
`pull-out to reveal` (contexto), `crash zoom`, `FPV drone`. Planos: `extreme close-up` (intensidade),
`close-up` (fala/conexão), `wide`/`establishing` (escala). Tabela completa no método de roteiro
(pack de vídeo pago).

## Ver também

- `AUDIO-POLICY.md` — quando gerar com áudio (publicar) vs sem áudio (hero/background loop).
- `CREDIT-DISCIPLINE.md` — defaults de resolução/duração, compress-for-web, 4K só showpiece.
- `ENGINE-MENU.md` — qual engine escolher (inclui Higgsfield).
- roteiro-method (roteiro-antes-de-pixel: cenário, estilo, voz, copy, fonética PT-BR) e post-kit (QA de áudio, unir clipes, cortar mudos, acelerar, end-card) — **conteúdo dos packs de vídeo pagos**, na squad `higgsfield-studio-nirvana` (`references/roteiro-method/`, `scripts/post-kit/`); não no engine livre.
