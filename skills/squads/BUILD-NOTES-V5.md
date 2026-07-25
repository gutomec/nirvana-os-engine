# Squad Protocol Engine — Notas de Build v4 → v5

## Resumo

A skill `squads` foi atualizada de "v4 operacional" para "v5 operacional
capabilities-aware", mantendo compat total com o ecossistema v4 existente
(~133 squads).

Sem novas dependências externas. Tudo roda em fresh install com
`node>=18` e `python3>=3.8` (validators centralizados em
`~/.claude/skills/_shared/validators/`).

---

## O que mudou

| Área | v4 | v5 |
|------|----|----|
| Manifest default | `protocol: "4.0"` | `protocol: "5.0"` |
| Descoberta | `find ${SQUADS_DIR} -name squad.yaml` | Registry + BM25 + capabilities |
| Capability declaration | (não existe) | `capabilities[]` obrigatório |
| Routing | manual ou keyword | 3 sinais (HIGH/AMBIGUOUS/NO_MATCH) |
| Humanização | implícita | P11 + `humanize: true/false` por capability |
| Telemetria | opcional | `telemetry_otel` em `features_optional` |

### Arquivos novos

- `templates/squad.yaml.tmpl` — template v5 default (substitui o v4).
- `templates/squad-v4.yaml.tmpl` — template v4 preservado para legacy.
- `templates/capability-block.tmpl` — snippet reusável de capability.
- `lib/registry.js` — indexer + scan/build/write/rebuild.
- `lib/capability-validator.js` — validador estrutural + pydantic-backed.
- `references/12-v5-capabilities.md` — guia operacional de capabilities.
- `references/13-v5-registry.md` — guia do registry + troubleshooting.
- `references/15-creation-wizard.md` — fluxo de 4 rounds para creation.
- `scripts/init-squad.ts` — scaffold determinístico.
- `scripts/index-squads.ts` — wrapper bash do registry.
- `scripts/list-squads.ts` — tabela formatada do registry.
- `tests/smoke-v5.ts` — smoke E2E.
- `BUILD-NOTES-V5.md` — este arquivo.

### Arquivos atualizados

- `scripts/validate-squad.ts` — branch v5/v4 baseado em `protocol:`.
- `references/02-creation.md` — gera v5 por default.

### Arquivos preservados (sem mudanças)

- `SKILL.md` — já estava em v5 (atualização anterior).
- `lib/output-resolver.js`, `lib/adapter-loader.js`, etc.
- Adapters em `adapters/` (substituídos progressivamente pelos
  centralizados em `_shared/adapters/`).
- `references/01-discovery.md`, `03-validation.md`, ..., `11-adapters-guide.md`.

---

## Breaking changes

**Nenhum.** A intenção foi explícita: zero breaking.

- Squads v4 (`protocol: "4.0"`) continuam validando, listando, executando.
- O registry indexa squads v4 (com `capabilities: []`), mas elas não
  aparecem na busca por capability_id (esperado).
- `validate-squad.ts` detecta `protocol:` automaticamente e usa o branch
  apropriado.
- O template default mudou de v4 para v5, mas usuários que precisam de
  v4 continuam tendo `templates/squad-v4.yaml.tmpl` à mão.

---

## Upgrade path para squads v4 existentes

Comando manual sugerido (a implementação fica para próxima onda):

```bash
*squad migrate <name> --to v5
```

Steps que o migrator deve executar:

1. Ler `${SQUADS_DIR}/<name>/squad.yaml`.
2. Bump `protocol: "5.0"`.
3. Inferir 1 capability inicial a partir de `description` + `tags`.
   Sugerir id no formato `<primary-tag>.<name>.run` como placeholder.
4. Gerar `examples[]` a partir de `description` (LLM-assisted).
5. Mover ou symlink para `${SQUADS_DIR}/<name>/`.
6. Rodar `validate-squad.ts` no novo path.
7. Idempotente: re-rodar não duplica nada.

A migração é **opt-in**. Não mexemos nas 133 squads v4 existentes
durante este build — o usuário decide quando migrar cada uma.

---

## Como funciona o sistema fresh-install

Em uma máquina nova com `claude-code` (ou `codex`, ou `gemini-cli`),
sem dotfiles pré-existentes:

1. SKILL.md é descoberto por path padrão.
2. Primeira invocação cria `${SQUADS_DIR}/` (idempotent mkdir).
3. Registry vazio inicial em `${SQUADS_REGISTRY_PATH}` (apenas estrutura).
4. Validators usam `~/.claude/skills/_shared/validators/validators.py`
   via `python3 -c "import importlib.util; ..."` (sem precisar instalar
   pacote). Pydantic já vem com instalações Python típicas via brew /
   pyenv. Se faltar, structural fallback ainda funciona.
5. Yaml parser embutido em `~/.claude/skills/squads/node_modules/yaml`.

Zero `npm install`. Zero `pip install`. Zero internet em runtime.

---

## Limites conhecidos

1. **`humanize: true/false` só está documentado**, ainda não enforced
   pelo wrapper. P11 fica como contrato de capability — o runtime que
   decide aplicar. Quando o pipeline de humanização do harness for
   ativado, não precisa mexer nas squads.
2. **BM25 é "lite"** dentro do smoke test (TF-IDF + score_boost). O
   harness em produção pode swap por Lunr.js / FlexSearch sem mudar
   a forma do registry.
3. **Migrator v4→v5 não está implementado** — apenas documentado.
4. **`scripts/activate-squad.ts` não foi tocado** — segue v4. O
   registry rebuild é o único passo de "ativação" necessário em v5.
5. **Adapters em `~/.claude/skills/_shared/adapters/` (camada canônica v5)** (claude-code,
   codex, gemini-cli, cursor, antigravity) ainda existem. A SKILL.md
   já aponta para `_shared/adapters/` como source of truth. Os
   adapters locais podem ser deletados em onda futura.

---

## Tests

```bash
bun ~/.claude/skills/squads/tests/smoke-v5.ts
```

Saída esperada (todos PASS):

```
==== Squad v5 Smoke Test ====
[PASS] T1: pilot v5 squad.yaml exists
[PASS] T2: validate-squad.ts PASS on pilot
[PASS] T3: registry rebuilt and contains sales-funnel-masters
[PASS] T4: capability-validator.js validateAll PASS
[PASS] T5: BM25 search 'criar funil de vendas' → marketing.funnel.create
==== Result: 5 passed, 0 failed ====
```

Status atual: **5/5 PASS** no pilot `${SQUADS_DIR}/sales-funnel-masters`
(7 capabilities declaradas, 21 agents, 42 tasks, 6 workflows).

---

## Comandos de verificação rápidos

```bash
# Listar todas as squads no registry
bun ~/.claude/skills/squads/scripts/list-squads.ts

# Só squads v5
bun ~/.claude/skills/squads/scripts/list-squads.ts --proto 5.0

# Validar uma squad
bun ~/.claude/skills/squads/scripts/validate-squad.ts ${SQUADS_DIR}/<name>

# Forçar rebuild do registry
bun ~/.claude/skills/squads/scripts/index-squads.ts

# Smoke test E2E
bun ~/.claude/skills/squads/tests/smoke-v5.ts
```
