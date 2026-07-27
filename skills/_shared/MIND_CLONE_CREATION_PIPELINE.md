# Pipeline nativo de criação de mind-clone

> **Este pipeline É o criador de clones do engine.** O nirvana-os-engine
> instala sem businesses, sem squads e sem clones — e mesmo assim cria um
> mind-clone de ponta a ponta, agenticamente, sem depender de squad nenhum.
> Squads de fábrica (ex.: `fabrica-de-genios`, vendido em pack) são pipeline
> pesado OPCIONAL para acervos grandes; nunca pré-requisito.
>
> Documento irmão obrigatório: `MIND_CLONE_ROUTING_CONTRACT.md` (o bloco
> `routing:` que torna o clone encontrável — regras medidas, não estilo).

## Quando criar

Só com o usuário ciente: clone é artefato permanente da biblioteca dele
(Regra 9 do harness — pergunte antes). E só com material real: **clone sem
fonte é persona inventada com nome de gente**, e a Regra 4 do harness proíbe
afirmar fidelidade que não existe.

## Fase 1 — Fontes (web, obrigatória)

Pesquise o material REAL da pessoa: livros, artigos, palestras, entrevistas,
posts, código. Monte a lista de fontes com nome e data — ela vira o
`source_material` do MANIFEST e o lastro de todo `^[FONTE]`.

Aceite material do próprio usuário (arquivos, transcrições) como fonte
primária quando fornecido.

**Gate de material:** sem fontes suficientes para sustentar as 5 camadas,
PARE e diga isso. Oferecer um "archetype" declarado (persona construída, sem
nome de pessoa real) é honesto; entregar um clone raso com nome real, não.

## Fase 2 — Destilação em DNA de 5 camadas

Escreva `dna/dna-schema.md` com as camadas, cada afirmação com `^[FONTE]`
apontando para a Fase 1:

| camada | o que é | teste de qualidade |
|---|---|---|
| L1 Filosofias | crenças de fundo | citável da fonte, não parafraseável de qualquer um |
| L2 Modelos mentais | como a pessoa enxerga o problema | específico o bastante para discordar de outro expert |
| L3 Heurísticas | regras de decisão rápidas | acionável em 1 frase |
| L4 Frameworks | estruturas nomeadas | tem nome próprio e passos |
| L5 Metodologias | processos completos | reproduzível por quem nunca viu a pessoa |

**Regra de ouro (é a regra 1 do contrato de roteamento):** o que não tem
método nas camadas não vira território declarado. Fama sem material é lacuna
de corpus — registre, não invente.

## Fase 3 — Embodiment

```
~/businesses/_library/dna/<slug>/          # layout FLAT, slug kebab-case
├── MANIFEST.yaml                          # manifesto + bloco routing:
├── agent/
│   ├── AGENT.md                           # persona operável: quando invocar, o que entrega, recusas
│   ├── SOUL.md                            # voz e temperamento — como a pessoa fala
│   └── DNA-CONFIG.yaml                    # config de injeção (sem pin de model)
└── dna/
    └── dna-schema.md                      # as 5 camadas com ^[FONTE]
```

O `AGENT.md` declara recusas coerentes com o material (o que a pessoa
publicamente não faz). Nenhum arquivo pinna modelo — o sistema é
model-agnóstico.

## Fase 4 — Bloco `routing:` no MANIFEST

Siga `MIND_CLONE_ROUTING_CONTRACT.md` à risca — atenção às regras 3d
(sintoma na voz do dono, SEM verbo de intenção) e 3e (comprimento). Schema
novo sempre: `serves` / `not_for` / `refuses` / `delegates_to`.

Com biblioteca não-vazia, leia os blocos dos vizinhos de território antes de
escrever (regra 4 do contrato) e delegue nominalmente só para slug que
existe. Biblioteca vazia (install limpo): não há vizinho a proteger —
`delegates_to` fica vazio até existir destino.

## Fase 5 — Index + gates (todos bloqueantes)

```bash
bun ~/.claude/skills/_shared/scripts/index-clones.ts   # espelha o escopo global sozinho
```

1. **Auto-recuperação:** o `one_liner` recupera o clone em 1º
   (`nrv find-clone "<one_liner>"`). É o invariante universal — vale para
   biblioteca de 1 clone ou de 542.
2. **Necessidade:** 2-3 consultas de SINTOMA que o usuário-alvo digitaria
   (PT, sem jargão) trazem o clone em 1º.
3. **Vizinhos intactos:** com biblioteca não-vazia, as consultas-casa dos
   vizinhos citados continuam com os donos.
4. **Zero aviso** de `domains ∩ refuses` ou domínio malformado no reindex.

Máximo 3 iterações de ajuste; se não bater, reporte o número real em vez de
empilhar tokens (regra 3e — empilhar dilui).

## O que NUNCA fazer

- Afirmar fidelidade de clone cujo material não sustenta (Regra 9.4 do
  harness: degradar com honestidade, não mentir).
- Nome de pessoa real em clone de material inventado — use archetype.
- Delegar para slug inexistente (precedente `sendak`/`lobel`).
- Copiar bloco `routing:` de outro clone como template de conteúdo — o
  território sai do MATERIAL, não do formato.
