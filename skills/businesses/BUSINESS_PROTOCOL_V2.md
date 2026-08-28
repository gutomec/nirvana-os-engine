# Business Protocol Specification — v2.0

```
Title:    Business Protocol Specification
Version:  2.0.0-draft
Status:   DRAFT (delta sobre a v1.0)
Date:     2026-08-27
Author:   Luiz Gustavo Vieira Rodrigues (Prospecteezy)
license:  SUL-1.0
Scope:    Núcleo agnóstico de runtime para operação autônoma de empresas
Predecessor: v1.0.0 (`BUSINESS_PROTOCOL_V1.md`)
```

## Sobre esta versão

A v2.0 é um **delta sobre a v1.0**, na mesma forma que a v5 do Squad Protocol foi delta sobre a v4: este documento descreve só o que muda. Tudo o que não aparece aqui continua valendo exatamente como está escrito em `BUSINESS_PROTOCOL_V1.md`.

A v1 foi escrita antes do engine existir. Dois anos de uso mediram a distância: em 26/08/2026, com 61 empresas e 581 funcionários instalados, **475 funcionários declaravam `heartbeat` e nada lia**, **566 declaravam `self_score_contract` e nada lia**, **234 declaravam `escalation_triggers` e nada lia**, nenhuma empresa tinha o diretório `tickets/` que a §10.2 chama de obrigatório, e nenhuma das 61 declarava `run_budget_usd`, o único campo de orçamento que o despacho realmente lê. Na direção contrária, o engine precisava de sete coisas que o protocolo não declarava: metadados de roteamento, clone fixado por cargo, preferência de squads sem fechar o conjunto, critério de aceitação por cargo, um campo único de orçamento, `.nirvana-surface.json` e o enum de `type` com os quatro valores que o validador já aceitava.

A v2 fecha essa distância nas duas direções. Ela não inventa capacidade nova: ela declara o que o engine faz, aposenta o que ninguém implementou e nomeia a semântica que estava só no código.

**Uma empresa v1 continua carregando, roteando e despachando como antes.** Os campos novos são opcionais; os campos aposentados continuam sendo aceitos pelo loader. A diferença aparece no portão de admissão (`nrv validate business <slug>`), que avisa, e no `--fix`, que converte.

### O que muda, em uma linha cada

| Mudança | Onde |
|---|---|
| `protocol: "2.0"` com leitura dupla (1.0 e 2.0) | §18 |
| Metadados de roteamento entram no protocolo (`produces`, `keywords`, `example_briefs`, `not_for`) | §6.9 |
| `auto_routes` mora só em `routing.yaml`, com semântica definida | §13.2 |
| `pinned_mind_clones`: clone fixado por cargo, primeiro degrau da escada | §7.7 |
| `squads_preferred` (aberto) × `squads_authorized` (fechado só quando não vazio) | §6.10 |
| `acceptance[]` por cargo substitui `self_score_contract` | §11 |
| `run_budget_usd` é o campo único de orçamento | §6.11 |
| Superfície morta deprecada e ignorada | §22 |
| Symlinks `dna/` aposentados | §5.3 |
| Enum `type` com os quatro valores e checagem flag/tipo | §7.8 |
| BP13 sobe para §3; BP4 redefinido; BP9 e BP10 aposentados | §3 |
| `employee_count` derivado; `.nirvana-surface.json` é do engine | §6.12, §5.3 |
| A tabela de validação é o catálogo do portão | §16 |

---

## §0 Política de deprecação

Esta política vale para todo campo, arquivo ou bloco marcado **aposentado** na v2. Ela é escrita uma vez e referenciada por cada item; nenhuma seção redefine o que "aposentado" significa.

1. **O loader tolera.** Um manifesto ou frontmatter com o campo aposentado carrega sem erro, na v1 e na v2. Rejeitar quebraria 475 dos 581 funcionários instalados no dia da publicação.
2. **O portão avisa.** `nrv validate business <slug>` emite um aviso por campo (`deprecated_field:<nome>`) ou por arquivo (`deprecated_file:<nome>`). Aviso não reprova a empresa; com `--strict`, reprova.
3. **A conversão é explícita.** Só `--fix` converte ou remove. `self_score_contract` vira `acceptance[]`, `draws_from` vira `assigned_mind_clones`, `dna_reference` vira `pinned_mind_clones`; os demais são removidos. Nenhum fixer apaga conteúdo autoral: arquivos deprecados são relatados, nunca apagados.
4. **A remoção é v3.** O loader só deixa de aceitar o campo numa v3. Até lá, um manifesto que nunca rodou `--fix` continua funcionando.

