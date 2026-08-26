# API do control plane

## 1. Princípios

CLI, Glance e `nrv serve` são adapters dos mesmos application services. Base HTTP proposta: `/api/v1`. Toda escrita exige `Idempotency-Key`; atualização concorrente usa `If-Match`; erro usa `application/problem+json` e inclui `correlation_id`.

## 2. Services internos

```ts
interface ProjectService {
  planCreate(input: CreateProjectInput): Promise<ProjectPlan>;
  create(input: CreateProjectInput, command: CommandContext): Promise<Project>;
  planAdoption(input: AdoptProjectInput): Promise<ProjectPlan>;
  adopt(input: AdoptProjectInput, command: CommandContext): Promise<Project>;
  inspect(projectId: string): Promise<ProjectInspection>;
}

interface RunService {
  submit(input: SubmitRunInput, command: CommandContext): Promise<RunReceipt>;
  followup(runId: string, message: AgentMessage, command: CommandContext): Promise<Receipt>;
  steer(runId: string, message: AgentMessage, command: CommandContext): Promise<Receipt | Unsupported>;
  cancel(runId: string, command: CommandContext): Promise<Receipt>;
  retry(runId: string, command: CommandContext): Promise<RunReceipt>;
}

interface RuntimeProvider {
  descriptor(): Promise<RuntimeDescriptor>;
  probe(request: ProbeRequest): Promise<ProbeEvidence>;
  prepare(request: CreateAgentRequest, scope: ExecutionScope): Promise<PreparedAgent>;
  resume(request: ResumeAgentRequest, scope: ExecutionScope): Promise<AgentHandle>;
}
```

## 3. Rotas

| Método e rota | Resultado |
|---|---|
| `POST /projects/plan` | Preview sem side effect |
| `POST /projects` | Project criado pelo ProjectService |
| `POST /projects:adopt` | Project legado adotado |
| `GET /projects/{id}` | Project projection |
| `POST /projects/{id}:inspect` | Diagnóstico sem mutação |
| `POST /projects/{id}:archive` | Arquivamento lógico |
| `POST /projects/{id}/conversations` | Conversation persistente |
| `POST /conversations/{id}/messages` | Message e eventual Run (`202` quando o Run entrou na fila de execução) |
| `POST /conversations/{id}:fork` | Conversation com ancestry |
| `GET /runs/{id}` | Run projection |
| `GET /runs/{id}/gauntlet` | Projeção do Gauntlet, candidates e scorecards do Run |
| `GET /runs/{id}/multi-target` | Projeção do coordenador multi-target reconstruída do journal (`projection: null` sem snapshot) |
| `POST /runs/{id}:followup` | Próxima interação |
| `POST /runs/{id}:steer` | Intervenção no ponto seguro |
| `POST /runs/{id}:cancel` | Cancelamento idempotente |
| `POST /runs/{id}:retry` | Novo Run ligado ao anterior |
| `POST /runs/{id}:revise` | Revision orientada por gate |
| `GET /runs/{id}/artifacts` | Artifact manifests |
| `POST /approvals/{id}:decide` | Decisão autorizada |
| `GET /projects/{id}/events` | Journal paginado |
| `GET /projects/{id}/stream` | SSE retomável por sequence |
| `GET /settings?project_id={id}` | Schema das configurações do engine com valor efetivo, origem e `locked` por chave |
| `PUT /settings/{key}` | Grava `{ value, scope }` no arquivo do escopo (projeto ou global) |
| `DELETE /settings/{key}?scope=` | Remove a chave do arquivo do escopo; a camada seguinte passa a valer |

## 4. Stream

SSE usa `id: <sequence>`. O client envia `Last-Event-ID`. O servidor repete a partir da próxima sequence. Heartbeats não entram no journal. Se o cursor preceder a retenção, a API responde com checkpoint e cursor inicial verificável.

## 4.1. Execução de Messages

Uma Message de projeto adotado prepara um Run com `policySnapshotRef: gauntlet-light-canary` e o entrega à fila do Glance. O texto pode nomear o alvo no início: `use business <slug>:` ou `use squad <slug>:`; sem isso o alvo é `agent-x`. Com runner configurado, o Run roda em um processo filho do `dispatch.ts` com `--run-id`, e a timeline (`glance.child_started`, eventos do Gauntlet, `glance.child_exited`) chega pelo stream. `POST /runs/{id}:cancel` mata o filho e conclui `cancelling → cancelled`. Detalhes, recuperação após restart e variáveis de ambiente em [Execução no Glance](glance-execution.md).

## 4.2. Configuração

As três rotas de `settings` são adapters do núcleo de configuração (`skills/_shared/lib/settings.ts`), sem lógica própria de precedência. A camada de projeto é o root que o servidor serve, o mesmo que o runner de execução fixa nos filhos, então o que a API mostra é o que o próximo filho recebe. `GET` responde `{ schema, values, files, allow_actions }`: `schema` é `settingInfo` de cada chave, `values[key]` traz `value`, `source` (`env`, `project`, `global`, `engine-default`, `default`), `path`, `variable`, `raw` e `locked` (`true` quando a origem é uma variável). `project_id`, quando enviado, precisa nomear o projeto adotado que o servidor serve; outro id é `404`.

`PUT` e `DELETE` passam pela autorização de toda escrita de `/api/v1`: `403` sem ações (`--read-only`) ou com `Origin` estranho, `400` sem `Idempotency-Key`. Depois disso, os códigos seguem o `SettingsError` do núcleo:

| Situação | Código |
|---|---|
| chave fora do schema | `404` |
| valor que o schema recusa, escopo que a chave não aceita, corpo sem `value` ou `scope` inválido | `400`, com a mensagem do schema no `detail` |
| chave fixada por variável no ambiente do servidor (`locked`) | `409`, nomeando a variável e o valor |
| arquivo de configuração que o resolvedor não consegue ler | `409`, nomeando o arquivo (também no `GET`) |
| mesma `Idempotency-Key` com o mesmo corpo | a mesma resposta, sem segunda gravação nem segundo audit |
| mesma `Idempotency-Key` com outro corpo | `409` |

Uma escrita bem-sucedida responde `{ key, scope, path, from, to, changed, effective }`, onde `effective` é a resolução da chave depois da gravação (o valor em vigor pode continuar vindo de uma camada acima). Cada gravação que muda um arquivo grava `x_settings_changed { key, scope, path, from, to, actor: "glance" }` no audit do projeto. O painel que consome estas rotas está em [Configuração pelo Glance](glance-settings.md).

## 5. Segurança

- Loopback usa token efêmero e cookie `HttpOnly`, `SameSite=Strict`.
- Remoto exige TLS, autenticação revogável, CSRF e Origin estrito.
- Browser nunca envia executable ou shell arbitrário.
- Paths de API são IDs ou relativos, nunca absolutos.
- Artifact HTML abre em origem isolada e sandbox.
- Permissions são capabilities como `project.create`, `run.dispatch`, `run.cancel`, `tool.execute.shell` e `approval.decide.security`.
- Toda autorização registra policy ID, version e decision.

## 6. Glance

O cockpit usa três áreas: Projects e Conversations; chat e artifacts; Run inspector com timeline, DAG, lineage, agents, costs, approvals e gates. Todas são projections. O UI mostra organização antes da infraestrutura: business, employee, squad, capability, workflow, task, mind-clone, agent, runtime, model e tools.
