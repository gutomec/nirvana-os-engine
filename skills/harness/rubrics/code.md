---
name: code
display_name: "Code (snippets, modules, scripts)"
type: harness_rubric
version: 1.0.0
target_model: inherit
pass_threshold: 75
applies_to_produces:
  - code
  - script
  - module
  - api-endpoint
  - migration
  - refactor
# PT/EN synonyms of the slugs above (rubric-selector.ts): the same artifact
# spelled the other way selects this rubric instead of the generic fallback.
aliases:
  - codigo
  - código
  - script-python
  - biblioteca
  - componente
  - patch
  - cli
  - test-suite
  - sdk
description: |
  Applies to code artifacts. Failures catchable without running: typos,
  missing imports, security smells, anti-canonical patterns.
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
   Implements the request without inventing extra features. No speculative
   flexibility (toggles nobody asked for).

2. **correctness_static** (weight 25)  
   Complete imports, coherent types, no orphan variables, no obvious
   typos, no await outside async, etc. We do not run it; static checks only.

3. **security_smells** (weight 15)  
   No obvious command injection (shell=True with direct input), SQL
   injection (string concatenation in queries), hardcoded credentials,
   eval on external input.

4. **idiomatic_style** (weight 10)  
   Language conventions (camelCase in JS, snake_case in Python, etc).
   Does not mix styles in the same file.

5. **error_handling_calibrated** (weight 10)  
   Handles errors at the boundaries (network, FS, external parsing).
   Does NOT try to handle impossible scenarios (overengineering).

6. **comments_calibrated** (weight 5)  
   Comments explain non-obvious WHY. They do not explain the WHAT the code
   already says. No planning comments or "removed X".

7. **tests_present** (weight 5)  
   If the brief asked for tests, they are there; if the brief did not ask,
   their absence is OK.

8. **dependencies** (weight 5)  
   Does not introduce a heavy library for a trivial task. Reuses an
   existing library when it makes sense.

## Output schema
Default.
