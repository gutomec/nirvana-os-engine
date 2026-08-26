# Matriz de rastreabilidade

## 1. Evidências fonte

| ID | Fonte |
|---|---|
| E-RT | `NIRVANA-UNIVERSAL-RUNTIME-ARCHITECTURE.md` |
| E-DSH | `NIRVANA-DEEPSEEK-HARNESS-REASSESSMENT.md` |
| E-GL | `NIRVANA-GLANCE-PROJECT-COCKPIT-ARCHITECTURE.md` |
| E-GT | `RELATORIO-ANALISE-GAUNTLET-LOOP.md` |
| E-REPO | Engine e contratos atuais do Nirvana-OS |

## 2. Requisito → evidência → contrato → teste

Caminhos sem prefixo ficam em `skills/harness/tests/`. `(parcial)` marca uma prova que cobre só parte do requisito; a lacuna está em [Requisitos executáveis](executable-requirements.md).

| Requisito | Evidência | Contrato ou ADR | Testes | Arquivos de teste |
|---|---|---|---|---|
| RK-001 | E-RT, E-DSH, E-REPO | ADR-001 | TK-001, TK-002 | `run-kernel.test.ts`, `dispatch-standard-kernel.e2e.test.ts`, `glance-agent-x-canary-e2e.test.ts` (parcial) |
| RK-002 | E-DSH | ADR-001, ADR-004 | TK-005, TK-010 | `run-kernel.test.ts`, `gauntlet-controller.test.ts`, `run-kernel-multi-target-ports.test.ts` (parcial) |
| RK-003 | E-RT, E-DSH | ADR-002 | TK-003, TK-004, TK-008 | `run-kernel.test.ts` |
| RK-004 | E-RT, E-DSH | ADR-003 | TK-006, TK-007 | `run-kernel.test.ts`, `agent-x-gauntlet-cutover.test.ts` (parcial) |
| RK-005 | E-DSH | ADR-002 | TK-009 | `run-kernel.test.ts`, `gauntlet-store.test.ts` (parcial) |
| RK-006 | E-DSH | ADR-004 | TK-010 | `run-kernel.test.ts` |
| RT-001 | E-RT, E-REPO | ADR-005, ADR-008 | TR-001 a TR-004 | `skills/squads/tests/active-runtime-policy.test.ts` |
| RT-002 | E-RT | ADR-005 | TR-004 a TR-006 | `skills/squads/tests/runtime-broker.test.ts`, `runtime-snapshot-after-catalog-update.e2e.test.ts`, `standard-publication.test.ts` |
| RT-003 | E-RT | ADR-005 | TR-005, TR-009 | sem cobertura |
| RT-004 | E-RT | ADR-005 | TR-006, TR-007 | `skills/squads/tests/runtime-broker.test.ts`, `runtime-snapshot-after-catalog-update.e2e.test.ts` |
| RT-005 | E-RT | ADR-005 | TR-007, TR-010, TR-011 | `runtime-snapshot-after-catalog-update.e2e.test.ts` (parcial) |
| RT-006 | E-RT, E-DSH | ADR-008 | TR-012 | `skills/squads/tests/active-runtime-policy.test.ts`, `skills/squads/tests/runtime-broker.test.ts`, `scripts/check-organizational-non-regression.ts` (parcial) |
| GT-001 | E-GT | ADR-006 | TG-001, TG-002 | `gauntlet-compiler.test.ts`, `agent-x-gauntlet-cutover.test.ts` |
| GT-002 | E-GT | ADR-006 | TG-003, TG-011 | `gauntlet-compiler.test.ts`, `gauntlet-controller.test.ts`, `agent-x-gauntlet-cutover.test.ts` (parcial) |
| GT-003 | E-GT | ADR-006 | TG-005, TG-006, TG-012 | `gauntlet-controller.test.ts`, `gauntlet-revision-loop.e2e.test.ts` |
| GT-004 | E-GT | ADR-006 | TG-007 | `gauntlet-controller.test.ts`, `gauntlet-revision-loop.e2e.test.ts` |
| GT-005 | E-GT | ADR-006 | TG-004 a TG-006 | `gauntlet-controller.test.ts`, `gauntlet-revision-loop.e2e.test.ts`, `gauntlet-compiler.test.ts` (parcial) |
| GT-006 | E-GT | ADR-006 | TG-010 | `gauntlet-compiler.test.ts`, `gauntlet-revision-loop.e2e.test.ts` |
| GT-007 | E-GT, E-DSH | ADR-006 | TG-011 | `business-gauntlet-glance-proof.e2e.test.ts`, `gauntlet-revision-loop.e2e.test.ts`, `multi-target-coordinator.test.ts` (parcial) |
| GL-001 | E-GL, E-REPO | ADR-007 | TL-001, TL-002 | `project-control-plane.test.ts`, `init-existing-project.test.ts` (parcial) |
| GL-002 | E-GL | ADR-007 | TL-002 | `project-control-plane.test.ts`, `glance-control-plane.test.ts` |
| GL-003 | E-GL, E-DSH | ADR-002, ADR-007 | TL-003, TL-011 | `project-control-plane.test.ts`, `glance-control-plane.test.ts` |
| GL-004 | E-GL, E-DSH | ADR-002, ADR-007 | TL-004, TL-005 | `glance-control-plane.test.ts`, `glance-agent-x-canary-e2e.test.ts`, `business-gauntlet-glance-proof.e2e.test.ts`, `glance-multi-target-projection.test.ts`, `glance-run-event-labels.test.ts` (parcial) |
| GL-005 | E-GL | ADR-004, ADR-007 | TL-006, TL-008, TL-009 | `glance-control-plane.test.ts`, `project-control-plane.test.ts` |
| GL-006 | E-GL | ADR-007 | TL-010 | sem cobertura |
| GL-007 | E-GL, E-DSH | ADR-005, ADR-007 | TL-007, TL-012 | `glance-agent-x-canary-e2e.test.ts` (parcial) |

## 3. Cobertura inversa

Todo ADR aponta para requisitos neste arquivo. Os IDs TK, TR, TG e TL são cenários planejados da [matriz de testes](test-matrix.md); a coluna de arquivos lista as provas que existem hoje, e `sem cobertura` marca o requisito sem teste algum. Novos requisitos críticos devem entrar nesta matriz antes da implementação. Evidência nova não cria requisito automaticamente; ela exige decisão autorizada.
