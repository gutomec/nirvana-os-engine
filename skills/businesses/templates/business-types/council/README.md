# example-solo · Template de Business Solo

Este diretório é um template rodável de business mínima válida (1 employee CEO que faz brief_intake, processa e entrega).

## Estrutura

```
example-business/
├── business.yaml                 # manifest protocol 2.0
├── org-chart.yaml                # hierarquia (CEO sem reports)
├── routing.yaml                  # brief_intake → ceo
├── employees/
│   └── ceo.md                    # CEO com acceptance + brief_intake=true
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
cp -R ~/.nirvana/skills/businesses/templates/example-business ~/businesses/minha-empresa
# Editar ~/businesses/minha-empresa/business.yaml e ajustar nome, domínios, descrição.
# Editar ~/businesses/minha-empresa/employees/ceo.md (description, entradas de acceptance).
# Validar:
nrv validate business minha-empresa --strict
```

## Validação

Este template passa no portão de admissão (`nrv validate business <slug>`):

- Manifest válido contra o schema Zod executado (`_shared/validators/validators.ts`).
- Exatamente 1 brief_intake (ceo).
- BP7 não-aplicável (1 funcionário, antagonista desnecessário).
- Org chart sem ciclos, exatamente 1 CEO (`reports: []`).
- Bloco `acceptance` com 3 critérios no cargo de intake (v2 §11).

## Outros templates

- `template council`: 5 advisors + 1 CEO (council strategy review)
- `template agency`: CEO + 4-7 specialists + 1 antagonist (agency model com BP7 atendido)
- `template custom`: wizard pergunta tudo

O fluxo completo do wizard está em `SKILL.md` (§Wizard flow).
