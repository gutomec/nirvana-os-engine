# Matriz completa de testes

## 1. Run Kernel

| ID | Nível | Cenário | Resultado esperado |
|---|---|---|---|
| TK-001 | unit | Transição legal e ilegal | Mesma state machine em todos os consumers |
| TK-002 | contract | Business, squad e `agent-x` | Cadeia própria aceita; cadeia incompleta rejeitada |
| TK-003 | replay | Event duplicado | Um efeito e uma projection |
| TK-004 | replay | Mesmo ID, payload diferente | Conflito crítico |
| TK-005 | crash | Falha antes e depois de commit | Rollback antes; terminal compensatório depois |
| TK-006 | artifact | Arquivo trocado após gate | Delivery bloqueada |
| TK-007 | artifact | Symlink, traversal e Unicode | Confinamento e digest corretos |
| TK-008 | projection | Rebuild total e snapshot | Mesmo hash final |
| TK-009 | outbox | Crash entre DB e publicação | Evento crítico publicado uma vez |
| TK-010 | scope | Child tenta ampliar deny | Negado e auditado |

## 2. Runtime universal

| ID | Nível | Cenário | Resultado esperado |
|---|---|---|---|
| TR-001 | compatibility | Manifest sem requirements | Runtime ativo e comportamento histórico |
| TR-002 | compatibility | `policy: active`, runtime conhecido | Executa se features atendidas |
| TR-003 | compatibility | `policy: active`, runtime desconhecido | Executa por descriptor, sem core edit |
| TR-004 | compatibility | Declarados indisponíveis | Avalia ativo quando policy permite |
| TR-005 | unit | Required native, candidate advisory | Candidate eliminado |
| TR-006 | integration | Runtime compatível, modelo incompatível | Falha explicada |
| TR-007 | integration | Model switch no mesmo provider | Policy respeitada e snapshot congelado |
| TR-008 | security | Provider switch não autorizado | Aprovação ou bloqueio |
| TR-009 | conformance | Novo adapter fixture | Discovery, probe, cancel, tool, handoff e audit |
| TR-010 | chaos | Alias muda após plan | Versão congelada ou renegociação |
| TR-011 | offline | Catalog stale | Uso marcado ou decisão bloqueada |
| TR-012 | regression | Corpus completo de manifests | Parse e routing sem alteração |

## 3. Gauntlet Engine

| ID | Nível | Cenário | Resultado esperado |
|---|---|---|---|
| TG-001 | contract | Brief verificável | Success contract e plan completos |
| TG-002 | contract | Brief ambíguo crítico | `human_required`, sem produção |
| TG-003 | policy | Producer tenta julgar final | Rejeitado ou waiver explícito |
| TG-004 | unit | `max_rounds` atingido | Stop reason correto |
| TG-005 | unit | `max_cost` sem saldo | Sem novo dispatch |
| TG-006 | unit | Duas rounds sem delta | `no_progress` |
| TG-007 | regression | Revision quebra gate aprovado | Candidate não selecionado |
| TG-008 | integration | Candidates paralelos | Artifacts isolados e lineage preservada |
| TG-009 | integration | Judge disagreement | Regra de arbitragem ou parada |
| TG-010 | E2E | Light, balanced, exhaustive | Limites e DAG correspondentes |
| TG-011 | E2E | Business → squads → judges | Accountability organizacional visível |
| TG-012 | experiment | Direct versus compute-matched | Métricas de qualidade, custo e latência registradas |

## 4. Glance e Projects

| ID | Nível | Cenário | Resultado esperado |
|---|---|---|---|
| TL-001 | golden | CLI e web criam mesmo plano | Manifesto e scaffold equivalentes |
| TL-002 | migration | Adotar Project com arquivos customizados | Nenhuma sobrescrita |
| TL-003 | persistence | Reiniciar Glance durante chat | Conversation e Run preservados |
| TL-004 | stream | Queda e reconnect | Retoma após último sequence sem lacuna |
| TL-005 | projection | Chat, timeline, DAG e cost | Mesmos event IDs e totals |
| TL-006 | command | Retry de command | Um side effect |
| TL-007 | runtime | Steer unsupported | UI explica, não emula |
| TL-008 | security | CSRF, Origin, IDOR e traversal | Bloqueados |
| TL-009 | security | Shell arbitrário do browser | Não existe rota |
| TL-010 | accessibility | Teclado, screen reader, 400%, motion | WCAG 2.2 AA |
| TL-011 | recovery | Run ativo no restart | Reattach, resume ou stalled; não failure automático |
| TL-012 | Gauntlet UI | Expandir round e scorecard | Candidate, crítica, revision, custo e stop reason ligados |

## 5. Não regressão organizacional

- Golden corpus de todos os `business.yaml`, `squad.yaml`, agents, tasks e workflows.
- Snapshot de routing antes e depois.
- Symlinks de DNA preservados.
- Nenhum write em businesses, squads ou mind-clones durante negotiation.
- HANDOFF e summaries continuam legíveis.
- Base packs permanecem limpos de state, provenance per-user e watermark de comprador.
- Install, update e uninstall passam em macOS, Linux e Windows suportados.

## 6. Gates de release

1. `terminal_state_disagreement_total = 0`.
2. `gate_without_artifact_total = 0`.
3. `legacy_projection_parity_rate = 100%` durante a janela canário.
4. Nenhuma vulnerabilidade high ou critical aberta.
5. Nenhuma regressão de routing no corpus.
6. Replay e restore ensaiados.
7. Glance passa WCAG 2.2 AA.
8. Gauntlet demonstra parada finita em fault injection.