O par leitura tolerante / escrita canônica é o que permite aposentar dezenove superfícies sem uma janela de migração forçada.

---

## §3 Princípios de design (BP1-BP13)

BP1, BP2, BP3, BP5, BP6, BP7, BP8, BP11 e BP12 são idênticos à v1. Três mudam.

### BP4 (redefinido): aceitação é declarada por cargo, não pontuada pelo autor

A v1 dizia "self-score antes de todo handoff": o funcionário se avaliava contra o próprio `self_score_contract` e reportava a nota. Nada no engine lia esse contrato, e a nota que o autor dá a si mesmo não é evidência.

A v2 troca a autoavaliação por um **critério de aceitação declarado**: cada cargo declara `acceptance[]`, o que o entregável dele precisa satisfazer para ser aceito. Quem julga é o juiz do Gauntlet e o `verify-deliverable`, com o mesmo contrato que já vale para squads (`SuccessRequirement`). O funcionário continua podendo revisar antes de entregar; o que deixa de existir é a nota autoproclamada como gate.

### BP9 (aposentado na v2): cadeias de aprovação

`approval-chains.yaml` não existe em nenhuma das 61 empresas instaladas e nenhum código lê o arquivo. O número BP9 fica reservado — a numeração da v1 não é renumerada. Revisão adversarial continua existindo e continua sendo obrigatória: é BP7, o antagonista, que o team mode insere como passo de revisão antes do sintetizador.

### BP10 (aposentado na v2): heartbeats

`heartbeat` era o princípio mais declarado e o menos implementado: 475 funcionários o declaravam, 431 com `enabled: true`, e nenhum agendador jamais existiu. Um princípio que descreve um comportamento que o sistema não tem não é um princípio, é uma promessa. O número fica reservado. Trabalho recorrente é responsabilidade do agendador do host (`nrv schedule`, cron do sistema), fora do protocolo de empresas.

### BP13: contrato de escrita

BP13 já vigorava, mas morava na §10.7, fora da numeração do sumário (que anunciava BP1-BP12). Na v2 ele sobe para a §3, ao lado dos outros doze. O conteúdo não muda: todo entregável em prosa segue o contrato de escrita anexado a `AGENTS.md` / `CLAUDE.md` / `GEMINI.md`, por prevenção na hora da escrita, sem laço de correção posterior.

---

## §5 Estrutura da empresa

### 5.3 Layout canônico (revisão)

Três mudanças no layout da §5.1.

**`.nirvana-surface.json` é declarado e pertence ao engine.** O arquivo já era exigido na admissão de pack e não aparecia no layout do protocolo, o que fazia uma empresa válida ser recusada por um arquivo que a spec não mencionava. Ele fica na raiz da empresa, é gerado por `extractSurface`, e **nunca é editado à mão**: o portão o regenera (`surface_regen`). Ausência é erro (`surface_missing`); divergência em relação à extração é aviso (`surface_stale`).

**Symlinks `dna/` estão aposentados** (§0). Três empresas mantêm um diretório `dna/` com symlinks para clones da biblioteca. Symlinks não viajam em zip, então o vínculo se perde no pack e reaparece quebrado na máquina do comprador. Na v2 o vínculo entre cargo e clone mora só no frontmatter (`pinned_mind_clones`, `assigned_mind_clones`). O leitor de vínculos continua lendo `dna/` durante este ciclo, para detectar link quebrado (`dna_symlink_dangling`, erro); a presença do diretório é aviso (`dna_dir_present`) e `--fix` converte os nomes dos links em `assigned_mind_clones` do intake antes de remover o diretório.

**`processes/` sai do layout obrigatório** (§0). Nenhuma das 61 empresas tem o diretório e nada o lê. Workflow organizacional é responsabilidade de squad.

