# Squad Protocol Specification — v6.0

```
Título:      Squad Protocol Specification
Versão:      6.0.0-draft
Status:      DRAFT
Data:        2026-08-27
Autor:       Luiz Gustavo Vieira Rodrigues (Prospecteezy)
license:     SUL-1.0
Escopo:      O documento de workflow, a aceitação, o avaliador e a composição
Antecessor:  v5.0.0 (`SQUAD_PROTOCOL_V5.md`), que por sua vez é delta sobre v4.0.0
```

## Sobre esta versão

A v5 foi uma camada aditiva estrita sobre a v4: quem não declarava `capabilities[]` continuava válido. A v6 segue a mesma regra e resolve o segundo modo de falha prático do protocolo, o irmão do primeiro. A v5 arrumou a **descoberta** de uma squad. A v6 arruma **o que a squad é por dentro** quando alguém a abre: o workflow.

O número que motivou o corte foi medido na biblioteca instalada em 26/08/2026, 204 squads e 619 arquivos de workflow. O grafo aparece em oito dialetos, dos quais só um (`steps[]`) está na spec: `steps[]` 51,5%, `workflow:` + `sequence[]` 26,8%, `agent_sequence[]` 16,6%, e a cauda com `flow.steps`, `flow.phases`, `sequence[]` solto, `pipeline.steps`, `event_routes` e três arquivos Markdown. Só 40% expressam alguma dependência. Cada leitor do engine — validador, auditor, fixer, superfície, índice de corpo — derivava seu próprio subconjunto dessas formas, e cada um derivava um subconjunto diferente. Além disso, 160 de 1.740 `task:` e 180 de 2.786 `agent:` apontam para arquivo nenhum, e 56 passos carregam o prompt inline em vez de referenciar uma task.

A v6 acrescenta:

- §28 Documento de workflow (`.md` = frontmatter grafo + corpo prosa)
- §29 Contrato de aceitação (`capabilities[].acceptance[]`)
- §30 Contrato do avaliador (`capabilities[].evaluator{}`)
- §31 Composição (`requires[]` e `consumes[]`)
- §32 Vínculo de execução (o que o engine consome, e o que a capability resolvida leva à execução)
- §33 `not_for` com teto de 25 caracteres
- §34 Admissão (`nrv validate squad`)
- §35 Migração (`nrv migrate --to 6`)
- App-G Schemas JSON gerados
- App-H Lista de deprecados

A v6 **não** muda §1–§21 da v4, nem §22–§27 da v5, com uma exceção nomeada: a regra 6 de §22.9 (`not_for` mencionando uma capability alternativa) é substituída por §33, que quer o contrário dela.

Squads v4 e v5 continuam carregando sem alteração. O leitor aceita as duas codificações de workflow para sempre (§28.4), e a severidade de cada regra é decidida pelo `protocol` declarado no manifesto: o que é erro sob `"6.0"` é aviso sob `"5.0"`. Uma squad entra na v6 declarando `protocol: "6.0"` — e, a partir daí, o portão cobra dela o que a spec diz.

### Limites desta versão

Um contrato desta spec pode chegar **ligado pela metade**: o schema o aceita, o portão o valida, um leitor já o consome, e o caminho que fecharia o ciclo ainda não tem chamador. Está marcado no texto como **limite**, com o que falta: `requires` e `consumes` viram aresta no grafo de entidades, mas a herança dessa ordem no plano multi-target continua sem chamador de produção, porque `compileManifest()` aceita `opts.composition` e ninguém passa a opção (§31.4). A ordem de fallback da aceitação (§29.3) e a ordem de seleção do avaliador (§30.3) eram limites e passaram a ser encanamento — as duas atrás de interruptor, com o comportamento de hoje como padrão.

---

## §28 Documento de workflow

### 28.1 Forma canônica

Um workflow da v6 é **um arquivo**: `workflows/<stem>.md`. O frontmatter é o grafo, o corpo é a prosa.

```markdown
---
name: main-pipeline
description: "Planeja o artefato e depois o constrói"
version: "1.0.0"
steps:
  - id: plan
    agent: orchestrator
    task: plan
    creates: [outline]
  - id: build
    agent: specialist
    task: execute
    requires: [plan]
    creates: [deliverable]
    on_failure: abort
success_indicators:
  - "o entregável existe no caminho declarado"
  - "toda seção do outline está coberta"
---

## plan

O que este passo lê, o que decide e o que entrega ao próximo.

## build

O que este passo monta a partir do anterior, e o que "pronto" significa aqui.
```

O grafo é validado por `WorkflowSchema` em `skills/_shared/validators/validators.ts`, que é `.strict()`:

| Campo | Regra |
|---|---|
| `name` | igual ao stem do arquivo, minúsculo, `^[a-z][a-z0-9_-]*$` |
| `description` | string, opcional |
| `version` | string, opcional |
| `steps[]` | mínimo 1 |
| `steps[].id` | `^[a-z][a-z0-9_-]*$`, único no workflow |
| `steps[].agent` | **obrigatório**, ≥1 char, nomeia `agents/<agent>.md` |
| `steps[].task` | opcional, **sempre uma referência** a `tasks/<task>.md`, nunca prosa |
| `steps[].requires[]` | ids de passos deste workflow; padrão `[]` |
| `steps[].creates[]` | nomes de artefatos; padrão `[]` |
| `steps[].on_failure` | `abort` \| `retry` \| `escalate` \| `continue`, opcional |
| `steps[].parallel_safe` | booleano, opcional |
| `steps[].meta{}` | chaves legadas de passo, preservadas verbatim (`validation`, `inputs`, `phase`, `gates`…); padrão `{}` |
| `success_indicators[]` | opcional; é a lista que §29 transforma em aceitação |
| `on_failure` | mesmo enum, no nível do workflow, opcional |
| `extensions{}` | chaves legadas de topo, preservadas verbatim (`harness`, `retry_policy`, `triggers`, `config`, `key_commands`…); padrão `{}` |

`meta` e `extensions` existem por um motivo só: **nada é descartado**. Uma chave que a v6 não conhece cai em um dos dois e sobrevive a qualquer número de idas e voltas pelo leitor. Um dialeto legado normalizado, renderizado de volta e lido de novo produz o mesmo objeto.

O escopo do protocolo é o **primeiro nível** de `workflows/`. Árvores aninhadas (`<squad>/<sub>/workflows/`, que algumas squads carregam) não fazem parte da superfície e não são lidas nem cobradas.

### 28.2 O corpo

O corpo é dividido por passo, em `## <step.id>`. Uma seção cujo título não casa com nenhum `id` não é erro: o corpo é para o modelo, e o modelo lê o arquivo inteiro. O que a spec exige é que a prosa de um passo esteja embaixo do id dele, para que quem lê o grafo saiba onde procurar.

Teto: `LIMITS.workflow_body_words_max`, hoje **2.500 palavras** (`skills/_shared/validators/limits.ts`, configurável entre 200 e 20.000). Passar do teto é **aviso sob qualquer protocolo** — é um fato sobre autoria, não sobre contrato. O corpo não substitui as tasks: método que serve a um passo só e é longo pertence a `tasks/<task>.md`, e §35 explica como a migração faz esse corte sozinha.

### 28.3 Lint

O lint vive em `skills/squads/lib/workflow-reader.ts` (`lintWorkflow`) e o portão o consome inteiro em `skills/_shared/lib/verify/kinds/squad.ts`. Cada regra tem um id, e o id é parte do contrato: uma constatação que o relatório não sabe nomear é uma constatação que ninguém corrige.

| Id | O que constata | Sob `6.0` | Sob `5.0` | Fixer mecânico |
|---|---|---|---|---|
| `workflow_parse` | o documento não é um mapeamento YAML válido | erro | erro | — |
| `workflow_inline_prose` | um passo carrega o prompt em `task: \|` ou `action:` | erro | aviso | `workflow_inline_prose_to_body` |
| `workflow_ref_unresolved` | `agent`/`task` de um passo não existe em disco | erro | aviso | `workflow_refs_repair` |
| `workflow_twin` | o mesmo stem em duas codificações (§28.5) | erro | aviso | `twin_merge` |
| `workflow_step_id_duplicate` | dois passos com o mesmo `id` | erro | aviso | — |
| `workflow_dangling_requires` | um `requires` nomeia passo nenhum | erro | aviso | — |
| `workflow_requires_by_output` | uma dependência nomeia o **output** de outro passo, não o id | erro | aviso | `requires_by_output_name` |
| `workflow_cycle` | o grafo de passos tem ciclo | erro | aviso | — |
| `workflow_shape_legacy` | o grafo está em dialeto legado (§28.4) | erro | aviso | `workflow_normalize_shape` |
| `workflow_stem_case` | o stem não é `^[a-z][a-z0-9_-]*$` | erro | aviso | — |
| `workflow_event_router` | o documento é um roteador `event_routes`, e roteador não tem ordem de passos | informativo | informativo | — |
| `workflow_body_too_long` | o corpo passou do teto de §28.2 | aviso | aviso | — |
| `workflow_orphan` | nenhuma capability invoca este workflow | aviso | aviso | — |

As duas últimas são conselho sob qualquer protocolo: um corpo longo e um workflow sem dono são fatos sobre autoria, não sobre o contrato.

`workflow_event_router` não é nem conselho. Um documento com `event_routes` declara rotas que chegam independentes — canal, condição, prioridade e cadeia própria em cada uma —, então não existe ordem entre elas para derivar, e não derivar nenhuma é a leitura certa de um arquivo certo. Ele continua no relatório porque o `steps[]` vazio que ele produz ficaria sem explicação, e sai como `info`, que não conta para veredito nem para o número de critérios passados. Antes era aviso, e o custo apareceu na biblioteca: duas squads corretas carregavam uma constatação permanente e, sob `--strict`, um veredito REJECTED que não tinham feito nada para merecer. São **dois arquivos em 629** (`nirvana-crypto-trading` e `nirvana-ai-trading`, ambos `event-driven-reactive.yaml`, medido em 27/08/2026) — poucos demais para pagar uma segunda forma canônica que leitor, lint, migração, construtor de prompt, grafo e catálogo passariam a tratar. Por isso a resposta é reconhecer a forma no relatório, não canonizá-la no protocolo.

