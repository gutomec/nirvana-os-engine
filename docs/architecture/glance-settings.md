# Configuração pelo Glance

Data da revisão: 26 de agosto de 2026, branch `feat/glance-settings-panel`.

O painel "Configuração" do Glance liga, desliga e ajusta o engine pela interface, sobre o núcleo de configuração descrito em [Configuração](configuration.md). Tudo o que `nrv config` faz tem API e tela: a mesma resolução, os mesmos arquivos, o mesmo evento de audit. Este documento é o contrato do painel: o que ele mostra, como grava, quando a mudança vale e o que fica somente leitura.

## Uma aba, duas fontes

A engrenagem do cabeçalho abre um modal com duas famílias de abas, rotuladas na própria barra:

- **Engine**: as chaves de `skills/_shared/lib/settings-schema.ts`, agrupadas por seção na ordem do schema. É a seção principal e a única que edita `.nirvana/config.yaml`.
- **Ambiente (.env)**: a seção que já existia, com o comportamento anterior, para o que não tem chave no schema: segredos (chaves de API, token OAuth), escopo de biblioteca (`NIRVANA_SCOPE`, includes e excludes), caminhos, verbosidade, os padrões legados de host e `LLM_CASCADE`, mais as regras de runtime (`USE_*`, `NOT_USE_*`).

Não há segundo lugar para a mesma coisa. As variáveis que viraram chave do schema (`NIRVANA_MODEL`, `NIRVANA_ROUTING_MODE`, `NIRVANA_DNA_INJECTION`, `NIRVANA_STALL_THRESHOLD_MS`) saíram da lista do `.env`; uma linha delas que ainda exista num `.env` continua valendo, porque a variável vence, e aparece na seção Engine como chave fixada.

## O que o painel mostra, grupo a grupo

| Grupo | Chaves |
|---|---|
| Multi-target | `multi_target.enabled` |
| Gauntlet | `gauntlet.default_mode`, `default_intensity`, `evaluator`, `business_allowlist`, `business_kill_switch`, `auto_allowed` |
| Execução | `execution.default_runtime`, `model`, `dna_injection`, `headless_skip_permissions` |
| Glance | `glance.execution`, `maestro_max_budget_usd` |
| Runtime | `runtime.provider_catalog_dir`, `allow_stale_catalog` |
| Roteamento | `routing.mode`, `dense`, `on_router_failure` |
| Supervisor | `supervisor.progress_ping_sec`, `stall_threshold_ms`, `touch_events_max` |
| Atualizações | `updates.check` |
| Orçamento | `budget.default_max_cost_usd`, `default_max_tokens`, `default_max_handoffs`, `default_max_duration_seconds`, `on_budget_exceeded`, `auto_invoke_budget_usd` |
| Baselines de custo | `baselines.squad_capability_usd`, `business_usd`, `per_handoff_usd` |
| Quality gate | `quality_gate.judge_enabled`, `max_revisions`, `escalate_after`, `rubric_fallback`, `default_judge_model` |

Os grupos saem do schema, não de uma lista do painel: uma seção nova aparece sozinha, com o próprio nome quando o painel não tem rótulo para ela.

Cada chave tem um controle pelo tipo: um interruptor que diz `ligado` ou `desligado` para booleanos, um select com as opções do schema para enums, um campo numérico para números e um campo de texto para strings e listas (o schema valida a forma; `gauntlet.business_allowlist` é uma string de slugs separados por vírgula). Ao lado do controle: a descrição do schema em PT-BR, o valor esperado, o padrão, a variável legada, o valor efetivo e a origem em palavras (`projeto`, `global`, `engine`, `padrão` ou `variável NIRVANA_X=valor`) com o caminho do arquivo quando a origem é um arquivo. Um select por controle escolhe o escopo da gravação, `projeto` ou `global`, só entre os escopos que a chave aceita (`updates.check` só oferece `global`). Salvar grava aquela chave; "Remover do arquivo" a tira do arquivo do escopo escolhido, e a camada seguinte passa a valer. Uma recusa aparece embaixo do controle, com a mensagem do schema; uma gravação mostra o que mudou e, quando o valor em vigor continua vindo de outra camada, diz qual.

Acessibilidade: todo controle tem `label`, o interruptor é `role="switch"` com `aria-checked` e texto, a aba ativa leva `aria-current`, os erros são `role="alert"`, o foco é visível e nenhuma informação depende só de cor.

## Regras