Layout da v2, com o que mudou marcado:

```
~/businesses/<slug>/
├── business.yaml              # manifesto
├── org-chart.yaml             # hierarquia + escalation_path
├── routing.yaml               # brief_intake + auto_routes (local único)
├── .nirvana-surface.json      # NOVO no layout — propriedade do engine
├── employees/*.md             # cargos
├── memory/
│   ├── permanent.md           # curado, substituído na atualização de pack
│   └── learned.md             # promovido por humano, sobrevive à atualização
└── README.md
```

Saem do layout: `culture.md`, `budgets.yaml`, `secrets-manifest.yaml`, `escalation-triggers.yaml`, `approval-chains.yaml`, `tickets/`, `processes/`, `dna/` (todos §0, todos §22).

---

## §6 Manifesto (`business.yaml`)

### 6.9 Metadados de roteamento (novo no protocolo)

O roteador escolhe a empresa por BM25 sobre um documento montado a partir do manifesto. Até a v2 as regras desse documento moravam em `ROUTING_METADATA_CONTRACT.md`, fora do protocolo, então uma empresa podia ser válida e invisível ao mesmo tempo. Os quatro campos entram no contrato:

| Campo | Cardinalidade | Regra |
|---|---|---|
| `produces[]` | 1-60 | Slugs de tipo de artefato, kebab-case. O que sai da empresa, não o que ela faz. |
| `keywords[]` | ≤100 | Grupos de sinônimos multilíngues: EN + PT (+ES quando natural), com e sem acento como entradas separadas. |
| `example_briefs[]` | 3-30 | Frases-sintoma como o dono escreveria. Ao menos uma em inglês e uma em português; formas conjugada e infinitiva. |
| `not_for[]` | ≤40 | Cercas de exclusão. 5 a 80 caracteres, 2 a 4 palavras de conteúdo, sem parênteses e sem sufixo explicativo. |

`not_for` é novo no schema. Ele já existia como campo de capability de squad e cinco empresas o declaravam no manifesto, mas o registro nunca o carregava, então a cerca não chegava ao roteador e não penalizava nada. Na v2 ele é carregado, indexado no meta do documento da empresa e impresso no digest de roteamento.

**Por que o teto de 80 caracteres e as 2 a 4 palavras.** A regra de disparo do roteador é medida, não opinada: uma entrada de até 25 caracteres dispara por substring; acima disso, por sobreposição de tokens, exigindo pelo menos 60% dos tokens da entrada presentes no brief. Uma entrada de treze tokens precisa de oito num brief só, e a medição sobre os 2.832 `example_briefs` reais da biblioteca mostrou que **902 de 910 entradas longas não disparam contra nenhum brief**. Uma cerca que nunca dispara não é uma cerca: é a crença de que existe um limite. O portão mede isso por entidade (`auto_route_never_fires` para rotas, `check-not-for-fires` para cercas) e o gate de CI recusa conteúdo novo que chega com cerca morta.

O limite de 40 entradas é configurável por `business_not_for_max` em `nirvana-limits.yaml`.

### 6.10 Preferência de squads e restrição de squads

A v1 §6.2 dizia que `squads_authorized` vazio significa "sem restrição". O prompt do funcionário fazia o contrário: lista vazia significava "não despache squad nenhum". Trinta manifestos e 201 funcionários declararam a lista vazia acreditando na spec, e o engine leu o oposto. A v2 fixa a semântica da spec e adiciona o campo que faltava.

```yaml
squads_preferred: [brandcraft, landing-page-nirvana]   # conjunto ABERTO
squads_authorized: [brandcraft]                        # conjunto FECHADO
```

- **`squads_preferred`** lista squads que aparecem primeiro no catálogo do funcionário, marcados como preferidos. Não fecha nada: qualquer squad da biblioteca continua elegível, e a escolha entre os cinco finalistas continua sendo agêntica (v1 §13.4).
- **`squads_authorized`** fecha o conjunto **e só quando não é vazio**. `[]` é idêntico a ausente, e ambos significam **todos os squads permitidos**.

As listas do manifesto valem para todo cargo. No frontmatter do funcionário, `squads_authorized` **estreita** (precisa ser subconjunto da lista da empresa, quando ela existe) e `squads_preferred` **acrescenta**.