Os fixers **nunca inventam**. Eles renomeiam, movem e reformatam o que já está lá: uma extensão que sobrou numa ref, prosa saindo de `task: |` para o corpo verbatim, um `depends_on` que nomeava um output virando o passo que o cria. Uma referência que não resolve para nada continua sendo constatação: escrever a task faltante seria fabricar o método da squad.

### 28.4 Dialetos legados e leitura dupla

`normalizeWorkflow()` é a única implementação da tabela abaixo, e cada casamento emite `legacy-dialect:<nome>`. Os nomes fazem parte do contrato: são o que o lint reporta e o que `nrv migrate` imprime.

| Forma legada | Normaliza para | Tag |
|---|---|---|
| `steps[]` + `depends_on` / `deps` / `after` | `requires = depends_on ∪ deps ∪ after` | `steps_depends_on` |
| cabeçalho `workflow:` + `sequence[]` | o cabeçalho sobe para o topo, `task: "x.md"` → `x` | `workflow_sequence` |
| `agent_sequence[]` | um passo por agente, encadeados | `agent_sequence` |
| `flow.steps` | `steps[]`, `flow.type` → `extensions.flow_type` | `flow_steps` |
| `pipeline.steps` | `steps[]` | `pipeline_steps` |
| `flow.phases[]` / `phases[]` / `stages[]` | achatados; a fase n requer os últimos ids da fase n−1 quando não há dependência explícita; a fase vira `meta.phase` | `flow_phases`, `phases`, `stages` |
| `sequence[]` solto | um passo por entrada, encadeados | `sequence` |
| `workflow: {agents: [...]}` (la-bottega) | um passo por agente; `all-as-needed` descartado; `command` → `extensions.command` | `workflow_agents` |
| `depends_on` nomeando o `output:` de outro passo | o passo que o cria, quando é único | `requires_by_output` |
| `workflow_name` | `name` | `workflow_name` |
| `success_criteria` | `success_indicators` | `success_criteria` |
| `on_fail` | `on_failure` | `on_fail` |
| `output` | `creates` | (dentro do passo) |
| `event_routes` | nada: é roteador, não DAG | `event_routes` |

Aliases de passo: `step_id`/`step`/`name` → `id`, `owner`/`role` → `agent`, `outputs`/`output` → `creates`, `deps`/`after`/`depends_on` → `requires`.

**A leitura dupla é permanente.** O engine lê `.yaml` e `.yml` para sempre, porque squads autorais v5 nunca serão migradas por seus donos e continuarão instaladas. O que a v6 muda é a severidade: sob `protocol: "6.0"` o dialeto legado é erro, porque a squad optou por isso.

Quando dois arquivos disputam o stem, a ordem é `.md`, `.yaml`, `.yml` — a mesma que a superfície de contrato usa para chavear a entrada.

### 28.5 A regra do gêmeo

`x.md` e `x.yaml` no mesmo `workflows/` são **um erro** sob 6.0: um stem, um grafo, um arquivo.

O fixer `twin_merge` só age quando a situação é fusão e não escolha — o `.yaml` normaliza para um grafo e o `.md` não carrega nenhum. Aí o Markdown fica com sua prosa, o grafo do YAML vira o frontmatter dele, e o YAML é removido. Qualquer outro gêmeo (os dois carregam grafo, ou o YAML não normaliza) fica para um humano: escolher entre dois grafos não é mecânico.

### 28.6 Referências sem extensão

Uma capability nomeia **o workflow**, não a codificação dele:

```yaml
invoke:
  type: workflow
  ref: workflows/main-pipeline      # não `workflows/main-pipeline.md`
components:
  workflows:
    - main-pipeline                 # idem
```

`resolveWorkflowRef()` resolve uma ref com ou sem extensão, tentando a ref literal e depois `.md`, `.yaml`, `.yml`, primeiro como caminho e depois sob `workflows/`. Uma ref com extensão portanto **funciona**; o que a v6 diz é que ela liga a capability a um arquivo em vez de a um workflow, e que trocar a codificação passa a exigir editar o manifesto.

Duas notas de precisão sobre o que o código cobra hoje, e que a spec descreve como está:

1. O critério `invoke_ref_extension` do portão dispara **só em `invoke.ref`**, e só quando a ref resolve. Uma entrada de `components.workflows` com `.md` não gera constatação.
2. O fixer `invoke_ref_extension` normaliza **as duas** superfícies. Ou seja: `components.workflows: [main-pipeline.md]` é aceito pelo portão e reescrito para `[main-pipeline]` na primeira passada de `nrv validate squad --fix`. Por isso o template escreve as duas sem extensão — é a única forma que é ponto fixo do `--fix`.

---

## §29 Contrato de aceitação

### 29.1 O que é

`capabilities[].acceptance[]` declara **o que o juiz cobra** de uma execução desta capability. É a lista que hoje vive na cabeça de quem escreveu a squad, ou, na melhor das hipóteses, em `success_indicators` do workflow, onde nada a lê.

```yaml
acceptance:
  - id: outline_covered
    description: "toda seção do outline aparece no entregável"
    blocking: true
    minimumScore: 0.85
```

Schema (`CapabilitySchema.acceptance`, `.strict()`, **máximo 12 entradas**):

| Campo | Regra |
|---|---|
| `id` | `^[a-z][a-z0-9_-]*$`, único dentro da squad |
| `description` | string não vazia; é a frase que o juiz lê |
| `blocking` | booleano, opcional |
| `minimumScore` | número entre 0 e 1, opcional |

