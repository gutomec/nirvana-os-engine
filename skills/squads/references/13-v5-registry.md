# v5 Registry — Guia Operacional

## Quando carregar

Intent: DISCOVER | EXECUTE | OBSERVE quando o usuário fala em "registry",
"index", "rebuild", "auto-invalidation", ou diagnostica por que uma squad
não aparece.

## Protocol Reference

`SQUAD_PROTOCOL_V5.md` §23 (Global Registry and Indexing).
Schema do registry: `core-schemas.json#/registry_squads`.
Implementação: `~/.claude/skills/squads/lib/registry.js`.

---

## Por que o registry existe

Em v4, a discovery era `find ${SQUADS_DIR} ./squads -name squad.yaml` seguido de
parse de cada manifest. Para 137 squads isso é caro e não fornece índice
semântico. Em v5, o harness lê um índice pré-computado:

```
${SQUADS_REGISTRY_PATH}
```

O registry é **cache, não fonte da verdade**. A fonte continua sendo os
arquivos `squad.yaml` no disco. O registry é regenerado pelo
`scripts/index-squads.ts`.

### O que o registry contém

```json
{
  "schema_version": "1.0.0",
  "generated_at": "2026-05-02T15:00:00Z",
  "host_protocol_version": "5.0",
  "squads_root_dirs": [
    "${SQUADS_DIR}"
  ],
  "squads": {
    "sales-funnel-masters": {
      "version": "5.0.0",
      "protocol": "5.0",
      "manifest_path": "${SQUADS_DIR}/sales-funnel-masters/squad.yaml",
      "manifest_hash": "sha256:...",
      "domains": ["marketing", "sales", "growth", ...],
      "capabilities": ["marketing.funnel.create", ...]
    }
  },
  "capabilities": {
    "marketing.funnel.create": [
      {
        "squad": "sales-funnel-masters",
        "description": "...",
        "domains": [...],
        "examples": [...],
        "not_for": [...],
        "fidelity_status": "experimental",
        "invoke": { "type": "workflow", "ref": "..." },
        "score_boost": 1.0
      }
    ]
  },
  "domains": {
    "marketing": ["sales-funnel-masters", "..."]
  }
}
```

---

## Como é gerado

`bun ~/.claude/skills/squads/scripts/index-squads.ts`

Internamente:

1. Walk em `${SQUADS_DIR}`, `${SQUADS_LEGACY_DIR}` (se definido), `./squads` (depth ≤2).
2. Para cada `squad.yaml` encontrado, parse + validação leve.
3. Computa `manifest_hash = sha256(squad.yaml content)`.
4. Indexa por capability_id e por domain.
5. Aplica regra de colisão: local (`./squads`) > `${SQUADS_DIR}` > `${SQUADS_LEGACY_DIR}`. A última gravação por nome vence.
6. Grava `${SQUADS_REGISTRY_PATH}` atomicamente (write-temp + rename).

### Comando equivalente em Node

```bash
node ~/.claude/skills/squads/lib/registry.js rebuild
```

API JS:

```javascript
const reg = require('~/.claude/skills/squads/lib/registry');
reg.scan();              // [{squad_name, manifest_path, manifest, hash}, ...]
reg.build();             // objeto registry completo (sem gravar)
reg.write(reg.build());  // grava em ${SQUADS_REGISTRY_PATH}
reg.rebuild();           // scan + build + write
```

---

## Como o harness consome

Quando o harness recebe um brief, ele:

1. Carrega `${SQUADS_REGISTRY_PATH}` (lazy, cached em memória da sessão).
2. Tokeniza o brief NL.
3. Roda BM25 sobre `description + examples + not_for` de todas
   capabilities indexadas.
4. Aplica `score_boost` e penalidade de fidelity (validated=1.0,
   experimental=0.85, drifted=0.5, retired=0).
5. Retorna 1 dos 3 sinais (Squad v5 §24): `MATCH_HIGH` (score ≥0.80 e
   gap ≥0.15), `MATCH_AMBIGUOUS` (score 0.60-0.80), `NO_MATCH` (<0.60).