Migração: listas vazias são **removidas**, nunca renomeadas — remover restaura a intenção de quem as escreveu. Listas não vazias ficam fechadas e entram no relatório do portão para o dono decidir.

### 6.11 Orçamento

Um campo só:

```yaml
run_budget_usd: 12.0     # teto por execução; 0 ou ausente = ilimitado
```

`run_budget_usd` é o teto de uma execução da empresa. Quando a flag da linha de comando e o manifesto declaram tetos diferentes, **vence o menor**. Em team mode o teto é agregado: vale para a cadeia inteira, não por funcionário.

`budget_monthly_usd` no frontmatter do funcionário está **aposentado** (§0). Ele aparece em 93 funcionários e nunca foi lido, porque não existe contabilidade mensal em lugar nenhum do sistema: não há ciclo de faturamento, acumulador ou reset. Um teto que ninguém soma é um número decorativo.

### 6.12 `employee_count` é derivado

`employee_count` era autorado nos 61 manifestos, recomputado do disco pelo registro e **erro do loader quando divergia** — ou seja, o autor tinha a obrigação de manter sincronizado um número que o sistema já sabia contar, e pagava com falha de carga quando esquecia.

Na v2 o campo é **derivado**: a contagem de `employees/*.md` é a verdade. Declarar continua sendo aceito (§0) e vira aviso (`employee_count_authored`); divergência deixa de ser erro. `--fix` remove a declaração.

---

## §7 Funcionários

### 7.7 Clone fixado por cargo (novo)

```yaml
pinned_mind_clones: [rory-sutherland]   # máximo 2
assigned_mind_clones: [dan-kennedy]     # dica, como na v1
```

Desde a mudança para clone por tarefa, `assigned_mind_clones` virou apenas uma **dica**: o cargo marcava o clone com ★ no catálogo e a escolha final continuava sendo do agente. Setenta e nove funcionários e 169 referências carregam essa dica sem efeito garantido, e para um cargo cuja identidade **é** o clone — um conselheiro que fala com uma voz específica — a dica não basta.

`pinned_mind_clones` é o vínculo forte. A escada de resolução de clone na v2 tem quatro degraus, nesta ordem:

1. **PINNED** — os clones de `pinned_mind_clones`, injetados antes de qualquer ranking.
2. **SOLICITADO** — o clone que o brief nomeia explicitamente.
3. **BUSCA** — o resultado da busca semântica sobre a biblioteca.
4. **AGENTE** — a escolha do próprio agente, quando os degraus acima não resolvem.

O teto é **2** porque a injeção em modo full carrega no máximo três clones; dois fixados deixam um lugar para o degrau seguinte.

Um clone fixado que não resolve na biblioteca é **degradação ruidosa**, nunca silenciosa: o prompt segue sem ele, o portão marca `pinned_clone_unresolved` como erro e a execução emite `mind_clone_missing_degraded`. Um cargo que promete uma voz e entrega outra é pior do que um cargo que não promete nada.

`dna_reference` está **aposentado** (§0): `--fix` o converte em pin quando o caminho resolve para um slug da biblioteca.

### 7.8 `type`: quatro valores

O protocolo v1 documentava dois valores; o validador executado sempre aceitou quatro, e os quatro estão em uso (536 `functional_specialist`, 17 `mind_clone`, 9 `orchestrator`, 4 `antagonist_gate`). A v2 declara os quatro:

| `type` | Significado |
|---|---|
| `functional_specialist` | Padrão (BP8). Cargo definido pelo método, não por uma pessoa. |
| `mind_clone` | Cargo cuja identidade é um clone fixado. Exige `pinned_mind_clones` (aviso `type_mind_clone_without_pin` quando falta) e `disclosure_required: true`. |
| `orchestrator` | Cargo que decompõe e distribui trabalho, sem produzir o entregável final. |
| `antagonist_gate` | Cargo de revisão adversarial. Implica `is_antagonist: true` (aviso `type_flag_mismatch` quando divergem). |

### 7.9 `acceptance[]` no frontmatter (novo)

Ver §11.

---

## §11 Aceitação por cargo (BP4 redefinido)