### 29.2 Por que 12

Cada requisito de aceitação vira um gauntlet sequencial, uma linha no brief do juiz e uma dimensão exigida no scorecard. `validateScorecardFile` exige **exatamente N** dimensões: com N requisitos e N−1 dimensões o scorecard vira `indeterminate` e o entregável fica retido. Doze é o teto em que o custo do julgamento ainda cabe no orçamento de um run.

### 29.3 Ordem de fallback

`skills/harness/lib/gauntlet/success-requirements.ts` (`requirementsFor`) resolve o contrato do juiz nesta ordem, e o primeiro degrau que responde vence:

| Degrau | Origem | Bloqueia |
|---|---|---|
| `acceptance` | `capabilities[].acceptance[]` | sim, salvo `blocking: false` |
| `success_indicators` | `success_indicators[]` do workflow invocado, pelo leitor v6 (§28) | não |
| `task_acceptance_criteria` | `## Acceptance Criteria` da task invocada | não |
| `brief-conformance` | nada declarado | sim |

`brief-conformance` sempre vem antes de tudo, os ids derivados são namespaced (`acceptance.<id>`, `indicator.<n>`, `criterion.<n>`) para que nenhuma capability consiga sombrear o brief, e `minimumScore` sem valor cai no `fidelity.threshold` da capability e, na falta dele, no score do perfil de intensidade. Os dois últimos degraus não bloqueiam: um indicador que alguém escreveu em prosa nunca foi prometido como portão, e transformá-lo em um retém entregas que ninguém combinou reter.

**Interruptor.** `gauntlet.requirements_source` (`brief` | `capability`, padrão `brief`). No padrão, o contrato é o único `brief-conformance` de sempre e o plano compilado é bit a bit o de antes — o mesmo `planId`. Em `capability`, o contrato é o desta seção, e o `x_gauntlet_requirements_resolved` do audit diz de qual degrau ele veio.

---

## §30 Contrato do avaliador

### 30.1 O que é

Uma squad que oferece a capability `quality.specification_conformance` **é** um avaliador: o harness pode escolhê-la para julgar o trabalho de outra. Na v5 essa oferta não dizia com o que ela julga.

```yaml
- id: quality.specification_conformance
  evaluator:
    scorecard: scorecards/spec-conformance.json
    rubric: rubrics/spec-conformance.md
    dimensions: [completeness, fidelity, format]
    max_cost_usd: 0.40
```

Schema (`CapabilitySchema.evaluator`, `.strict()`): `scorecard` (string, obrigatória), `rubric` (string, obrigatória), `dimensions[]` (opcional), `max_cost_usd` (número ≥ 0, opcional).

### 30.2 Quando é cobrado

O critério `evaluator_missing` dispara para a capability de id `quality.specification_conformance` que não declara o bloco. É **erro sob 6.0** e aviso sob 5.0, e o reparo é agêntico: só quem escreveu a squad sabe qual é o scorecard dela.

### 30.3 Ordem de seleção

Entre vários avaliadores instalados e independentes do produtor (`evaluator-selection.ts`, `rankConformanceEvaluators`): `fidelity.status` `validated` antes de `experimental` antes de `drifted`, com `retired` fora da disputa; empate resolvido por `max_cost_usd` crescente, e uma capability sem bloco `evaluator` declara custo nenhum, então fica atrás de qualquer uma que declare; empate restante resolvido por slug. Uma biblioteca sem metadado de v6 tem só a terceira chave, então continua recebendo a resposta alfabética da v5.

`max_cost_usd` também vira o teto do orçamento passado ao avaliador: o `--max-budget` do subprocesso é `min(fatia do run, max_cost_usd)` — o teto declarado limita o gasto, nunca o aumenta. A linha vencedora viaja na seleção e é a razão que `nrv doctor` imprime. O override por `NIRVANA_GAUNTLET_EVALUATOR` continua acima de tudo isso, honrado ou recusado, nunca reinterpretado.

---

## §31 Composição

### 31.1 `requires[]`

Ids de capability de que esta capability depende, opcionalmente qualificados pela squad que os provê:

```yaml
requires:
  - research.market.scan          # desta mesma squad
  - brandcraft:branding.voice.define   # de outra squad
```

Padrão: `^(?:[a-z][a-z0-9-]{1,63}:)?[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$`. Máximo 8 entradas.

### 31.2 `consumes[]`

Slugs de `produces` que esta capability consome como insumo. Strings de 3 a 80 caracteres, máximo 20 entradas.

### 31.3 O que o portão cobra

`requires_no_provider` (aviso): uma entrada de `requires` sem prefixo tem que casar com uma capability da própria squad; com prefixo, tem que casar com uma capability declarada no `squad.yaml` da squad irmã, no mesmo diretório pai. Uma entrada de `consumes` tem que casar com algum `produces` da própria squad.

### 31.4 O grafo

