# Migração e compatibilidade

## 1. Estratégia

A migração usa facade, shadow mode, dual-read, dual-write localizado, comparison e cutover vertical. O driver atual será envolvido, não reescrito. Cada fase tem flag e rollback.

## 2. Entidades preservadas

### Businesses

`business.yaml`, employees, org chart, routing, memory e DNA não mudam. `business_slug` continua numa projection compatível durante a janela de migração.

### Squads

Manifest, capabilities, tasks, workflows e agents não são reescritos. `declared` e `active` mantêm semântica. `negotiate` é opt-in. Features legadas são compiladas em memória para capabilities.

### Mind-clones

Formato e symlinks permanecem. A injeção passa a gerar referência com digest, origem e locale. Conteúdo privado não entra no journal por padrão.

### Packs

State, descriptors, catalogs e dados per-user não entram em base packs. Purity e watermark gates permanecem obrigatórios.

## 3. Migração do lifecycle

1. Aprovar schemas e fixtures.
2. Readers aceitam v1 e v2.
3. Facade dual-write adiciona IDs, target e ArtifactRef.
4. Journal opera em shadow mode.
5. Projections são comparadas com ledger, audit, validator e Glance.
6. Divergência bloqueia cutover e gera fixture.
7. Uma projection por vez vira reader principal.
8. Escrita legada só termina em major release com rollback ensaiado.

## 4. Runtime compatibility

| Policy | Semântica durante migração |
|---|---|
| `declared` | Mantém listas e comportamento legado. |
| `active` | Usa runtime ativo; nome não precisa constar em allowlist. |
| `negotiate` | Opt-in, usa descriptors, evidence e policy. |

Runtime desconhecido em `active` pode executar se o host descriptor satisfizer features obrigatórias. Runtime desconhecido em `declared` preserva o verdict legado. Ausência de capability crítica sempre falha de forma explicada.

## 5. Projects

Projetos existentes com `.nirvana/` e sem manifesto aparecem como legacy. `inspect` é read-only. `adopt` produz plano, diff e `plan_hash`; só então grava `.nirvana/project.yaml`. O path pode mudar sem alterar `project_id`.

## 6. Dados e recovery

- Migrations são puras, versionadas e testadas em up e down quando reversíveis.
- Backup só é válido após restore ensaiado.
- Runs ativos são reconciliados por lease e provider handle.
- Reiniciar Glance não muda estado de Run.
- Event replay não repete side effect; tool calls usam idempotency keys.

## 7. Rollback

Cada commit funcional deve declarar flag, storage impact, reader fallback e cleanup. Rollback nunca apaga journal novo. Ele desativa writers novos, restaura readers legados e preserva dados para investigação.
