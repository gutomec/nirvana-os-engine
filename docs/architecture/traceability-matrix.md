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

| Requisito | Evidência | Contrato ou ADR | Testes |
|---|---|---|---|
| RK-001 | E-RT, E-DSH, E-REPO | ADR-001 | TK-001, TK-002 |
| RK-002 | E-DSH | ADR-001, ADR-004 | TK-005, TK-010 |
| RK-003 | E-RT, E-DSH | ADR-002 | TK-003, TK-004, TK-008 |
| RK-004 | E-RT, E-DSH | ADR-003 | TK-006, TK-007 |
| RK-005 | E-DSH | ADR-002 | TK-009 |
| RK-006 | E-DSH | ADR-004 | TK-010 |
| RT-001 | E-RT, E-REPO | ADR-005, ADR-008 | TR-001 a TR-004 |
| RT-002 | E-RT | ADR-005 | TR-004 a TR-006 |
| RT-003 | E-RT | ADR-005 | TR-005, TR-009 |
| RT-004 | E-RT | ADR-005 | TR-006, TR-007 |
| RT-005 | E-RT | ADR-005 | TR-007, TR-010, TR-011 |
| RT-006 | E-RT, E-DSH | ADR-008 | TR-012 |
| GT-001 | E-GT | ADR-006 | TG-001, TG-002 |
| GT-002 | E-GT | ADR-006 | TG-003, TG-011 |
| GT-003 | E-GT | ADR-006 | TG-005, TG-006, TG-012 |
| GT-004 | E-GT | ADR-006 | TG-007 |
| GT-005 | E-GT | ADR-006 | TG-004 a TG-006 |
| GT-006 | E-GT | ADR-006 | TG-010 |
| GT-007 | E-GT, E-DSH | ADR-006 | TG-011 |
| GL-001 | E-GL, E-REPO | ADR-007 | TL-001, TL-002 |
| GL-002 | E-GL | ADR-007 | TL-002 |
| GL-003 | E-GL, E-DSH | ADR-002, ADR-007 | TL-003, TL-011 |
| GL-004 | E-GL, E-DSH | ADR-002, ADR-007 | TL-004, TL-005 |
| GL-005 | E-GL | ADR-004, ADR-007 | TL-006, TL-008, TL-009 |
| GL-006 | E-GL | ADR-007 | TL-010 |
| GL-007 | E-GL, E-DSH | ADR-005, ADR-007 | TL-007, TL-012 |

## 3. Cobertura inversa

Todo ADR aponta para requisitos neste arquivo. Todo teste listado cobre ao menos um requisito. Novos requisitos críticos devem entrar nesta matriz antes da implementação. Evidência nova não cria requisito automaticamente; ela exige decisão autorizada.