`readSquadComposition()`, em `skills/_shared/lib/entity-graph.ts`, lê o `squad.yaml` de cada squad instalada e transforma as duas listas em arestas. Uma entrada de `requires` resolve para a squad que declara aquele id de capability e vira `depends_on` consumidor → provedor; uma entrada de `consumes` resolve por `produces` e vira `feeds` provedor → consumidor. As duas passam por `dependencyPair()`, que inverte a direção desenhada do `depends_on`, de modo que o provedor existe primeiro. `buildEntityGraph()` junta essas arestas às demais, e por isso `nrv graph order` e a ordem de instalação leem a composição sem precisar de uma segunda regra.

A aresta só nasce com provedor inequívoco. Repetir um id de capability é o desenho, não defeito: dez squads carregam `media.video.compose` e é o roteador que escolhe entre elas pelo brief. Escolher uma aqui inventaria uma ordem de execução que ninguém declarou, então dois provedores rendem nenhuma aresta e uma linha de relatório. Um prefixo `slug:` na referência (`brand-forge:design.brand.identity`) nomeia o provedor e encerra a dúvida. Uma referência que a própria squad satisfaz não é nem aresta nem achado, porque a auto-aresta seria ciclo e uma referência interna não é lacuna.

| Achado | `nrv graph check` |
|---|---|
| `requires` que nada provê | `x_requires_unresolved`, reprova sob `--strict` |
| `requires` que duas squads provêm | `x_requires_ambiguous`, reportado |
| `consumes` que nada produz | `x_consumes_unresolved`, reportado |
| `consumes` que duas squads produzem | `x_consumes_ambiguous`, reportado |

A ambiguidade para antes do erro de propósito. A capability existe, duas vezes, e reprovar a biblioteca por um id duplicado puniria a forma para a qual o roteador foi feito. Um `requires` sem resolução é o outro caso: a biblioteca não carrega aquela capability, e nenhuma ordenação a supre.

**O limite que sobra.** No plano a composição é costura, ainda não comportamento. `compileManifest()`, em `skills/harness/lib/plan-compiler.ts`, aceita o grafo derivado em `opts.composition`, e `inheritedCompositionEdges()` herda a ordem entre dois nós `squad` do mesmo plano quando o autor não a declarou. O autor sempre vence: um par já ligado por aresta, em qualquer direção, fica exatamente como escrito, e nada se herda para uma squad que o plano não nomeia. Só que nenhum chamador de produção passa a opção — `compileManifest()` é invocado hoje apenas por `plan-compiler.test.ts`. Sem ela a compilação é bit a bit a que já existia, e é essa que roda.

---

## §32 Vínculo de execução

Esta seção existe para separar o que a v6 promete do que o engine faz hoje, porque a diferença entre as duas coisas é onde um protocolo perde a confiança de quem o lê.

### 32.1 O que o engine consome hoje

- **`invoke.ref`** resolve pelo mesmo `resolveWorkflowRef` do portão, em `.md` e em `.yaml`, no índice de corpo (`body-index.js`) e no validador de capability.
- **O texto do workflow** entra no `body_text` que o BM25 indexa. Num `.md`, frontmatter e corpo entram juntos, sem os delimitadores, para que o mesmo grafo renda o mesmo texto esteja ele em `.yaml` ou em `.md`.
- **`components`** alimenta a superfície de contrato, que é o que um comprador vê mudar entre duas versões da squad.
- **`produces`, `domains`, `keywords`, `example_briefs`, `not_for`** alimentam o roteador.

### 32.2 O que a capability resolvida leva à execução

Até a 0.9.0 o engine despachava as 657 capabilities das 204 squads instaladas por um literal só. `dispatch.ts` carimbava `squad.execute` no Run, em cada ref de artefato e no alvo do Glance, e `buildSquadPrompt` não recebia capability nenhuma: o prompt era o `squad.yaml` inteiro mais os três primeiros `agents/*.md` e as três primeiras `tasks/*.md` em ordem alfabética, e `workflows/` nunca era aberto.

**A resolução.** `skills/harness/lib/capability-resolver.ts` responde, para uma squad e um brief, qual capability roda, e diz qual degrau respondeu:

| Degrau | Quando responde |
|---|---|
| `explicit` | quem chamou nomeou: `--squad <slug>:<capabilityId>`, `use squad <slug>:<cap>:` na cabeça de uma Message do Glance, um nó de plano com vários alvos |
| `single` | a squad declara exatamente uma capability, e nenhum brief é preciso |
| `bm25` | a squad declara várias: pontuadas contra o brief sobre os mesmos documentos que o roteador indexa, restritos a essa squad |
| `legacy` | a squad não declara nenhuma (manifesto v4): `squad.execute`, que é o que de fato vai rodar |

Toda resolução emite `x_capability_resolved` com o degrau, quantos ids a squad declara e, quando o BM25 decidiu, a nota, inclusive `0` quando nenhum termo do brief casou. A ausência de sinal aparece em vez de se disfarçar de acerto. Um id que quem chamou nomeou e a squad não declara é despachado assim mesmo, com `warning` no evento: quem chama manda.

**O prompt.** Com uma capability resolvida, `buildSquadPrompt` (`skills/harness/lib/squad-exec.ts`) monta quatro seções:

- `## SUA CAPABILITY` carrega o id, a descrição, `produces` e os critérios de aceitação, cada um marcado como bloqueante e com nota mínima quando os declara.
- `## SEU WORKFLOW (<arquivo>)` carrega a tabela de passos do grafo canônico (`#`, passo, agente, task, requer, cria), lida pelo leitor de workflow da v6, mais o corpo em prosa quando o workflow é `.md`. O caminho sai com separador POSIX em qualquer sistema, para que a squad leia a mesma referência que o `invoke.ref` declara.
- `## SEUS AGENTES` e `## SUAS TASKS` carregam todos os componentes que aquele workflow referencia, em ordem de passo, sempre por inteiro — nenhum documento é cortado ou omitido pelo tamanho. O par de seções mede o total contra um teto compartilhado, `LIMITS.squad_prompt_components_bytes_max`, 65.536 bytes por padrão (configurável, ver `limits.ts`): é um alvo, não uma cota. Quando as duas seções somadas ultrapassam o teto, o bloco de tasks — o último que o prompt mostra — fecha com uma nota dizendo o total e o excesso. O sinal existe para quem for revisar o workflow, não para decidir o que a squad recebe.

- `## O QUE MAIS ESTE SQUAD CARREGA` lista, um nível de profundidade, todo diretório que a squad carrega além dos três que o prompt já traz (`agents/`, `tasks/`, `workflows/`) — nome do diretório e o nome de cada arquivo dentro dele, com `/` no fim para subdiretório. Não é conteúdo: é mapa. O engine concede o diretório da squad no `addDirs` do despacho, então o agente abre o que precisar, em cascata, no momento em que precisar — o mesmo padrão de divulgação progressiva das skills. Ficam de fora o estado de execução (a lista é a do `isRunStatePath`, nunca uma cópia local) e a saída de build e dependência (`node_modules/`, `dist/`, `build/`, `__pycache__/`, `.venv/`). O que um passo **precisa** obedecer continua inline: um caminho é um pedido, texto inline é um fato.

  Esta seção é a única das quatro que **não** depende de capability resolvida, e de propósito. A squad legada é justamente a que recebe uma amostra alfabética arbitrária dos três primeiros agentes e tasks — é a que está com mais de si mesma faltando. Uma squad que não carrega nada fora dos três diretórios inlinados não ganha seção nenhuma, que é o que mantém o byte-a-byte honesto para quem de fato não tem nada a mais.

**A compatibilidade.** Sem capability resolvida as três primeiras seções não acontecem e o prompt é byte-idêntico ao anterior — ressalvado o mapa acima, que é aditivo e vale para toda squad que carregue algo além dos três diretórios inlinados: a seção de capability fica vazia e os dois blocos voltam para a coleta histórica dos três primeiros, com o cabeçalho `(top 3)`. Caem nesse caminho o `squad.execute` legado, um `squad.yaml` ilegível e um id que o manifesto não declara. É o que mantém as 204 squads instaladas despachando exatamente como despachavam, e `squad-exec.test.ts` fixa a string inteira nesse caso. Uma capability cujo `invoke.ref` não aponta para workflow legível mantém `## SUA CAPABILITY`, diz isso numa linha e deixa os componentes na coleta histórica; o mesmo vale quando toda referência de agente do workflow está pendurada, para que a squad nunca fique sem persona.

**O limite que sobra.** O grafo continua sem executor tipado. A tabela de passos é instrução para o agente que lê o prompt, não entrada de um engine: nada verifica que um passo só começou depois do que a coluna `requer` nomeia, nada guarda estado por passo e nada tenta de novo um passo que falhou. Escrever um workflow melhor muda o que a squad lê, o que o portão aceita, o que o roteador indexa e o que a migração deriva. Não muda quem executa.

---

## §33 `not_for` curto

Uma entrada de `not_for` tem no máximo **25 caracteres**.

A razão é mecânica. O roteador aplica a penalidade de `not_for` por substring até 25 caracteres; acima disso ele exige 60% de sobreposição de tokens entre a entrada e o brief, e uma frase inteira quase nunca alcança isso. Uma cerca longa é uma cerca que não dispara — o pior dos dois mundos, porque quem escreveu acredita que ela protege.

Forma: 2 a 4 palavras de conteúdo, sem parênteses e **sem sufixo de id**. Isto substitui a regra 6 de §22.9 da v5, que pedia o oposto (mencionar a capability alternativa): o sufixo `(use X)` fazia a entrada passar dos 25 caracteres e desligava a própria cerca que ela era.

```yaml
not_for:
  - "logo design"        # bom
  - "identidade visual"  # bom, e uma entrada separada por idioma
  # ruim: "logo design and visual identity work (use design-system-nirvana)"
```

O critério `not_for_too_long` é **erro sob 6.0** e aviso sob 5.0 — as 902 entradas longas da biblioteca instalada continuam carregando, e só uma squad que declara v6 é cobrada. Nota de precisão: o teto vive no portão (`NOT_FOR_MAX_CHARS` em `kinds/squad.ts`), não em `CapabilitySchema`, que só exige mínimo de 5 caracteres. Um manifesto com uma cerca longa parseia; o que ele não faz é ser admitido sob 6.0.

O critério irmão `not_for_dead` (aviso, baselineável) constata uma entrada que não dispara contra nenhum `example_brief` da própria squad.

---

## §34 Admissão

```bash
nrv validate squad <slug|path>          # relatório
nrv validate squad <slug> --fix         # aplica os reparos mecânicos, com backup e rollback
nrv validate squad <slug> --strict      # avisos também reprovam
nrv validate squad --all --json         # a biblioteca inteira, nirvana.verify-batch/v1
```

