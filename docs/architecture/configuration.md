# Configuração

Data da revisão: 26 de agosto de 2026, branch `feat/settings-core`.

Este documento é o contrato do núcleo de configuração do engine: onde cada interruptor operacional vive, em que ordem as origens vencem, como o `nrv config` lê e grava, o que os spawners fixam nos processos filhos, o que o `nrv doctor` mostra, quais variáveis ficam fora do schema e por quê, e a API que o painel de configuração do Glance vai consumir no corte seguinte.

## Camadas e precedência

Uma resolução só, em `skills/_shared/lib/settings.ts`, com a mesma ordem em todo leitor:

| Ordem | Camada | Onde vive | Quem escreve |
|---|---|---|---|
| 1 | variável de ambiente | o shell, o `.env` do projeto (o Bun carrega o `.env` da pasta onde o comando roda), o env que um spawner monta para o filho | o usuário, o CI, um spawner fixando o efetivo no filho |
| 2 | projeto | `<projeto>/.nirvana/config.yaml` | `nrv config set --project` (padrão dentro de um projeto) |
| 3 | global do usuário | `~/.nirvana/config.yaml` (`NIRVANA_HOME` substitui o `~`) | `nrv config set --global`, `nrv embeddings enable` |
| 4 | padrão do engine | `skills/harness/config.yaml` (instalado em `~/.nirvana/skills/harness/config.yaml`) | o engine; cada `nrv update` sobrescreve |
| 5 | padrão do schema | `skills/_shared/lib/settings-schema.ts` | o código |

A variável vence sempre: é o contrato de compatibilidade dos scripts, do CI e dos spawners. O arquivo do engine é só a camada 4; ele deixou de ser o lugar onde o usuário persiste escolhas, porque a atualização o apaga. O arquivo global é novo neste corte e sobrevive ao `nrv update`. O arquivo de projeto é o mesmo `.nirvana/config.yaml` que o `locale-resolver.ts` já lia (`locale`); chaves que o schema não conhece são ignoradas, então o `locale` continua onde estava.

Descoberta do projeto: `NIRVANA_PROJECT_ROOT`, senão o ancestral mais próximo do diretório atual que tenha um `.nirvana/`. O `~` nunca conta como projeto, mesmo tendo `.nirvana/`: esse é o armazém global, e lê-lo como projeto faria o arquivo global sobrescrever a si mesmo.

Arquivos são lidos com o pacote `yaml`, com cache por processo (caminho, mtime e tamanho), invalidado a cada gravação. YAML malformado, uma seção que não é mapeamento, um valor fora do tipo no arquivo ou uma variável fora do tipo são erros que nomeiam o arquivo (ou a variável) e a chave. Nenhum leitor cai num padrão silencioso: uma escolha que o usuário escreveu e o engine ignorou é o defeito que este núcleo existe para encerrar. Uma chave gravada num escopo que ela não aceita (`updates.check` num arquivo de projeto) é pulada naquela camada.

## O comando `nrv config`

```
nrv config list [--json]                          toda chave: valor efetivo, origem, padrão
nrv config get <chave> [--json]                   o valor efetivo (a resolução inteira com --json)
nrv config set <chave> <valor> [--global|--project]
nrv config unset <chave> [--global|--project]
nrv config explain <chave> [--json]               descrição, tipo, padrão, escopos, variável, valor efetivo
```

`set` e `unset` gravam no projeto quando rodam dentro de um (diretório `.nirvana/` no cwd ou num ancestral, ou `NIRVANA_PROJECT_ROOT`) e no global fora dele. A gravação edita uma linha por vez, `seção:` e `  chave:`, preservando todo o resto do arquivo, comentários inclusive, e é atômica (arquivo temporário e rename). Strings vão entre aspas duplas, para que `off`, `no` e `1.0` nunca virem outra coisa num leitor YAML 1.1.

Recusas, cada uma com o motivo e exit 4: valor que o schema rejeita (`routing.mode: valor inválido "turbo"; esperado agentic | fast`), escopo que a chave não aceita, chave fixada por variável no shell atual (o valor gravado só valeria sem a variável; o comando diz qual é) e `--project` fora de um projeto. Um arquivo que a resolução não consegue ler sai com exit 1 e o caminho. A gravação não valida o valor que substitui: um arquivo com um valor inválido pode ser consertado pelo próprio `nrv config set`.