`self_score_contract` está **aposentado** (§0). No lugar dele, cada cargo declara o que o entregável dele precisa satisfazer:

```yaml
acceptance:
  - id: sources_cited                      # ^[a-z][a-z0-9_-]*$, único na empresa
    description: toda afirmação factual cita fonte nomeada e datada
    blocking: true                         # padrão: true
    minimum_score: 0.8                     # 0..1; padrão = perfil de intensidade
    capability: quality.specification_conformance   # padrão
  - id: report_exists
    description: o relatório existe e não é um esboço
    path: outputs/report.md
    min_bytes: 2000
```

| Campo | Obrigatório | Regra |
|---|---|---|
| `id` | sim | `^[a-z][a-z0-9_-]*$`, único dentro da empresa |
| `description` | sim | O que o juiz vai verificar, em uma frase |
| `blocking` | não | Padrão `true` |
| `minimum_score` | não | 0 a 1; sem valor, herda o perfil de intensidade do Gauntlet |
| `capability` | não | Padrão `quality.specification_conformance` |
| `path` | não | Caminho relativo do artefato, alimenta `verify-deliverable` |
| `min_bytes` | não | Piso de bytes do artefato em `path` |

**Como isso chega ao juiz.** Cada entrada mapeia 1:1 em `SuccessRequirement`, o mesmo tipo que capabilities de squad já usam. O `acceptance` do cargo de intake vira `SuccessContract.requirements` da execução; em team mode, o de cada funcionário da cadeia entra também. Entradas com `path` alimentam a verificação de existência do entregável.

**Conversão mecânica.** `self_score_contract.criteria[]` tem exatamente a forma necessária: `{id, description, threshold}` vira `{id, description, minimum_score}`, com `blocking: true`. As 566 declarações mortas viram requisitos vivos do juiz sem uma linha de autoria nova. `on_below_threshold` e `max_revise_iterations` não têm destino: o laço de revisão do Gauntlet já os substitui. Como a maioria das empresas repete os mesmos ids em todos os cargos, a conversão prefixa com o nome do cargo (`ceo_brief_understood`) quando o id colidiria dentro da empresa.

**Nenhum `acceptance` declarado** não é erro. O cargo de intake sem `acceptance` recebe aviso (`acceptance_missing`), porque é o cargo cujo entregável chega ao usuário.

---

## §13 Roteamento de brief

### 13.2 `auto_routes` mora em `routing.yaml`

`auto_routes` aparecia em dois lugares: `routing.yaml` (56 empresas) e `business.yaml` (7). O registro lia os dois e deduplicava, o que fez a duplicação parecer inofensiva por tempo suficiente para virar padrão. Na v2 **o local é `routing.yaml`**; `business.yaml.auto_routes` está aposentado (§0) e `--fix` realoca mecanicamente.

**Semântica, definida pela primeira vez.** Uma `auto_route` faz duas coisas, nesta ordem:

```yaml
auto_routes:
  - pattern: "(?i)\\b(auditoria|audit)\\b.*\\b(seo)\\b"
    route_to: seo-lead
```

1. **Candidato de roteamento.** O par (pattern, route_to) vira um documento no índice BM25, e um brief que casa com ele torna a empresa candidata. É o que já acontecia.
2. **Seleção do intake.** O primeiro padrão que dispara contra o brief resolve o funcionário que recebe: o despacho entra por `route_to` em vez de sempre entrar pelo `is_brief_intake`. É o que a v1 §10.5 prometia e nunca aconteceu, porque o despachante sempre resolvia o intake.

Regras:

- `route_to` precisa nomear um funcionário existente (erro `auto_route_unknown_employee`).
- **Primeiro que casa vence.** A ordem no arquivo é a ordem de avaliação.
- Um padrão catch-all (`.*`, `.+`, `(?i).*`) é **ignorado e sinalizado** (`auto_route_catch_all`): ele desliga o roteamento sem parecer que desliga, porque casa com tudo antes que qualquer regra específica seja avaliada.
- Todo padrão precisa disparar em ao menos um `example_brief` da própria empresa (aviso `auto_route_never_fires`). Um padrão que só dispara na cabeça do autor não é uma rota.
- `confidence_threshold` e `requires_escalation_to` estão **aposentados** (§0): nenhum dos dois foi lido em nenhum momento, e "confiança" de um casamento de regex não é uma quantidade que exista.