Saída: **0** admitida · **1** erro que a baseline não cobre · **2** só avisos, sob `--strict` · **64** erro de uso ou entidade desconhecida.

O catálogo de critérios de squad vive em `skills/_shared/lib/verify/kinds/squad.ts` e é o mesmo que esta spec descreve. Além das treze regras de workflow de §28.3, ele cobre o manifesto (`manifest_parse`, `manifest_schema`, `capabilities_missing`, `capability_outputs_shape`, `capability_examples_missing`, `not_for_too_long`, `invoke_ref_unresolved`, `invoke_ref_extension`, `components_missing`), a superfície (`surface_missing`, `surface_stale`), a higiene do diretório (`outputs_pollution`, `distribution_artifacts`, `portability`), o contrato de auditoria como o conteúdo o escreve (`audit_event_unprefixed`, `audit_event_unattributed`, ambos baselináveis), os contratos da v6 (`evaluator_missing`, `requires_no_provider`), a qualidade dos componentes (`agent_frontmatter_incomplete`, `task_acceptance_missing`, `dependencies_missing`, `readme_missing`), o roteamento (`routing_metadata_incomplete`, `not_for_dead`, `produces_untyped`, `fidelity_validated_unproven`) e o próprio protocolo (`protocol_below_6`, aviso).

O `--fix` roda em ordem fixa — estrutura, manifesto, arquivos, superfície — porque um fixer que reescreve o manifesto depois de a superfície ter sido congelada deixa a entidade reportando `surface_stale`. Ele tira um backup antes, roda, checa de novo, e **reverte** quando um fixer estourou, quando o manifesto parou de parsear ou quando um erro **novo** apareceu. Uma segunda passada de `--fix` é no-op por construção: cada fixer só escreve quando algo difere.

---

## §35 Migração

```bash
nrv migrate <slug|path> --to 6              # dry run: não escreve nada
nrv migrate <slug|path> --to 6 --apply      # converte
nrv migrate squad --all --to 6              # a biblioteca inteira, em dry run
nrv migrate <slug|path> --rollback <ts>     # desfaz
```

**Dry run é o padrão.** Sem `--apply` nada é escrito: nem a squad, nem o backup, nem o relatório.

### 35.1 O que a conversão faz

Por workflow:

1. `normalizeWorkflow` mapeia o dialeto legado sobre o grafo canônico (§28.4).
2. A prosa que vivia em `task: |` / `action:` **sai do grafo**. Um passo com prompt de verdade (≥40 palavras e sem referência de task) vira `tasks/<workflow>-<step>.md`, com o passo ganhando `task: <workflow>-<step>`; um recado curto fica no corpo, sob `## <step.id>`.
3. O documento canônico é escrito em `workflows/<stem>.md`, e o `.yaml` só é apagado **depois** de o `.md` ser relido e casar com `WorkflowSchema`.
4. Um gêmeo (§28.5) vira um arquivo só: o grafo do YAML, o corpo do Markdown.
5. Um `name` autoral que não é o stem é **realocado**, não descartado: vai para `extensions.title`, uma chave que nenhum dialeto reivindica e que sobrevive a qualquer ida e volta pelo leitor.

No manifesto: `protocol: "6.0"`; `invoke.ref` e `components.workflows` sem extensão (§28.6); as tasks extraídas entram em `components.tasks`; e `acceptance[]` é derivada dos `success_indicators` do workflow invocado, com `blocking: false` — a checklist do autor virando a checklist do juiz, que é a única coisa da conversão que muda o que uma execução é cobrada a entregar.

### 35.2 O que ela nunca faz

**Nunca inventa prosa.** Todo texto do corpo de um workflow migrado já existia na fonte: comentários, `description`, `success_indicators`, `validation`, blocos `task: |`. O único texto que a migração escreve é o andaime da task extraída — o frontmatter dela e o cabeçalho `## Acceptance Criteria` com um TODO. Referências pendentes são relatadas, não fabricadas: o lint é o portão, a migração é a transformação.

Três documentos ela recusa converter, pelo mesmo motivo:

| Documento | Recusa |
|---|---|
| `event_routes` | roteador, não DAG: nenhuma ordem de passos pode ser derivada |
| grafo vazio | nenhum passo pôde ser derivado do documento |
| stem fora de `^[a-z][a-z0-9_-]*$` | renomeie o arquivo primeiro |

Sem `--force`, a squad inteira é recusada e **nada** é escrito. Com `--force`, aquele documento fica intocado, no `.yaml` dele, e o resto da squad migra.

### 35.3 Segurança