A lógica do painel está em `skills/harness/lib/glance/views/settings-panel.js`, um módulo ES puro que o `bun test` importa direto e que a página expõe em `window.NirvanaSettingsPanel` por um adapter em `index.html`, o mesmo padrão de `run-event-labels.js`. O módulo agrupa, mapeia controle e valor, monta as requisições e lê as respostas; não valida valor, porque o servidor valida com o schema e a mensagem que ele devolve é a que o usuário lê.

A API é a de [Configuração](control-plane-api.md#42-configuração): `GET /api/v1/settings`, `PUT /api/v1/settings/<chave>` e `DELETE /api/v1/settings/<chave>?scope=`. Cada gravação leva uma `Idempotency-Key` própria; a mesma chave com o mesmo corpo devolve a mesma resposta sem gravar de novo. Uma gravação que muda um arquivo grava `x_settings_changed` com `actor: "glance"` no audit do projeto, o mesmo evento que `nrv config set` grava.

A camada de projeto é o root que o servidor serve (`NIRVANA_PROJECT_ROOT` ou o diretório onde `nrv glance` subiu). O arquivo global é `~/.nirvana/config.yaml` (`NIRVANA_HOME` substitui o `~`). O painel imprime os dois caminhos no alto da seção.

## Quando a mudança vale

O runner de execução do Glance resolve as configurações a cada spawn e fixa os valores efetivos no ambiente do filho como as variáveis legadas (`settingsEnvForChild`), e o núcleo invalida o cache do arquivo a cada gravação. Por isso uma mudança feita no painel vale no próximo despacho pelo Glance, sem reiniciar o servidor: `gauntlet.evaluator: judge-x` chega ao próximo filho como `NIRVANA_GAUNTLET_EVALUATOR=judge-x`, `multi_target.enabled: false` como `NIRVANA_MULTI_TARGET_KILL_SWITCH=1`. O teste `glance-settings-api.test.ts` prova isso com o filho fake: uma Message antes da mudança, a gravação pela API, uma Message depois, e o ambiente que cada filho registrou.

Duas chaves o servidor lê na própria inicialização, então valem no próximo `nrv glance`, não no próximo despacho: `glance.execution` (decide se o runner sobe) e, pela natureza dela, `updates.check` (a verificação de release roda no próximo comando `nrv`). O painel grava as duas normalmente; o efeito é o que muda de momento.

## O que fica somente leitura, e por quê

**Chave fixada por variável.** Quando a origem do valor efetivo é uma variável (`source: env`), o controle fica desabilitado, com o selo "somente leitura" e a explicação: fixado por `NIRVANA_X=valor` no ambiente do servidor. A variável pode vir do shell que iniciou o Glance ou do `.env` do projeto, que o Bun carrega. Gravar no arquivo seria inútil, porque a variável venceria, e a API recusa com `409` dizendo qual é. O caminho é remover a variável, reiniciar o Glance e editar.

**Modo `--read-only`.** Todo controle fica desabilitado e a API responde `403` a qualquer gravação; a leitura continua.

**Origem `engine`.** O valor que vem de `skills/harness/config.yaml` é editável como qualquer outro, mas o painel nunca grava nesse arquivo: a gravação vai para o projeto ou para o global, que sobrevivem ao `nrv update`. A origem `engine` só informa de onde o valor atual está vindo.

**Segredos.** Não existem no schema (`secret: false` em toda chave), então a seção Engine nunca mostra nem grava um segredo; eles ficam na seção `.env`, mascarados, como antes.

**Um arquivo ilegível.** YAML malformado ou um valor fora do tipo em `.nirvana/config.yaml` faz a seção inteira aparecer com o erro que nomeia o arquivo e a chave, e a API responde `409` até o arquivo ser consertado à mão; `nrv config list` dá o mesmo erro. Nada é gravado por cima de um arquivo que o resolvedor recusa.

## Testes

| Arquivo | O que prova |
|---|---|
| `skills/harness/tests/glance-settings-api.test.ts` | as rotas: schema, valor efetivo, origem e `locked` no `GET`; `Idempotency-Key`, `Origin` e `--read-only`; chave desconhecida, valor inválido, escopo recusado; chave fixada por variável; set → get → unset no projeto e no global com o audit de cada escrita; replay idempotente; arquivo ilegível; e o efeito no próximo filho fake sem reiniciar |
| `skills/harness/tests/glance-settings-panel.test.ts` | o módulo puro: grupos e rótulos a partir do schema real, controle por tipo, estado `locked`, mapeamento de valores, requisições, avisos e mensagens de recusa |
| `glance-control-plane.test.ts`, `glance-agent-x-canary-e2e.test.ts` | regressão da segurança das rotas existentes e da execução por processo filho |
