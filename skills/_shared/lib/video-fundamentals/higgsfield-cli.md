# Higgsfield CLI — superfície de referência (compartilhada)

Referência única da CLI do Higgsfield para qualquer squad de vídeo. **Execução** mora no squad
`higgsfield-studio-nirvana` (não duplicar a lógica). Este arquivo é o que os outros squads leem para
saber *que* o Higgsfield existe, *quando* escolhê-lo e *como* ele é chamado.

Binário: `higgsfield` (aliases `higgs`, `hf`). **Nunca use `hf`** — em muitas máquinas `hf` é a CLI do
HuggingFace. Fonte da verdade dos parâmetros = `higgsfield model get <model>`, nunca specs de blog.

## Autenticação e conta

```bash
higgsfield account status              # email, plano, créditos
# Não autenticado → ! higgsfield auth login   (device login; o prefixo ! = o humano roda)
```
Erros `Session expired` / `Not authenticated` → o humano roda `! higgsfield auth login`.
Auth alternativa não-interativa: env `HF_KEY` no formato `key:secret`.

## Modelos (IDs reais)

- **Imagem:** `text2image_soul_v2` (Soul 2.0, fotoreal + Soul ID consistente), `nano_banana_2`, `flux_2`.
- **Vídeo:** `kling3_0`, `veo3_1`, **Seedance 2.0** (start_image/end_image → keyframe-chaining), `marketing_studio_video` (UGC/product ad).
  - O id CLI exato do Seedance NÃO é chumbado aqui (muda): resolva com `higgsfield model list | grep -i seedance` e confirme flags com `higgsfield generate create --help`. Fonte da verdade = o CLI, nunca spec de blog.
- **Upscale/reframe:** Topaz (4K/8K).

## Custo (SEMPRE antes de gerar)

```bash
higgsfield generate cost <model> --prompt "..." --mode ugc --duration 15
# ref: ~75 créditos por clipe 15s/720p no marketing_studio_video
```

## Fotos de referência (o hero-image entra por aqui)

```bash
higgsfield upload create ./hero.png      # UMA por vez (várias args = "accepts at most 1 arg"). Devolve id.
```
A imagem-âncora (ver `FUNDAMENTALS.md`) sobe uma vez e o `id` é reusado em `--image` em todo clipe.

## Gerar — caminho genérico (o que o squad usa hoje)

```bash
higgsfield generate create kling3_0 --prompt "<prompt>" --duration 5 --wait --json
higgsfield generate create <model> --prompt "$(cat prompt.txt)" --image <id> \
  --duration 8 --aspect_ratio 16:9 --resolution 1080p --generate_audio false --wait --json
```

## Gerar — Marketing Studio (UGC / product ad)

```bash
higgsfield generate create marketing_studio_video \
  --prompt "$(cat prompt.txt)" \
  --image <upload_id_produto_ou_rosto> \
  --mode ugc --duration 15 --aspect_ratio 9:16 --resolution 720p --generate_audio true \
  --wait --wait-timeout 25m --wait-interval 15s --json
```

Modos do `marketing_studio_video`: `ugc` (default), `ugc_how_to`, `ugc_unboxing`, `product_showcase`,
`product_review`, `tv_spot`, `ugc_virtual_try_on`, `virtual_try_on`, `wild_card`. Confirme em
`higgsfield model get marketing_studio_video`.

### Flags (`marketing_studio_video`)

| Flag | Valores | Nota |
|---|---|---|
| `--prompt` | texto (obrigatório) | estrutura em camadas; voz CALMA (método de roteiro no pack de vídeo) |
| `--mode` | ver modos acima | confirme em `model get` |
| `--aspect_ratio` | auto,21:9,16:9,4:3,1:1,3:4,9:16 | **9:16** social |
| `--duration` | inteiro ≥4 (s) | comece em 15 |
| `--resolution` | 480p,720p,1080p | default 720p |
| `--generate_audio` | true/false | ver `AUDIO-POLICY.md` (false=hero mudo, true=publicar) |
| `--image` | upload_id (repetível) | a foto-âncora; shape seguro = 1 imagem |
| `--url` | URL | atalho Click-to-Ad |
| `--wait` | — | bloqueia; `--wait-timeout 25m` |

### Click-to-Ad (direto da URL do produto)

```bash
higgsfield marketing-studio products fetch --url "https://loja.exemplo.com/produto" --wait
higgsfield generate create marketing_studio_video --url "https://loja.exemplo.com/produto" \
  --prompt "<cena>" --mode ugc --duration 15 --aspect_ratio 9:16 --resolution 720p \
  --generate_audio true --wait
```

## Monitorar / baixar resultado

```bash
higgsfield generate list --video --json
higgsfield generate get <job_id> --json        # result_url quando completa
higgsfield model get <model>                   # params/modos atuais (fonte da verdade)
```
Avatar preset (opcional): `higgsfield marketing-studio avatars list` → `--avatars '[{"id":"<id>","type":"preset"}]'`.

## Gotchas (aprendidos na prática — não repita)

- **`@token` no prompt QUEBRA o CLI** (`Failed to read image1`): ele lê `@token` como caminho de arquivo.
  Fotos entram só por `--image`; no texto do prompt escreva "the reference photo", nunca `@`.
- **Shape seguro = 1 imagem + 15s.** "2 imagens + 20s" falhou (job `failed` sem motivo).
- `products create` pode dar `Method Not Allowed` (instável) → pule o produto e passe as fotos direto
  via `--image`; `product_ids` não é obrigatório.
- `accepts at most 1 arg` (upload) → suba 1 arquivo por vez.
- Job `failed` sem mensagem → transitório ou variáveis demais → reduza a 1 img/15s e repita.
- `Invalid values: aspect_ratio=…` → use um enum válido da tabela.

## Prompt-craft (resumo; método completo no pack de vídeo pago)

Prompt em camadas: **referências (--image) → setup visual (cenário+estilo) → ação+diálogo beat-by-beat
→ specs no fim** (`Camera:`, `Sound design:`, `Mood:`). Verbos de câmera concretos (dolly in, orbit,
handheld, crash zoom), um movimento por clipe. Para fala falada (audio ON): voz calma/clara, cláusula
de enunciação das palavras difíceis (sem hífen), trava pós-diálogo e cláusula negativa anti-prop/CTA —
tudo no método de roteiro/fonética PT-BR (conteúdo dos packs de vídeo pagos — squad `higgsfield-studio-nirvana`).
</content>
