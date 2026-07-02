---
name: code
display_name: "Code (snippets, módulos, scripts)"
type: harness_rubric
version: 1.0.0
target_model: sonnet
pass_threshold: 75
applies_to_produces:
  - code
  - script
  - module
  - api-endpoint
  - migration
  - refactor
description: |
  Aplica-se a artefatos de código. Falhas pegáveis sem rodar: typos,
  imports faltando, security smells, padrões anti-canônicos.
---

# Code Rubric

## Inputs
```json
{
  "artifact": "<full code>",
  "language": "typescript"|"python"|"go"|"rust"|"...",
  "brief": "<...>"
}
```

## Criteria

1. **brief_fidelity** (weight 25)  
   Implementa o pedido sem inventar features extra. Sem flexibility
   especulativa (toggles que ninguém pediu).

2. **correctness_static** (weight 25)  
   Imports completos, tipos coerentes, sem variáveis órfãs, sem typos
   óbvios, sem await fora de async, etc. Não rodamos; só estática.

3. **security_smells** (weight 15)  
   Sem command injection óbvio (shell=True com input direto), SQL
   injection (concat de strings em queries), credenciais hardcoded,
   eval em input externo.

4. **idiomatic_style** (weight 10)  
   Convenções da linguagem (camelCase em JS, snake_case em Python, etc).
   Não mistura estilos no mesmo arquivo.

5. **error_handling_calibrated** (weight 10)  
   Trata erros nos pontos de fronteira (network, FS, parsing externo).
   NÃO tenta tratar cenários impossíveis (overengineering).

6. **comments_calibrated** (weight 5)  
   Comentários explicam WHY não-óbvio. Não explicam WHAT que o código já
   diz. Sem comentários de planejamento ou "removed X".

7. **tests_present** (weight 5)  
   Se o brief pediu testes, eles estão; se o brief não pediu, ausência
   é OK.

8. **dependencies** (weight 5)  
   Não introduz lib pesada para tarefa trivial. Reusa lib existente
   quando faz sentido.

## Output schema
Padrão.