Cada `set` e `unset` que muda um arquivo grava `x_settings_changed { key, scope, path, from, to }` no audit, pelo mesmo `lib/audit.js` do resto do engine. Um valor já igual não escreve nem audita.

## Tabela: chave, variável, padrão, escopo

Gerada a partir do schema. `nrv config explain <chave>` mostra a descrição de cada uma.

| Chave | Variável (legada) | Padrão | Escopos | Valores |
|---|---|---|---|---|
| `multi_target.enabled` | `NIRVANA_MULTI_TARGET_KILL_SWITCH` (também `NIRVANA_MULTI_TARGET_ENGINE`) | `true` | global, projeto | true / false |
| `gauntlet.default_mode` | `NIRVANA_EXECUTION_MODE` | `standard` | global, projeto | standard / gauntlet / auto |
| `gauntlet.default_intensity` | `NIRVANA_GAUNTLET_INTENSITY` | `balanced` | global, projeto | light / balanced / exhaustive |
| `gauntlet.evaluator` | `NIRVANA_GAUNTLET_EVALUATOR` | `""` | global, projeto | squad:<slug>[:<capability>] / judge-x / agent-x / heuristic / vazio |
| `gauntlet.business_allowlist` | `NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST` | `""` | global, projeto | slugs separados por vírgula (ou vazio) |
| `gauntlet.business_kill_switch` | `NIRVANA_BUSINESS_GAUNTLET_KILL_SWITCH` | `false` | global, projeto | true / false |
| `gauntlet.auto_allowed` | `NIRVANA_ALLOW_AUTO_GAUNTLET` | `false` | global, projeto | true / false |
| `execution.default_runtime` | `NIRVANA_DEFAULT_RUNTIME` | `""` | global, projeto | nome de runtime (claude-code, codex, gemini-cli, ...) ou vazio |
| `execution.model` | `NIRVANA_MODEL` | `""` | global, projeto | id ou alias de modelo (opus, sonnet, haiku, fable, ...) ou vazio |
| `execution.dna_injection` | `NIRVANA_DNA_INJECTION` | `full` | global, projeto | full / fragments |
| `execution.headless_skip_permissions` | `NIRVANA_HEADLESS_SKIP_PERMISSIONS` | `true` | global, projeto | true / false |
| `glance.execution` | `NIRVANA_GLANCE_EXECUTION` | `true` | global, projeto | true / false |
| `runtime.provider_catalog_dir` | `NIRVANA_PROVIDER_CATALOG_DIR` | `""` | global, projeto | lista de caminhos separados pelo delimitador do sistema, ou vazio |
| `runtime.allow_stale_catalog` | `NIRVANA_ALLOW_STALE_CATALOG` | `false` | global, projeto | true / false |
| `routing.mode` | `NIRVANA_ROUTING_MODE` | `agentic` | global, projeto | agentic / fast |
| `routing.dense` | `NIRVANA_ROUTER_DENSE` (`1` = fallback, `0` = off) | `off` | global, projeto | off / fallback |
| `routing.on_router_failure` | nenhuma | `cascade` | global, projeto | cascade / fail |
| `supervisor.progress_ping_sec` | `NIRVANA_PROGRESS_PING_SEC` | `1800` | global, projeto | inteiro >= 0 (segundos) |
| `supervisor.stall_threshold_ms` | `NIRVANA_STALL_THRESHOLD_MS` | `300000` | global, projeto | inteiro > 0 (milissegundos) |
| `updates.check` | `NIRVANA_NO_UPDATE_CHECK` (opt-out: `1` = não verificar) | `true` | global | true / false |
| `budget.default_max_cost_usd` | nenhuma | `0` | global, projeto | número >= 0 (USD); 0 = ilimitado |
| `budget.default_max_tokens` | nenhuma | `0` | global, projeto | inteiro >= 0 |
| `budget.default_max_handoffs` | nenhuma | `0` | global, projeto | inteiro >= 0 |
| `budget.default_max_duration_seconds` | nenhuma | `0` | global, projeto | inteiro >= 0 (segundos) |
| `budget.on_budget_exceeded` | nenhuma | `warn` | global, projeto | abort / warn / escalate |
| `budget.auto_invoke_budget_usd` | nenhuma | `0` | global, projeto | número >= 0 (USD) |
| `baselines.squad_capability_usd` | nenhuma | `0.3` | global, projeto | número >= 0 (USD) |
| `baselines.business_usd` | nenhuma | `0.8` | global, projeto | número >= 0 (USD) |
| `baselines.per_handoff_usd` | nenhuma | `0.05` | global, projeto | número >= 0 (USD) |
| `quality_gate.judge_enabled` | nenhuma | `false` | global, projeto | true / false |
| `quality_gate.max_revisions` | nenhuma | `2` | global, projeto | inteiro >= 0 |
| `quality_gate.escalate_after` | nenhuma | `2` | global, projeto | inteiro >= 0 |
| `quality_gate.rubric_fallback` | nenhuma | `prose_shortform` | global, projeto | nome de rubrica |
| `quality_gate.default_judge_model` | nenhuma | `inherit` | global, projeto | id de modelo ou inherit |

