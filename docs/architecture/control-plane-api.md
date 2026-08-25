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
| `POST /conversations/{id}/messages` | Message e eventual Run |
| `POST /conversations/{id}:fork` | Conversation com ancestry |
| `GET /runs/{id}` | Run projection |
| `POST /runs/{id}:followup` | Próxima interação |
| `POST /runs/{id}:steer` | Intervenção no ponto seguro |
| `POST /runs/{id}:cancel` | Cancelamento idempotente |
| `POST /runs/{id}:retry` | Novo Run ligado ao anterior |
| `POST /runs/{id}:revise` | Revision orientada por gate |
| `GET /runs/{id}/artifacts` | Artifact manifests |
| `POST /approvals/{id}:decide` | Decisão autorizada |
| `GET /projects/{id}/events` | Journal paginado |
| `GET /projects/{id}/stream` | SSE retomável por sequence |

## 4. Stream

SSE usa `id: <sequence>`. O client envia `Last-Event-ID`. O servidor repete a partir da próxima sequence. Heartbeats não entram no journal. Se o cursor preceder a retenção, a API responde com checkpoint e cursor inicial verificável.

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
