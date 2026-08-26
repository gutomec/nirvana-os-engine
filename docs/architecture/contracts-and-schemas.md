# Contratos e schemas propostos

Os exemplos usam nomes internacionais em inglês. A fonte normativa futura deve gerar tipos, JSON Schema, catálogo de events e documentação.

## 1. Identidades

| Entidade | Prefixo | Estabilidade |
|---|---|---|
| Project | `prj_` | Permanente |
| Conversation | `cnv_` | Permanente |
| Run | `run_` | Uma tentativa |
| Event | `evt_` | Imutável |
| Artifact | `art_` | Identidade lógica |
| Artifact revision | `arv_` | Conteúdo imutável |
| Candidate | `can_` | Uma alternativa |
| Evaluation | `evl_` | Um verdict versionado |

## 2. Run e target

```ts
type TargetRef =
  | { kind: "business"; slug: string }
  | { kind: "squad"; slug: string; capabilityId: string }
  | { kind: "agent-x"; slug: "agent-x" };

interface RunEnvelope {
  schemaVersion: "nirvana.run/v1alpha1";
  projectId: string;
  conversationId?: string;
  runId: string;
  traceId: string;
  parentRunId?: string;
  planId: string;
  target: TargetRef;
  route?: { source: "explicit" | "router" | "fallback"; rationale: string };
  state: RunState;
  policySnapshotRef: string;
  createdAt: string;
  version: number;
}
```

Aliases `business_slug` e `squad_name` permanecem apenas nas projections de compatibilidade durante a migração.

## 3. Event envelope

```ts
interface RunEvent<T extends string, P> {
  schemaVersion: "nirvana.event/v1alpha1";
  eventId: string;
  projectId: string;
  runId: string;
  traceId: string;
  sequence: number;
  type: T;
  occurredAt: string;
  recordedAt: string;
  actor: { kind: string; id: string };
  correlationId: string;
  causationId?: string;
  idempotencyKey?: string;
  payload: P;
}
```

`sequence` é monotônica por Project. Ordem causal não depende de relógio. Unknown extension `x_*` pode ser preservada, mas não satisfaz invariante normativa sem registro.

## 4. Artifact

```yaml
schema_version: nirvana.artifact-manifest/v1alpha1
project_id: prj_example
run_id: run_example
revision: 2
artifacts:
  - artifact_id: art_report
    revision_id: arv_report_002
    role: deliverable
    media_type: text/markdown
    bytes: 84449
    sha256: "0123456789abcdef"
    staging_uri: file:///workspace/.nirvana/staging/report.md
    published_uri: file:///workspace/report.md
    classification: internal
    producer:
      target_kind: squad
      target_slug: tessera-executable-specs
      capability_id: software.executable_specification.compile
```

Publication segue stage, flush, hash, validate, atomic publish e journal. Symlink não é seguido fora do workspace autorizado.

## 5. Runtime e model descriptors

```yaml
schema_version: nirvana.runtime-descriptor/v1alpha1
runtime:
  id: vendor.runtime
  instance_id: rti_example
  version: 1.0.0
  kind: interactive_agent_runtime
capabilities:
  filesystem.read:
    support: native
    enforcement: strong
    evidence: [{ source: verified_adapter, confidence: 1.0 }]
  agent.steer:
    support: unavailable
models:
  current: provider/model-version
security:
  domains:
    filesystem: strong
    process: best_effort
    network: none
```

```yaml
schema_version: nirvana.model-descriptor/v1alpha1
canonical_id: provider/family/2026-08-20
provider_model_id: family-2026-08-20
modalities: { input: [text, image], output: [text] }
capabilities:
  tool_calling: { support: native }
  structured_output: { support: native, enforcement: strong }
limits: { context_tokens: 200000, output_tokens: 32000 }
economics:
  currency: USD
  observed_at: 2026-08-25T00:00:00Z
```

## 6. Negotiation result

```json
{
  "schema_version": "nirvana.negotiation-result/v1alpha1",
  "status": "compatible_with_degradation",
  "selected": { "runtime": "vendor.runtime@1.0.0", "provider": "provider", "model": "provider/model-version" },
  "degradations": [{ "capability": "agent.steer", "impact": "Steering indisponível" }],
  "rejected": [{ "candidate": "other/runtime", "reason": "filesystem.read ausente" }],
  "evidence_snapshot": "sha256:example",
  "requires_approval": false
}
```

## 7. Gauntlet plan e scorecard

```yaml
schema_version: nirvana.gauntlet-plan/v1alpha1
mode: balanced
success_contract_ref: success-contract.yaml
candidate_strategy:
  count: 3
  diversity: { approach: required, model: preferred, runtime: preferred }
gauntlets:
  - id: specification
    capability: quality.specification_conformance
    blocking: true
  - id: factual
    capability: research.claim_verification
    blocking: true
selection:
  method: evidence_weighted
  independent_judge: required
stop:
  max_rounds: 4
  max_cost_usd: 25
  max_duration_seconds: 7200
  minimum_score: 0.92
  minimum_delta: 0.03
  no_progress_patience: 2
  require_regression_pass: true
```

```ts
interface EvaluationScorecard {
  evaluationId: string;
  candidateId: string;
  rubricVersion: string;
  verdict: "pass" | "revise" | "reject" | "indeterminate";
  dimensions: Array<{ id: string; score: number; confidence: number; blocking: boolean; evidenceRefs: string[] }>;
  regressions: string[];
  revisionRequests: Array<{ requirementId: string; evidenceRefs: string[] }>;
  evaluator: TargetRef;
}
```

## 8. Project e conversation

```json
{
  "schema_version": "nirvana.project/v1alpha1",
  "project_id": "prj_example",
  "display_name": "Example project",
  "created_at": "2026-08-25T00:00:00Z",
  "lifecycle": "active",
  "workspace": { "workspace_id": "wsp_example", "relative_root": ".", "kind": "local" },
  "scope": "merge",
  "orchestration_mode": "always"
}
```

Conversation guarda mensagens visíveis e referências a Runs. Provider session ID é um handle técnico e não substitui Conversation.

## 9. Compatibilidade de schema

- Readers ignoram campos desconhecidos e preservam extensões quando reserializam.
- Upcasters são puros, determinísticos e versionados.
- Duas versões anteriores permanecem legíveis.
- Breaking changes exigem major version, migrator e rollback.
- Descriptors e snapshots são imutáveis durante um Run.