`routing.yaml.brief_intake.default_employee` continua valendo: é para onde o brief vai quando nenhuma rota dispara.

---

## §16 Validação

### 16.1 O validador executado

O validador que roda é **Zod**, em `skills/_shared/validators/validators.ts`. `validators.py` é o espelho canônico para hosts com Python, e `schemas/business.schema.json` e `schemas/core-schemas.json` são **espelhos de documentação**: eles descrevem o contrato, não o executam. Uma divergência entre o JSON e o Zod é um defeito do JSON.

### 16.2 O catálogo do portão

A tabela abaixo **é** o catálogo de critérios de `nrv validate business <slug>`. Os ids desta tabela e os ids do módulo do portão são o mesmo conjunto, verificado por teste de paridade (`skills/businesses/tests/protocol-v2-spec-parity.test.ts`). Uma linha aqui sem critério lá, ou um critério lá sem linha aqui, reprova o teste.

Colunas: **id** · **severidade** (erro reprova; aviso reprova só com `--strict`) · **autofix** (mecânico = aplicado por `--fix`; agêntico = `--fix=agentic`; nenhum = autoria humana) · **baselinável** (pode virar débito registrado em vez de reprovar).

Até 2026-08-28 nenhum erro era baselinável: débito era reservado a fato de pipeline (`seat_thin`, `self_retrieval_miss`), e violação de contrato reprovava na hora. Os dois critérios de auditoria abrem a exceção, e o motivo é a ordem do plano em `.nirvana/plans/event-contract.md`: este corte torna a violação **visível**, e é o corte 4 que renomeia os eventos preservando o payload. Sem baseline, as 4 entidades que já violam a regra — duas delas dentro de packs publicados — seriam reprovadas antes de existir para onde migrar. Com baseline, elas viram débito registrado, que só encolhe, e qualquer violação **nova** reprova.

#### Erros

| id | autofix | baselinável | o que verifica |
|---|---|---|---|
| `manifest_parse` | nenhum | não | `business.yaml` existe e é YAML válido |
| `manifest_schema` | mecânico | não | O manifesto passa em `BusinessManifestSchema` |
| `protocol_unsupported` | nenhum | não | `protocol` é `1.0` ou `2.0` |
| `employees_present` | nenhum | não | `employees/` existe com pelo menos um `.md` |
| `employee_frontmatter_invalid` | mecânico | não | Todo frontmatter passa em `EmployeeFrontmatterSchema` |
| `intake_exactly_one` | mecânico | não | Exatamente um funcionário com `is_brief_intake: true` |
| `org_chart_missing` | mecânico | não | `org-chart.yaml` existe |
| `org_chart_inconsistent` | mecânico | não | Todo nó existe em `employees/`, reporte bidirecional, sem ciclo |
| `antagonist_bp7` | nenhum | não | BP7: mais de 5 funcionários exige um antagonista |
| `auto_route_unknown_employee` | nenhum | não | Todo `route_to` nomeia um funcionário existente |
| `auto_route_in_manifest` | mecânico | não | `auto_routes` não está em `business.yaml` |
| `pinned_clone_unresolved` | nenhum | não | Todo `pinned_mind_clones` resolve na biblioteca |
| `acceptance_invalid` | mecânico | não | Ids de `acceptance` válidos e únicos na empresa; `minimum_score` em 0..1 |
| `surface_missing` | mecânico | não | `.nirvana-surface.json` existe |
| `dna_symlink_dangling` | nenhum | não | Nenhum symlink de `dna/` aponta para um alvo inexistente |
| `outputs_pollution` | nenhum | não | Nenhum diretório de saída de execução dentro da empresa |
| `audit_event_unprefixed` | nenhum | sim | Todo evento de auditoria que um arquivo nomeia está no enum fechado ou carrega o prefixo `x_` |
| `audit_event_unattributed` | nenhum | sim | Todo evento `x_` que a empresa emite nomeia a empresa (`business_slug` ou `--business=`) |

#### Avisos

