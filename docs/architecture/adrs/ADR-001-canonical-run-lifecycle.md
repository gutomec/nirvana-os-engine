# ADR-001: lifecycle canônico do Run

**Status:** proposto
**Requisitos:** RK-001, RK-002

## Contexto

Ledger, audit, validator e delivery podem interpretar o mesmo trace de formas diferentes. Validators atuais também impõem forma empresarial a squad e `agent-x`.

## Decisão

Adotar uma state machine discriminada por `TargetRef`. O Run Kernel é a única autoridade de transição. Ledger, audit compatível, gate e Glance são projections. Run é preparado e validado antes de commit; falha anterior executa rollback, falha posterior produz terminal compensatório.

## Consequências

Business, squad e `agent-x` compartilham envelope e estados, mas mantêm cadeias de execução próprias. Delivery com reservas é terminal distinto de gate aprovado. A migração exige dual-write e corpus de traces.

## Alternativas rejeitadas

Manter validator empresarial; tornar ledger autoridade sem journal; aceitar qualquer sequência que termine em `delivered`.
