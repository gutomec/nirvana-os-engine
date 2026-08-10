# Contrato do bloco `routing:` do mind-clone

O orquestrador não sabe o nome de ninguém. Ele sabe que precisa de "uma diretora de elenco", de "alguém que resolva o tom de voz da marca". O bloco `routing:` no `MANIFEST.yaml` é o que torna um clone encontrável por **necessidade** em vez de por nome. Sem ele, o clone só é alcançado por quem já sabe quem procurar — o que anula a descoberta.

Este documento é o contrato do bloco e o registro do que já deu errado. Cada regra abaixo existe porque um defeito real foi medido, não por gosto de estilo.

## O schema

```yaml
routing:
  # ── INDEXADO: o que este clone serve ────────────────────────────────
  one_liner: "..."      # 1 frase: quem é + a escolha para o quê
  domains:              # 20-30 itens, cada um em PT e EN como itens SEPARADOS
    - tom de voz de marca
    - brand tone of voice
  serves: "..."         # parágrafo: quando escolher. Só afirmação.

  # ── NUNCA INDEXADO: lido pelo orquestrador DEPOIS de recuperar ──────
  not_for: "..."        # o que ele não faz, e quem faz
  delegates_to:         # slugs que existem de fato
    - outro-clone
  refuses:              # termos curtos do que ele recusa
    - resposta direta
```

`serves` substitui o antigo `when_to_use`. Blocos legados que ainda usam `when_to_use` continuam indexados por compatibilidade, mas bloco novo não deve escrevê-lo.

A separação entre os dois lados é a razão de o schema existir. Ver regra 3.

## Regra 1 — domínio só com lastro material

Para cada domínio declarado, tem que existir um item de camada do DNA que o sustente: framework, heurística, metodologia ou playbook. Se a pessoa é famosa por X mas o clone não tem método de X, **X não entra**.

Domínio declarado sem método é despacho que chega vazio: o orquestrador convoca, paga o custo, e recebe vocabulário em vez de procedimento.

Casos reais: `greg-mckeown` declarava `leadership-multiplication` e *Multipliers* como fonte primária, sem uma linha de método. `charles-duhigg` tinha `productivity-frameworks` em tags enquanto o próprio schema registrava a lacuna — "um dispatch pedindo 'aumente a produtividade do time' recebe vocabulário, não método".

## Regra 2 — nunca convoque pelo que o clone recusa

`saul-steinberg` declara `cartum` em `domains` enquanto o `AGENT.md` abre com "Não-cartunista" e define cartum como o modo de falha. Quem roteia por cartum recebe uma recusa.

Leia as seções de recusa antes de escrever: `Limitations`, `What You Refuse to Do`, "NÃO use quando", "O que NUNCA diz".

Declarar o termo recusado em `refuses` faz o indexador avisar sobre a contradição (`index-clones.ts` compara `domains ∩ refuses`) e faz o corpus descartar tag do manifesto que o contradiga.

## Regra 3 — BM25 não entende negação

Esta é a razão de o schema ter dois lados.

O índice pontua sobreposição de termo. "Não use para resposta direta" indexa como voto **a favor** de resposta direta. Não é hipótese: dois blocos escritos por autores independentes ranquearam em primeiro lugar nas consultas que a prosa deles queria repelir.

- `brene-brown` veio em 1º numa consulta clínica porque a recusa dizia "diagnóstico", "tratamento", "saúde mental".
- `nils-leonard-cco` veio em 3º na consulta que nega porque a recusa espelhava "custo por aquisição".

`not_for`, `refuses` e `delegates_to` **não entram no corpus**. Escreva a recusa lá, com as palavras que quiser — ela não pode mais trair o bloco. `serves` recebe só afirmação.

### 3a — a negação cabe num item de `domains` de três palavras

Variante mais traiçoeira, porque parece um domínio bem-comportado. `billy-wilder` declarava `sugerir em vez de explicar` e `escalar até o clímax e parar sem epílogo`. O índice leu `explicar` e `epílogo` como voto a favor, e ele passou a vencer "exposição explícita e didática" e "epílogo longo depois do clímax" — o oposto exato do que declarava.

Nomeie o método pelo que ele **é** (`subtexto`, `Lubitsch Touch`, `escalada do terceiro ato até o clímax`), nunca pelo que evita. Proibido em `domains` e em `serves`: "em vez de", "sem", "não", "nunca".

### 3b — cubra as variantes de vocabulário

BM25 casa token, não sentido. `IA` e `inteligência artificial` são estranhos entre si; `diretora de elenco` e `casting` também. O clone que declarou só uma das formas fica invisível para quem escreveu a outra.

Inclua sigla e forma por extenso, o sinônimo que um leigo usaria, e a forma em português mesmo quando o material de origem é todo em inglês — 21 dos 542 clones têm material majoritariamente em inglês e dependem do bloco para existir em consulta PT-BR.