Formas legadas das variáveis, mantidas por compatibilidade: `NIRVANA_MULTI_TARGET_KILL_SWITCH=1|true|on` desliga o multi-target e `NIRVANA_MULTI_TARGET_ENGINE=0|false|off` também (em `1` a flag antiga é aceita e não faz nada); `NIRVANA_HEADLESS_SKIP_PERMISSIONS` e `NIRVANA_GLANCE_EXECUTION` só desligam com `0|false|off|no`, qualquer outro texto mantém o padrão ligado; `NIRVANA_NO_UPDATE_CHECK=1|true|yes` desliga a verificação; uma variável vazia é o mesmo que ausente. Para todas as outras a variável carrega o valor no formato da chave, e um texto fora do tipo é erro com o nome da variável.

`updates.check` é a única chave só global: a verificação de release é da máquina, não do projeto. O `bin/nrv` em bash, que decide antes de qualquer Bun se imprime o aviso de release, continua lendo só a variável e o `CI`; com `updates.check: false` no arquivo global, o refresher em Bun grava um cache sem aviso e o bash não imprime nada nem o relança.

## Leitores migrados

Cada interruptor do schema tem exatamente um caminho de leitura, `resolveSetting` ou `resolveAllSettings`:

| Chave | Leitor |
|---|---|
| `multi_target.enabled` | `harness/scripts/multi-target.ts` (`engineGate`) |
| `gauntlet.default_mode`, `default_intensity`, `auto_allowed` | `harness/lib/gauntlet/execution-options.ts` |
| `gauntlet.evaluator` | `harness/scripts/dispatch.ts`, `harness/scripts/doctor-system.ts` |
| `gauntlet.business_allowlist`, `business_kill_switch` | `harness/scripts/dispatch.ts` (canário de business), `multi-target-dispatch-adapters.ts` (merge da allowlist) |
| `execution.default_runtime` | `harness/scripts/dispatch.ts`, `control-plane/execution-runner.ts` |
| `execution.model` | `_shared/lib/system-model.ts` |
| `execution.dna_injection` | `harness/lib/dispatch.ts`, `harness/lib/squad-exec.ts`, `businesses/lib/employee-prompt.ts` |
| `execution.headless_skip_permissions` | `_shared/lib/host-agent-driver.ts` |
| `glance.execution` | `harness/scripts/glance.ts` |
| `runtime.provider_catalog_dir`, `allow_stale_catalog` | `harness/lib/runtime-snapshot.ts` |
| `routing.mode` | `_shared/lib/routing-mode.ts` |
| `routing.dense`, `on_router_failure`, `quality_gate.*` | `harness/lib/harness-config.ts` (`loadHarnessConfig`, `denseRoutingMode`, `setRoutingDense`) e, por ele, `router.js`, `dispatch.ts`, `revise.ts`, `supervisor.ts`, `embeddings.ts` |
| `supervisor.progress_ping_sec`, `stall_threshold_ms` | `harness/scripts/supervisor.ts`; o limiar também é o `stallBudgetMs` padrão do heartbeat em `host-agent-driver.ts` |
| `updates.check` | `harness/scripts/update-check.ts` |
| `budget.*`, `baselines.*` | `harness/lib/budget.js` |

`harness-config.ts` é um adaptador sobre a mesma resolução, não um segundo caminho: `loadHarnessConfig()` devolve a forma `routing` / `quality_gate` que os consumidores já leem, `denseRoutingMode()` é `routing.dense` efetivo e `setRoutingDense()` grava no arquivo global (com um caminho explícito, edita aquele arquivo, o gancho dos testes). O teste `settings-readers.test.ts` varre `skills/**/{lib,scripts}` e falha se qualquer arquivo voltar a ler uma variável do schema direto do ambiente; a exceção documentada é o fallback só-Node de `_shared/lib/host-agent-driver.js`, que sob Bun delega ao driver em TypeScript nas primeiras linhas.

