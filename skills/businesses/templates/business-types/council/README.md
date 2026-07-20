# example-solo · Template de Business Solo

Este diretório é um template rodável de business mínima válida (1 employee CEO que faz brief_intake, processa e entrega).

## Estrutura

```
example-business/
├── business.yaml                 # manifest v1
├── org-chart.yaml                # hierarquia (CEO sem reports)
├── routing.yaml                  # brief_intake → ceo
├── escalation-triggers.yaml      # 3 triggers default (budget, scope creep, legal)
├── employees/
│   └── ceo.md                    # CEO com self_score_contract + brief_intake=true
├── memory/
│   └── permanent.md              # memória cross-session (skeleton)
└── README.md                     # este arquivo
```

## Como usar este template

Não modifique este diretório. Use como referência ou ponto de partida:

```bash
# Via wizard:
*business init minha-empresa --template solo

# Ou copy manual:
cp -R ~/.claude/skills/businesses/templates/example-business ~/businesses/minha-empresa
# Editar ~/businesses/minha-empresa/business.yaml e ajustar nome, domínios, descrição.
# Editar ~/businesses/minha-empresa/employees/ceo.md (description, criteria do self_score).
# Validar:
*business validate minha-empresa
```

## Validação

Este template passa em todas as checks do `validateBusinessIntegrity`:

- Manifest válido contra `business.schema.json`.
- Exatamente 1 brief_intake (ceo).
- BP7 não-aplicável (employee_count = 1, antagonist desnecessário).
- Org chart sem ciclos, exatamente 1 CEO (`reports: []`).
- Self-score contract com 3 criteria.

## Outros templates

- `template council`: 5 advisors + 1 CEO (council strategy review)
- `template agency`: CEO + 4-7 specialists + 1 antagonist (agency model com BP7 atendido)
- `template custom`: wizard pergunta tudo

Veja `references/01-creation.md` para detalhes de cada template.