Cubra também as flexões, porque o tokenizer não faz stemming: `buy` e `buying` são tokens distintos, assim como `sentiria` e `sentiriam`, `screen` e `screens`, `fontes` e `tipografia`. Declare a forma que a pessoa vai digitar, não só a canônica.

### 3d — declare o sintoma, não só o método

O defeito mais caro descoberto até agora, e o mais fácil de cometer justamente por quem escreve bem.

Sete clones de UX tinham bloco — avaliação heurística, severity rating, formulário, microcopy, ethos, hierarquia atômica, animação — e nenhum era encontrado por **"meu app está confuso e os usuários não conseguem completar as tarefas"**. A consulta caía em `donald-miller`, `andrew-chen-cgo` e `anne-lamott`. Cada um havia declarado o instrumento com precisão; ninguém declarou o problema como o dono o descreve.

Quem procura não sabe o nome do método — se soubesse, procurava pelo nome do especialista. Declare pelo menos três ou quatro itens no registro de quem tem o problema:

- o **sintoma** (`app confuso`, `usuário abandona no meio`, `time repete a mesma discussão`, `a margem caiu dois meses seguidos`)
- a **consequência** (`ninguém completa a tarefa`, `perdemos o cliente na renovação`)
- o **pedido amplo** que o dono faria (`melhorar a experiência do produto`, `organizar a área de RH`)

Isso não conflita com a regra 3c: o teto de 20-30 itens continua, e o corte sai de domínio técnico redundante — se `avaliação heurística` e `heuristic evaluation` já estão lá, o terceiro sinônimo técnico vale menos que um sintoma.

Teste antes de entregar: escreva a consulta como um dono não-técnico escreveria, sem jargão nenhum, e confira que ela chega em alguém do cluster certo.

Caso real: `reuven-avi-yonah` vencia "transfer pricing Pillar Two BEPS" em inglês e era invisível para "preços de transferência e imposto mínimo global", deixando a consulta cair num clone de IVA que só casava a palavra `imposto`.

**Declare o sintoma, não o andaime.** Escreva `o app está confuso e ninguém completa a tarefa`, nunca `quero consertar o app que está confuso`. O verbo de intenção é a moldura da frase e não o assunto dela — e como quase nenhum bloco o declara, ele fica raro no corpus, e o IDF paga raridade. `quero` chegou a pesar 4.28 contra 1.40 de `marca`: três vezes o peso do substantivo que nomeia o domínio. O tokenizer agora descarta `quero`, `quer`, `queria`, `gostaria`, `want` e `need`, mas a lista não cobre tudo (`preciso` e `ajuda` ficaram de fora porque também são adjetivo e substantivo). Vale como disciplina de escrita, não só como conserto de motor.

### 3e — o `serves` longo se dilui

BM25 normaliza por comprimento, e o corpus tem média de ~145 tokens porque a maioria dos clones ainda não foi enriquecida. Um `serves` de 1.200 tokens recebe por ocorrência de termo cerca de um quarto do que recebe um bloco legado de 110 — para empatar com um legado que diz o termo uma vez, o bloco completo precisa repeti-lo seis vezes.

Três autores independentes tropeçaram nisso na mesma leva e resolveram do mesmo jeito: `john-maeda-products-practice` cortou de 1.214 para 1.064 tokens, `caio-braga-products-practice` de 983 para 707 e virou as três consultas de uma vez, `aarron-walter-products-practice` viu um clone **perder** uma consulta que já ganhava quando era um documento curto. A régua prática: **`serves` acima de ~500 tokens custa mais do que rende.**

Escrever mais não é declarar melhor. Corte a prosa, preserve os números e os nomes próprios dos frameworks.

Isso **não** é caso de recalibrar o `b` do BM25. A varredura foi feita (2026-07-27, b de 0.0 a 0.9 contra 47 consultas de necessidade escritas antes de os blocos existirem): o alvo com bloco vem em 1º em **todos** os valores de `b`, e o alvo sem bloco perde em todos. O que decide é ter bloco, não a calibração — MRR 1.000 contra 0.05. Não repita a varredura.

### 3c — densidade também rouba consulta

Nem todo roubo é vazamento de negação. `chris-mercer-tracking` vencia uma consulta de BigQuery que recusa porque tinha quatro domínios carregando `GA4` mais três menções no `serves` — virou ímã de qualquer consulta pesada em GA4.

O conserto é estreitar a reivindicação ao que o material sustenta, não empilhar mais itens: BM25 normaliza por comprimento, então acumular dilui o que já pontuava.

## Regra 4 — vizinhança antes de escrever

Delegação só depois de confirmar que o destino existe. Handoff para clone inexistente já aconteceu (`sendak`, `lobel` no bloco do `saul-steinberg`) e é beco sem saída.

Ache os vizinhos de duas formas, porque uma só não basta:

**Por nome** — acha o irmão de mesmo sobrenome com outro sufixo de papel. Precedente: os três `david-droga` (`-ceo`, `-cco`, `-brand-practice`), cada um vencendo a própria consulta e caindo para 4º nas dos irmãos.