| id | autofix | baselinável | o que verifica |
|---|---|---|---|
| `protocol_v1` | mecânico | não | A empresa ainda declara `protocol: "1.0"` |
| `employee_count_authored` | mecânico | não | `employee_count` declarado no manifesto (§6.12) |
| `deprecated_field` | mecânico | não | Um campo aposentado presente (`:<nome>` identifica qual) |
| `deprecated_file` | nenhum | não | Um arquivo aposentado presente (`:<nome>` identifica qual) |
| `squads_authorized_empty` | mecânico | não | `squads_authorized: []` declarado (§6.10) |
| `squads_ref_unknown` | nenhum | não | Squad citado em preferred/authorized não existe na biblioteca |
| `acceptance_missing` | agêntico | não | O cargo de intake não declara `acceptance` |
| `routing_metadata_incomplete` | agêntico | não | Falta ou está truncado um dos quatro campos da §6.9 |
| `description_short` | agêntico | não | `description` curta demais para render sinal de roteamento |
| `auto_route_never_fires` | nenhum | não | Um padrão não dispara em nenhum `example_brief` da empresa |
| `auto_route_catch_all` | mecânico | não | Um padrão casa com tudo (§13.2) |
| `seat_thin` | agêntico | sim | Um cargo não tem método próprio suficiente |
| `self_retrieval_miss` | agêntico | sim | Um `example_brief` não volta para a própria empresa em top-1 |
| `readme_missing` | mecânico | não | `README.md` ausente |
| `readme_thin` | agêntico | não | `README.md` sem conteúdo além do esqueleto |
| `memory_missing` | mecânico | não | `memory/permanent.md` ausente |
| `runtime_requirements_default` | mecânico | não | `runtime_requirements` no esqueleto do template |
| `type_mind_clone_without_pin` | nenhum | não | `type: mind_clone` sem `pinned_mind_clones` (§7.8) |
| `type_flag_mismatch` | mecânico | não | `type: antagonist_gate` sem `is_antagonist: true` (§7.8) |
| `dna_dir_present` | mecânico | não | Diretório `dna/` presente (§5.3) |
| `surface_stale` | mecânico | não | `.nirvana-surface.json` diverge da extração |
| `operation_mode_unsupported` | nenhum | não | `operation_mode` diferente de `zero_human`, não honrado neste ciclo |
| `legacy_partial` | nenhum | não | Bloco `legacy` presente e incompleto |

### 16.3 Comando

```bash
nrv validate business <slug> [--fix] [--strict] [--json]
nrv validate business --all [--fix] [--strict] [--json]
```

Códigos de saída: `0` admitida · `1` erro não baselinado · `2` só avisos, com `--strict` · `64` uso inválido ou entidade desconhecida.

---

## §18 Versionamento e compatibilidade

### 18.4 Leitura dupla

```yaml
protocol: "2.0"
```

O loader aceita `1.0` e `2.0`. Uma empresa `1.0` carrega exatamente como carregava, e recebe o aviso `protocol_v1`. `3.0` é recusado.

A subida para `2.0` é **a última coisa que `--fix` faz**, e só quando não resta nenhum erro v2 na empresa: declarar uma versão que a empresa ainda não cumpre é pior do que declarar a antiga.

Os dois schemas de registro (`RegistryBusinessesSchema` e o manifesto) aceitam o enum `1.0|2.0`. Antes desta versão o schema de registro fixava `1.0` como literal, então a primeira empresa `2.0` faria `nrv index` lançar antes de escrever o arquivo.

---

## §22 Superfície aposentada

Todos os itens seguem a §0: tolerados pelo loader, avisados pelo portão, convertidos ou removidos só por `--fix`, removidos do loader na v3. A coluna "medida" traz quantas entidades declaravam o item em 26/08/2026, sobre 61 empresas e 581 funcionários.