- **Backup** em `~/squads-legacy-v5/<slug>.<ts>/`, com `fs.cpSync` e nunca `rsync` (a matriz de CI roda Windows, onde `rsync` não existe). Estado de run (`RUN_STATE_EXCLUDES`) fica de fora.
- **Relatório** JSON em `<state>/squads/<slug>/migrate-<ts>.json`, schema `nirvana.squad-migrate/v1`, **nunca dentro da squad** — um artefato de migração dentro do diretório viaja para todo pack construído a partir dele. Por arquivo, ele registra `{from, to, dialect_detected, steps_before, steps_after, unresolved_refs, inline_prompts_extracted, prose_words_moved}`; no topo, o backup, as refs reescritas, as tasks criadas, a aceitação derivada, os digests de árvore antes e depois, o resultado de `diffSurfaces(backup, migrado)` e o veredito do portão.
- **`--rollback <ts>`** restaura o backup e **recusa** quando a squad mudou depois da migração: o digest de árvore gravado no relatório é comparado com o digest de agora, e a divergência só é ignorada com `--force`.
- **Idempotência** decidida em bytes: uma segunda passada é no-op exatamente quando cada arquivo que a migração escreveria já contém o que ela escreveria.
- Ao final de `--apply`, a migração chama o portão (§34) e imprime o veredito.

### 35.4 Flags

| Flag | Efeito |
|---|---|
| `--to 6` | obrigatória (é o único protocolo de destino) |
| `--apply` | escreve; sem ela, dry run |
| `--all` | toda a biblioteca (ou o que estiver sob `--root`) |
| `--map-refs` | renomeia a ref de `agent`/`task` quando exatamente um componente casa por caixa ou por `_`/`-` |
| `--no-extract-tasks` | mantém todo prompt inline no corpo, sem criar tasks |
| `--no-derive-acceptance` | não deriva `acceptance[]` de `success_indicators` |
| `--force` | migra o resto de uma squad com documento irredutível; com `--rollback`, restaura sem a prova de "não mudou desde" |
| `--rollback <ts>` | restaura o backup daquele carimbo |
| `--json` | o relatório `nirvana.squad-migrate/v1` no stdout |

### 35.5 As três populações de `~/squads`

A migração da biblioteca não é uma passada só, e a ordem importa:

1. **Cópias instaladas de pack** (47, watermarkadas). **Nunca migrar ali.** Migre a fonte no repositório de packs; o `nrv update` entrega a versão nova.
2. **Originais que também existem nos packs** (~78). **Unifique antes** com `unify-squad.ts <slug> --authored <local>`, migre a cópia unificada, e deixe o `unify-squad` gravar em todos os packs byte-idêntico. `check-copy-drift --strict` compara o md5 do `squad.yaml` entre cópias: migrar uma cópia só é FATAL no build.
3. **Órfãs** (79). Migre no lugar, uma por vez, começando pelas roteadas. O resto fica v5 sob leitura dupla permanente, e isso é uma decisão, não uma pendência.

---

## App-H · Deprecado na v6

Nada abaixo deixa de carregar. Cada item é tolerado pelo leitor, avisado pelo portão, convertido ou removido só por `--fix` ou por `nrv migrate`, e sai do leitor numa v7.

| Deprecado | Substituto |
|---|---|
| `workflows/*.yaml` como forma canônica | `workflows/*.md` (§28.1); a leitura de `.yaml` é permanente |
| os oito dialetos legados de grafo | a forma canônica `steps[]` + `requires` (§28.4) |
| v5 §22.9 regra 6 (`not_for` citando a capability alternativa) | §33: teto de 25 caracteres, sem sufixo de id |
| `humanize` (campo, fixer e critério de auditoria) | removido; o pedaço útil virou o fixer `outputs_shape_repair` |
| `*squad run <name> --workflow <wf>` | `nrv run --squad <slug>[:<cap>]` |
| `skills/squads/schemas/*.json` | os schemas gerados de App-G |
| `tests/smoke-v5.ts` | `bun test skills` |
| limite de 500 caracteres em `capabilities[].description` | `LIMITS.capability_description_max`, hoje 1.500 |
| `output:` singular em capability | `outputs[]` |

---

## App-G · Schemas JSON

Os schemas JSON do protocolo são **gerados**, nunca editados à mão:

```bash
bun scripts/gen-json-schemas.ts            # grava
bun scripts/gen-json-schemas.ts --check    # falha quando um arquivo difere (roda no check:all)
```

| Arquivo | Gerado de |
|---|---|
| `skills/_shared/schemas/capability.schema.json` | `CapabilitySchema` |
| `skills/_shared/schemas/squad.schema.json` | `SquadManifestSchema` |
| `skills/_shared/schemas/workflow.schema.json` | `WorkflowSchema` |

O validador que **roda** é o Zod em `skills/_shared/validators/validators.ts`. O JSON é documentação, e documentação escrita à mão de um contrato executável diverge: `capability.schema.json` limitava `description` a 500 caracteres muito depois de `LIMITS` ter subido para 1.500, e `skills/squads/schemas/squad-schema.json` descrevia um manifesto v4 que ninguém autorava havia um ano. Gerar remove a classe inteira do bug, porque o espelho não pode discordar da fonte: ele **é** a fonte.

Os espelhos por squad (`squad-schema.json`, `agent-schema.json`, `task-schema.json`, `adapter-schema.json`, `handoff-schema.json`) foram removidos. `references/05-schemas.md` diz o que substituiu cada um.

---

## App-Z · Histórico

| Versão | Data | Delta |
|---|---|---|
| 4.0.0 | 2026-03 | núcleo agnóstico de runtime |
| 5.0.0 | 2026-05-02 | camada de descoberta por capability (§22–§27) |
| 6.0.0 | 2026-08-27 | documento de workflow, aceitação, avaliador, composição, `not_for` curto, admissão, migração (§28–§35, App-G, App-H) |