Sem nada configurado, nenhum comportamento muda: os padrões do schema são os valores que cada leitor tinha em código, o engine multi-target continua ligado por padrão e o `config.yaml` do engine continua valendo como camada 4.

## Spawners

Um filho que só lê variáveis não veria o arquivo de projeto nem o global. Por isso cada spawner fixa no env do filho o valor efetivo de cada chave que tem variável, no formato que a variável fala (`settingsEnvForChild`): `routing.dense: fallback` vira `NIRVANA_ROUTER_DENSE=1`, `multi_target.enabled: false` vira `NIRVANA_MULTI_TARGET_KILL_SWITCH=1`, `updates.check: false` vira `NIRVANA_NO_UPDATE_CHECK=1`. Uma string vazia e um `updates.check: true` ficam sem variável, porque nada muda para o filho. Um filho que resolve por conta própria encontra a variável primeiro e concorda com o pai; uma variável que já estava no env do pai vence e é fixada como está.

| Spawner | Filho |
|---|---|
| `harness/lib/control-plane/execution-runner.ts` | o `dispatch.ts` de uma Message do Glance |
| `harness/lib/gauntlet/multi-target-dispatch-adapters.ts` | o `dispatch.ts` de cada nó de um plano; a allowlist de um nó gauntlet é o merge sobre a allowlist efetiva, não só sobre a do shell |
| `harness/lib/gauntlet/evaluator-adapter.ts` | o `dispatch.ts` do avaliador de um Gauntlet |
| `harness/scripts/dispatch.ts` (`prepScriptEnv`) | `brief-business.ts`, `brief-squad.ts` e `employee-prompt.ts` |

## O `nrv doctor`

A seção `config` do doctor tem uma linha `config: files` com os três arquivos (projeto, global, engine) e se existem, e uma linha por chave, `config: <chave>`, com o valor efetivo e a origem (`env NIRVANA_X=...`, `project <arquivo>`, `global <arquivo>`, `engine <arquivo>`, `default`). Não há segredo no schema, então não há valor mascarado. Um arquivo que a resolução recusa é `config: files` em FAIL com a mesma mensagem que todo leitor daria; `nrv config list` mostra o mesmo erro.

## O que fica só no ambiente, e por quê

Variáveis que o schema não absorve, agrupadas pelo motivo:

**Identidade e caminhos do processo.** Cada processo os recebe de quem o inicia; gravá-los num arquivo faria um projeto apontar para os diretórios de outro. `NIRVANA_HOME`, `NIRVANA_SKILLS_DIR`, `NIRVANA_DEPS_DIR`, `NIRVANA_PROJECT_ROOT`, `NIRVANA_PROJECT_SQUADS_DIR`, `NIRVANA_PROJECT_BUSINESSES_DIR`, `NIRVANA_PROJECT_MIND_CLONES_DIR`, `NIRVANA_PROJECT_SKILLS`, `NIRVANA_OUTPUTS_DIR`, `NIRVANA_STATE_DIR`, `NIRVANA_STATE_DB`, `NIRVANA_RUN_LEDGER_DB`, `NIRVANA_COOLDOWN_FILE`, `NIRVANA_SPEND_FILE`, `NIRVANA_PACKS_DIR`, `NIRVANA_SERVE_DIR`, `NIRVANA_SERVE_SESSIONS_ROOT`, `HARNESS_LOGS_DIR`, `MAESTRO_LOGS_DIR`, `SQUADS_DIR`, `BUSINESSES_DIR`, `BUSINESSES_LIBRARY`, `DNA_LIBRARY`, `MAESTRO_DIR`, `BUSINESSES_REGISTRY_PATH`, `SQUADS_REGISTRY_PATH`, `ROUTING_DIGEST_PATH`, `KEYWORD_ALIASES_PATH`.

**Identidade de um run.** Mudam a cada dispatch e são o pai que grava no filho. `NIRVANA_TRACE_ID`, `NIRVANA_PROJECT_ID`, `NIRVANA_BUSINESS_SLUG`, `NIRVANA_MULTI_TARGET_NODE_ID`, `NIRVANA_DISPATCH_TRACKS_RUN`, `NIRVANA_DISPATCH_SCRIPT`, `NIRVANA_RESOLVED_SQUAD_PATH`, `NIRVANA_BRIEF_VERIFIABLE`, `NIRVANA_BRIEF_RISK` (descrevem um brief, não uma preferência), `NIRVANA_RUNTIME`, `NIRVANA_AGENT_RUNTIME`, `NIRVANA_HOST_RUNTIME`, `NRV_IN_SWEEP`.