**Pelo tema, usando a própria busca** — grep por nome só encontra quem por acaso se chama como o assunto. Num despacho de tributário isso perdeu 13 vizinhos reais, porque `humberto-avila` e `paulo-barros-carvalho` não têm "tributo" no nome. Rode os domínios candidatos contra o índice e veja quem vence hoje:

```
bun -e 'const {findCloneForTask}=await import("./skills/_shared/lib/clone-search.ts");for(const q of ["dominio candidato"]){console.log(q,"->",findCloneForTask(q,{limit:5}).map(h=>h.slug).join(", "))}'
```

Quem aparecer ali é o concorrente de fato. Depois de escrever, rode a consulta-casa de cada um e confirme que continuam vencendo. **Tomar o lugar de um vizinho com lastro melhor é pior do que não ser encontrado.**

Quando dois clones dividem obra — coautores, ou a mesma pessoa em recortes diferentes — escreva a fronteira dos dois lados. Precedente: `chan-kim` e `renee-mauborgne` dividiram Blue Ocean por camada (a maquinaria analítica dele, o lado humano dela) e o mapa de utilidade do comprador por enquadramento (ele testa viabilidade de ideia pronta, ela caça bloqueio ignorado pela indústria). A consulta genérica virou disputa real, 1.00 contra 0.96, em vez de vitória por ausência.

## Verificação obrigatória

**Integridade** — o YAML parseia, `domains` não tem item com barra (PT e EN são itens separados), nenhuma outra seção do MANIFEST foi tocada, o diff é só inserção.

**Reindexe nos dois escopos** — o registry é cache derivado; sem reindexar, a busca não enxerga o bloco novo. A escrita é atômica, então pode rodar com outros agentes trabalhando.

Existem **dois** registries, e o escopo depende do diretório de onde você roda:

```
cd ~/nirvana-os && bun skills/_shared/scripts/index-clones.ts   # escopo de projeto
cd ~            && bun nirvana-os/skills/_shared/scripts/index-clones.ts   # escopo global
```

O primeiro grava em `~/nirvana-os/.nirvana/`, o segundo em `~/.nirvana/` — que é a instalação de quem de fato usa o sistema. Rodar só o primeiro deixa o bloco invisível para o install, e isso já aconteceu: o registry global ficou cinco dias parado enquanto dezenas de blocos entravam no de projeto. Rode os dois.

**Busca por necessidade** — 3 consultas em linguagem natural (2 PT, 1 EN) que descrevem a necessidade **sem citar o nome**. O clone precisa vir em 1º. Use a consulta inteira e realista; fragmento de palavra-chave não prova nada, e encurtar a consulta muda o teste.

**Controle negativo** — uma consulta sobre assunto que o clone recusa. Ele **não** pode vir em 1º. Se vier, o problema é quase sempre a regra 3 (vocabulário da recusa vazando) ou a 3c (densidade). Corrija e repita.

## O que o motor faz por você

- **Acento é dobrado** no tokenizer, então `perícia` e `pericia` casam. Antes o acento era separador e `hábito` virava `h`+`bito`, o que penalizava domínio escrito em português.
- **Palavra funcional PT/EN é descartada.** Num acervo majoritariamente em português as stopwords inglesas são raras, e o IDF premia raridade: `and` chegava a pesar mais que `marca`.
- **`refuses` filtra tag do manifesto.** Tag anterior ao bloco que contradiga a recusa não entra no corpus — foi assim que `lex-fridman` fechou o vazamento das tags `tecnologia` e `ia-filosofia-politica`. O casamento é por **igualdade exata normalizada**, então escreva termo canônico, não prosa de fronteira: `pesquisa de palavras-chave` no plural jamais filtra uma tag no singular. A fronteira em prosa vai no `not_for`; `refuses` é lista de termos.
- **Palavra funcional descartada inclui o verbo de intenção** — `quero`, `quer`, `queria`, `gostaria`, `want`, `need` e flexões. Ver 3d.
- **Numeral por extenso na prosa do `serves` vira token de alto IDF.** `kevin-indig` vencia uma consulta sobre queda de tráfego pós-update sem casar `google`, `atualização` nem `recuperar` — pontuava em `cento`, vindo de "as citações sobem cento e vinte". Escreva o número em algarismo, ou reescreva a frase.
- **Contradição `domains ∩ refuses` vira aviso** no reindex. É aviso, não erro: gate que reprova por falso positivo ensina todo mundo a ignorar aviso.

## Dívida conhecida

`slug` e `display_name` são indexados, e sobrenome colide com substantivo comum em português: "meu filho desiste na primeira dificuldade" cai em `mario-filho-data`, "a rocha da estratégia" em `melina-rocha`. São 8 colisões atingindo 15 clones.

O conserto é tirar o nome do corpus de necessidade — busca por nome roda antes, no passo SOLICITADO do orquestrador. Não é seguro enquanto houver clone sem bloco: `billy-wilder` não tinha nem tags, e o nome era a única âncora dele. Fazer quando o enriquecimento fechar.