Squads v4 (sem `capabilities[]`) **estão no registry**, mas
`registry.capabilities` não tem entradas para elas. Resultado: continuam
listáveis e ativáveis manualmente, mas o harness não as descobre por
intenção NL.

---

## Invalidação

O registry tem `manifest_hash` por squad. Quando alguém edita uma
`squad.yaml`, o hash muda. Quando o registry é rebuildado, ele detecta
diff e reindexar somente o que mudou (hoje a implementação faz full
rebuild — incremental fica para próxima onda).

### Hook automático (Claude Code)

Adicione em `~/.claude/settings.json` para reindexar automaticamente
após edits em squad.yaml:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": {
          "tool": ["Edit", "Write"],
          "file_pattern": "*/squad.yaml"
        },
        "command": "bun ~/.claude/skills/squads/scripts/index-squads.ts --quiet"
      }
    ]
  }
}
```

### Invalidação manual

```bash
# Force rebuild (sempre seguro, idempotente)
bun ~/.claude/skills/squads/scripts/index-squads.ts

# Listar tudo no registry
bun ~/.claude/skills/squads/scripts/list-squads.ts

# Filtrar só v5
bun ~/.claude/skills/squads/scripts/list-squads.ts --proto 5.0
```

---

## Troubleshooting

### "Squad não aparece no `*squad list`"

1. `bun ~/.claude/skills/squads/scripts/index-squads.ts` — força rebuild.
2. Confirme que `squad.yaml` está em `${SQUADS_DIR}`, `${SQUADS_LEGACY_DIR}` (se definido) ou
   `./squads` (depth ≤2 — `${SQUADS_DIR}/foo/squad.yaml` funciona,
   `${SQUADS_DIR}/foo/bar/squad.yaml` não).
3. Confira que o YAML parsea: `node -e "console.log(require('yaml').parse(require('fs').readFileSync('squad.yaml','utf8')))"`.
4. Confira que tem `name:` no YAML (campo obrigatório do registry).

### "Capability não é descoberta pelo harness"

1. `*squad validate <name> --report` — verifique erros de capability.
2. Confira `${SQUADS_REGISTRY_PATH}` tem entrada em `capabilities.<id>`.
3. Verifique se os `examples[]` cobrem a frase real do usuário (BM25
   rankeia por overlap de tokens com description+examples+not_for).
4. Se outra squad tem mesma capability_id com `score_boost` maior ou
   `fidelity_status` melhor, o harness escolhe ela. Use `not_for[]`
   para diferenciar.

### "Registry obsoleto após várias edições"

Sintoma: `*squad list` mostra 137 squads mas `${SQUADS_REGISTRY_PATH}`
ainda diz 100. Solução:

```bash
bun ~/.claude/skills/squads/scripts/index-squads.ts
```

Idempotente. Sempre seguro.

### "Erro ao parsear squad.yaml de uma squad antiga"

O registry é robusto: log de warning no stderr e pula o squad.yaml
malformado. Outras squads continuam indexáveis. Veja stderr para
detalhes.

```bash
bun ~/.claude/skills/squads/scripts/index-squads.ts 2> /tmp/index-warnings.log
grep WARN /tmp/index-warnings.log
```

### "Registry diz que squad existe em v4 e v5 simultaneamente"

A regra de colisão garante que uma só vence (a última, em ordem
`${SQUADS_LEGACY_DIR} → ${SQUADS_DIR} → ./squads`). Se você quer manter as duas
versões mas com nomes distintos, renomeie a v4. Se você terminou a
migração, delete a v4.

---

## Localização dos arquivos

| Arquivo | Função |
|---------|--------|
| `${SQUADS_REGISTRY_PATH}` | Cache do registry (gerado) |
| `~/.claude/skills/squads/lib/registry.js` | Indexer (Node) |
| `~/.claude/skills/squads/scripts/index-squads.ts` | Wrapper bash |
| `~/.claude/skills/squads/scripts/list-squads.ts` | Lê registry, formata tabela |
| `~/.claude/skills/_shared/schemas/core-schemas.json#/registry_squads` | Schema do JSON gerado |

Zero deps externas — usa só Node stdlib + módulo `yaml` vendored.