**Escopo de biblioteca e locale.** Já têm contrato próprio em `.env`, `--scope` e `_shared/lib/scope.ts`; o `locale` do projeto vive no mesmo `.nirvana/config.yaml`, lido por `locale-resolver.ts`. `NIRVANA_SCOPE`, `NIRVANA_SCOPE_QUIET`, `NIRVANA_GLOBAL_INCLUDE_ONLY`, `NIRVANA_GLOBAL_EXCLUDE`, `NIRVANA_LOCALE`.

**Segredos e licença.** Nunca entram num arquivo que o `nrv config list` imprime e o doctor mostra. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, as demais chaves de API do painel, `CLAUDE_CODE_OAUTH_TOKEN`, `NIRVANA_PROVENANCE`, `NIRVANA_ARTIFACTS_KEY`. Continuam no `.env`.

**Endpoints e distribuição.** Só quem constrói, publica ou testa o engine os muda. `NIRVANA_ENGINE_REPO`, `NIRVANA_ENGINE_URL`, `NIRVANA_ENGINE_TARBALL`, `NIRVANA_RELEASE_API`, `NIRVANA_CHANGELOG_URL`, `NIRVANA_ACTIVATE_URL`, `NIRVANA_VALIDATE_URL`, `NIRVANA_PACK_UPDATE_URL`, `NIRVANA_ARTIFACTS_URL`, `NIRVANA_STOREFRONT_URL`, `NIRVANA_PRODUCTS_FILE`, `NIRVANA_BUN`, `NIRVANA_SERVE_BUN`, `NIRVANA_SERVE_DISPATCH_BIN`.

**Diagnóstico, afinação do roteador e seams de teste.** Botões de quem mede ou depura o engine, não preferências de operação. `NIRVANA_VERBOSE`, `NIRVANA_AUDIT_STRICT`, `NIRVANA_AUDIT_PREFIXES`, `NIRVANA_LIMITS_DEBUG`, `NIRVANA_CORPUS_SKIPPED`, `NIRVANA_NO_DESKTOP_NOTIFY`, `NIRVANA_UPDATE_CHECK_ASSUME_TTY`, `NIRVANA_SKIP_PATH_PERSIST`, `NIRVANA_SERVE_ALLOW_ROOT`, `NIRVANA_EMBEDDER`, `NIRVANA_EMBEDDER_MODEL`, `NIRVANA_ROUTER_FUSION`, `NIRVANA_ROUTER_INTENT_FILTER`, `NIRVANA_TOKENIZER_STEM`, `NIRVANA_BODY_DOC_MIN_OVERLAP`, `NIRVANA_BODY_DOC_MAX`, `NIRVANA_RULE_MIN_SCORE`, `NIRVANA_PRICING_USD`, `NIRVANA_MAX_GATE_RETRIES`, `NIRVANA_GATE_EXHAUSTED`, `NIRVANA_VOICE_FIDELITY_THRESHOLD`, `NIRVANA_VOICE_FIDELITY_FLOOR`, `NIRVANA_CONTEXT_ROLL_AT`, `NIRVANA_CONTEXT_WINDOW`.

`LLM_CASCADE` (a cadeia de failover de cota) é uma preferência real de operação, mas tem sintaxe e arquivo próprios (`cascade.ts`); fica para um corte seguinte decidir se entra no schema.

## Pelo Glance