| Superfície | Medida | Destino |
|---|---|---|
| `heartbeat` (BP10) | 475 funcionários | Removido. Agendamento é do host. |
| `self_score_contract` (BP4) | 566 funcionários | Convertido em `acceptance[]` (§11) |
| `escalation_triggers` | 234 funcionários | Removido. `routing_rules.escalation_path` fica e passa a ser lido. |
| `escalation-triggers.yaml` | 13 empresas | Relatado, nunca apagado |
| `budget_monthly_usd` | 93 funcionários | Removido (§6.11) |
| `mentions` + `mention_routing` | 52 funcionários | Removidos. Handoff é `manages`/`reports_to` + org-chart. |
| `draws_from` | 51 funcionários | Convertido em `assigned_mind_clones` |
| `dna_reference` | 7 funcionários | Convertido em `pinned_mind_clones` (§7.7) |
| `business.yaml.auto_routes` | 7 empresas | Realocado para `routing.yaml` (§13.2) |
| `dna/` (symlinks) | 3 empresas | Convertido em vínculo de frontmatter (§5.3) |
| `culture.md` | 2 empresas | Relatado; conteúdo migra para `memory/permanent.md` |
| `budgets.yaml` | 1 empresa | Relatado, nunca apagado |
| Tickets (`tickets/`, bloco `tickets:`, `ticket_intake`) | 0 empresas | Removidos do protocolo |
| `approval-chains.yaml` (BP9) | 0 empresas | Removido do protocolo |
| `secrets-manifest.yaml` | 0 empresas | Removido. Segredo é `env_required` + o cofre do host. |
| `processes/` | 0 empresas | Removido do layout (§5.3) |
| `capabilities_required` | — | Removido. `capabilities[]` é o campo. |
| `project_tool_overrides`, `default_tools` | — | Removidos. `tools` do funcionário é a lista. |
| `disclosure_template` e o MUST de divulgação | — | Removidos. `disclosure_required` fica informativo. |
| `confidence_threshold`, `requires_escalation_to` | — | Removidos de `auto_routes` (§13.2) |

### O que continua honrado neste ciclo

`is_brief_intake` · `is_antagonist` / `antagonizes` (BP7, com passo de revisão real no team mode) · `reports_to` / `manages` · `org-chart.chart` e `routing_rules.escalation_path` · `routing.yaml` (`brief_intake.default_employee` e `auto_routes`) · `memory/permanent.md` e `memory/learned.md` · `maxTurns` · `tools` · `model` · `effort` · `authority_level` · `operation_mode` (só `zero_human`; os outros recebem aviso de "não honrado neste ciclo") · `runtime_requirements` · `features_required` · `env_required` · `legacy` · `ui` · metadados de roteamento (§6.9) · `run_budget_usd` (§6.11) · pins e dicas de clone (§7.7) · `squads_preferred` / `squads_authorized` (§6.10) · `acceptance` (§11).

---

## App-A Migração v1 → v2

Nenhum passo é obrigatório para continuar rodando. A ordem abaixo é a que `--fix` aplica, e ela termina na subida de versão porque a versão é uma afirmação sobre o resto.

1. `nrv validate business <slug> --json` — inventário do que a empresa declara.
2. `nrv validate business <slug> --fix` — remoção das listas vazias, realocação de `auto_routes`, conversão de `self_score_contract`, remoção dos campos aposentados, `dna/` para vínculo de frontmatter, regeneração da superfície.
3. Autoria humana para o que o `--fix` não inventa: `not_for`, `acceptance` do intake, cargos finos, cercas mortas.
4. `nrv validate business <slug> --strict` — relatório final.
5. `protocol: "2.0"` sobe sozinho, no fim, quando não resta erro.

O que `--fix` nunca faz: apagar arquivo autoral, remover rota, escrever `not_for` ou `example_briefs` que o autor não escreveu, ou tocar em metadado que o ratchet de cobertura conta.

---

## App-Z Histórico de versões

| Versão | Data | Mudança |
|---|---|---|
| 1.0.0-draft | 2026-05-02 | Primeira publicação. Modelo conceitual completo, BP1-BP12 (BP13 fora da numeração). |
| 2.0.0-draft | 2026-08-27 | Delta medido contra 61 empresas e 581 funcionários: metadados de roteamento, clone fixado, preferência × restrição, aceitação por cargo, campo único de orçamento, `auto_routes` com local e semântica, `dna/` aposentado, enum `type`, BP4 redefinido, BP9 e BP10 aposentados, BP13 na §3, `employee_count` derivado, superfície e catálogo de validação. |