O painel "Configuração" do Glance é um adapter sobre este núcleo, sem lógica própria de precedência: `GET /api/v1/settings` devolve o schema com o valor efetivo, a origem e `locked` de cada chave; `PUT /api/v1/settings/<chave>` com `{ value, scope }` e `DELETE /api/v1/settings/<chave>?scope=` gravam pelo `setSetting` e `unsetSetting`, com a autorização de toda escrita do Glance (`--read-only` recusa, `Origin` local, `Idempotency-Key`) e o mesmo `x_settings_changed` do CLI, com `actor: "glance"`. A camada de projeto é o root que o servidor serve, o mesmo que o runner fixa nos filhos, então a gravação vale no próximo despacho pelo Glance sem reiniciar. Uma chave fixada por variável no ambiente do servidor aparece como somente leitura e a gravação é recusada com `409`. O painel, as regras e o que fica somente leitura estão em [Configuração pelo Glance](glance-settings.md); as rotas e os códigos em [API do control plane](control-plane-api.md#42-configuração).

A seção `.env` do mesmo painel (`harness/lib/glance/config-schema.ts`) continua para o que não tem chave no schema: segredos, escopo de biblioteca, caminhos, `LLM_CASCADE`. As variáveis que viraram chave saíram dessa lista. Tudo sai de `skills/_shared/lib/settings.ts`:

```ts
import {
  SETTINGS_SCHEMA, settingInfo,                 // o schema (settings-schema.ts), sem os tipos zod
  resolveAllSettings, resolveSetting,           // leitura
  setSetting, unsetSetting, defaultWriteScope,  // escrita
  settingsEnvForChild, SettingsError,
} from "../../_shared/lib/settings.ts";

type SettingSource = "env" | "project" | "global" | "engine-default" | "default";
interface ResolvedSetting { key: string; value: string | number | boolean; source: SettingSource; path?: string; variable?: string; raw?: string }
interface ResolveOptions { env?: Record<string, string | undefined>; projectRoot?: string | null; globalPath?: string | null; enginePath?: string | null; cwd?: string }
interface ChangeOptions extends ResolveOptions { scope: "global" | "project"; ignoreEnv?: boolean; audit?: (event: string, payload: Record<string, unknown>) => void }
interface SettingChange { key: string; scope: "global" | "project"; path: string; from: string | number | boolean | null; to: string | number | boolean | null; changed: boolean }

resolveAllSettings(opts?: ResolveOptions): ResolvedSetting[]        // schema order, one read of the layers
resolveSetting(key: string, opts?: ResolveOptions): ResolvedSetting
setSetting(key: string, input: unknown, opts: ChangeOptions): SettingChange   // validates; refuses (SettingsError) an invalid value, a wrong scope, a key pinned by a variable
unsetSetting(key: string, opts: ChangeOptions): SettingChange
defaultWriteScope(opts?: ResolveOptions): { scope: "global" | "project"; projectRoot: string | null }
settingInfo(spec): { key, kind, default, scopes, description, expects, options, env, envAliases, secret: false }
```

`nrv config list --json` devolve `settingInfo(spec)` e `ResolvedSetting` fundidos por chave; o `GET` do Glance devolve os dois lados separados (`schema` e `values`), a mesma informação. A gravação pelo painel passa o mesmo `audit` (`lib/audit.js` `emit`) que o CLI passa, para que `x_settings_changed` seja o registro dos dois. `SettingsError.code` distingue as recusas, e a API os traduz em códigos HTTP: `unknown_key` 404; `invalid_value`, `scope` e `no_project` 400; `pinned_by_env`, `invalid_file` e `invalid_env` 409.

## Testes

| Arquivo | O que prova |
|---|---|
| `skills/_shared/tests/settings-schema.test.ts` | chaves bem formadas, padrão válido por tipo, variável única por chave, recusas com a mensagem do schema, ida e volta de cada variável legada |
| `skills/_shared/tests/settings.test.ts` | as quatro origens e a precedência, projeto sem arquivo, descoberta do projeto, YAML inválido e valor inválido como erros claros, gravação preservando comentários, recusas do `setSetting`, audit, cache, `settingsEnvForChild` |
| `skills/harness/tests/harness-config.test.ts` | o adaptador sobre a mesma resolução e o `setRoutingDense` no arquivo global |
| `skills/harness/tests/settings-readers.test.ts` | cada leitor com variável, projeto e global, e o guarda contra leituras diretas |
| `skills/harness/tests/settings-spawners.test.ts` | os quatro spawners fixando o efetivo no filho (o fake dispatch lê as variáveis) |
| `skills/harness/tests/config-command.test.ts` | `nrv config` de ponta a ponta, recusas e audit |
| `skills/harness/tests/doctor-config.test.ts` | a seção `config` do doctor e o FAIL de um arquivo recusado |
| `skills/harness/tests/glance-settings-api.test.ts`, `glance-settings-panel.test.ts` | as rotas de `settings` do Glance, o efeito no próximo filho sem reiniciar e o módulo do painel (ver [Configuração pelo Glance](glance-settings.md)) |
